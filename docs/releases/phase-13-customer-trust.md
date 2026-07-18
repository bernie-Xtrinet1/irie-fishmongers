# Phase 13 — Customer Trust (Reviews, Ratings, Compliance Score)

_Release notes. Convention: one file per release/phase under `docs/releases/`;
this doubles as the source for the GitHub PR body and GitHub Release text._

> ⚠️ **DO NOT MERGE TO `main` YET.** Final regression sign-off is blocked on
> backend e2e DB isolation (see "Known gate" below). Safe to review now.
>
> **Scope note:** a `develop → main` PR currently spans **75 commits** (the
> whole platform release since the last `main` push), not Phase 13 alone. If a
> Phase-13-scoped review target is wanted, cut `release/phase-13` from
> `develop` and PR that instead. `git log --oneline main..develop` /
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
| backend e2e (full suite together) | ❌ nondeterministic — see gate |

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

## Known gate (blocks merge to main)
The full backend e2e suite is not reliably green: the global `@Cron` jobs
registered by `ScheduleModule.forRoot()` fire on a wall-clock timer during the
multi-minute run and race suite teardown → Prisma P2025 ("No record was found
for an update"). CI runs `test:e2e` **in parallel** (`jest-e2e.json` sets no
`maxWorkers`) on one shared Postgres, so this surfaces as nondeterministic red.

**The fix is NOT yet committed to any branch in this repository.** A fix was
investigated in a separate working session, but no local branch here carries a
`ScheduleModule` test-guard (verified: a search of every ref for the guard
came up empty; `claude/competent-darwin-38ccfa` @ `d9058ad` is a Phase 12B
passport e2e test, not the fix). It must be integrated and re-verified in this
tree before sign-off. When integrating, review it against:
- prefer an explicit `ENABLE_SCHEDULER=false` switch over a blanket
  `NODE_ENV==='test'` disable;
- keep dedicated tests that exercise the scheduled services directly (SLA
  breach detection, nightly compliance recompute) so silencing the timer in
  the default e2e run does not drop that coverage;
- confirm the full suite exits **non-zero** on a deliberately failing test
  (no pipeline/wrapper swallows Jest's code — the CI command
  `npm run test:e2e -w backend` does not).

**Sign-off requires:** two consecutive clean full-suite runs locally AND in
GitHub Actions.

## Pre-Merge Gate

- [ ] Confirm the E2E isolation fix commit and inspect its diff.
- [ ] Cherry-pick the confirmed fix into the release branch.
- [ ] Run the complete backend E2E suite twice successfully.
- [ ] Confirm a failing Jest test produces a non-zero process exit code.
- [ ] Run full monorepo typecheck, lint, unit and frontend test suites.
- [ ] Confirm migrations and the compliance-score backfill procedure.
- [ ] Confirm the working tree is clean.
- [ ] Push the release branch and wait for GitHub Actions to pass.
