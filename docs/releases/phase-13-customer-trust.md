# Phase 13 — Customer Trust (Reviews, Ratings, Compliance Score)

_Release notes. Convention: one file per release/phase under `docs/releases/`;
this doubles as the source for the GitHub PR body and GitHub Release text._

> ✅ **Local gate passed; awaiting CI.** The backend e2e DB-isolation flakiness
> that previously blocked sign-off is **resolved locally** (commits `76b7907` /
> `8ec3892` / `c1299f9`): 3 consecutive clean full-suite runs, zero P2025 across
> the last 6 runs, deliberate-failure test exits non-zero. The only remaining
> gate is a green run in GitHub Actions (which runs e2e in **parallel** — pin
> `maxWorkers: 1` in `jest-e2e.json` if parallel CI proves flaky). Do not merge
> to `main` until CI is green. Safe to review now.
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

**Remaining sign-off step:** confirm green in GitHub Actions (which runs the
suite in parallel — `jest-e2e.json` still sets no `maxWorkers`; consider
pinning `maxWorkers: 1` if parallel CI proves flaky).

## Pre-Merge Gate

- [ ] Confirm the E2E isolation fix commit and inspect its diff.
- [ ] Cherry-pick the confirmed fix into the release branch.
- [ ] Run the complete backend E2E suite twice successfully.
- [ ] Confirm a failing Jest test produces a non-zero process exit code.
- [ ] Run full monorepo typecheck, lint, unit and frontend test suites.
- [ ] Confirm migrations and the compliance-score backfill procedure.
- [ ] Confirm the working tree is clean.
- [ ] Push the release branch and wait for GitHub Actions to pass.
