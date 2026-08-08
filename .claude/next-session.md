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
- Commit Unit 1 (`57c73b4`) through Phase 16A.0-A (`5acbb4b`/`c8ccdf3`/
  `b10da0b`) and Phase 16A.0-B (`16fc405` plus this session's docs
  closeout) are all present on `origin/develop`.

## Phase 16A.0-A and Phase 16A.0-B are both complete

`CheckoutAttemptRepository`/`CheckoutAttemptService` (Phase A) and
`PriceLockService`/`PriceLockRepository` (Phase B) both exist, are fully
tested, and remain **completely unwired** - `CartService` still reads
`item.product.price` live and never calls `PriceLockService`;
`OrdersService.checkout` still reads `item.product.price` live and
hardcodes `currency: 'JMD'`; neither service writes to `CheckoutAttempt`.
See `.claude/current-task.md` for the full delivery summary of both
phases.

## The next session begins READ-ONLY: Phase 16A.0-C gate resolution and cutover planning

**Do not implement Phase C yet.** This session's job is to inspect and
resolve ADR-007's remaining Phase C gates and produce an integration
plan - not to write `CheckoutReservationFacade` or any other Phase C/D
code.

Per ADR-007's Implementation sequence table, Phase C
(`CheckoutReservationFacade`, feature flags, shadow mode, combined
availability) is blocked on open decisions 1, 9, and 10 - **none resolved
yet**. Inspect and resolve:

1. **Redis-first vs. Postgres-first cart mutation sequencing** (open
   decision 1) - ADR-007 Decision 2 deferred this to Phase C's own
   shadow-mode comparison rather than deciding it upfront; determine what
   that comparison actually needs to observe.
2. **Exact ownership/location of the combined-availability bridge**:
   `Available = Product.quantityAvailable - LegacyReserved - NewReserved`
   - ADR-007 Decision 6 assigns this to
   `CheckoutReservationFacade.getAvailability`; confirm this is still
   correct against the actual current `CartService`/`ProductsService`
   call sites.
3. **Rollout-control mechanism** (open decision 10) - direction is
   settled (allowlist-based, per-request, not bootstrap-level), mechanism
   is not: environment feature flag vs. internal-account allow-list vs.
   request-scoped decision vs. a `MarketplaceModeConfig`-style persisted
   configuration table, plus what emergency rollback looks like.
4. **Whether shadow mode can safely compare old/new reservation
   calculations without dual-writing authoritative reservation state** -
   ADR-007 Decision 2/§"Dual-write ... is rejected" already forbids
   dual-write; confirm shadow mode's read-only comparison design doesn't
   quietly reintroduce it.
5. **Exact `CheckoutReservationFacade` responsibility and API** - ADR-007
   Decision 3 names the shape (`markCart`, `finalizeCart`, `revertCart`,
   `getAvailability`) in direction only; needs an exact method-by-method
   contract before implementation.
6. **How `PriceLockService` will later integrate with `CartService`
   without silently renewing price locks** - `PriceLockService` itself is
   done and unwired; this is specifically about the future integration
   call sites, not a `PriceLockService` change.
7. **Cart-empty currency reset** (`Cart.currency -> null` when the final
   `CartItem` is removed) - already an approved rule (see
   `.claude/decisions.md`), not yet implemented; this session should plan
   exactly where it lands in the eventual `CartService` integration, not
   implement it.
8. **Compensation behavior** when a Redis mutation succeeds but the
   Postgres cart mutation fails, or vice versa.
9. **Which cart mutation order should become authoritative** after
   shadow evidence is collected - not decided now, but the plan should
   state what evidence would settle it.

## Explicitly prohibited this session

- `CartService` source edits.
- `OrdersService` edits.
- `PriceLockService` edits, unless a genuine planning-time defect is
  discovered in it (not a preference change).
- `CheckoutCoordinatorService` implementation.
- Production feature-flag wiring.
- Scheduler implementation.
- Payment integration.
- Legacy Redis deletion.
- Any production cutover.

## Do NOT do

- Do not begin any Phase C/D source-code edit before a plan is presented
  and explicitly approved, matching the discipline used through Phase
  16A.0-A and 16A.0-B.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s or
  `ADR-007`'s content into session files - reference them, don't restate
  them.
- Do not treat Phase A/B (`CheckoutAttemptRepository`/`CheckoutAttemptService`/
  `PriceLockService`/`PriceLockRepository`) as authorizing any caller
  wiring - they remain fully additive and unwired; do not assume
  otherwise or begin implementation without a separate, explicit
  approval.

The session must return a read-only integration plan and wait for
approval before any implementation begins.
