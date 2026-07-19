# ADR-004 Admin Dashboard Authentication

Status:
Approved

Date:
2026-07-11

---

## Context

Phase 12A adds the platform's first operator-facing frontend
(`apps/admin-dashboard`) and, with it, the first web login flow anywhere
in this codebase. `apps/web` (the existing customer-facing app) has no
auth flow at all, so there is no existing frontend pattern to copy.

An admin session is higher-value than a customer session: an admin token
can approve/suspend vendors and drivers, activate recalls, and reach every
compliance record on the platform. A naive design that stores a
long-lived refresh token in `localStorage` would let a successful XSS
exfiltrate a long-lived admin credential, not just a short-lived one.

A review of an earlier draft of this plan flagged exactly that risk.
Investigating the existing backend before designing a fix found that
`backend/src/modules/auth` **already implements the secure pattern the
review asked for** - this ADR documents using it correctly from the
frontend, not building anything new on the backend beyond CORS.

---

## Decision

The admin dashboard authenticates using the backend's existing hybrid
cookie/bearer-token design, with one added frontend discipline: **the
frontend never persists any token to `localStorage` or `sessionStorage`.**

- `POST /auth/login` and `POST /auth/refresh`
  (`backend/src/modules/auth/controllers/auth.controller.ts`) already set
  an `httpOnly`, `Secure`, `sameSite: 'strict'` `refresh_token` cookie,
  scoped to `/api/v1/auth`, alongside returning both tokens in the JSON
  response body (kept for non-browser clients). Access tokens expire in
  15 minutes (`JWT_ACCESS_EXPIRES_IN`), refresh tokens in 7 days
  (`JWT_REFRESH_EXPIRES_IN`).
- `POST /auth/logout` already revokes the refresh token server-side
  (`RefreshTokensRepository.revoke`, sets `revokedAt`) and clears the
  cookie.
- The admin dashboard frontend keeps the **access token in memory only**
  (a React context) and never touches the refresh token directly at all -
  the browser sends the `httpOnly` cookie automatically on every
  `fetch(..., { credentials: 'include' })` call.
- On app load, the dashboard calls `POST /auth/refresh` (cookie carries
  the token, no body needed) to silently re-establish a session. Failure
  means "not logged in." This is what lets a session survive a page
  reload without the frontend ever persisting a token itself.
- Concurrent 401s are coalesced through a single in-flight refresh
  promise in `lib/api-client.ts`, so a burst of failed requests triggers
  exactly one `/auth/refresh` call, not one per request.
- Logout calls `POST /auth/logout` (server-side revocation), clears the
  React Query cache, clears the in-memory access token, and redirects to
  `/login`.
- Client-side route protection (`RequireAdmin`) is UX only. The only real
  authorization boundary is the backend's existing
  `@Roles(RoleName.ADMINISTRATOR)` + `RolesGuard` check, already applied
  independently to every admin endpoint.
- **A non-administrator must never end up with a live admin-dashboard
  session, even transiently.** `POST /auth/login` sets the refresh cookie
  *before* the frontend can inspect the returned user's roles - so
  `AuthProvider.login()` and the silent-refresh effect both check
  `user.roles.includes('ADMINISTRATOR')` immediately after a successful
  login/refresh, and if it's false, call `POST /auth/logout` (revoking
  that just-issued refresh token) and `queryClient.clear()` before ever
  setting `status: 'authenticated'`. The same rule applies to a silent
  refresh that resolves a non-admin user - it is revoked, not merely
  ignored. See `apps/admin-dashboard/lib/auth/auth-context.tsx`'s
  `revokeCurrentSession()`.

---

## Deployment Domain Requirements

`sameSite: 'strict'` on the refresh cookie means the admin dashboard and
the API it calls must be **same-site** (share a registrable domain) for
the browser to send the cookie at all on the dashboard's own top-level
navigations and fetches:

- `admin.iriefishmongers.com` calling `api.iriefishmongers.com` - same
  site (`iriefishmongers.com`), works.
- `admin.iriefishmongers.com` calling a different registrable domain
  (e.g. a third-party API hosting provider's own domain, unless a custom
  domain/CNAME is configured on it) - **not** same-site; the cookie would
  not be sent and the silent-refresh flow would break.

This must hold in every environment:

- **Local development**: both apps run on `localhost` at different ports
  (`:3001` API, `:3002` admin) - same-site by the browser's port-agnostic
  same-site rules; `secure: false` in dev (see
  `AuthController.setRefreshTokenCookie`, gated on `NODE_ENV ===
  'production'`) since `localhost` isn't served over HTTPS.
- **Staging**: staging API and staging admin dashboard must share a
  registrable domain (e.g. `admin.staging.iriefishmongers.com` /
  `api.staging.iriefishmongers.com`), and `secure: true` requires both to
  be served over HTTPS.
- **Production**: same requirement, `secure: true` enforced.

Any deployment plan that puts the admin dashboard and the API on
different registrable domains must revisit this ADR before shipping -
either provision same-site subdomains, or fall back to
`sameSite: 'none'` with `secure: true` (a materially different CSRF risk
profile, out of scope for this ADR's Phase 12A decision).

---

## Reasoning

No backend authentication change was needed - only correct frontend
usage of a design that was already built. Storing tokens client-side
(localStorage/sessionStorage) was rejected outright: it offers no
functional benefit here (the httpOnly cookie already gives the frontend
refresh capability without ever exposing the refresh token to JavaScript)
and only adds XSS blast radius.

---

## Architectural Requirements

Claude must design the admin dashboard's `lib/api-client.ts` so that:

- Every request includes `credentials: 'include'`.
- The access token is sourced from an in-memory auth context, never from
  `localStorage`/`sessionStorage`/`document.cookie` reads.
- A single shared refresh promise serializes concurrent 401 handling.
- `/auth/login` and `/auth/refresh` calls never themselves trigger the
  401-refresh-retry logic (no infinite loop risk).

`backend/src/main.ts`'s CORS configuration must move from a single
`CORS_ORIGIN` string to a comma-separated allowlist (still never `origin:
'*'`, which is incompatible with `credentials: true` regardless), so the
admin dashboard's dev/staging/production origins can be added alongside
the existing customer-web origin. Parsing must trim and drop empty
entries (`.split(',').map(trim).filter(Boolean)`) so a stray trailing
comma never silently becomes an allowed empty-string origin.

**Environment configuration is centralized, not scattered.**
`apps/admin-dashboard/lib/env.ts` is the only file that reads
`process.env.NEXT_PUBLIC_*` with a fallback; `NEXT_PUBLIC_API_URL`,
`NEXT_PUBLIC_ENVIRONMENT`, and `NEXT_PUBLIC_APP_URL` are consumed from
`env` everywhere else (`api-client.ts`, `dashboard-shell.tsx`,
`next.config.js`'s CSP). In production, a missing required variable
throws at module-evaluation time rather than silently falling back to a
`localhost` default that could never work; in development the documented
`.env.example` defaults apply.

**Defense in depth beyond the cookie**: the in-memory access token is
only as safe as this page is from XSS. `apps/admin-dashboard/next.config.js`
sets `Content-Security-Policy` (`frame-ancestors 'none'`, `connect-src`
scoped to `'self'` plus the configured API origin, no wildcard
`script-src`), `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
`Permissions-Policy`, and `X-Frame-Options: DENY` on every response. No
component may use `dangerouslySetInnerHTML` with API-provided content.

---

## Dashboard Query Architecture

An early draft had each of the six overview widgets call
`GET /analytics/dashboard-summary` under its own React Query `queryKey`
(one per widget) so each could pick its own refetch interval. That does
not work the way it sounds: React Query only dedupes/shares requests for
the *same* `queryKey` - six different keys hitting the same URL is six
independent caches, and a widget with a 5s interval would silently
re-trigger the full financials/orders/vendors/drivers/compliance
aggregation every 5 seconds, not just its own field.

The corrected design, in `apps/admin-dashboard/lib/hooks/`:

- **One shared query** for every business-KPI consumer (`FinancialSummaryCard`,
  `OrdersSummaryCard`, `VendorSummaryCard`, `DriverSummaryCard`,
  `ComplianceSummaryCard`, the `NeedsAttentionPanel`, and the overview
  page's "last refreshed" header) - `use-dashboard-summary.ts` exports a
  single `DASHBOARD_SUMMARY_QUERY_KEY`, and each widget calls
  `useDashboardSummary(select)` with its own `select` function to pick its
  slice of the one cached response. One `refetchInterval` (20s) governs
  the whole group.
- **A separate, independent query for system health** -
  `use-health-status.ts` polls the new `GET /health/status` endpoint (see
  below) every 5s, entirely decoupled from the dashboard-summary query.
  `SystemHealthCard` and the topbar connectivity indicator both use this,
  never `useDashboardSummary`.
- **Failure boundaries follow the query, not the widget.** Because the
  five KPI cards and the Needs Attention panel share one query, a
  dashboard-summary failure surfaces as an error state on all of them
  simultaneously - they do not have independent backend failure
  boundaries, only independent presentation. `SystemHealthCard` is the
  only widget with a genuinely independent failure boundary, because it
  reads a different endpoint.

### `GET /health/status`

`GET /health` (`backend/src/common/health/health.controller.ts`) is an
infra readiness probe: it throws 503 the moment either dependency is
down, which is the right behavior for a load balancer but the wrong
behavior for a UI widget that wants to keep showing granular status
during a partial outage. `GET /health/status` is a second, admin-gated
route on the same controller that reuses `HealthService.checkStatus()`
directly and always resolves 200 with `{ postgres, redis }` - cheap (two
ping-style checks, no business-KPI computation) regardless of poll
frequency, so polling it every 5s carries none of the cost the flawed
per-widget design above would have had.

---

## Permission Matrix (documented, not implemented)

Today every admin capability is gated on the single `ADMINISTRATOR` role
via `RolesGuard`. This is deliberately left as-is for Phase 12A - no
fine-grained permission system is built now. A future, more granular
model should look like:

| Permission | Administrator (today) | Operations Manager (future) | Compliance Officer (future) |
|---|---|---|---|
| View Vendors | yes | yes | yes |
| Approve/Suspend Vendors | yes | yes | no |
| Manage Fleet & Delivery Zones | yes | yes | no |
| Manage Compliance (recalls, certifications, emergency response) | yes | no | yes |
| View Analytics | yes | yes | yes |

When this is built, it replaces `RolesGuard`'s current all-or-nothing
`@Roles(RoleName.ADMINISTRATOR)` checks with a finer-grained permission
check per endpoint - a schema and guard change, not an ADR-004 concern to
solve now. Recorded here so the target shape is documented before anyone
starts building it piecemeal.

---

## Consequences

Positive

- No new backend attack surface - reuses an already-built, already-secure
  token design.
- No admin token is ever readable by injected JavaScript via Storage
  APIs.
- A compromised admin browser tab loses access within 15 minutes (access
  token expiry) once the httpOnly cookie can no longer be silently
  refreshed (e.g. after logout or cookie expiry).

Negative

- The access token does not survive a full browser process restart within
  its own 15-minute window without a silent-refresh round trip on load -
  an accepted UX cost (one extra request) for not persisting it.
- CORS configuration now requires maintaining an allowlist across
  environments instead of a single string, adding minor deployment
  configuration surface.
- **Known gaps carried into 12B, not silently worked around in 12A:**
  - `PATCH /vendors/:id/status` and the equivalent driver endpoint accept
    only `{ status }` - no `reason`/note field, and neither vendor nor
    driver status changes are audit-logged today (unlike Recalls, which
    already go through `ComplianceAuditLogService`). The Vendor/Driver
    Management screens' confirmation dialogs therefore do not collect a
    reason - adding an input that silently discards what the admin types
    would be worse than not asking. Adding `reason` + audit coverage to
    those two endpoints is 12B scope.
  - The Recall Management screen (12A, not yet built as of this writing)
    depends on `GET /food-safety/audit-logs?entityType=Recall&entityId=:id`
    for its "changed by/at/reason" detail view - the exact `entityType`
    casing, pagination shape, response entity, and whether the caller
    display name is embedded or must be resolved separately must be
    verified against that controller before that screen is built, the
    same way every other endpoint in this phase was verified against its
    actual controller/DTO rather than assumed from the plan.

---

## Future Review

Review when:

- A second admin-facing frontend (e.g. a future Operations Manager or
  Compliance Officer app) is built and the Permission Matrix above needs
  to become real code.
- The backend's own auth design changes (e.g. token expiry durations,
  cookie scope) for reasons unrelated to this ADR.

---

## Implementation Directive

Claude shall:

- Never write an access or refresh token to `localStorage`,
  `sessionStorage`, or any other persistent client-side store, in the
  admin dashboard or any future frontend.
- Always send `credentials: 'include'` on requests to the backend from
  the admin dashboard.
- Treat the backend's existing cookie-based refresh flow as final for
  Phase 12A - do not propose alternate token-storage schemes without
  updating this ADR first.
- Keep `RolesGuard`'s `ADMINISTRATOR`-only checks as the actual
  authorization boundary; treat all frontend route guards as UX
  convenience only.

This ADR takes precedence over any implementation suggestion that
proposes storing tokens in browser Storage APIs.
