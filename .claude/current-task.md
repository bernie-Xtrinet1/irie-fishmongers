# Current Task

Current phase: **Phase 16A.0 - Cart Price Integrity** (remains active)

## Status

- **Commit Unit 1 completed and pushed** at `57c73b4` - additive Prisma
  schema (`Cart.currency`, `CartItem.lockedUnitPrice`/`lockedCurrency`/
  `priceLockedAt`, `Order.currency`, `OrderItem.currency`) and the new
  `CheckoutAttempt` model/enum.
- **Unit 2.1 completed and pushed** at `c757bdd` - `RedisService.eval()`/
  `loadScript()`/`evalsha()`/`runScript()` (NOSCRIPT reload-and-retry).
- **Unit 2.2 completed and pushed** at `393c970` - cart-scoped reservation
  key helpers (`reservationKey`, `isLegacyReservationKey`/
  `isCurrentReservationKey`, `cartIndexKey`/`productIndexKey`/
  `productTotalKey`/`productSuspectKey`) and timing/version constants.
- **Unit 2.3 completed and pushed** at `a27cb65` - additive cart-scoped
  reservation accounting: `ReservationEntry` (version 1), atomic
  `reserveOrRenew`/`releaseReservation` Lua scripts (cart index + product
  index + product reserved-total maintained together, fail-closed
  underflow handling - never clamped), `getActiveReservation` (malformed/
  version-mismatch handling, expired-entry self-heal), cart-aware
  availability (`getReservedTotalExcludingCart`/`computeAvailableToPurchase`,
  correct empty-cart-context handling), and atomic
  `reconcileProductReservedTotal` (NO_DRIFT/OVERCOUNT/UNDERCOUNT, suspend-
  before-repair-verify-before-clear). Validated against real Redis 8.8.0
  (18/18 scenarios) and the full backend suite (192/192 suites, 1501/1501
  tests, CI-equivalent coverage 96.79/91.83/96.64/96.68 against an
  80/90/90/90 threshold).
- **Unit 2.4.1 completed and pushed** at `4db6018` - atomic checkout
  reservation marking (`checkoutMark`, `CHECKOUT_MARK_SCRIPT`, whole-cart
  validate-all-then-mutate-all).
- **Unit 2.4.2 completed and pushed** at `8c68f3b` - whole-cart
  checkout-pending lease inspection and extension
  (`getCheckoutPendingLeaseState`, `extendCheckoutLease`,
  `CheckoutLeaseStateService`).
- **Unit 2.4.3 completed and pushed** at `e907998` - checkout revert and
  final reservation consumption (`checkoutRevert`,
  `finalizeCheckoutConsumption`, `CheckoutReservationRecoveryService`,
  `CHECKOUT_REVERT_SCRIPT`, `FINALIZE_CHECKOUT_CONSUMPTION_SCRIPT`);
  relocated `ReservationUnderflowDetails` into the neutral
  `reservation-accounting.types.ts` so `InventoryReservationsService`
  never depends on a checkout-specific types module.
- **Unit 2.4.4 completed and pushed** at `ad89219` - durable
  checkout-pending reconciliation orchestration
  (`CheckoutPendingReconciliationService.reconcileExpiredCheckoutPending`):
  durable `PROCESSING`/`COMMITTED`/`FAILED`/`NOT_FOUND` state handling,
  hard-ceiling-first recovery, active-lease/resync/revert branching, and
  strict dependency-contract-error handling. Pure orchestration over
  `CheckoutLeaseStateService`/`CheckoutReservationRecoveryService` - no
  Redis calls of its own, no Prisma dependency.
- **The complete checkout reservation engine (Units 2.4.1-2.4.4) remains
  additive and unwired.** `CartService`, `OrdersService`, and
  `ProductsService` are untouched and still call the legacy
  per-product-hash methods (`reserve`, `release`, `getReservedByOthers`,
  `getAvailableToPurchase`), which remain fully active and behaviorally
  unchanged. See `.claude/decisions.md` for the explicit approved decision
  that this stays additive/unwired until a separately approved,
  coordinated cutover.
- **No scheduler or Prisma integration exists yet.**
  `CheckoutPendingReconciliationService` takes durable state as plain
  input parameters; nothing reads or writes `CheckoutAttempt`, and no
  `@Cron` caller exists anywhere in the checkout reservation engine.

- **Caller-cutover planning is complete.** A read-only investigation
  mapped the current `CartService`/`OrdersService`/payment/scheduler/module
  flows in full and produced a 19-section cutover plan, since revised after
  review.
- **ADR-007 is committed and pushed** at `15bbacf`
  (`docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md`)
  - records the approved architecture (`CheckoutAttemptRepository` ->
  `CheckoutAttemptService` -> `CheckoutCoordinatorService`,
  `CheckoutReservationFacade`, `PriceLockService`, PostgreSQL advisory
  locking for the future scheduler, the combined-availability formula) and
  the phased sequence A-H, with 11 open decisions each explicitly marked
  OPEN (with the phase it blocks) or RESOLVED.
- **Phase 16A.0-A is complete and pushed**, `5acbb4b`
  (`feat(checkout): add checkout attempt persistence`), `c8ccdf3`
  (`docs(architecture): record failure-message sanitization contract in
  ADR-007`), `b10da0b` (`chore(docs): close Phase 16A.0-A checkout attempt
  persistence session`) - all present on `origin/develop`.
  - Delivered: `CheckoutAttemptRepository` (`createOrGetByIdempotencyKey`
    with target-validated P2002 handling, `findById`, conditional
    `updateHeartbeatIfProcessing`/`markCommitted`/`markFailed`, keyset
    `findStaleProcessing`), `CheckoutAttemptService` (`createOrResume`,
    `updateHeartbeat`, `markCommittedInTransaction` - `tx` required, never
    defaulted, `markFailed` - sanitizes `failureMessage` rather than
    rejecting it, `findStalePage`), the narrow `CheckoutAttemptSummary`
    projection (excludes `failureMessage`), and the additive
    `[status, lastHeartbeatAt, id]` index (old two-column index untouched -
    confirmed via `pg_indexes`).
  - 66 new tests across 7 files (6 service/repository unit files + 1
    module-boundary structural file), full backend suite 1733 -> 1799,
    216 suites passing, `checkout-attempt.service.ts` at 100%
    lines/functions/branches.
  - Zero production wiring: confirmed via `git grep` that
    `CheckoutAttemptService`/`Repository`/`Module` appear nowhere outside
    `backend/src/modules/checkout-attempt/` except in documentation
    (`ADR-007`, `.claude/*.md`).
  - **`CheckoutAttempt` persistence remains completely unwired** -
    `CartService`/`OrdersService` still write nothing to it.
- **Phase 16A.0-B is complete and pushed**, `16fc405`
  (`feat(checkout): add price lock service`), plus this docs-closeout
  commit - present on `origin/develop`.
  - Delivered: standalone `PriceLockModule` (`PriceLockService`,
    `PriceLockRepository`) - `createPriceLock`, `reconfirmPrice`,
    `getPriceLockState`, `validateCartPriceLocks`. `PRICE_LOCK_TTL_SECONDS
    = 900` as an independent constant. `Product.currency` confirmed
    authoritative (a real per-row column). `Cart.currency` established
    atomically (`CartRepository.establishCurrencyIfCompatible`, one
    conditional `updateMany`) before any lock write. Existing-lock
    classification (COMPLETE valid/expired, the `Cart.currency` invariant,
    `PARTIAL` -> `PRICE_LOCK_STATE_INVALID`) always precedes any `Product`
    read - a duplicate `createPriceLock` call, or a race-loss winner
    reclassification, never re-consults vendor pricing. Only explicit
    `reconfirmPrice` may replace a `COMPLETE` lock.
  - 54 new tests across 7 files, full backend suite 1799 -> 1853, 222
    suites passing, `price-lock.service.ts` at 100% lines/functions/
    branches/statements. Global coverage 97.21/93.55/96.97/97.12 against
    an 80/90/90/90 threshold.
  - Real-Postgres concurrency proven: a two-currency race on a
    null-currency cart produces exactly one winner (loser's `CartItem`
    lock fields remain `null`); a same-`CartItem` create race produces
    exactly one `CREATED`/one `ALREADY_LOCKED` (winner's `priceLockedAt`
    never renewed).
  - Zero production wiring: confirmed via `git grep` that
    `PriceLockService`/`Repository`/`Module` appear nowhere outside
    `backend/src/modules/price-lock/` except a code comment in
    `cart.repository.ts` and documentation.
  - **`PriceLockModule` remains completely unwired** - `CartService` still
    reads `item.product.price` live and never calls `PriceLockService`;
    `OrdersService.checkout` still reads `item.product.price` live (twice)
    and hardcodes `currency: 'JMD'` at the payment-initiation call.
    Neither service was touched by Phase B.

- **Phase 16A.0-C, Units C0 and C1 are complete and pushed**: `357e35b`
  (`chore(inventory): register checkout reservation services`), `8978f03`
  (`feat(checkout): add reservation engine mode control`) - both on
  `origin/develop`.
  - **C0**: `InventoryModule` now registers/exports
    `CheckoutReservationStateService`, `CheckoutLeaseStateService`,
    `CheckoutReservationRecoveryService`, and
    `CheckoutPendingReconciliationService` - pure DI wiring, zero
    behavior change (verified via full `AppModule` bootstrap). **Still no
    production caller consumes any of them** - this only makes them
    reachable within `InventoryModule`'s own dependency graph for a
    future consumer that doesn't exist yet.
  - **C1**: `ReservationEngineModeConfig` (Postgres, append-only,
    `MarketplaceModeConfig`-shaped) + `ReservationEngineModeService` +
    `ReservationEngineModeConfigRepository`, in a standalone, unwired
    `ReservationEngineModeModule`.
    - Persisted modes: `LEGACY`, `MIRROR`, `CART_SCOPED`, `DRAINING` -
      `DRAINING` is a dedicated 4th enum value (never a reuse of
      `MIRROR`) representing "legacy authoritative, zero new writes to
      the new engine" during an in-progress rollback.
    - The full transition graph is enforced in
      `ReservationEngineModeService` (`VALID_TRANSITIONS`, no self-loops):
      `LEGACY<->MIRROR`, `MIRROR->CART_SCOPED`, `CART_SCOPED<->DRAINING`,
      `DRAINING->LEGACY` (gated). `CART_SCOPED->LEGACY` directly is
      structurally absent - not merely discouraged.
    - `setMode`'s entire read-validate-write sequence runs inside one
      Postgres transaction serialized by a transaction-scoped advisory
      lock (`pg_advisory_xact_lock(hashtext(...))`), closing the
      append-only-table concurrent-write race - proven with a real
      Postgres test where two racing transitions from the same starting
      mode produce exactly one winner and one `INVALID_TRANSITION` loser.
    - The `DRAINING -> LEGACY` rollback gate checks **two independent
      Redis signals** - aggregated product-total keys and the cart-scoped
      reservation index - and distinguishes a genuine outstanding hold
      (`ROLLBACK_BLOCKED`) from the two signals disagreeing
      (`ROLLBACK_STRUCTURE_DRIFT`, which takes priority and fails closed
      until reconciled).
    - `PrismaService` is injected into the service solely to open
      `$transaction`; every actual persistence call goes through
      `ReservationEngineModeConfigRepository` - confirmed via direct
      inspection.
  - 39 new tests across 4 files (service unit, repository real-Postgres,
    rollback gate real-Redis, mode-change real-Postgres concurrency). Full
    backend suite 226 suites / 1892 tests, exit 0. Coverage 97.26%
    statements / 93.66% branches / 97.00% functions / 97.18% lines
    (80/90/90/90 threshold), exit 0. `reservation-engine-mode.service.ts`
    at 100/100/100/100. `AppModule` bootstrap 4/4. Prisma validate/
    generate/migrate-status/drift all clean.
- **Phase 16A.0-C, Unit C2 is complete and pushed** at `a89aff8`
  (`feat(checkout): add mode-aware reservation availability`), on
  `origin/develop`.
  - **`ReservationAvailabilityService` is implemented and exported by
    `ReservationEngineModeModule`, but remains unwired** - no caller
    consumes it yet. Public surface: `getGeneralAvailability(productId,
    quantityAvailable)` (no cart context) and
    `getCartAdmissionAvailability(productId, quantityAvailable, cartId)`
    (own-cart add-back per mode). Depends only on
    `ReservationEngineModeService.getCurrentMode()` and
    `InventoryReservationsService`.
  - Corrected ADR-007 Decision 6's global `Available =
    Product.quantityAvailable - LegacyReserved - NewReserved` formula
    (unsafe under `MIRROR`'s dual-write, which double-subtracted the same
    logical hold) into a per-mode authority matrix: **`LEGACY` and
    `MIRROR` both admit via legacy only** (`MIRROR`'s new-engine read is a
    separate, non-blocking comparison that can never alter or block
    customer admission); **`CART_SCOPED` admits via the new engine only**
    (no legacy subtraction, own-cart add-back active, suspect-flag-gated);
    **`DRAINING` never admits** - returns a typed `MODE_NOT_ADMITTING`,
    never a numeric `0`, reading neither system.
  - `InventoryReservationsService` gained
    `getAvailabilityWithSuspectStatus(productId, quantityAvailable,
    excludingCartId)`, returning `{status:'OK', available} |
    {status:'SUSPECT'}`, sharing one private calculation path with the
    pre-existing `computeAvailableToPurchase` - whose contract is
    byte-for-byte unchanged (still collapses `SUSPECT` to `0`); no
    existing caller needed to change.
  - `MIRROR`'s comparison states: `AVAILABLE`, `COMPARISON_UNAVAILABLE`
    (the comparison read itself threw), `STRUCTURE_DRIFT_CONFIRMED` (the
    existing, already-persisted product suspect flag is set). C2 performs
    no synchronous per-request structural scan of its own.
  - Mechanical split: `inventory-reservations.service.ts` (380 lines)
    exceeded the 400-line cap after the refactor above; its three
    private, non-public-API script-result helpers
    (`flagMalformedReservation`, `toUnderflowDetails`,
    `parseScriptResult`) were extracted unchanged to
    `inventory-reservations-script-helpers.ts` (76 lines) - no behavior
    change, confirmed by the complete pre-existing test set (5 suites, 56
    tests) still passing.
  - 34 new tests across 2 new files (`reservation-availability.service.spec.ts`,
    `reservation-availability.redis.integration.spec.ts`) plus 5 new
    compatibility tests added to the existing
    `cart-scoped-availability-reconciliation.service.spec.ts`. Full
    backend suite 226 -> 228 suites, 1892 -> 1926 tests, exit 0. Coverage
    97.30%/93.75%/97.03%/97.22% (80/90/90/90 threshold), exit 0.
    `reservation-availability.service.ts` and
    `inventory-reservations.service.ts` both at 100/100/100/100.
  - Real-Redis proof: a genuinely mirrored duplicate hold (same quantity
    written to both the legacy hash and the cart-scoped model) is
    subtracted exactly once for customer-facing admission; a before/after
    keyspace snapshot proves the service performs no writes across any
    mode.
  - **No C3 work exists** - no `CheckoutReservationFacade`,
    `ReservationGateway`, or any `CartService`/`ProductsService`/
    `OrdersService` file was touched.
  - ADR-007 Decision 6 (formula) and Decision 8 (`DRAINING` wording) were
    corrected in the same session, in a separate docs-only commit; a new
    §9 records the C2 implementation. ADR-007 `Status` remains
    `Proposed`, unchanged.

## Next task: Phase 16A.0-C3 - checkout reservation facade / reservation gateway, read-only planning first

Per the approved sequencing, the next session inspects and designs (does
not implement) the `ReservationGateway` abstraction and
`CheckoutReservationFacade`'s mode-aware write routing
(`reserveForCart`/`releaseForCart`/clear-cart behavior across `LEGACY`/
`MIRROR`/`CART_SCOPED`/`DRAINING`), how the facade uses
`ReservationAvailabilityService`, `MIRROR` write semantics and
non-blocking mirror-failure handling, the compensation boundary, the
operation/idempotency inputs a later C5 will need, and the facade's
relationship to `CartService`/`PriceLockService` - without touching
`CartService`/`ProductsService`/`OrdersService`, without implementing the
compensation ledger or `addItem` idempotency, and without any production
mode switching. See `.claude/next-session.md` for the exact scope and
explicit prohibitions.

## Operational policy: Accepted (see `.claude/decisions.md`)

- Rolling reservation TTL 15 minutes; absolute ordinary-retail maximum 60
  minutes, never extended by renewal.
- Price locks never renew automatically.
- No wholesale exception in Phase 16A.0.
- One-cart-one-currency (`Cart.currency`, nullable).
- Checkout requires both a valid price lock **and** a valid Redis
  reservation, independently.
- Product reserved-total underflow must never be silently clamped;
  undercount drift is fail-closed until reconciliation repairs and
  verifies the total; Redis Cluster migration is prohibited until a
  separately approved design exists.
- Cart-scoped reservation accounting remains additive and unwired until a
  separately approved, coordinated cutover.

See "Next task" above for the exact scope of the next session's work.
