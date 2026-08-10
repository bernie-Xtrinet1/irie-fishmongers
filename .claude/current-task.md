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
  - ADR-007 Decision 6 (formula) and Decision 8 (`DRAINING` wording) were
    corrected in the same session, in a separate docs-only commit; a new
    §9 records the C2 implementation. ADR-007 `Status` remains
    `Proposed`, unchanged.

- **Phase 16A.0-C, Unit C3 is complete and pushed** at `7fddac0`
  (`feat(checkout): add reservation gateway facade`), on `origin/develop`.
  - **`ReservationGateway` is now the stable, cart-facing reservation
    abstraction** - a genuine TypeScript interface (`reserveForCart`,
    `releaseForCart`, `releaseCart`, `getCartAdmissionAvailability`), the
    first interface-typed DI seam in this codebase.
    `CheckoutReservationFacade implements ReservationGateway` and is the
    sole implementation. `RESERVATION_GATEWAY` (a `Symbol` token, bound
    via `useExisting`) is the **only** export from
    `CheckoutReservationModule` - the concrete `CheckoutReservationFacade`
    class is a provider but not exported, unreachable by any module that
    only imports `CheckoutReservationModule`.
  - **`CheckoutReservationModule` remains completely unwired** - not
    imported by `CartModule`, `AppModule`, or any other production
    module; `CartService` still calls `InventoryReservationsService`'s
    legacy methods directly, unchanged.
  - Reserve routing: `LEGACY`/`MIRROR` admit via legacy first (a thrown
    legacy exception propagates untouched, mirror never attempted);
    `CART_SCOPED` via the new engine only; `DRAINING` rejects all
    admission (reserve/increase/renew/any desired-quantity decrease)
    uniformly, with zero reads of current reservation quantity - no
    special-casing. Release routing: `LEGACY`/`MIRROR` release legacy
    first (mirror release best-effort, non-blocking); `CART_SCOPED` and
    `DRAINING` both release via the new engine only - **full cleanup
    stays allowed while `DRAINING`**, "no admission" and "no cleanup" are
    deliberately different rules.
  - `MirrorDiagnostic` (`SYNCED`/`NOT_ATTEMPTED`/`FAILED`) with a fixed
    `MirrorFailureReasonCode` union (`PRODUCT_SUSPENDED`,
    `CHECKOUT_IN_PROGRESS`, `ACCOUNTING_UNDERFLOW`,
    `UNKNOWN_INFRA_FAILURE` - no `REDIS_ERROR`, nothing in `RedisService`
    can produce one reliably today). `ACCOUNTING_UNDERFLOW` is
    structurally impossible to report as `SYNCED` - the underflow check
    runs before that branch. A thrown mirror exception never exposes the
    raw `Error`/message, only a structured log line.
  - `releaseCart(cartId, productIds)` takes caller-supplied product ids
    only (no Redis/catalog scan), deduplicates, preserves first-seen
    order, and resolves `ReservationEngineMode` **exactly once** for the
    whole call - every item uses identical routing semantics even if mode
    changes mid-call.
  - `getCartAdmissionAvailability` is a pure, unmodified delegation to
    `ReservationAvailabilityService` (C2) - no new arithmetic, no general
    (no-cart) availability method on this interface.
  - No `Cart`/`Product`/`PriceLock`/`CheckoutAttempt` persistence, no
    compensation ledger, no `operationId`/idempotency anywhere in the
    gateway/facade/diagnostic types - all deferred to later units.
    `customerId`/`cartId` ownership is documented as a caller
    precondition; C3 has no `CartRepository`/`ProductsRepository`/
    `PrismaService` dependency.
  - 43 new unit tests across 2 files (split to stay under the 400-line
    cap) plus 10 real-Redis tests (isolated logical DB 1). Full backend
    suite 228 -> 231 suites, 1926 -> 1971 tests, exit 0. Coverage
    97.36%/93.90%/97.08%/97.28% (80/90/90/90 threshold), exit 0.
    `checkout-reservation-facade.service.ts` and
    `reservation-gateway.types.ts` both at 100/100/100/100.
  - Real-Redis proof: a `MIRROR` accounting-underflow write (manufactured
    via the same stored-total-corruption technique Unit 2.3's own tests
    already use) leaves the legacy reservation correct and the customer
    result successful; `DRAINING` permits a full release to drain a
    genuine `CART_SCOPED`-era hold to zero.
  - ADR-007 gained a new §10 recording this implementation in the same
    session, in a separate docs-only commit. ADR-007 `Status` remains
    `Proposed`, unchanged.

- **Phase 16A.0-C4.0 is complete and pushed** at `8e2daaf`
  (`feat(checkout): extract shared error-message sanitizer`), on
  `origin/develop`.
  - `CheckoutAttemptService.sanitizeFailureMessage` extracted verbatim
    into `common/utils/sanitize-error-message.util.ts`
    (`sanitizeErrorMessage(message, maxLength)`), parameterized rather
    than hardcoded. `CheckoutAttempt` behavior is byte-for-byte unchanged
    - its complete pre-existing test suite passes without modification.
    This is now the approved, sole source for `lastError` sanitization
    across the codebase, including C4.1's compensation model.

- **Phase 16A.0-C4.1 is complete and pushed** at `0e97a5c`
  (`feat(checkout): add mirror compensation schema and repository`), on
  `origin/develop`.
  - **`CartReservationCompensation`**: the durable recovery record for
    `MIRROR`-mode divergence, created only when the legacy write already
    succeeded and the mirror write failed (`RESERVE_MIRROR` /
    `RELEASE_MIRROR`). `generation` is the sole concurrency counter (no
    separate `version` field) - `PROCESSING -> RESOLVED`/`-> PERMANENT_
    FAILURE` are conditioned on it matching what the claiming worker
    observed, so a newer divergence arriving mid-repair defeats a stale
    resolve and requeues instead of ever being lost.
    `blockedCheckCount` is tracked entirely separately from
    `attemptCount` - checking a `BLOCKED` precondition never consumes
    recovery-attempt budget. `Cart`/`Product` use `onDelete: Restrict`
    (matching `CheckoutAttempt`). No `correlationId`/`requestId` yet
    (deferred to C5/C6).
  - **Partial uniqueness** (one unresolved row per `(cartId, productId)`,
    independent of `operation`) is enforced **only** via a hand-added
    migration-SQL index, never a Prisma `@@unique` - verified via
    `migrate status`/`migrate diff --exit-code` reporting no drift and a
    real-Postgres `pg_indexes` assertion on the exact predicate.
    Historical `RESOLVED`/`PERMANENT_FAILURE` rows may coexist without
    limit for the same pair.
  - **`CompensationRepository`**: 11 primitive conditional-update
    methods, each one concrete state transition (matching
    `CheckoutAttemptRepository`'s convention). `claimForRecoveryAttempt`
    folds stale-`PROCESSING` reclamation (>5 minutes) into the same
    conditional update as an ordinary due-`PENDING` claim -
    contractual, not a fallback; a stale reclaim consumes a real
    attempt. `MAX_OPTIMISTIC_RETRIES = 3` defined at the repository
    level for C4.2's bounded `recordDivergence` loop to reuse.
    Deterministic unresolved-row lookup (`orderBy: createdAt asc`).
    Repository tests are seed-independent (upsert their own `Role` rows
    rather than depending on the application seed script).
  - **A pre-existing environment gap was found and fixed while validating
    this unit**: the local Postgres `Role` table was empty, which broke
    not just new C4.1 tests but the unmodified, already-shipped
    `products.repository.spec.ts` too. Fixed by running the existing,
    idempotent `npm run prisma:seed` script (no deletes, `role.upsert`
    only) - not a C4.1 code change, an environment-state fix.
  - 23 new tests. Full backend suite 231 -> 234 suites, 1971 -> 2003
    tests (incl. C4.0's 9 sanitizer tests), exit 0. Coverage
    97.39%/93.83%/97.10%/97.31% (80/90/90/90 threshold), exit 0.
  - **No `CompensationService`, reconciler, decorator, or scheduler
    exists yet** - additive and unwired, nothing outside this unit's own
    tests calls `CompensationRepository`.
  - ADR-007 gained a new §11 recording both C4.0 and C4.1 in the same
    session, in a separate docs-only commit. ADR-007 `Status` remains
    `Proposed`, unchanged.

- **Phase 16A.0-C4.2 is complete and pushed** at `943c913`
  (`feat(checkout): add mirror compensation divergence service`), on
  `origin/develop`.
  - **`CompensationService.recordMirrorDivergence`** is the sole writer of
    `CartReservationCompensation` rows: runtime-validated input (`Set`-
    backed `operation`/`reasonCode` membership checks, not just TS
    typing; `RESERVE_MIRROR` requires a non-null valid `customerId` and a
    positive-integer `desiredQuantity`; `RELEASE_MIRROR` requires both
    `null`), `sanitizeErrorMessage`-cleaned `lastError` (500-char cap),
    and a bounded optimistic-retry loop (`MAX_OPTIMISTIC_RETRIES = 3`)
    that retries on `P2002`, on a since-resolved existing row, and on a
    zero-row generation-advance update - exhaustion throws a plain
    internal-consistency error, never a normal result.
  - **Latest-wins arrival semantics, widened per correction**: a new
    divergence against an unresolved row overwrites `operation`,
    `customerId`, `desiredQuantity`, `reasonCode`, sanitized `lastError`,
    and `nextAttemptAt` (not just the originally-scoped
    `reasonCode`/`lastError`/`nextAttemptAt`) - avoids a
    self-contradictory row since dedup is keyed on `(cartId, productId)`
    alone, independent of `operation`. `BLOCKED` + `ACCOUNTING_UNDERFLOW`
    arrival stays `BLOCKED`; any other reason unblocks to `PENDING`.
  - Result type has no `currentGeneration` field by design - `generation`
    stays internal to the repository/recovery-worker relationship.
  - `MirrorCompensationModule` exports only `CompensationService`,
    declares no `imports` (`PrismaService` is available via the existing
    `@Global()` `PrismaModule`). `AppModule` imports it; **nothing else
    calls `CompensationService` yet** - fully additive and unwired.
  - 22 new tests across 3 files (unit + 2 real-Postgres, split for the
    400-line cap). Full backend suite 234 -> 237 suites, 2003 -> 2025
    tests, exit 0. Coverage 97.43%/93.97%/97.12%/97.35% (80/90/90/90
    threshold), exit 0.
  - **`_prisma_migrations` incident root-caused and confirmed by
    reproduction** (not left as correlation): `prisma migrate diff
    --shadow-database-url` pointed at the same URL as the live target
    resets/replays that target as scratch space without ever writing
    `_prisma_migrations`, silently wiping data and migration history
    while leaving the schema structurally correct. Reproduced against a
    disposable database only (created and dropped for the test); the
    shared dev database was never touched during either the original
    diagnosis or this reproduction. Repair (31x `prisma migrate resolve
    --applied`) remains a proposal only, explicitly deferred to a
    separate maintenance task requiring its own approval - not performed
    in C4.2. Full account in ADR-007 §12.
  - ADR-007 gained a new §12 recording this implementation and the
    confirmed incident in the same session, in a separate docs-only
    commit.

- **Phase 16A.0-C4.3 is complete and pushed** at `4c139b4`
  (`feat(checkout): add mirror compensation desired-state reconciler`),
  on `origin/develop`.
  - **`CompensationReconciliationService.attemptRecovery`** and
    **`CompensationBlockedRecheckService.recheckBlocked`** are the
    recovery layer consuming `CartReservationCompensation` rows. Desired
    state is authoritative from *current* `Cart`/`CartItem` truth (read
    via `CartRepository.findById` + the new
    `CartRepository.findItemByCartAndProduct(cartId, productId)`) -
    `compensation.operation`/`customerId`/`desiredQuantity` remain
    historical diagnostics only, never replay instructions.
  - **`CompensationBlockReason`** (`PRODUCT_SUSPECT` | `MODE_NOT_ADMITTING`)
    is a new, separate enum/column from `CompensationReasonCode` -
    additive migration `20260809171336_add_compensation_block_reason`,
    drift-verified against a genuinely separate disposable shadow
    database. `blockReason` clears to `null` on every path leaving
    `BLOCKED`.
  - **`CompensationRepository` gained**: `blockIfGenerationMatches`
    (establishes `BLOCKED`, generation-gated), `requeueAfterAttemptIfGenerationMatches`
    (replaces an earlier ungated form - normal retry scheduling, also
    generation-gated), and `releaseStaleClaim` (intentionally **ungated**
    - releases a claim a generation-gated write has just proven stale,
    asserts no convergence; kept deliberately distinct from the
    generation-gated retry primitive).
  - **Mode policy**: `MIRROR`/`CART_SCOPED` converge to current durable
    state (`CART_SCOPED` additionally logs an invariant warning);
    `DRAINING` blocks reserve-shaped desired state
    (`blockReason: MODE_NOT_ADMITTING`) but allows release; `LEGACY`
    never recreates a reservation, always releases, resolving as
    `RESOLVED_NO_LONGER_NEEDED_LEGACY`.
  - **Retry budget**: `MAX_RECOVERY_ATTEMPTS = 5`, fixed backoff 30s/
    120s/600s/1800s, then `PERMANENT_FAILURE`. `BLOCKED` rechecks never
    consume `attemptCount`. Every generation mismatch (`resolve`/`block`/
    `retry-schedule`/`permanent-failure`) returns `REQUEUED_NEWER_DIVERGENCE`
    after a safe `releaseStaleClaim` release, never treated as failure.
  - 115 new tests across 5 new files (unit, mode-matrix, real
    Postgres+Redis integration). Full backend suite 237 -> 241 suites,
    2045 -> 2104 tests, exit 0. Coverage 97.50%/94.18%/97.17%/97.43%
    (80/90/90/90 threshold); `mirror-compensation/services` at
    100/100/100/100.
  - **Migration-history repair** (the previously-deferred 31x `prisma
    migrate resolve --applied`) was executed as its own explicitly-
    approved maintenance action during this session, verified via a
    full pre/post disposable-database structural comparison (zero
    differences) and confirmed no application data was reset. See
    ADR-007 §12 for the full account - this repair is now complete and
    should not be repeated.
  - **`CompensationReconciliationService`/`CompensationBlockedRecheckService`
    remain completely unwired** - no batch orchestrator, no scheduler,
    no decorator, no `CartService`/`ProductsService`/`OrdersService`
    wiring. `MirrorCompensationModule` remains unimported by `AppModule`.
  - ADR-007 gained a new §13 recording this implementation in the same
    session, in a separate docs-only commit.

## Next task: Phase 16A.0-C4.4 - compensation batch orchestration, read-only planning/contract confirmation first

Per the established phase sequence, the next session's scope is the
batch orchestrator that repeatedly invokes
`CompensationReconciliationService.attemptRecovery`/
`CompensationBlockedRecheckService.recheckBlocked` across many rows. As
with every prior unit, begin read-only: restate the current contract,
confirm scope boundaries, and produce a plan for explicit approval before
any implementation begins. See `.claude/next-session.md` for the exact
scope and explicit prohibitions.

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
