# Next Session

## Entry point - read these first

- `docs/roadmap.md`
- `docs/integrations/ADR-005-master-catalogue-vs-vendor-daily-listing.md`
- `docs/architecture/reservation-lifecycle.md`
- `.claude/current-task.md`
- `.claude/next-session.md` (this file)
- `.claude/decisions.md`
- `.claude/worklog.md`

## Confirm before doing anything else

- Branch is `develop`.
- Working tree is clean.
- Local `develop` and `origin/develop` are synchronized (0 ahead / 0
  behind).
- Commit Unit 1 (`57c73b4`), Unit 2.1 (`c757bdd`), Unit 2.2 (`393c970`),
  Unit 2.3 (`a27cb65`), Unit 2.4.1 (`4db6018`), Unit 2.4.2 (`8c68f3b`),
  Unit 2.4.3 (`e907998`), and Unit 2.4.4 (`ad89219`) are all present on
  `origin/develop`.

## The next session must begin with repository confirmation, then a read-only review only

**PHASE 16A.0 - CALLER CUTOVER AND OPERATIONAL INTEGRATION REVIEW**

This is not an implementation unit. The next session must inspect and
produce a read-only plan - the same discipline used for every prior unit
- covering:

- How `CartService` will call `reserveOrRenew` (Unit 2.3) in place of the
  legacy `reserve`/`getReservedByOthers` methods.
- How checkout will call `checkoutMark` (Unit 2.4.1).
- How `OrdersService`, or a dedicated checkout coordinator, will create
  and update `CheckoutAttempt` rows.
- When `finalizeCheckoutConsumption` (Unit 2.4.3) runs.
- When `checkoutRevert` (Unit 2.4.3) runs.
- How durable heartbeat updates (`CheckoutAttempt.lastHeartbeatAt`) occur.
- How a future scheduler calls
  `CheckoutPendingReconciliationService.reconcileExpiredCheckoutPending`
  (Unit 2.4.4).
- The maintenance-window cutover sequence (see
  `docs/architecture/reservation-lifecycle.md` §8 for the existing legacy
  drain plan this must coordinate with).
- The legacy Redis drain itself.
- Rollback strategy.
- Feature-flag or staged-rollout strategy.
- Production observability and metrics.

The complete checkout reservation engine (Units 2.4.1-2.4.4) already
exists, is fully tested (real Redis + full backend suite + CI-equivalent
coverage on every unit), and remains entirely additive and unwired. This
review plans *how* to wire it, not whether to build more of it.

## Explicitly excluded until the plan is reviewed and separately approved

- No caller wiring (`CartService`, `OrdersService`, `ProductsService`
  remain untouched).
- No Nest module registration.
- No scheduler implementation.
- No Prisma repository/query-service changes.
- No controller or DTO changes.
- No frontend changes.
- No production cutover.
- No legacy deletion (Redis drain or otherwise).

## Do NOT do

- Do not begin any cutover-related source-code edit before a plan is
  presented and explicitly approved.
- Do not say cutover implementation has begun until the corresponding
  files have actually been edited.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s content
  into session files - reference it, don't restate it.
- Do not treat the checkout reservation engine (Units 2.4.1-2.4.4) or the
  cart-scoped reservation engine (Units 2.1-2.3) as partially wired - both
  are fully additive and untouched by any production caller; do not
  assume otherwise or begin a cutover without a separate, explicit
  approval.
