# Decisions

## Codespaces/demo troubleshooting (2026-07-30 reconciliation)

- **Local bundled demo images over a remote placeholder service.**
  Switched from `placehold.co` URLs (raster variant) to three PNGs
  committed at `apps/web/public/demo-products/`. Rejected keeping any
  remote placeholder dependency: it introduces external-service downtime,
  SVG-vs-raster `next/image` behavior, remote-domain allowlist
  maintenance, and outbound-network risk as ongoing demo failure modes.
  User explicitly approved this as "the reliable technical baseline";
  realistic licensed product photography is a deferred, separate content
  task - not a blocker on the current fix. [[worklog]]

- **Demo-container detection: explicit marker, not `/.dockerenv`.**
  Rejected `-f /.dockerenv` for scoping the `NEXT_PUBLIC_*` shell-unset
  guard because it matches ANY Docker container, not specifically this
  demo's devcontainer - it could erase intentional developer config in an
  unrelated container. Added `IRIE_DEMO_CONTAINER=true` as a project-owned
  marker in `.devcontainer/docker-compose.yml` instead; the guard checks
  `CODESPACES=true || IRIE_DEMO_CONTAINER=true`. On any other host, it now
  only warns and preserves the existing value.

- **Frontend `NEXT_PUBLIC_*` must never be set in docker-compose.**
  Established as a hard rule after diagnosing the storefront/admin CORS
  failures: Next.js gives `process.env` (container/shell) precedence over
  `.env.local`, so any `NEXT_PUBLIC_*` in compose silently overrides the
  environment-correct value `scripts/start-codespaces-demo.sh` generates,
  and no amount of clearing `.next` fixes it. Documented in
  `.devcontainer/README.md`'s new "How frontend env is resolved" section
  specifically so "clear the cache" stops being the reflexive wrong fix.

- **Frontend API-URL fallback: relative `/api/v1`, never an absolute
  localhost URL.** Changed the hardcoded fallbacks in `api-client.ts`,
  `next.config.js` (both apps), and `env.ts` from
  `http://localhost:3001/api/v1` to `/api/v1`, so a missing env var
  degrades safely to a same-origin path instead of silently shipping a
  `localhost` host in a bundle that will only work on the machine that
  built it.

- **Seed idempotency: per-product upsert, not "skip if any product
  exists."** The original demo seed's `count > 0 -> return` guard meant
  re-running `demo:seed` after a source fix (e.g. the image URL change)
  never touched existing rows. Changed to `findFirst` by
  `(vendorId, name)` -> `update` or `create`, so re-seeding always
  reconciles stale fields.

- **CI open-handle investigation: identify before attributing, don't
  suppress.** When a parallel test run printed a Jest worker-teardown
  warning, the explicit instruction was to find the exact handle and
  owning module via `--detectOpenHandles` before calling it a cause, and
  to prefer disabling scheduling under `NODE_ENV=test` over log
  suppression or `--forceExit` if a scheduler handle were implicated.
  Result: zero open handles were actually reported; no code change was
  made, since no leak was confirmed. This stands as the precedent for
  how to handle future "looks like CI noise" reports - reproduce and
  isolate first, never mute logs to make a report quieter.

- **CI-vs-Prebuilds scope discipline.** When the true failure turned out
  to be the GitHub-managed Codespaces Prebuilds pipeline
  (`GenerateManifest did not succeed`), the investigation was explicitly
  bounded to `.devcontainer/devcontainer.json` and `docker-compose.yml`
  review only - no test or application code was touched based on that
  error, since the earlier (incorrect) working theory had been the app
  CI workflow.

## Resolved: phase-17-uat-production-readiness branch treated as stale

- **The unmerged `phase-17-uat-production-readiness` branch
  (`e1b487b`, `cc9a766`, `68b5178`) is superseded by the restructured and
  renumbered roadmap created directly on `develop`. It must not be merged
  into `develop`.** Its useful content was reviewed and selectively
  incorporated into the new Phase 17 UAT plan
  (`docs/uat/phase-17-uat-production-readiness.md` on `develop` - a
  distinct file from the branch's own version of the same filename; the
  two share a name coincidentally, since the branch always called its UAT
  phase "17" and the corrected roadmap does too, just with a marketplace
  phase now inserted before it). The branch itself is left in place,
  unmerged and undeleted, as a historical record.

## Roadmap resequencing (2026-07-31): Marketplace Operating Model before UAT

- **Approved phase order (final): 16 = Jamaican Seafood Marketplace
  Operating Model, 17 = UAT & Production Readiness, 18 = AI Marketplace.**
  Explicit user rationale: "The Jamaican Seafood Marketplace Operating
  Model is a core pre-production requirement, not a post-release
  enhancement. Final UAT must validate the platform as it is actually
  intended to operate." The unmerged `phase-17-uat-production-readiness`
  branch's own numbering had UAT as "Phase 17" immediately after Phase 13,
  with no marketplace phase in between — that would have validated only
  the pre-marketplace transactional skeleton, not the vendor-daily-listing
  / available-today / platform-managed-pickup model the business actually
  intends to run. The old unstarted "AI Marketplace" phase (numbered
  informally as "16" only inside the now-retired `.claude/roadmap.md`)
  moves to the end, after both the new marketplace phase and UAT.

  This landed in two passes: an initial correction numbered the new
  phases 17 (Marketplace) / 18 (UAT) / 19 (AI), inserting the marketplace
  phase without renumbering UAT's existing "17" out of the way. A
  follow-up correction closed that gap - there is no completed historical
  Phase 16 to preserve, since the informal old ".claude/roadmap.md" "16"
  was never implemented - producing the final continuous sequence above
  (13/14/15 unchanged, 16/17/18 for the three new/renumbered phases, no
  gap, nothing after 18). Every design document, ADR, and the UAT plan
  were mechanically renumbered to match; see [[worklog]] for the file
  list and the specific line-wrap edge cases caught during verification.

- **`.claude/roadmap.md` and `.claude/project-status.md` retired to short
  pointers; `docs/roadmap.md` is now the sole authoritative roadmap.**
  Both `.claude` files had drifted from actual `develop` state (frozen
  before Phase 13 shipped; used a different, informal phase-numbering
  scheme for Notifications/Analytics/AI Marketplace than `docs/roadmap.md`
  ever did) and were creating exactly the "duplicate roadmap authority"
  risk the reconciliation check was run to catch. Full historical detail
  from both files remains recoverable via `git log -- .claude/roadmap.md`
  / `.claude/project-status.md`; nothing was deleted from history, only
  from the working copy going forward.

- **Phase 13/14/15 status corrected in `docs/roadmap.md` before adding new
  phases**, verified against actual code/tests in this session (not
  trusted from either stale status doc): Phase 13 Customer Trust COMPLETE;
  Phase 14 Notifications COMPLETE (module + 15 specs, email/push adapters,
  SMS correctly deferred); Phase 15 Analytics COMPLETE (backend
  `AnalyticsModule` + 5 admin-dashboard screens, all with passing tests -
  17 tests across vendor-dashboard/sales/delivery/inventory-analytics
  components) with one recorded documentation gap (5 analytics endpoints
  missing from `docs/api-spec.md` - tracked as a close-out task, not
  treated as a code gap; no analytics application code changed).

- **New Phase 16 design docs reuse existing domain models, not new ones,
  except where an ADR justifies a genuine gap.** ADR-005 extends `Species`
  with catalogue-only fields (alternative names, reference image, typical
  weight range) and adds `Product.speciesId`, rather than a parallel
  catalogue model - avoids duplicating `Species`'s existing regulatory/
  seasonal fields as a second source of truth. ADR-006 creates a new
  `CustomerCollection` model (QR/PIN verified customer pickup) kept
  structurally separate from the existing `Delivery` model - a customer
  self-collecting is not a driver-executed delivery leg, and forcing both
  through one model risks driver-assignment/route-optimization logic
  accidentally touching customer-collection rows. Rejected generalizing
  `Delivery` into an abstract fulfillment-event model as premature
  abstraction for a benefit (unified reporting) Phase 15's existing
  Analytics can already achieve via a query-time join.

  **Superseded/final**: the ADR-005 summary above describes the *first*
  round of that design, before four further rounds of correction. **ADR-005
  is now Accepted** (commit `d22afe4`) with a materially different final
  shape: a new `SeafoodCatalogueItem` is the catalogue identity, joined to
  `Species` via a `CatalogueItemSpecies` **join table** (not a direct
  `Species` extension - a single-species FK cannot represent a mixed pack,
  and a regulated component could hide inside one undetected); **`Species`
  remains the sole biological and regulatory authority**, unchanged by this
  ADR; `Product` unchanged in shape
  and vendor scope, gaining a nullable `catalogueItemId` and a three-state
  `inventoryMode`; a new `VendorDailyListing` (not `Product` itself) as the
  actual dated, priced, expiring stock, with multiple simultaneously active
  per `Product` supported; `Product.quantityAvailable` demoted to a
  best-effort, non-authoritative compatibility projection; customer-facing
  aggregation corrected to the catalogue-item level (cross-vendor), never
  the product level (one vendor per `Product`, so it can never represent
  multiple sellers). See the ADR itself for the full accepted design.

- **This was a documentation-only change set.** No application code, no
  Prisma schema, no migrations were touched. See [[current-task]] and
  [[next-session]] for what is queued once these docs are committed.

## Phase 16A.0 (Cart Price Integrity) - permanent decisions (2026-07-31)

- **One cart uses one currency.** `Cart.currency` (nullable) is established
  by the first item to acquire a price lock and must match on every later
  add; a mixed-currency add is rejected outright, not merged or converted.
  Rejected supporting genuine multi-currency carts as a materially larger
  problem (conversion, split payment capture, mixed-currency totals) than
  this phase's scope - a customer can use separate carts/sessions per
  currency/region if that's ever needed instead.
- **A valid customer price lock survives an ordinary vendor price change
  until the lock's own expiry.** A vendor changing `Product.price` never
  invalidates an already-issued, still-valid lock - that protection is the
  entire purpose of locking. The customer only sees a different price once
  their own lock naturally expires and they return to the cart.
- **Price locking never guarantees stock availability.** Locking concerns
  price only. Purchasability (active, food-safety-clear, vendor approved)
  and durable stock sufficiency are always checked live at checkout
  regardless of lock state - a locked price is not a promise the item is
  still purchasable.
- **Checkout must validate both the price lock and the Redis reservation
  independently.** They are separate timers (reservation renews on
  quantity-change, the lock does not), so a valid reservation can coexist
  with an expired lock and vice versa. A valid lock alone must never be
  sufficient to authorize checkout - reservation existence, cart ownership,
  and reserved-quantity match are checked as their own, independent gates.

## Phase 16A.0 (Cart Price Integrity) - reservation timing (2026-07-31, approved)

- **Rolling reservation TTL is 15 minutes** (`RESERVATION_TTL_SECONDS = 900`),
  renewed on quantity-changing operations, never on a plain cart view.
- **Absolute maximum reservation lifetime for ordinary retail is 60 minutes**
  (`MAX_RESERVATION_LIFETIME_SECONDS = 3600`), measured from the
  reservation's original creation and never extended by renewal:
  `expiresAt = min(now + 900, absoluteExpiresAt)`.
- **No wholesale exception exists in Phase 16A.0.** No current
  classification distinguishes a wholesale/bulk order from an ordinary
  retail one; a longer-hold exception is deferred until such a
  classification is confirmed, not built speculatively now.
- **Price locks never renew automatically.** Only creation or explicit
  customer reconfirmation writes `priceLockedAt` - a quantity change alone
  never touches it. Because the reservation renews independently of the
  lock, a valid reservation can temporarily coexist with an expired lock;
  checkout treats the two as independent, both-required conditions.

## Phase 16A.0 (Cart Price Integrity) - product reservation accounting (2026-08-02, approved)

- **Cart-scoped reservation accounting (Commit Unit 2.3) remains additive
  and unwired until a separately approved, coordinated cutover.**
  `reserveOrRenew`, `releaseReservation`, `getActiveReservation`,
  `getReservedTotalExcludingCart`, `computeAvailableToPurchase`, and
  `reconcileProductReservedTotal` exist and are fully tested (including
  against real Redis), but no production caller (`CartService`,
  `OrdersService`, `ProductsService`) references them - the legacy
  per-product-hash methods (`reserve`, `release`, `getReservedByOthers`,
  `getAvailableToPurchase`) remain the only code path actually exercised in
  production. Cutover happens in its own later commit, gated by the
  checkout maintenance window already described in
  `docs/architecture/reservation-lifecycle.md` §8, not silently as a side
  effect of building the new engine.
- **Product reserved-total underflow must never be silently clamped.** If
  a release/consumption-type Redis mutation would subtract more than the
  stored product reserved-total currently holds, this is an invariant
  violation, not a number to round to zero. The specific reservation
  mutation still succeeds; the aggregate total's arithmetic is skipped;
  the product is flagged for urgent reconciliation. See
  `docs/architecture/reservation-lifecycle.md` §5 for the full
  `RESERVATION_TOTAL_UNDERFLOW` contract.
- **Undercount drift is fail-closed until reconciliation repairs and
  verifies the total.** A reconciled product reserved-total found lower
  than the true calculated total is a live overselling risk, not a
  harmless discrepancy - `getAvailableToPurchase` returns `0` for that
  product from the moment underflow or undercount is detected until a
  reconciliation run repairs the value and confirms it matches before
  clearing the suspension. Overcount drift (stored higher than true) is
  the opposite, safe direction and is repaired routinely without
  suspending admission. See `docs/architecture/reservation-lifecycle.md`
  §7.
- **Redis Cluster migration is prohibited until a separately approved
  reservation-sharding/orchestration design exists.** Phase 16A.0's Lua
  scripts atomically combine cart-tagged and product-tagged keys, which is
  only valid because the current deployment is a single, non-cluster
  Redis instance. See `docs/architecture/reservation-lifecycle.md` §12 for
  the four named alternatives a future Cluster migration would need to
  choose between.

## Phase 16A.0 (Cart Price Integrity) - checkout reservation recovery (2026-08-05, approved)

- **`ReservationUnderflowDetails` is an inventory-accounting shared type,
  not a checkout-specific type.** It lives in the neutral
  `reservation-accounting.types.ts`, not in
  `checkout-reservation-state.types.ts` - `InventoryReservationsService`
  must never depend on a checkout-specific types module.
- **`checkoutRevert` and `finalizeCheckoutConsumption` use two-pass,
  best-effort per-item recovery.** Pass 1 classifies every cart-index
  member with zero writes; Pass 2 mutates each classified bucket
  independently - one corrupted/unresolvable entry never blocks another
  product's independently-resolvable outcome in the same call.
- **Malformed and unsupported-version entries preserve evidence and set
  suspect state.** Never guessed, never deleted, never silently repaired.
- **Missing reservation entries are silent stale-index cleanup.** A
  cart-index member with no backing reservation key has its membership
  removed but is never reported in any result array or exposed in any
  API.
- **`underflow` is an array (`ReservationUnderflowDetails[]`), never a
  single nullable object**, because multiple products may independently
  underflow within one whole-cart recovery call - a single-object shape
  would silently drop all but one occurrence.
- **`admissionSuspended` is true whenever malformed, version-mismatch, or
  underflow handling sets suspect state** - computed as the OR of all
  three conditions, never from `underflow.length` alone.
- **Duplicate `checkoutRevert`/`finalizeCheckoutConsumption` calls are
  naturally idempotent by construction.** No explicit duplicate-detection
  branch exists; a repeat call's Pass 1 simply finds nothing left in the
  matching-key-pending bucket to act on.

## Phase 16A.0 (Cart Price Integrity) - checkout-pending reconciliation orchestration (2026-08-06, approved)

- **A durable `COMMITTED` attempt finalizes without inspecting Redis lease
  state.** `finalizeCheckoutConsumption` is called unconditionally - the
  durable record is already the authority that the checkout succeeded.
- **A durable `FAILED` or `NOT_FOUND` attempt reverts without inspecting
  Redis lease state.** `checkoutRevert` is called unconditionally in both
  cases - there is nothing a Redis read could add to that decision.
- **`PROCESSING` applies hard-ceiling-first recovery.** The 600-second
  hard pending ceiling is checked before any other `PROCESSING` condition,
  using both the Lua-detected `hardLimitViolationProductIds` and an
  independent cart-wide check against the earliest `checkoutPendingAt`
  across the complete cart - neither signal alone is trusted exclusively.
- **Only a complete, uniformly owned cart with an expired Redis lease and
  a fresh durable heartbeat may be resynchronized.** `extendCheckoutLease`
  is the one dependency call attempted only when lease-state already
  indicates a realistic chance of success; every other condition reverts
  directly.
- **Unsafe or incomplete Redis state reverts directly, without attempting
  an extension.** Missing/malformed/version-mismatched/active/
  conflicting-key members, or `found: false`, are never resynchronized -
  `extendCheckoutLease` would reject all of them deterministically anyway,
  so reconciliation skips the guaranteed-to-fail round trip and reverts
  immediately.
- **An unexpected `INVALID_INPUT` from a sibling service is an internal
  contract failure, not a normal outcome.** `CheckoutPendingReconciliationService`
  always validates its own arguments before calling a dependency, so a
  dependency rejecting them anyway signals a bug in this service's own
  argument construction - it throws, is never mapped to `REVERTED`, and is
  never retried.
- **A future durable heartbeat timestamp is invalid input**
  (`durableLastHeartbeatAt > now` -> `INVALID_INPUT`), rejected before any
  dependency call.
- **`CheckoutPendingReconciliationService` remains unwired and
  scheduler-free until a separately approved integration unit.** It takes
  durable state as plain input parameters; nothing in the checkout
  reservation engine reads or writes `CheckoutAttempt`, and no `@Cron`
  caller exists yet.
