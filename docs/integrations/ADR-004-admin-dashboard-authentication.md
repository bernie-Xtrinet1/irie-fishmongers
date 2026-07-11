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
the existing customer-web origin.

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
