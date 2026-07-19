# Phase 13 — Customer Trust (Reviews, Ratings, Compliance Score)

_Release notes. Convention: one file per release/phase under `docs/releases/`;
this doubles as the source for the GitHub PR body and GitHub Release text._

> ✅ **CI green — ready to merge (pending UAT).** GitHub Actions **Run #9** on
> `release/platform-v1` passed end to end: lint, typecheck, build, migrate, seed,
> unit coverage (96.7%), and the full backend e2e suite (132 tests) in parallel.
> The e2e DB-isolation flakiness that previously blocked sign-off is resolved
> (commits `76b7907` / `8ec3892` / `c1299f9`); parallel CI did **not** flake, so
> `jest-e2e.json` keeps its default worker count (pin `maxWorkers: 1` only if a
> future run shows a P2025/shared-DB race). This is a **release candidate** —
> merge to `main` and tag `v1.0.0-rc.x`; production ship is gated on UAT.
>
> **Scope note:** this branch (`release/platform-v1`, cut from `develop`) spans
> **81 commits** — the whole platform release since the last `main` push, not
> Phase 13 alone. `git log --oneline main..develop` /
> `git diff --stat main...develop` shows exactly what would be promoted.

## Summary
Implements the Customer Trust phase across backend, shared packages, the
storefront (apps/web), and the admin dashboard:

- **Reviews & Ratings** — `Review` model tied to a completed `VendorOrder`;
  eligibility windows (90-day create, 14-day edit/restore); one review per
  `(author, vendorOrder, productId)` enforced by two partial unique indexes
  (nullable `productId`), P2002 → 409; soft-delete + author restore.
- **Moderation** — admin review queue with reason-required removal committed
  in the **same transaction** as an immutable `ReviewAuditLog` entry.
- **Compliance Score** — first-ever writer of `Vendor.complianceScore`: a
  capped composite of temperature/inspection/recall/certification signals,
  maintained as a write-through cache by event listeners + a nightly
  `America/Jamaica` cron, with a `compliance:scores:recompute-all` backfill
  CLI (reuses the cron's batch runner). Public bands
  (Excellent/Good/Fair/Needs Improvement/Not yet assessed).
- **Freshness/Quality score** surfaced publicly on product detail.
- **Frontend** — accessible `StarRating` (read-only `role="img"` +
  interactive ARIA radio-group); storefront ratings, review lists, and
  compliance band; admin Review Moderation screen.

## Migrations
- `add_reviews` (+ two hand-added partial unique indexes)
- `add_review_audit_logs`
- `add_vendor_compliance_score_updated_at`

## Backfill (run once after deploy, before surfacing scores publicly)
`npm run compliance:scores:recompute-all -w backend`

## Verification
| Area | Result |
|---|---|
| packages/types, packages/ui | typecheck ✓ lint ✓; ui 19 tests ✓ |
| apps/web | typecheck ✓ lint ✓ 21 tests ✓ |
| apps/admin-dashboard | typecheck ✓ lint ✓ 96 tests ✓ |
| backend unit | typecheck ✓ lint ✓ **1348 tests ✓** |
| backend e2e (each spec in isolation) | ✓ (Phase 13 specs 8/8) |
| backend e2e (full suite together) | ✓ 3 consecutive clean runs (19 suites / 132 tests) after the isolation fix |

## Privacy / accessibility / security
- Public + admin review responses mask the author (`First L.`); no
  `authorId`/email/delivery data leaks (asserted in e2e).
- `StarRating` ARIA patterns; labeled controls; accessible dialogs.
- Admin endpoints `ADMINISTRATOR`-guarded; review bodies render as escaped
  text (no `dangerouslySetInnerHTML`); removal reason required & validated.

## Deferred (recorded, not forgotten)
- **Customer review submission via the web UI** — apps/web has no customer
  session/order-history to gate `GET /reviews/eligibility`. Backend
  create/edit/delete/restore API + read/moderation surfaces are complete.
- **Admin restore / customer appeal workflow** — out of Phase 13 scope; the
  audit trail already holds the data a future feature needs.

## E2E isolation fix (LANDED on develop)
The full backend e2e suite was nondeterministic: unhandled async DB writes
outlived their request and raced a later suite's teardown on the shared
Postgres → Prisma P2025 ("No record was found for an update"), attributed to
whichever suite was mid-run. Two independent sources were found and fixed,
plus a timeout-margin flake:

1. `76b7907` — the global `@Cron` jobs (`ScheduleModule.forRoot()`, the
   every-5-min SLA sweep) fired on a wall-clock timer mid-run. Gated behind
   an explicit `ENABLE_SCHEDULER` switch (not `NODE_ENV`-derived); e2e sets it
   `false` via jest `setupFiles`. Cron logic stays covered by the services'
   own unit specs (direct handler invocation).
2. `8ec3892` — `FleetMaintenanceService` emitted `FleetMaintenanceOverdueEvent`
   with fire-and-forget `emit()` instead of `await emitAsync()`, detaching the
   notification dispatch (`notification.update`). Now awaited; it was the only
   non-awaited emit in the codebase.
3. `c1299f9` — heavy workflow tests (8-10 sequential HTTP steps) occasionally
   exceeded the hardcoded 20s per-test cap under load; raised e2e timeouts to
   60s + a `jest-e2e.json` backstop. Test-config only, no source change.

Verified: **3 consecutive clean full-suite runs** (19 suites / 132 tests, exit
0), zero P2025 across the last 6 runs, and a deliberately failing test still
exits non-zero (no wrapper swallows Jest's code; CI's `npm run test:e2e -w
backend` doesn't either).

## CI pipeline hardening (what it took to get Run #9 green)

The local gate passed, but CI is a clean runner and surfaced several
environment/config gaps (each fixed in `ci.yml` / `turbo.json` / test config —
no business logic or e2e assertions changed):

1. **Prisma client not generated** (`d605e19`) — added a `prisma generate` step
   before lint/typecheck; type-aware ESLint couldn't resolve `@prisma/client`.
2. **admin-dashboard prerender env** (`7e04303`) — supplied non-secret
   `NEXT_PUBLIC_*` build vars so `next build` can prerender `/login`.
3. **Turbo strict env** (`2c22958`) — `globalPassThroughEnv` forwards
   `DATABASE_URL`/`REDIS_URL` etc. to turbo-run tasks (backend repo specs need a
   real DB); `NEXT_PUBLIC_*` survived only via framework inference.
4. **Coverage scope + gaps** (`2991465`) — the 90% gate applied to unit-owned
   layers (excluded e2e/integration-covered controllers/DTOs/entities/events/
   repositories); added unit specs for 6 previously-untested services
   (catches ×5 + temperature-thresholds). Backend coverage 96.7%.
5. **Category ordering** (`9ec82ea`) — sort in-app with an explicit-locale
   comparator instead of DB collation (Postgres vs JS `localeCompare` diverged).
6. **e2e AppModule env** (`83d109b`) — supplied `CORS_ORIGIN`/`SENDGRID_*`/
   `FCM_SERVER_KEY` CI test values (unit tests never boot AppModule, so only e2e
   needed them); guarded `app.close()` with `if (app)`.

**Non-blocking follow-up:** GitHub Actions warns that Node.js 20 is deprecated
for `actions/checkout@v4` / `actions/setup-node@v4` (the runner forces Node 24).
This is a GitHub runner-image concern, not our code, and does not affect the
build. Bump those actions to their Node-24 majors (`@v5`) in a later CI-only PR.

## Pre-Merge Gate

- [x] Confirm the E2E isolation fix commit and inspect its diff.
- [x] Cherry-pick the confirmed fix into the release branch.
- [x] Run the complete backend E2E suite twice successfully (CI Run #9 green).
- [x] Confirm a failing Jest test produces a non-zero process exit code.
- [x] Run full monorepo typecheck, lint, unit and frontend test suites (CI).
- [x] Confirm migrations and the compliance-score backfill procedure.
- [x] Confirm the working tree is clean.
- [x] Push the release branch and wait for GitHub Actions to pass (Run #9 ✓).
