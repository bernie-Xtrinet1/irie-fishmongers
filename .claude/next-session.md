# Next Session

## Entry point - read these first

- `docs/roadmap.md`
- `docs/integrations/ADR-005-master-catalogue-vs-vendor-daily-listing.md`
- `docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md`
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
  Unit 2.4.3 (`e907998`), Unit 2.4.4 (`ad89219`), and `ADR-007` (`15bbacf`)
  are all present on `origin/develop`.

## The next session must begin with repository confirmation, then Phase 16A.0-A planning only

**PHASE 16A.0-A - CHECKOUTATTEMPT REPOSITORY AND SERVICE**

This is read-only planning only. Per `ADR-007`'s Implementation
Prohibition section, ADR approval is not implementation approval - Phase A
still needs its own separate go-ahead before any source file is edited.

Inspect and plan:

- The `CheckoutAttempt` Prisma model and its `CheckoutAttemptStatus` enum
  (`PROCESSING`/`COMMITTED`/`FAILED` - `NOT_FOUND` is a synthesized query
  result, not a stored enum value, confirmed during the caller-cutover
  review).
- Existing repository conventions in this codebase (`CartRepository`,
  `OrdersRepository`) for the shape a new `CheckoutAttemptRepository`
  should follow.
- `createOrResume` atomicity - `ADR-007` recommends an atomic
  `prisma.checkoutAttempt.upsert` keyed on `idempotencyKey`, stronger than
  `CartRepository`'s existing find-then-create idiom, justified by the
  higher stakes of a duplicate checkout.
- Customer/cart/idempotency-key ownership validation - every lookup must
  cross-check `customerId`, never key-only (per `ADR-007` §Decision 1 and
  the security section of the original cutover plan).
- COMMITTED/FAILED/PROCESSING semantics and transitions.
- Heartbeat updates - one write, immediately after `checkoutMark` succeeds,
  not a periodic background ping.
- **The transaction-aware COMMITTED update with `orderId`** -
  `ADR-007`'s hard, non-negotiable requirement: this write must share the
  same Postgres transaction as order creation, never a separate
  post-transaction write.
- The stale-candidate keyset query for the future scheduler - paginated on
  `(lastHeartbeatAt, id)`, per `reservation-lifecycle.md` §10, not
  offset-based.
- Exact `CheckoutAttemptRepository`/`CheckoutAttemptService` result types.
- Unit test plan.
- Database integration test plan.
- Module placement (`CheckoutAttemptModule`, per `ADR-007`'s module
  architecture) and dependency direction.

**Explicitly excluded from Phase 16A.0-A**:

- `CheckoutCoordinatorService` implementation.
- `CartService` cutover.
- `PriceLockService`.
- Payment changes.
- Scheduler.
- Module registration into any production call path.
- Rollout flags.
- Legacy Redis drain.

## Do NOT do

- Do not begin any Phase 16A.0-A source-code edit before a plan is
  presented and explicitly approved.
- Do not say Phase 16A.0-A implementation has begun until the
  corresponding files have actually been edited.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s or
  `ADR-007`'s content into session files - reference them, don't restate
  them.
- Do not treat the checkout reservation engine (Units 2.4.1-2.4.4), the
  cart-scoped reservation engine (Units 2.1-2.3), or `ADR-007` itself as
  authorizing any caller wiring - all three remain fully additive and
  untouched by any production caller; do not assume otherwise or begin
  implementation without a separate, explicit approval.
