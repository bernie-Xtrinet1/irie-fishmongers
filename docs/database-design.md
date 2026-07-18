Users
Vendors
Drivers
Products
Inventory
Orders
Payments
Deliveries
Reviews
Notifications

---

# Infrastructure (Phase 2)

- ORM: Prisma, schema at `backend/prisma/schema.prisma`, PostgreSQL datasource via `DATABASE_URL`.
- Cache/queue backend: Redis via `ioredis`, connection URL via `REDIS_URL`, wrapped by `RedisModule`/`RedisService` (`backend/src/common/redis`).
- Environment variables are validated at boot via `class-validator` (`backend/src/config`); the app refuses to start with missing/invalid config.
- `GET /api/v1/health` reports Postgres and Redis connectivity for local/CI/ops checks.
- Local dev (Windows): PostgreSQL runs as the `postgresql-x64-16` service; Redis runs as a Windows service named `IrieRedis` (portable Redis-for-Windows build wrapped with NSSM, since Memurai's MSI installer fails in this environment). Both auto-start on boot.
- Domain entities (Users, Vendors, Products, Orders, etc.) are added to `schema.prisma` module-by-module starting with Authentication (Phase 3), not all at once.

---

# Authentication Tables (Phase 3)

- `users` - id, email (unique), passwordHash, firstName, lastName, phone (optional),
  status (PENDING_VERIFICATION | ACTIVE | SUSPENDED | DEACTIVATED), email
  verification/password reset token hashes + expiries, timestamps.
- `roles` - id, name (CUSTOMER | VENDOR | DRIVER | ADMINISTRATOR, unique), seeded via
  `backend/prisma/seed.ts` (`npm run prisma:seed -w backend`).
- `user_roles` - join table (userId, roleId), unique per pair.
- `refresh_tokens` - id, userId, tokenHash (unique, SHA-256 of the raw token - the
  raw value is never stored), expiresAt, revokedAt, createdAt.

---

# Marketplace Tables (Phase - Marketplace, per .claude/marketplace-build-instructions.md)

- `vendors` - id, userId (unique, one profile per user), businessName,
  status (PENDING | APPROVED | SUSPENDED | REJECTED, default PENDING). This is the
  minimal profile needed for products to have an owner; full vendor management
  (dashboards, reports, storefront settings, documents) is a later phase.
  Expanded in the Vendor Management phase below with description, phone,
  parish, logoUrl, termsAcceptedAt.
- `categories` - id, name (unique), slug (unique). Seeded with Fish, Shellfish,
  Crustaceans, Mollusks via `backend/prisma/seed.ts`.
- `products` - id, vendorId, categoryId (onDelete: Restrict - a category with
  products can't be deleted), name, description, unit (PER_POUND | PER_KILOGRAM |
  PER_PACKAGE | PER_ITEM), price (Decimal(10,2)), currency (default "JMD"),
  quantityAvailable (Int, floor enforced at 0), imageUrl, isActive (soft
  delete/deactivate instead of hard delete).
  - "Availability" (ACTIVE | OUT_OF_STOCK | INACTIVE) shown to API consumers is
    computed from isActive/quantityAvailable, not stored.
  - Only APPROVED vendors may create products; any vendor may edit only their
    own products regardless of status.
  - Stock adjustment (`ProductsRepository.adjustStock`) is an atomic guarded
    UPDATE (the floor-at-zero check runs in the same SQL statement as the
    decrement via a WHERE clause, not a prior read), so concurrent checkouts
    racing for the last units can't both succeed and drive stock negative.
    Fixed as part of the Orders phase, which is the first thing that mutates
    stock concurrently.
  - Search ranking currently only accounts for availability (in-stock first);
    the vendor rating / distance / freshness factors from business-rules1.md's
    Search Rules require Reviews and Delivery Zones, which don't exist yet.

---

# Vendor Management (Phase 4, per .claude/marketplace-build-instructions.md)

Expands the minimal Marketplace-phase Vendor profile with:

- `description` (optional), `phone` (optional), `logoUrl` (optional).
- `parish` (required, `Parish` enum of Jamaica's 14 parishes per
  docs/reference/jamaica-delivery-zones.md - the authoritative parish/zone
  mapping). Zone grouping itself belongs to the later Delivery Zones phase;
  only the parish taxonomy is needed now.
- `termsAcceptedAt` (required, set at registration) - vendors must pass
  `acceptedTerms: true` to register; this satisfies business-rules1.md's
  "accept platform terms and conditions" requirement.

New endpoints:

- `PATCH /vendors/me` - vendor self-service update of business info (not
  status - that stays admin-only via the existing `PATCH /vendors/:id/status`).
- `GET /vendors` (admin only) - paginated list, optionally filtered by status,
  so admins can actually discover pending vendors to approve.
- `GET /vendors/:id/public` - public storefront view (id, businessName,
  description, parish, logoUrl only - never userId/phone/status/
  termsAcceptedAt). 404s unless the vendor is APPROVED.
- `GET /products/mine` (vendor only) - the vendor's own products including
  inactive ones, unlike the public search which only ever returns active
  listings.

Deliberately out of scope for this phase: identification/compliance document
upload (no S3/file storage pipeline exists yet - that belongs with a future
Food Safety/Compliance phase), and sales reporting (would be meaningless
zeros with no Orders/Payments data yet - belongs with Orders + Reporting).

---

# Orders Tables (Order Management phase, per Startup instructions.md - built
# ahead of the cross-vendor same-product Allocation Engine and Payments,
# which are their own later phases)

- `carts` / `cart_items` - one cart per customer (unique customerId),
  `[cartId, productId]` unique so adding the same product again increments
  quantity instead of duplicating a row. Cart contents are re-validated
  (active product, approved vendor) both when adding items and again at
  checkout, since a vendor/product could change status while sitting in cart.
- `orders` - the customer-facing aggregate. customerId, a delivery address
  snapshot (line1/line2/parish/phone - not a reusable saved address; that's a
  later "Advanced Commerce" roadmap item). No top-level status: an order's
  state is the union of its vendor orders' statuses (matches
  docs/architecture.md's "Customer sees: 1 Order. Platform manages: N Vendor
  Orders.").
- `vendor_orders` - one per vendor represented in the order. status
  (PENDING | ACCEPTED | PREPARING | READY_FOR_PICKUP | ASSIGNED_TO_DRIVER |
  IN_TRANSIT | DELIVERED | REJECTED | CANCELLED) matches business-rules1.md's
  documented workflow exactly, but only PENDING->ACCEPTED/REJECTED/CANCELLED,
  ACCEPTED->PREPARING, and PREPARING->READY_FOR_PICKUP are reachable right
  now (enforced by `VendorOrdersService`'s transition table) - the driver/
  delivery states exist in the schema for forward compatibility but nothing
  can transition into them until the Delivery phase exists.
- `order_items` - a snapshot of productName/unitPrice/unit/quantity/subtotal
  at order time, so historical orders stay accurate even if the vendor later
  edits or reprices the product.

Business rules encoded here:

- Checkout is all-or-nothing: if any cart item is inactive, its vendor isn't
  APPROVED, or stock is insufficient, nothing is created and nothing is
  decremented (the whole thing runs in one `prisma.$transaction`).
- A multi-vendor cart splits into one `vendor_orders` row per vendor
  automatically - this is the simple "cart already references specific
  vendor-owned products" split, not the fancier cross-vendor
  same-product-demand allocation described in the multi-vendor fulfillment
  rules doc (50lbs snapper split 20/15/15 across three vendors selling the
  same species) - that's the explicitly separate, later Allocation Engine
  phase per Startup instructions.md.
- Cancellation (business-rules2.md): only while a vendor order is PENDING -
  once ACCEPTED the seafood is considered reserved/perishable and cannot be
  cancelled. Cancelling and rejecting both restore the reserved stock via the
  same atomic `adjustStock`.
- Payment verification is now enforced (see Payments Tables below):
  `CheckoutDto.paymentMethod` is required, and a vendor cannot accept an order
  paid through an online provider until that payment is confirmed PAID.

---

# Payments Tables (Payments phase)

- `payments` - one per order (`orderId` unique - `Order.payment` is a 1:1
  back-relation). provider (WIPAY | CASH_ON_DELIVERY), status (PENDING | PAID |
  FAILED | REFUNDED | PARTIALLY_REFUNDED, default PENDING), amount
  (Decimal(10,2)), currency (default "JMD"), providerReference (the gateway's
  transaction id, or a synthetic `cod-{orderId}` for cash-on-delivery),
  failureReason, paidAt. Only transaction ids/authorization references and
  status are ever stored - never card numbers or CVVs (security.md,
  business-rules1.md Payment Rules).
- `refunds` - one row per refund attempt against a `payments` row (a payment
  can have several partial refunds). amount, reason, status (PENDING |
  COMPLETED | FAILED), providerReference. A payment's refundable balance is
  `amount - sum(refunds where status = COMPLETED)`; refunds are rejected if
  they would exceed it.

Business rules encoded here:

- Provider abstraction (docs/integrations/ADR-001-payment-provider-selection.md):
  `OrdersService`/`VendorOrdersService` never call a payment gateway directly -
  only through `PaymentsService`, which delegates to whichever
  `PaymentProviderAdapter` matches `Payment.provider`
  (`backend/src/modules/payments/interfaces/payment-provider.interface.ts`).
  Adding a new provider (Stripe, Lynk) means writing one adapter, not touching
  Orders/Vendors.
- Checkout (`OrdersService.checkout`) creates the `orders`/`vendor_orders`
  rows in one DB transaction, then - once that transaction has committed -
  calls `PaymentsService.initiatePayment` outside the transaction, since it
  may involve an external HTTP call (WiPay's hosted-checkout `request`
  endpoint) that shouldn't hold a DB transaction open.
- Vendor acceptance gate: `VendorOrdersService.accept` calls
  `PaymentsService.assertReadyForFulfillment(orderId)` before allowing
  PENDING->ACCEPTED. Cash-on-delivery orders are never blocked (nothing to
  verify yet); online-provider orders are blocked until their payment is PAID.
- Vendor rejection refund: `VendorOrdersService.reject` restores stock as
  before, then calls `PaymentsService.refundForOrder` with that single vendor
  order's subtotal - a multi-vendor order where only one vendor rejects only
  refunds that vendor's share, not the whole order (business-rules2.md:
  "Vendor rejects order" is a full-refund-eligible reason, scoped here to the
  rejected portion). A no-op if that order was never paid.
- WiPay payment confirmation is webhook-driven, not polled:
  `POST /payments/webhooks/wipay` verifies an HMAC-SHA256 signature (keyed
  with `WIPAY_API_KEY`) over the exact raw request bytes (`main.ts` enables
  `rawBody: true` so the raw buffer survives past body-parsing) before
  trusting the payload.
- Cash-on-delivery has no external gateway to poll or webhook from, so an
  admin confirms collection manually via `PATCH /payments/:id/mark-paid`
  (admin only, audit-logged like all admin actions per security.md).
- `POST /payments/:id/refund` (admin only) covers business-rules2.md's
  "Administrator-approved exceptional circumstances" partial-refund case,
  independent of the automatic vendor-rejection refund above.
- The WiPay adapter's request/response shape (`account_number` + `total` +
  `currency`, HMAC-signed callbacks) follows WiPay's standard hosted-checkout
  integration pattern but has not been verified against a live WiPay merchant
  sandbox - field names and endpoint paths should be confirmed before
  production use.

---

# Delivery Tables (Delivery phase, per .claude/commands/build-delivery.md)

- `drivers` - id, userId (unique, one profile per user), licensePlate,
  vehicleType (MOTORCYCLE | CAR | VAN | TRUCK), status (PENDING | APPROVED |
  SUSPENDED | REJECTED, default PENDING - mirrors the Vendor approval
  workflow, since drivers handle cash-on-delivery collection and customer
  delivery addresses/phone numbers). Only APPROVED drivers may browse
  available deliveries, claim one, or report GPS location.
- `deliveries` - one per `vendor_orders` row (`vendorOrderId` unique), not
  one per customer `orders` row: each vendor portion of a multi-vendor order
  is picked up and delivered independently, matching the existing
  `vendor_orders` granularity already established in the Orders phase rather
  than inventing a second, parallel status machine. driverId, assignedAt
  (default now), pickedUpAt/deliveredAt/failedAt (nullable timestamps -
  whichever is set determines the delivery's current stage), failureReason,
  proofType (SIGNATURE | PHOTO), proofUrl.
- `driver_locations` - append-only GPS ping history. driverId, latitude,
  longitude, recordedAt. Never updated or deleted; tracking always reads the
  most recent row for a driver.
- `vendor_orders.status` gains a `DELIVERY_FAILED` value (business-rules2.md's
  Failed Delivery Policy: a failed delivery is fulfilled-but-undelivered, not
  refund-eligible like REJECTED/CANCELLED, so it needs its own terminal
  state).

Business rules encoded here:

- Single authoritative status machine: `VendorOrder.status` remains the one
  place delivery progress is recorded (no duplicate status field on
  `deliveries`). `DeliveriesService` owns the driver-controlled slice of the
  transition graph (READY_FOR_PICKUP -> ASSIGNED_TO_DRIVER -> IN_TRANSIT ->
  DELIVERED/DELIVERY_FAILED) the same way `VendorOrdersService` already owns
  the vendor-controlled slice (PENDING -> ACCEPTED -> PREPARING ->
  READY_FOR_PICKUP) and `OrdersService` owns the customer-cancellation slice -
  three services, one shared `VendorOrdersRepository.updateStatus`, no
  duplicated transition logic.
- Assignment is driver-initiated ("claim," not admin dispatch): any APPROVED
  driver can claim any READY_FOR_PICKUP vendor order with no existing
  delivery via `POST /delivery/assign`. A driver may only have one active
  (not yet delivered or failed) delivery at a time - claiming a second one
  while the first is still open is rejected, since there is no fleet/route
  consolidation engine yet (deferred, see below).
- Driver-facing "available" listings (`GET /delivery/available`) intentionally
  omit the customer's delivery address/phone - business-rules1.md: "Drivers
  may only access assigned deliveries" / "information required for delivery."
  Full delivery-address details only appear once a driver has actually
  claimed that vendor order.
- Proof of delivery is required to mark a delivery DELIVERED (business-rules1.md:
  "Proof of delivery is required"; driver-settlement-engine.md: "Driver
  compensation may only be generated when ... Proof Of Delivery exists" - not
  itself implemented yet, but the data model captures it now so settlement
  doesn't need a schema change later).
- Customer tracking (`GET /delivery/track/:vendorOrderId`) only exists once a
  Delivery row exists (i.e., a driver has claimed that vendor order); earlier
  stages (PENDING/ACCEPTED/PREPARING/READY_FOR_PICKUP) are already visible via
  the existing `GET /orders/:id`. `DeliveryModule` deliberately has no reverse
  dependency on `OrdersModule` beyond reusing `VendorOrdersRepository` (mirrors
  the Payments-phase precedent of keeping module dependencies one-directional)
  - delivery/tracking info is not embedded into `OrderResponseEntity`.

Deliberately out of scope for this phase (tracked in the ADRs/engine docs but
not yet built):

- Delivery zones, fleet assets, and route consolidation
  (docs/integrations/ADR-002-delivery-zones.md, fleet-management-engine.md) -
  the "one truck per zone" fleet strategy and cross-vendor route planning are
  a future logistics-scaling initiative, not needed while assignment is
  driver-claim-based with no fleet to schedule. **Built in the Phase 10
  zones/fleet/logistics pass below** - see "Delivery Zones, Fleet & Logistics
  Tables" further down this file.
- Driver compensation/settlement calculations
  (docs/integrations/driver-settlement-engine.md) - a separate later phase;
  this phase only captures the data (proof of delivery, timestamps) that
  settlement will eventually need. **Built in the Driver Settlement Tables
  section immediately below.**
- Cold-chain temperature logging (docs/compliance/cold-chain-requirements.md) -
  belongs to the Food Safety/Compliance phase. **Built in the Food Safety /
  Compliance Tables section below; extended with two more checkpoints in the
  Phase 10 pass.**

---

# Driver Settlement Tables (Driver Settlements phase, per
# docs/integrations/driver-settlement-engine.md)

- `driver.vehicleOwnership` (new field, `VehicleOwnership` enum:
  PERSONAL_VEHICLE | COMPANY_VEHICLE) - a driver's ownership model (who
  absorbs fuel/maintenance/insurance), distinct from the existing
  `vehicleType` (MOTORCYCLE | CAR | VAN | TRUCK, the physical vehicle body
  type from the Delivery phase). Ownership model determines which
  compensation formula applies. Required at driver registration going
  forward; defaults to PERSONAL_VEHICLE for the column itself so the
  migration applies cleanly.
- `settlement_rate_configs` - append-only: publishing new rates creates a new
  row rather than mutating one in place; "current" is always the most
  recently created row (`findFirst({ orderBy: { createdAt: 'desc' } })`).
  Past `driver_settlements` rows store their own computed dollar amounts, so
  they're never retroactively affected by a later rate change. Seeded with
  the driver-settlement-engine.md example figures (base fee JMD 150, distance
  rate JMD 20/km, heavy-load threshold 50 lbs / bonus JMD 200, volume bonus
  tiers 20/40/60 deliveries -> JMD 1,000/3,000/5,000). The peak bonus amount
  (JMD 100) has no example figure in the source doc - it's a configurable
  placeholder, adjustable via `POST /driver-settlements/rate-config` without
  a schema change (satisfies the doc's "must support dynamic pricing...
  without schema redesign" future requirement).
- `driver_settlements` - one row per completed `Delivery` (`deliveryId`
  unique, nullable), plus at most one extra row per driver per settlement
  period with `deliveryId` null for that week's shared volume bonus (a bonus
  isn't tied to any single delivery). Summing a driver's rows for a period
  gives their total weekly payout while every row stays an individually
  immutable, auditable unit - matches "never overwrite calculations, use
  immutable records" without needing a separate "volume bonus" side-table.
  `settlementPeriodStart`/`settlementPeriodEnd` replace the source doc's
  single opaque `settlement_period` string with queryable DateTime bounds.
  `vehicleOwnership` is snapshotted onto each row at generation time, so a
  driver later changing ownership model doesn't retroactively alter historical
  settlements.

Business rules encoded here:

- `DriverSettlementEngine` (backend/src/modules/driver-settlements/services/driver-settlement-engine.service.ts)
  is the sole place compensation math happens, per the doc's Implementation
  Directive ("Business services must use DriverSettlementEngine and shall not
  implement compensation calculations directly"). It has no repository/DB
  dependency - pure calculation given a delivery's data and the current rate
  config. `DriverSettlementsService` is the orchestration layer: it finds
  eligible deliveries, computes distance via GPS history, and persists what
  the engine calculates.
- Settlement grain is one row per completed `Delivery` (per-vendor-order),
  not per customer `Order`, because that's the unit our system already
  tracks a driver completing (see Delivery phase notes above: no route
  consolidation exists yet, so "3 vendor pickups count as 1 completed
  delivery" from the source doc's Multi-Order Optimization section doesn't
  yet apply - every Delivery already is exactly one completed delivery in
  this architecture).
- Distance compensation is computed from real GPS history, not estimated:
  `DriverLocationsRepository.findBetween(driverId, pickedUpAt ?? assignedAt, deliveredAt)`
  fetches that delivery's location pings (safe to attribute to a single
  delivery because a driver may only have one active delivery at a time -
  a Delivery phase business rule), and the engine sums the haversine
  distance between consecutive points. Distance compensation is 0 for
  COMPANY_VEHICLE drivers (per the source doc's formula, which omits the
  distance term entirely for company vehicles) and for PERSONAL_VEHICLE
  drivers when `distanceCompensationEnabled` is off.
- Heavy load bonus is evaluated from order-item weight: PER_POUND items
  count directly, PER_KILOGRAM items convert (x 2.20462), and PER_PACKAGE /
  PER_ITEM units contribute 0 lbs since they carry no defined physical
  weight in the current Product schema - a genuine data gap (products don't
  have a weight attribute), not a business decision. Revisit if a weight
  field is ever added to Product.
- Peak bonus is weekend-only (Jamaica-local Saturday/Sunday, computed via a
  fixed UTC-5 offset - Jamaica does not observe DST). The source doc also
  lists holidays, severe weather, and "high demand periods" as peak
  triggers, but the platform has no holiday calendar, weather feed, or
  demand-level signal to evaluate those against, so only the objectively
  derivable weekend case is implemented; the other three are deferred until
  a data source exists.
- Weekly volume bonus is calculated once per driver per settlement period:
  after generating that run's per-delivery rows, the total completed-delivery
  count for the driver+period (across all generation runs, not just this
  one) determines the tier, and a bonus row is created only if one doesn't
  already exist for that driver+period. Re-running generation for an
  already-bonused period will not top up the bonus even if the tier
  increases from additional late-arriving deliveries - settlements are meant
  to be generated once per week after the window closes (Wednesday payout
  per the source doc), not repeatedly.
- Settlement weeks are Jamaica-local (Monday 00:00 through Sunday 23:59,
  stored as UTC `settlementPeriodStart`/`settlementPeriodEnd`). Generation
  takes any date within the target week and normalizes it to that week's
  Jamaica-local Monday - the input's calendar date is treated as the
  intended Jamaica-local date directly (not reinterpreted through a UTC
  timezone shift), since an admin typing a plain date means that Jamaica
  calendar day.
- Settlement status transitions (PENDING -> APPROVED -> PAID, or ->
  FAILED/DISPUTED from PENDING or APPROVED) are admin-only via
  `PATCH /driver-settlements/:id/status`, mirroring how Payments status
  changes are all admin-gated. Marking PAID sets `payoutDate` automatically.

---

# Vendor Settlement Tables (Vendor Settlements phase, per
# docs/integrations/settlement-engine.md)

- `platform_commission_configs` - append-only, same pattern as
  `settlement_rate_configs`: publishing a new commission rate creates a new
  row rather than mutating one in place; "current" is the most recently
  created row. Seeded at 10% (0.10) - the source doc never gives a concrete
  commission percentage (unlike driver settlements, which had explicit
  dollar figures for every component), so this is a configurable placeholder,
  adjustable via `POST /vendor-settlements/commission-rate` without a schema
  change.
- `vendor_settlements` - one row per `VendorOrder` (`vendorOrderId` unique),
  not per customer `Order` + separate vendor id pair as the source doc's
  entity literally lists - a `VendorOrder` already uniquely identifies both,
  so a compound key would be redundant (same adaptation as
  `driver_settlements.deliveryId`). `grossAmount` is the vendor order's own
  `subtotal` directly - no quantity-supplied ratio formula is needed because
  our order model splits by vendor-owned distinct `vendor_orders` rows
  (simple cart-based split established in the Orders phase), not the
  cross-vendor same-product demand-splitting the source doc's Allocation
  Formula example assumes (that scenario belongs to the still-unbuilt Order
  Allocation Engine). `platformFee = grossAmount * commissionRate`,
  `netAmount = grossAmount - platformFee`. Delivery fees are trivially
  excluded from this calculation per the source doc, since the platform
  doesn't charge a separate delivery fee anywhere yet - there's nothing to
  exclude.
- `vendor_settlement_adjustments` - immutable correction records for
  settlement-engine.md's "If customer receives refund: Vendor settlements
  must be recalculated." `amount` may be positive (top-up) or negative
  (clawback); a settlement's original `grossAmount`/`platformFee`/
  `netAmount` are never edited (per "never overwrite calculations, use
  immutable records") - the true payout is `netAmount + sum(adjustments)`,
  exposed as the response entity's computed `adjustedNetAmount` field.

Business rules encoded here:

- Settlement eligibility (`VendorSettlementsRepository.findEligibleVendorOrders`)
  requires both `VendorOrder.status = DELIVERED` (matching the source doc's
  "Order Status = DELIVERED AND Proof of Delivery exists" trigger - proof is
  already guaranteed whenever a `Delivery` reaches DELIVERED, per the
  Delivery phase) and the order's `Payment.status = PAID`. The payment check
  isn't in the source doc's trigger list explicitly, but it's a necessary
  precondition here: a cash-on-delivery order can be DELIVERED while its
  payment is still PENDING (awaiting the admin's manual
  `PATCH /payments/:id/mark-paid` collection confirmation), and a vendor
  can't be settled for money the platform hasn't actually collected.
- Generation (`POST /vendor-settlements/generate`) has no settlement-period/
  week concept, unlike Driver Settlements - the source doc's Future Support
  section asks for weekly/monthly/instant payout flexibility "without schema
  changes," which this satisfies by not baking in a cadence at all: an admin
  (or an external scheduler) decides when to call the endpoint, and it
  simply settles every currently-eligible vendor order that doesn't already
  have one. Safe to re-run at any cadence - already-settled vendor orders
  are excluded by the `settlement: null` filter.
- Refund-driven recalculation is a manual admin action
  (`POST /vendor-settlements/:id/adjustments`), not automatic. A `Payment`/
  `Refund` is scoped to the whole `Order`, not to a specific `VendorOrder`,
  so for a multi-vendor order there's no reliable way to determine which
  vendor's settlement an arbitrary admin-issued refund should be attributed
  to without a human deciding - only the already-vendor-scoped rejection
  refund (`VendorOrdersService.reject` -> `PaymentsService.refundForOrder`)
  is unambiguous, and a REJECTED vendor order never reaches DELIVERED, so it
  never becomes settlement-eligible in the first place. This is a genuine
  scope boundary given the current data model, not a business decision to
  skip automatic recalculation.
- Settlement status transitions (PENDING -> APPROVED -> PAID, or -> FAILED
  from PENDING or APPROVED - no DISPUTED status here, unlike Driver
  Settlements, matching settlement-engine.md's exact status list) are
  admin-only via `PATCH /vendor-settlements/:id/status`. Marking PAID sets
  `paymentDate` automatically.

---

# Food Safety / Compliance Tables (Food Safety/Compliance phase, per
# docs/compliance/food-safety-compliance.md, docs/compliance/cold-chain-requirements.md,
# .claude/rules/seafood-compliance-rules.md, food-safety.md, cold-chain-management.md)

Scope note: this is the traceability/cold-chain/recall CORE, anchored on
entities the platform already has (Vendor, Product, VendorOrder, Delivery),
not the full literal scope of the source docs. Deliberately deferred:

- Real IoT sensor ingestion (cold-chain-management.md's Bluetooth/cellular
  telemetry) - no hardware exists to integrate with. Temperature readings are
  point-in-time, manually/driver-recorded observations, not a continuous
  stream. The Phase 11 amendment (see below) gives readings a device
  identity, configurable thresholds, and calibration tracking, but still no
  actual protocol/hardware integration.
- A scheduled/random vendor-audit subsystem distinct from lot inspections -
  the source docs describe periodic compliance audits of a vendor's
  facility/operations as a whole; this phase only models per-lot quality
  inspections (`QualityInspection`), not a separate audit-scheduling entity.
- Mandatory `Product.lotId` - the source docs state "no seafood product may
  be sold without traceability records," which would literally mean every
  product requires a lot. `lotId` is optional instead: making it mandatory
  would retroactively break every prior phase's e2e `createProduct()` helper
  (7 existing suites), none of which pass a lot. When a product IS linked to
  a lot, full enforcement applies (see below); this is a deliberate, revisit-
  able scope decision, not an oversight.

Note: an independent Fisherman/Vessel/Landing-Site registration layer
(originally deferred here) and actual notification delivery for recalls/
cold-chain alerts (originally deferred pending the Notifications module)
are both now built - see the "Phase 11 Amendment" subsection below.

Tables:

- `seafood_lots` - the traceability anchor. vendorId, species, storageType
  (FRESH | FROZEN), catchDate, catchLocation (optional), landingSite
  (optional), weight/weightUnit (POUNDS | KILOGRAMS), freshnessGrade (GRADE_A
  | GRADE_B | GRADE_C | REJECTED, set by inspection), qualityScore (0-100, set
  by inspection), foodSafetyStatus (SAFE | UNDER_REVIEW | SAFETY_HOLD |
  QUARANTINED | RECALLED | REJECTED, default SAFE), statusNotes. `lotNumber`
  (unique, `LOT-{year}-{6-digit sequence}`, e.g. `LOT-2026-000001`) is the
  human-readable identifier surfaced to customers via the public traceability
  endpoint, matching seafood-compliance-rules.md's example format.
- `temperature_readings` - a point-in-time checkpoint reading. lotId,
  checkpoint (VENDOR_STORAGE | PACKING | DISPATCH | DRIVER_PICKUP |
  IN_TRANSIT | DELIVERY - covers cold-chain-management.md's five monitoring
  points), temperatureC, recordedById (a vendor or an approved driver),
  optional latitude/longitude/photoUrl, recordedAt. Append-only.
- `temperature_alerts` - auto-generated whenever a reading falls outside the
  lot's storageType safe band; never overwritten, one row per breaching
  reading. severity (WARNING | CRITICAL | EMERGENCY), actualC, resolved/
  resolvedAt (admin-clearable via `PATCH /temperature-alerts/:id/resolve`,
  which only acknowledges the alert - it does not change the lot's status).
- `quality_inspections` - admin-conducted (this platform's RBAC has no
  separate Inspector role; food-safety authority sits with ADMINISTRATOR).
  lotId, inspectorId, result (PASSED | CONDITIONAL | REJECTED | QUARANTINED),
  freshnessGrade, qualityScore, notes, photoUrl. Recording an inspection
  always updates the lot's freshnessGrade/qualityScore, and (unless the lot
  is currently RECALLED - see below) also updates foodSafetyStatus via a
  fixed result->status mapping (PASSED->SAFE, CONDITIONAL->UNDER_REVIEW,
  REJECTED->REJECTED, QUARANTINED->QUARANTINED).
- `food_safety_incidents` - reportable by the owning vendor or an admin;
  covers non-temperature hazards (contamination, spoilage, packaging
  failure - temperature-specific problems are already captured via
  `temperature_alerts`). lotId, reportedById, severity (LOW | MEDIUM | HIGH |
  CRITICAL), status (OPEN | INVESTIGATING | RESOLVED | CLOSED, default OPEN),
  description, photoUrl, correctiveAction, resolvedAt.
- `recalls` / `recall_lots` - admin-only. A `Recall` can span multiple lots
  (`recall_lots` join table). severityClass (CLASS_I | CLASS_II | CLASS_III),
  status (DRAFT | ACTIVE | INVESTIGATING | RESOLVED | CLOSED, default DRAFT),
  reason, rootCause, resolutionNotes, createdById, closedAt.

Business rules encoded here:

- Temperature severity is magnitude-based, not duration-based: cold-chain-
  requirements.md defines Warning/Critical by how long a breach persists (15
  vs 30 minutes), which only makes sense for continuous IoT telemetry -
  manual/discrete readings have no "duration." `TemperatureMonitoringService.
  evaluateSeverity` instead derives severity from how far a reading is
  outside the safe band (Fresh 0-4C, Frozen <= -18C). EMERGENCY has no
  concrete numeric definition anywhere in the source docs, so it is never
  auto-derived - it remains a valid status for a future continuous-monitoring
  engine to set.
- A CRITICAL reading downgrades its lot's foodSafetyStatus to UNDER_REVIEW,
  but only if the lot is currently SAFE (an already-flagged or recalled lot
  isn't overwritten by a routine subsequent breach).
- RECALLED status is permanent until deliberately cleared: per recall-
  management.md, "No recalled product may re-enter the marketplace without
  compliance approval." Activating a Recall (DRAFT -> ACTIVE) cascades
  foodSafetyStatus = RECALLED onto every linked lot; resolving/closing the
  recall itself does NOT clear it back to SAFE, and a routine quality
  inspection explicitly skips its normal status-update step whenever the
  lot's current status is RECALLED (the inspection record itself is still
  created for audit purposes). Clearing a recalled lot requires a separate,
  deliberate `PATCH /seafood-lots/:id/status` admin action - which is why
  RECALLED is deliberately excluded from that endpoint's assignable statuses
  (it's a read-only side effect of the Recall workflow, never a direct
  target).
- Recall status transitions are strictly linear (DRAFT -> ACTIVE ->
  INVESTIGATING -> RESOLVED -> CLOSED, enforced by
  `RecallsService`'s transition table, same enum-transition-table pattern
  as `VendorOrder`/`Settlement`/`Incident` status), matching recall-
  management.md's workflow diagram exactly - no skipping stages.
- Ownership checks are centralized: `SeafoodLotsService.
  assertOwnedByRequester` (admin bypass, or the requester's own vendor
  profile owns the lot) is the single method reused by Temperature
  Monitoring, Quality Inspections, and Food Safety Incidents, instead of each
  service duplicating the same admin-or-owner check.
- Product/Cart/Orders enforcement: `Product.lotId` is optional, but when set,
  is fully enforced end-to-end - creation requires the lot to belong to the
  same vendor and be SAFE; `ProductsRepository.findMany`'s active-only search
  excludes products whose lot isn't SAFE; `ProductAvailability.ON_HOLD` is
  computed (not stored) whenever a linked lot isn't SAFE; `CartService.
  assertProductIsPurchasable` and `OrdersService.checkout`'s re-validation
  loop both reject a non-SAFE-lot product the same way they already reject an
  inactive product or an unapproved vendor.
- Recall impact lookup (`GET /recalls/:id/affected-orders`) joins
  `OrderItem -> Product (lotId in the recall's lots)` to surface impacted
  orders/customers for manual admin follow-up. Activating a recall (DRAFT ->
  ACTIVE) also now emits one `RecallIssuedEvent` per affected order via this
  same lookup - see the Phase 11 Amendment subsection below.

---

# Phase 11 Amendment: Traceability Chain, Species, Cold-Chain IoT, Compliance
# Operations, Digital Product Passport (per seafood-compliance-rules.md,
# cold-chain-management.md, food-safety.md, business-rules1.md)

Closes the gaps the Food Safety / Compliance CORE above deliberately
deferred (Fisherman/Vessel/Landing-Site registration, real notification
delivery) plus a further round of gaps an audit against the same source
docs found: regulatory certification tracking, sensor calibration, a
documented emergency-response workflow, waste/disposal evidence, and a
customer-facing traceability passport. Additive throughout - no existing
table's shape changed except where noted, and every new relationship keeps
prior-phase e2e fixtures working unchanged (`catchItemId`/`speciesId` on
`seafood_lots` stay nullable, exactly like `Product.lotId` above).

Traceability chain tables:

- `landing_sites` - name, parish, latitude/longitude, status (ACTIVE |
  INACTIVE), inspectionStatus (NOT_INSPECTED | PASSED | FAILED).
- `fishermen` - distinct from `Vendor` per the traceability chain (Sea ->
  Fisherman -> Landing Site -> Vendor -> ...). `userId` (unique, one fisherman
  profile per user account), optional `vendorId` link for the common case
  where a COMMUNITY_FISHER vendor IS the fisherman (not required - a
  retailer/peddler vendor may buy from a fisherman who never registers as a
  vendor). fullName, contactPhone/Email, licensing/banking fields,
  `landingSiteId`, status (PENDING | APPROVED | SUSPENDED | REJECTED,
  default PENDING - only APPROVED fishermen may register catches).
- `vessels` - `ownerFishermanId`, unique `registrationNumber`, name,
  `fishingMethod` (TRAP | NET | LINE | SPEARFISHING | POT | TROLLING |
  DIVING | LONGLINE | OTHER - modeled per-vessel, not per-catch, since a
  vessel is generally rigged for one method), capacityTons, status (ACTIVE |
  INACTIVE | DECOMMISSIONED).
- `species` - scientificName (unique), commercialName, regulatoryStatus
  (UNRESTRICTED | RESTRICTED | PROHIBITED), seasonalStartMonth/EndMonth
  (nullable - no restriction configured, not "always in season"),
  minimumSizeCm. Seeded with Snapper/King Fish/Mackerel/Lobster/Shrimp/Conch
  (Conch RESTRICTED, per the spec's own example).
- `catches` / `catch_items` - trip-level record (`catches`: catchNumber,
  fishermanId, optional vesselId, landingSiteId, catchDate, lat/long,
  fishingArea, photos) plus a per-species line item (`catch_items`:
  catchId, speciesId, weight/weightUnit, estimatedFreshness). Split this way
  because one physical landing event routinely mixes species (e.g. a net
  catch of Snapper + King Fish + Lobster) - modeling that as three `Catch`
  rows would force fabricating three catchNumbers/photos for one trip.
  `seafood_lots.catchItemId` (nullable FK, `onDelete: Restrict`) links a lot
  to one species-specific line item - a lot is species-homogeneous by
  definition, so it can never trace to a whole mixed-species trip.
  `seafood_lots.speciesId` (nullable FK, `onDelete: SetNull`) is a lighter
  enrichment path for lots not linked to a full catch record; both stay
  optional, matching `Product.lotId`'s "prospective enforcement, no
  retroactive break" precedent.

Cold-chain IoT tables:

- `temperature_devices` - vendorId, unique deviceCode, status (ACTIVE |
  OFFLINE | DECOMMISSIONED), lastSeenAt (touched on every reading that
  supplies a `deviceId`; `isOffline` is computed on read from staleness, not
  stored), lastCalibratedAt/calibrationDueAt (set via `PATCH
  /temperature-devices/:id/calibrate`, due 90 days later - a documented
  constant, not an admin-configurable interval table).
  `isCalibrationOverdue` is computed on read and informational only - it
  does not block new readings from an overdue device.
- `temperature_thresholds` - replaces the previously-hardcoded FRESH_MAX_C/
  FROZEN_MAX_C constants with real, admin-editable data. `deviceId` nullable
  (null = platform-wide default per `SeafoodStorageType`, seeded once per
  type); minC/maxC/warningBandC. `TemperatureReading.deviceId` (nullable)
  lets a reading resolve a device-specific threshold first, else the
  platform default.
- `TemperatureAlert.severity` gains EMERGENCY (WARNING/CRITICAL already
  existed): a reading more than 2x `warningBandC` past `minC`/`maxC` - the
  source docs define EMERGENCY by sustained duration, which needs a
  scheduler this codebase doesn't have, so this magnitude-based definition
  is this service's own defensible substitute. An EMERGENCY reading
  auto-quarantines its lot (foodSafetyStatus = QUARANTINED, an enum value
  that existed in the schema but was never actually set anywhere before
  this amendment) and auto-creates an `emergency_responses` row.
- `emergency_responses` - one row per EMERGENCY alert (`alertId` unique).
  assignedToId (nullable, set by `PATCH .../acknowledge`), status (OPEN |
  ACKNOWLEDGED | CONTAINED | RESOLVED, strictly linear - no skipping
  stages), actionsTaken, and a CAPA (Corrective and Preventive Action)
  triad: rootCause/correctiveAction/preventiveAction. Transitioning to
  RESOLVED requires rootCause and correctiveAction to be set - the same
  "no silent auto-clear of a compliance hold" discipline already applied to
  RECALLED lots.

Compliance operations tables:

- `chain_of_custody_events` - an explicit, appendable event log distinct
  from `temperature_readings` (custody starts at the catch, before a lot
  exists, and includes non-temperature checkpoints like INSPECTION).
  eventType (LANDING | STORAGE_ENTRY | STORAGE_EXIT | PACKING | DISPATCH |
  PICKUP | TRANSIT | DELIVERY | INSPECTION | DISPOSAL), nullable catchId/
  lotId, nullable fromUserId/toUserId (who custody transferred *between*,
  not just who logged it - LANDING sets only toUserId since the sea isn't a
  User; DISPOSAL sets only fromUserId since there's no downstream
  recipient; INSPECTION sets both to the inspector, a checkpoint not a
  transfer). Auto-written at three call sites (catch registration ->
  LANDING, lot registration -> STORAGE_ENTRY, quality inspection ->
  INSPECTION); manual recording via `POST /food-safety/custody-events` is
  admin-only (narrower than the original vendor/driver/admin design - the
  leaf module that owns this table can't reach `SeafoodLotsService`'s
  ownership check without a circular import).
- `compliance_audit_logs` - userId, action, entityType/entityId, before/
  afterValue (JSON), ipAddress, reason. Written by every seafood-lot/
  recall/incident/inspection/fisherman status-update mutation. Permanent -
  the one place in this phase with no `retentionExpiresAt` field, per the
  spec's "Audit Logs: Permanent" retention table.
- `compliance_documents` - documentType (INSPECTION_REPORT | RECALL_NOTICE |
  TEMPERATURE_REPORT | AUDIT_REPORT), optional relatedLotId/relatedRecallId,
  fileUrl, version (auto-incremented per documentType + lot/recall - never
  overwritten), uploadedById. Distinct from the vendor-tier `VendorDocument`
  (licensing docs) - this is for inspection/recall/temperature/audit report
  *artifacts*.
- `regulatory_authorities` / `regulatory_certifications` - authorities are
  small normalized reference data (name unique, country, contact info;
  seeded with Jamaica's Fisheries Division/NFA, Ministry of Health, Bureau
  of Standards Jamaica) rather than a free-text `issuingAuthority` string
  per certificate, so the same authority is one canonical, queryable row.
  Certifications attach to exactly one of vendorId/fishermanId/
  landingSiteId (validated in the service). status (PENDING | ACTIVE |
  SUSPENDED | EXPIRED | REVOKED) defaults to PENDING; only an explicit
  `PATCH .../activate` moves it to ACTIVE. Expiry detection mirrors
  `VendorDocumentsService.syncExpiredStatuses`'s computed-on-read pattern -
  only ACTIVE rows are swept to EXPIRED on each list call, since a PENDING/
  SUSPENDED certificate was never in force.
- `waste_disposal_records` - lotId, optional productId/recallId, quantity/
  weightUnit, reason (SPOILAGE | RECALL_DESTRUCTION | EXPIRED | DAMAGED |
  QUALITY_REJECTION | OTHER), disposalMethod, evidencePhotoUrls (plural -
  controlled destruction typically needs multiple angles/stages),
  witnessName/Title/SignatureUrl (required by the service when reason is
  RECALL_DESTRUCTION - regulator-facing destruction evidence; optional for
  the other five reasons), recordedById, disposedAt. When productId is
  supplied, reuses `ProductsService`'s existing stock-adjustment code path
  (a new `adjustStockForDisposal` sibling to the existing `adjustStock`,
  sharing one `applyStockAdjustment` helper) rather than a second,
  untracked bookkeeping trail - decrements `Product.quantityAvailable` and
  writes an `InventoryEvent{eventType: DISPOSED}` (new enum value) in the
  same transaction. Also writes a DISPOSAL chain-of-custody event, giving
  the lot's custody chain an explicit end-state.

Digital Product Passport (no new table - computed/composed read-model, same
precedent as the compliance dashboard):

- `seafood_lots.publicTraceToken` (unique, `@default(uuid())`) is the
  public lookup key for `GET /passport/:token` and the QR-code endpoint -
  deliberately not `lotNumber`, which is sequential/enumerable
  (`LOT-2026-000001`, `-000002`, ...) and would let anyone scrape every
  lot's traceability data by incrementing through it.
- `GET /seafood-lots/:id/qr-code` (owning vendor or admin - it's for label
  printing, not itself public) generates a QR PNG via the `qrcode` npm
  package, returned as a base64 data URI encoding
  `https://iriefishmongers.com/passport/{publicTraceToken}`.
- The composed passport response is versioned (`passportVersion: '1.0.0'`,
  semver) rather than the storage being versioned, so the contract can grow
  without a schema migration: lot summary, origin (fisherman/vessel/landing
  site/species - null when the lot has no linked catch item), the full
  custody-chain timeline with fromRole/toRole resolved to a role label
  (FISHERMAN | VENDOR | DRIVER | CUSTOMER - never a name, for privacy),
  cold-chain summary (reading count / unresolved alerts / worst severity),
  certifications (status + issuing authority name only, never documentUrl/
  certificateNumber), and a sustainability block built entirely from
  already-modeled data (`Vessel.fishingMethod`, `Species.regulatoryStatus`/
  seasonal window). `sustainability.meetsMinimumSize` is always `null` -
  this platform records no measured catch size anywhere to check against
  `Species.minimumSizeCm`, and presenting an honest "unknown" is safer than
  a defaulted `false` that reads as a violation that was never checked.

Notification wiring closed by this amendment:

- `NotificationEventType.RECALL_ISSUED` - `RecallsService.updateStatus()`
  emits one `RecallIssuedEvent` per affected order when a recall transitions
  to ACTIVE (reusing the already-built `getAffectedOrders()` lookup),
  notified via Email + In-App at CRITICAL priority.
- `NotificationEventType.COLD_CHAIN_ALERT_RAISED` - `TemperatureMonitoringService.recordReading()`
  emits one `ColdChainAlertRaisedEvent` to the owning vendor whenever a
  reading raises a WARNING/CRITICAL/EMERGENCY alert, notified via Email +
  In-App with priority scaled to severity (NORMAL/HIGH/CRITICAL). The
  seeded template body was extended to interpolate `temperatureC`/
  `checkpoint` alongside `lotNumber`/`severity`. Admin/operations
  escalation for CRITICAL/EMERGENCY (per cold-chain-management.md's
  automated-actions table) remains unwired - see the "Explicitly out of
  scope" note below on `NotifyAdmin`/`NotifyOperations`.

Explicitly out of scope (see the source plan's own "Explicitly out of
scope" section for the full list and reasoning): real IoT sensor
ingestion, calibration-overdue blocking new readings, admin/operations
broadcast notifications (`NotifyAdmin`/`NotifyOperations` for CRITICAL/
EMERGENCY alerts - no "notify all users with role X" primitive exists;
the `emergency_responses` OPEN queue is the practical substitute),
scheduled/random vendor or fisherman audits, PDF/Excel export (CSV/JSON
only), a persisted Digital Product Passport table (computed/composed only,
not a point-in-time snapshot), and literal 7-year retention
enforcement/purge (informational `retentionExpiresAt` only, same as the
core Food Safety phase above).

---

# Notification Tables (Notifications phase, per business-rules1.md's
# Notification Rules and .claude/rules/notification-standards.md)

Scope note: this is the event-driven notification CORE - a centralized
module every other module publishes domain events into (per notification-
standards.md's "Centralized Notification Service" principle: "No individual
module may directly integrate with Email/SMS/Push providers"), rather than
the full literal event list in notification-standards.md. Wired for the 7
events business-rules1.md explicitly mandates: registration confirmation,
vendor approval, order placement, order acceptance, payment confirmation,
delivery updates, refund status changes. The event-bus architecture makes
adding notification-standards.md's larger event list (vendor rejected/
suspended, low stock, product deactivated, vendor order received/preparing/
ready, vendor settlement completed, cold-chain temperature warnings, etc.)
later a matter of one `eventEmitter.emitAsync()` call at the source plus one
seeded `NotificationTemplate` row - not a rearchitecture.

Deliberately deferred:

- SMS channel - no SMS provider credential (e.g. Twilio) exists anywhere in
  this codebase's `.env.example`, unlike SendGrid (email) and FCM (push),
  which are both already anticipated there.
- The scheduled retry ladder (Attempt 2 at 5 min, Attempt 3 at 30 min,
  Attempt 4 at 2 hours) from notification-standards.md's Retry Policy - no
  job queue/scheduler infrastructure exists yet (same class of gap as IoT
  sensors in the Food Safety phase, or IoT-driven duration-based temperature
  severity). Only one immediate, synchronous attempt is made per channel;
  failures are recorded via `NotificationLog` for manual/future automated
  follow-up rather than actually retried.
- Marketing/promotional notifications and the `marketingEnabled` preference
  - no promotions feature exists anywhere in this codebase to trigger them.
- Admin-editable notification templates via API - `notification_templates`
  is seeded by `backend/prisma/seed.ts`, not exposed through a CRUD endpoint,
  since no admin template-editor screen exists yet (mirrors how
  `settlement_rate_configs` started append-only-via-code before getting an
  admin endpoint).

Tables:

- `notifications` - one row per (recipient, channel) delivery attempt, not
  one row per event with a channel list - a single event fanning out to
  Email + Push + In-App creates three independently retryable/markable rows.
  category (ACCOUNT | VENDOR | ORDER | PAYMENT | DELIVERY), eventType (the
  7 wired events), channel (EMAIL | PUSH | IN_APP), priority (LOW | NORMAL |
  HIGH | CRITICAL), title, message, data (optional JSON payload), status
  (PENDING | SENT | FAILED | READ), sentAt, readAt.
- `notification_logs` - append-only delivery-attempt history. Since only one
  immediate attempt is currently made (see scope note above), most
  notifications have exactly one log row - the shape already supports a
  future retry worker adding attemptNumber 2, 3, 4 without a schema change.
- `notification_preferences` - one row per user (created lazily on first
  update via upsert; no row means every default applies). Channel-level
  (emailEnabled, pushEnabled) and category-level (accountEnabled,
  vendorEnabled, orderUpdatesEnabled, paymentUpdatesEnabled,
  deliveryUpdatesEnabled) opt-outs. In-app notifications have no opt-out -
  `GET /notifications/mine` is the user's own record of what happened to
  their account, not a promotional channel a user should be able to fully
  silence.
- `notification_templates` - `{{variable}}`-templated subject/body per
  (eventType, channel) pair (`@@unique([eventType, channel])`), seeded with
  exactly the 18 rows the 7 wired events need across their configured
  channels. Which channels actually fire for an event is entirely data-
  driven from this table (`NotificationTemplatesRepository.
  findChannelsForEvent`), not hardcoded in the service layer.
- `device_tokens` - push-notification registration, keyed by a unique token
  string. No mobile app exists yet in this codebase to register real
  tokens, but the registration endpoint and storage are real, forward-
  compatible infrastructure that `PushChannelAdapter` actively reads today
  for any token a client does register - not dead code.

Business rules encoded here:

- Provider abstraction mirrors the Payments phase precedent exactly:
  `NotificationsService` never calls Email/SMS/Push providers directly -
  only through a `NotificationChannelAdapter` interface, with
  `EmailChannelAdapter` (SendGrid v3 mail-send API), `PushChannelAdapter`
  (Firebase Cloud Messaging legacy HTTP API), and `InAppChannelAdapter` (no
  external call - the `Notification` row itself is the in-app notification)
  as the three implementations. Adding a channel means writing one adapter.
- Event-driven, not directly coupled: `AuthService`, `VendorsService`,
  `OrdersService`, `VendorOrdersService`, `PaymentsService`, and
  `DeliveriesService` only emit a plain event class (defined in
  `backend/src/common/events/`) via `EventEmitter2` - none of them import or
  depend on `NotificationsModule`. `NotificationEventsListener` (inside
  `NotificationsModule`) is the only place that translates an event into a
  category/priority/template-variables call to `NotificationsService.notify`.
- Emission is awaited (`eventEmitter.emitAsync`, not fire-and-forget
  `emit`), matching the "only an immediate, synchronous first attempt is
  made" scope decision above: the triggering request (registration,
  checkout, vendor acceptance, payment confirmation, delivery status
  update) genuinely waits for the notification attempt to complete before
  responding, rather than racing it in the background. This was deliberately
  chosen over fire-and-forget after discovering `emit()` created a benign
  but real race (the HTTP response could return before the Notification row
  existed) during this phase's own e2e testing.
- Which channels fire for an event is looked up from
  `NotificationTemplatesRepository.findChannelsForEvent(eventType)` (data-
  driven from seeded templates), then filtered by the recipient's
  `NotificationPreference` (a `null` preference row - the common case until
  a user explicitly changes a setting - means every channel/category
  defaults to allowed, i.e. opt-out rather than opt-in).
- A failed channel adapter send (e.g. SendGrid/FCM rejecting placeholder
  dev credentials, or a user with zero registered device tokens) does not
  throw and does not block other channels for the same event: the
  `Notification` row is still created and marked FAILED with a
  `NotificationLog` entry recording why, while other channels for the same
  event proceed independently.
- Test-isolation note for anyone adding to `notification_templates` in a
  future spec: never `deleteMany` by a bare `eventType`/`channel` filter in
  a repository test - those are real Prisma enum values shared with
  production seed rows, and a broad delete will silently wipe seeded
  templates other code depends on. Scope test fixtures to specific created
  IDs (see `notification-templates.repository.spec.ts`), the same pattern
  `categories.repository.spec.ts` already established for other seeded,
  non-per-test-scoped config tables.

---

# Vendor Tier Tables (Vendor Tier phase, per .claude/marketplace/vendor-tier-rules.md,
# vendor-classification.md, vendor-onboarding.md, vendor-verification.md, and
# CLAUDE.md's own "VENDOR TIER DIRECTIVE")

Reconciliation note: `.claude/compliance/vendor Vvrification & compliance
module.md` describes a different, inconsistent vendor-classification scheme
(a 7-value `VendorType` enum - FISHERMAN, FISH_PEDDLER, SMALL_BUSINESS,
SEAFOOD_RETAILER, WHOLESALER, IMPORTER, PROCESSOR - plus a 3-value
`ComplianceLevel`, vs. this family's 4-tier COMMUNITY_FISHER..
ENTERPRISE_SUPPLIER vocabulary). The 4-tier scheme is authoritative for this
phase: CLAUDE.md's own Vendor Tier Directive uses this exact vocabulary
verbatim ("Community Fisher vendors must not be blocked by enterprise
compliance requirements"), giving it Highest-Authority backing the other
draft lacks. The compliance draft's `VendorDocument` sub-schema (document
type/expiry/verification-status shape) doesn't conflict with the tier
vocabulary and is reused directly below.

Scope note: this implements the real, enforceable core - tier assignment,
document-gated tier upgrades, configuration-driven feature flags/limits
(never a hardcoded `tier === 'X'` branch, per the Directive), listing-limit
and sales-limit enforcement, and the upgrade/downgrade workflow with an
audit trail.

Deliberately deferred:

- Of the 10 feature flags vendor-tier-rules.md requires (SELL_RETAIL,
  SELL_WHOLESALE, ACCEPT_HOTEL_ORDERS, ACCEPT_RESTAURANT_ORDERS,
  ACCEPT_GOVERNMENT_ORDERS, EXPORT_PRODUCTS, ACCESS_ANALYTICS,
  ACCESS_PROMOTIONS, API_ACCESS, MULTI_ZONE_OPERATIONS), only SELL_RETAIL has
  anything to gate today - the marketplace has no wholesale/hotel/
  restaurant/government/export order-type distinction (every order is the
  same generic customer-to-vendor retail order), no promotions system, no
  API-key issuance system, no analytics module, and no delivery-zone module.
  All 10 flags are genuinely computed from DB config (not dead code - they're
  read by `VendorPermissionsService` and exposed via `GET /vendors/me/
  permissions` today), but the other 9 have no real gate to attach to yet;
  wiring them is a one-line permission check at the point each of those
  future features is actually built, not a rearchitecture.
- **Update (Phase 8 gap-closure pass)**: `canSell`/document-gating is now
  also enforced on `ProductsService.create()`, closing the exact gap this
  note used to describe - the compliance draft's Rule 4 ("a vendor may not
  create products unless canSell === true") is now a real runtime check, not
  just the tier-upgrade-approval-only gate it originally shipped as.
  `VendorDocumentsService.assertCanSell(vendor.id, vendor.tier)` runs
  immediately after the existing `vendor.status !== 'APPROVED'` check, before
  the category lookup, throwing `403 Forbidden` (same exception the
  tier-upgrade path already used). Every e2e vendor fixture across the
  backend test suite was updated to upload + get an admin-approved
  `GOVERNMENT_ID` as part of vendor setup, since even COMMUNITY_FISHER (the
  default tier) requires one. Tier upgrade approval
  (`VendorTiersService.reviewUpgradeRequest`) still separately calls
  `computeCanSell` for the REQUESTED tier before allowing the upgrade.
- `GET /vendors/me/compliance-status` (vendor only) surfaces the
  per-document-type breakdown behind `assertCanSell` -
  `VendorDocumentsService.getComplianceStatus()` returns `{ tier, canSell,
  requiredDocuments: [{ type, status }] }` where `status` is the real
  `DocumentReviewStatus` (PENDING/APPROVED/REJECTED/EXPIRED) or the
  synthetic `MISSING` value for a required type with no uploaded document at
  all - built for the future vendor dashboard to render a compliance
  checklist instead of just surfacing a bare 403 on product creation.
- Automatic tier downgrades: vendor-tier-rules.md's "Automatic review
  triggered by: Expired Documents, Food Safety Violations, Repeated Delivery
  Failures, Fraud Reports, Compliance Breaches" describes a review being
  triggered, not literally an autonomous system decision about which tier to
  drop to - no fraud-detection engine or delivery-failure-threshold engine
  exists to make that call. Every downgrade in this phase is an explicit
  admin action (`POST /vendors/:id/downgrade`) recording which of those
  reasons applies; `VendorDowngradeEvent.triggeredById` stays nullable for a
  future automated engine but is always set today.

Tables:

- `vendor_documents` - a vendor's compliance documents. vendorId,
  documentType (GOVERNMENT_ID | BUSINESS_REGISTRATION |
  TAX_COMPLIANCE_CERTIFICATE | INSURANCE_CERTIFICATE |
  FOOD_SAFETY_DOCUMENTATION | REGULATORY_CERTIFICATION | OTHER), fileUrl,
  documentNumber/issuedDate/expiryDate (all optional), status (PENDING |
  APPROVED | REJECTED | EXPIRED, default PENDING), rejectionReason,
  verifiedById/verifiedAt. Phone/address/fishing-area data (Community
  Fisher's other "required" items) and the Food Safety Agreement are not
  modeled as uploaded documents here - phone/address are already captured on
  the Vendor/User profile, and the Food Safety Agreement is the existing
  `Vendor.termsAcceptedAt` field captured at registration; duplicating that
  data as document rows would be redundant, not additional enforcement.
- `vendor_tier_configs` - one row per tier (`@unique`), seeded verbatim from
  vendor-tier-rules.md's per-tier tables: dailySalesLimit/monthlySalesLimit/
  maxActiveListings (null means unlimited/not specified in the source doc,
  never a magic sentinel number), badge (the emoji/checkmark label shown on
  the vendor's public profile).
- `vendor_tier_features` - one row per (tier, feature) pair
  (`@@unique([tier, feature])`), seeded true/false directly from vendor-
  tier-rules.md's per-tier Permissions sections - the Feature Flag Rules'
  explicit "Required Functions" list (SELL_RETAIL, SELL_WHOLESALE, ...
  MULTI_ZONE_OPERATIONS).
- `vendor_upgrade_requests` - one row per upgrade request. vendorId,
  requestedTier, status (PENDING | APPROVED | REJECTED, default PENDING),
  reason, reviewedById/reviewedAt/reviewNotes. A vendor may only have one
  PENDING request at a time (enforced in `VendorTiersService`, not the
  schema).
- `vendor_downgrade_events` - append-only audit trail. vendorId, fromTier,
  toTier, reason (EXPIRED_DOCUMENTS | FOOD_SAFETY_VIOLATION |
  REPEATED_DELIVERY_FAILURES | FRAUD_REPORT | COMPLIANCE_BREACH |
  ADMIN_MANUAL), triggeredById (nullable - see scope note above), notes.
- `Vendor` gains `tier` (`VendorTier`, default COMMUNITY_FISHER) and
  `complianceScore` (nullable Int, per vendor-verification.md's Compliance
  Scoring section - captured as a field but not yet computed by any engine,
  since no automated scoring inputs - document compliance, food safety
  compliance, order fulfillment, customer ratings, cold chain compliance -
  are wired together anywhere yet; this is a genuine forward-compatibility
  placeholder, not a business decision to skip scoring).

Business rules encoded here:

- Feature-flag lookups are the ONLY place tier-derived capability decisions
  are made (`VendorPermissionsService.getPermissions`), per vendor-tier-
  rules.md's explicit "Never hardcode vendor tier checks... permissions =
  getVendorTierPermissions()" - reads `vendor_tier_configs`/
  `vendor_tier_features`, never a `tier === 'X'` branch anywhere else in the
  codebase.
- Listing-limit enforcement (`ProductsService.create` ->
  `VendorPermissionsService.assertListingLimitNotExceeded`) counts the
  vendor's current active (`isActive: true`) products against
  `vendor_tier_configs.maxActiveListings` for their tier, throwing
  `ForbiddenException` at the limit - a real, enforced restriction (unlike
  the 9 deferred feature flags above).
- Sales-limit enforcement (`OrdersService.checkout` ->
  `VendorPermissionsService.assertSalesLimitNotExceeded`) sums each cart's
  per-vendor subtotal against that vendor's trailing-24-hour and trailing-
  30-day `VendorOrder` subtotals (excluding REJECTED/CANCELLED orders) before
  the order is created, checking daily and monthly limits independently -
  either one exceeded blocks that portion of checkout.
- Document expiry detection is lazy, not a scheduled sweep (no job queue
  exists in this codebase, same class of gap as the Notifications phase's
  deferred retry ladder): `VendorDocumentsService`'s private
  `syncExpiredStatuses` transitions any APPROVED-but-now-past-`expiryDate`
  document to EXPIRED status the next time that vendor's documents are
  actually read (`listMine`/`listForVendor`/`computeCanSell`), satisfying
  "the system shall automatically detect expired documents" without
  fabricating a scheduler.
- Tier upgrade approval cascades a real `Vendor.tier` change:
  `VendorTiersService.reviewUpgradeRequest` only calls
  `vendorsRepository.updateTier` after confirming (via
  `VendorDocumentsService.computeCanSell`) that every document type the
  REQUESTED tier requires has an APPROVED row - rejecting the request itself
  never touches the vendor's tier.
- `VendorsService`/`VendorsRepository` gained a `tier` filter (`GET
  /vendors?tier=...`) and `VendorPublicEntity.tier`, satisfying vendor-tier-
  rules.md's Search/Filter Rules ("Filter By Vendor Tier", "Display Vendor
  Badge") - the badge itself is fetched separately via `GET /vendors/:id/
  permissions` (already built) rather than embedded in every vendor list
  row, since computing it there would require `VendorsModule` to depend on
  `VendorTiersModule`, which already depends on `VendorsModule` for vendor
  lookups - a circular module dependency this avoids entirely.

---

# Marketplace Selection Engine Tables (Vendor Tier Marketplace Enhancement
# phase, per .claude/marketplace/marketplace-modes.md, vendor-selection-
# engine.md, fulfillment-strategy.md, and vendor-tier-rules.md's MARKETPLACE
# VISIBILITY section)

Scope note: implements the two purchasing modes marketplace-modes.md
requires - Mode 1 "Customer Selected Vendor" (already fully supported by the
pre-existing Product/Cart/Order flow, no schema change needed) and Mode 2
"Marketplace Fulfillment"/"Best Available Vendor" (the platform auto-selects
the fulfilling vendor via a configurable scoring engine) - plus the
append-only audit trail vendor-selection-engine.md's Audit Requirements
mandate.

Deliberately deferred (same "neutral, not fabricated" treatment as
`Vendor.complianceScore` above):

- Vendor Rating: no `Review`/`Rating` model exists anywhere in this schema.
  `VendorScore.ratingScore` is computed as a neutral mid-point value by the
  selection engine (and given the lowest weight in the seeded default
  distribution) rather than inventing a fake rating source.
- True GPS distance: no geocoding/lat-lng infrastructure exists (`Vendor.
  parish` is the only location data anywhere). `VendorScore.distanceScore`
  uses a same-parish-first proxy - a real, functional heuristic, not
  fabricated data - pending the `google-maps` integration `tech-stack.md`
  already anticipates.
- Delivery Capacity: no fleet/vehicle-capacity data model exists (Driver only
  has a single `vehicleType`/`vehicleOwnership`, not a load-capacity number).
  `VendorScore.deliveryCapacityScore` is a neutral value today, same
  treatment as rating.

Tables:

- `marketplace_mode_configs` - append-only, mirrors `settlement_rate_configs`
  /`platform_commission_configs`: toggling a mode creates a new row rather
  than mutating the current one; "current" is always the most recently
  created row. `customerSelectedEnabled`/`bestAvailableEnabled` gate the two
  modes. Seeded default matches marketplace-modes.md's own Phase 1 rollout
  table (Mode 1 enabled, Mode 2 disabled).
- `vendor_selection_weight_configs` - append-only weighted-scoring
  configuration (inventoryWeight/freshnessWeight/complianceWeight/
  distanceWeight/ratingWeight/deliveryCapacityWeight, each `Decimal(5,4)`)
  read by `VendorSelectionEngineService` - never a hardcoded weight, per
  vendor-selection-engine.md's Claude Execution Rule. Seeded default follows
  fulfillment-strategy.md's Selection Priority ordering (Inventory >
  Compliance > Freshness > Distance > Delivery Capacity > Rating) and sums to
  1.0000.
- `fulfillment_decisions` - one row per "resolve best vendor" attempt
  (fulfillment-strategy.md's "All fulfillment decisions must be auditable").
  requestedProductId, quantity, deliveryParish, customerId, decidedAt. A
  decision persists even when no vendor is eligible - a "no eligible vendor"
  outcome is itself an auditable fact, not an error to discard.
- `vendor_scores` - one row per vendor considered for a `FulfillmentDecision`
  (the "Competing Vendors" + "Scores" audit fields) - includes ineligible
  vendors with `eligible = false` and `ineligibilityReason`, not just the
  winner, so the full comparison is reconstructable later.
- `vendor_assignments` - the winning vendor+product for a
  `FulfillmentDecision` (the "Winning Vendor" audit field), 1:1 via a unique
  `fulfillmentDecisionId`. Absent entirely when no eligible vendor was found.
  Kept as its own table rather than columns on `FulfillmentDecision` to avoid
  a duplicate/nullable FK pair on the decision row itself.

Business rules encoded here:

- "Best Available Vendor" cross-vendor product matching (there is no
  canonical species/product catalog independent of `Product.vendorId`) uses
  case-insensitive `name` + `categoryId` equality - an honest, functional
  heuristic, not a fabricated canonical-catalog join, flagged for revisiting
  if/when a real species catalog is introduced.
- The existing, fully-tested `POST /cart/items` (`AddCartItemDto {
  productId, quantity }`) and checkout contracts are untouched. Best
  Available Vendor is a new, additive resolution endpoint (`POST
  /marketplace/best-vendor/resolve`) that returns a concrete winning
  `productId`; the client then calls the existing, unmodified `POST
  /cart/items` with it - zero changes to Cart/Orders contracts.
- `POST /marketplace/best-vendor/resolve` returns `403` when
  `MarketplaceModeConfig.bestAvailableEnabled` is `false`, rather than
  silently proceeding - `MARKETPLACE MODE RULES`' "do not hardcode mode
  behavior" enforced as a real runtime check, not just a doc convention.

---

# Inventory Management Tables (Phase 7, per .claude/roadmap.md's "Prevent
# overselling" purpose, dependencies Redis/Orders/Products)

Two deliberately separate sources of truth, matching the roadmap's own split
between "Inventory Events"/"Inventory Audit" (durable) and "Stock
Reservation"/"Reservation Expiration" (ephemeral):

- **Redis** holds live, short-lived soft holds on stock - one hash per
  product, `inv:reserved:{productId}`, field = `cartId`, value = JSON
  `{ quantity, expiresAt }`. A 15-minute TTL (`RESERVATION_TTL_SECONDS`,
  `backend/src/modules/inventory/constants/inventory.constants.ts`) is
  created/refreshed on every `POST /cart/items` or `PATCH
  /cart/items/:itemId`, and cleared on `DELETE /cart/items/:itemId` or a
  successful checkout. Expiry is enforced by comparing `expiresAt` to the
  current time on every read (lazy expiry), not by relying on Redis's own
  per-key TTL for correctness - a defensive outer `EXPIRE` on the hash key
  (2x the reservation TTL) exists only so Redis reclaims memory for
  abandoned/discontinued products.
- **Postgres** holds a durable, append-only audit trail of real stock
  movements only - not reservation churn:

  ```prisma
  enum InventoryEventType {
    DECREMENTED        // checkout
    RESTOCKED          // order cancellation or vendor rejection
    MANUAL_ADJUSTMENT  // vendor-initiated stock edit
  }
  ```

  - `inventory_events` - id, productId, eventType, quantityDelta (signed),
    vendorOrderId (optional, set for DECREMENTED/RESTOCKED), triggeredById
    (optional, set to the vendor's user id for MANUAL_ADJUSTMENT),
    notes (optional), createdAt. `product` is `onDelete: Restrict` (a
    product cannot be deleted while its audit history still references it,
    same append-only-audit pattern used throughout this codebase, e.g.
    `FulfillmentDecision`/`VendorDowngradeEvent`); `vendorOrder`/
    `triggeredBy` are `onDelete: SetNull` so the audit row survives order
    deletion or user removal.

Business rules encoded here:

- `ProductsRepository.adjustStock()`'s existing atomic `updateMany` +
  `WHERE quantityAvailable >= -delta` guard (unchanged by this phase)
  already makes the checkout-time decrement race-safe. The real gap this
  phase closes is upstream: cart writes previously did zero stock checks,
  so a customer could add more of a product to their cart than exists, or
  two customers could both believe they were about to buy the last unit.
  `POST /cart/items` / `PATCH /cart/items/:itemId` now compute
  `availableToPurchase = quantityAvailable - reservedByOthers` via
  `InventoryReservationsService.getAvailableToPurchase()` and reject with
  `409 Conflict` if the requested quantity would exceed it.
- `InventoryModule` never imports `ProductsModule`, `CartModule`, or
  `OrdersModule` - those three import `InventoryModule` instead.
  `InventoryReservationsService` takes `productId`/`quantityAvailable` as
  plain parameters rather than fetching the product itself (every caller
  has already loaded it), and `InventoryReconciliationService` reads
  `prisma.cartItem` directly (via the `@Global()` `PrismaModule`) instead
  of importing `CartModule`, keeping the dependency graph one-directional.
- `POST /orders/checkout` writes one `DECREMENTED` `InventoryEvent` per
  order item inside the same transaction that creates the `VendorOrder`/
  `OrderItem` rows, then releases the Redis holds for the purchased
  products after the transaction commits (they're no longer "reserved",
  they're actually decremented). Order/vendor-order cancellation and
  vendor rejection write matching `RESTOCKED` events alongside their
  existing `adjustStock` restock calls, in the same transaction - this
  also fixed a pre-existing atomicity bug where `VendorOrdersService`'s
  rejection path called `adjustStock` without a transaction at all.
- `PATCH /products/:id/stock` (manual vendor stock edits) writes a
  `MANUAL_ADJUSTMENT` `InventoryEvent` with `triggeredById` set to the
  requesting vendor's user id. Manual adjustments are not blocked by
  outstanding customer reservations - a vendor can still mark down stock
  for spoilage/recount even if it drops below what shoppers currently have
  reserved; those reservations simply may fail at final checkout with the
  same `409 Conflict` already in place, rather than adding new invasive
  business logic the roadmap doesn't ask for.
- `POST /inventory/reconcile` (admin only, optional `productId` filter) is
  an on-demand endpoint, not a scheduled job - no job-queue/scheduler
  infrastructure exists anywhere in this codebase yet. It cross-checks
  each product's Redis reservations against live `CartItem` rows and
  releases any orphaned or quantity-mismatched holds.

---

# Delivery Zones, Fleet & Logistics Tables (Phase 10, per
# docs/integrations/ADR-002-delivery-zones.md, fleet-management-engine.md,
# docs/reference/jamaica-delivery-zones.md)

Closes the "delivery zones, fleet assets, and route consolidation" gap the
original Delivery phase deliberately deferred, plus a second round of
operational deliverables added after review: vendor pickup confirmation,
customer acceptance, delivery exceptions, fleet maintenance, driver
performance metrics, a vendor pickup queue, notification event placeholders,
route history, and multi-stop scaffolding.

- `delivery_zones` - id, name, code (unique), description, active (default
  true - deactivated, never deleted, matching `Vendor.status`/
  `Product.isActive`'s soft-disable convention). Seeded with the three
  ADR-002 zones from jamaica-delivery-zones.md.
- `delivery_zone_parishes` - one row per `Parish` (unique), mapping it to
  exactly one zone. A join table rather than a `Parish[]` scalar array so the
  one-parish-one-zone rule is a real DB constraint; seed-authored only, no
  admin-editable endpoint (the mapping is authoritative and stable).
- `vendors.primaryZoneId` (nullable, `SetNull`) + `vendor_zones` join table -
  one fast-path FK for the common case, a join table for the full
  one-or-more-zones case ADR-002 describes; same shape as the existing
  `Product.lotId` (fast FK) vs. `VendorTierFeature` (join table) split.
- `drivers.availabilityStatus` (`ONLINE | OFFLINE | BUSY`, default `OFFLINE`),
  `capacityLbs`, `coldChainCapable`, `assignedZoneId` (nullable, `SetNull`) +
  `driver_zones` join table (same fast-FK/join-table split as vendors).
  `ONLINE`/`OFFLINE` are the only manually settable states (`PATCH
  /drivers/me/availability`, rejected while an active delivery exists);
  `BUSY` is set automatically inside `POST /delivery/assign`'s transaction
  and cleared automatically back to `ONLINE` when a delivery reaches
  `DELIVERED`/`FAILED`. `GET /delivery/available` and `POST /delivery/assign`
  both now additionally require `availabilityStatus === 'ONLINE'`.
- `orders.deliveryZoneId` (nullable, `SetNull`) - resolved server-side from
  `dto.deliveryParish` at checkout via a direct `DeliveryZoneParish` read
  (never client-supplied). `OrdersService` reads this directly through the
  global `PrismaService` rather than importing `DeliveryModule`, since
  `DeliveryModule` already imports `OrdersModule`.
- `deliveries` gains: `scheduledPickupWindowStart/End`,
  `customerDeliveryWindowStart/End` (all nullable - populated by the new
  `PATCH /delivery/:id/schedule`, opt-in enrichment on an already-claimed
  delivery, not a prerequisite for claiming); `vendorConfirmedAt` +
  `vendorConfirmedById` (set by `PATCH /delivery/:id/vendor-confirm`, an
  audit fact only - it does not gate the driver's own pickup transition);
  `customerAcceptanceStatus` (`PENDING | ACCEPTED | REJECTED`, default
  `PENDING`) + `customerAcceptedAt`/`customerRejectedAt`/`rejectionReason`,
  set by `PATCH /delivery/:id/customer-acceptance` once `deliveredAt` is set.
- Cold-chain claim gating: `POST /delivery/assign` now rejects a
  cold-chain-capable-required delivery (any linked `SeafoodLot`) for a
  driver whose `coldChainCapable` is false.
- `delivery_exceptions` - id, deliveryId (`Cascade`), type (enum:
  `CUSTOMER_UNAVAILABLE | ADDRESS_ISSUE | VEHICLE_BREAKDOWN | TRAFFIC_DELAY |
  WEATHER_DELAY | PRODUCT_DAMAGE | OTHER`), reason, photos (`String[]`,
  plain URLs, no referential integrity needed), notes, resolved (default
  false) + resolvedAt/resolvedById. `POST /delivery/:id/exceptions` (driver),
  `PATCH /delivery/exceptions/:id/resolve` (admin).
- `route_history` - one row per delivery (`deliveryId` unique, `Cascade`),
  written once when a delivery reaches `DELIVERED`/`FAILED`: gpsSamples,
  distanceKm, durationMinutes. Distance is computed by reusing the existing,
  already-shipped `DriverSettlementEngine.computeDistanceKm()` (registered as
  a `DeliveryModule` provider via direct class import, not a module import,
  to avoid a `DriverSettlementsModule -> DeliveryModule -> DriverSettlementsModule`
  cycle) rather than reimplementing GPS distance math.
- `route_optimization_runs` (audit: zoneId, strategyName, `deliveryIds`
  snapshot array, decidedAt) + `delivery_runs`/`delivery_run_stops`
  (operational outcome: zone, optional driver/fleetAsset, status, ordered
  stops) - the same audit-vs-outcome split already used for
  `FulfillmentDecision`/`VendorAssignment`. `POST
  /delivery/zones/:zoneId/optimize-route` (admin, read-only planning) calls
  an injectable `RouteOptimizationStrategy` (DI token
  `ROUTE_OPTIMIZATION_STRATEGY`, default `SingleStopRouteOptimizationStrategy`
  is an honest no-op) and persists both an audit row and a `DeliveryRun`.
  Does **not** change `POST /delivery/assign` or the one-active-delivery
  invariant - a driver working a run still claims/picks-up/delivers each
  stop through the existing per-delivery flow.
- `fleet_assets` (zoneId `Restrict`, assetType, ownership, licensePlate
  unique, capacityLbs, coldChainCapable, status `ACTIVE|MAINTENANCE|RETIRED`,
  currentDriverId nullable `SetNull`) + `fleet_trips` (all three FKs
  `Restrict` - a financial record analogous to `DriverSettlement`; four
  nullable cost fields captured but not computed, no cost-engine) +
  `fleet_maintenance_records` (fleetAssetId `Cascade`, status
  `SCHEDULED|IN_PROGRESS|COMPLETED|OVERDUE`). New `FleetModule`
  (`backend/src/modules/fleet/`) with full CRUD for all three, admin-only:
  `POST/GET/PATCH /fleet-assets`, `POST/GET /fleet-assets/:id/maintenance`,
  `POST/GET/PATCH /fleet-trips`, `PATCH /fleet-maintenance/:id`. Creating or
  updating a maintenance record with `status: IN_PROGRESS` also sets the
  parent asset's `status` to `MAINTENANCE` in that same explicit service
  call - a traceable state change, not an implicit trigger. `FleetModule`
  imports only `AuthModule`; it validates `Driver`/`DeliveryZone` existence
  via the global `PrismaService`, not by importing `DeliveryModule`.
- `temperature_readings.checkpoint` gains two additive enum values,
  `VEHICLE_LOADING` and `CUSTOMER_ACCEPTANCE` (the existing 6 stay
  unchanged) - no new endpoint needed, the existing `POST
  /temperature-readings` flow (Food Safety phase) already accepts any
  checkpoint value. Gives an end-to-end cold-chain record: vendor
  release/`DISPATCH` -> `DRIVER_PICKUP` -> `VEHICLE_LOADING` -> `IN_TRANSIT`
  -> arrival/`DELIVERY` -> `CUSTOMER_ACCEPTANCE` (still driver-submitted -
  this platform has no model for customers operating measurement equipment).
- `notification_event_types` (Prisma enum) gains `DRIVER_ASSIGNED` and
  `AWAITING_CUSTOMER_ACCEPTANCE` - both wired end-to-end (event class ->
  `NotificationEventsListener` case -> seeded `NotificationTemplate` rows).
  Three more event classes (`DriverNearbyEvent`, `PickupDelayedEvent`,
  `DeliveryDelayedEvent`) exist as real, typed contracts in
  `backend/src/common/events/` but are deliberately never emitted yet -
  "nearby" needs delivery-address geocoding (this platform only has
  free-text address + parish) and "delayed" needs a job-queue/scheduler
  (none exists anywhere in this codebase), so no `NotificationEventType`
  enum value was added for them either.
- Driver performance metrics (`GET /drivers/me/performance`, `GET
  /drivers/:id/performance`) and the vendor pickup queue (`GET
  /vendors/me/pickup-queue`) are both **computed-on-read**, not
  materialized - matches the existing `getComplianceStatus`/rating-summary
  precedent over a cached/stored aggregate table. No new schema; both derive
  entirely from data introduced above (deliveries, route_history,
  temperature_readings/alerts, delivery_run_stops).

Rejected deliveries and food-safety incidents: `PATCH
/delivery/:id/customer-acceptance` with `decision: 'REJECTED'` emits a
`DeliveryRejectedEvent`, consumed by a new `FoodSafetyEventsListener`
(`backend/src/modules/food-safety/`) that creates one `FoodSafetyIncident`
per distinct `SeafoodLot` among the rejected vendor order's items, with
`reportedById` set to the customer's own user id. This calls
`FoodSafetyIncidentsRepository.create()` directly rather than the
ownership-gated `FoodSafetyIncidentsService.report()`, since the trigger is
a legitimate system/customer-initiated report, not vendor self-report
impersonation. Refund/compensation implications of a post-delivery
rejection are explicitly not resolved here - `business-rules2.md`'s Failed
Delivery Policy covers driver-side failure, not customer rejection of a
successfully delivered package, and that is flagged as an unresolved
business-policy question, not a schema gap.

Explicitly still out of scope after this pass: real route-optimization math
(the DI hook exists, the default strategy is a no-op), fleet-trip cost
*computation* (fields are captured, admin-populated only), vehicle-capacity
*enforcement* against real order weight (blocked on `Product`/`OrderItem`
having no weight field), and `DeliveryRun` as an active dispatch/claiming
mechanism (it's a planning/grouping layer - drivers still claim deliveries
one at a time via the existing `assign()` flow).

# Customer Trust Tables (Phase 13, Reviews / Ratings / Compliance Score)

- `reviews` - a customer review of a vendor (`productId` null) or a specific
  purchased product (`productId` set), always tied to the completed
  `VendorOrder` that makes the author eligible. FK deletes are deliberately
  non-cascading (trust/moderation records must survive account/catalog
  changes): `author` -> SetNull, `vendor`/`product`/`vendorOrder` ->
  Restrict. Removal is soft via `moderationStatus`
  (`VISIBLE`/`REMOVED_BY_AUTHOR`/`REMOVED_BY_ADMIN`), never a row delete.
  "One review per purchase" is enforced by TWO hand-added partial unique
  indexes (Postgres treats every NULL as distinct, so a plain compound
  `@@unique` over a nullable `productId` would not block a second vendor-only
  review): `WHERE productId IS NULL` and `WHERE productId IS NOT NULL`. The
  service catches the resulting P2002 and returns 409. Eligibility gates on a
  DELIVERED VendorOrder with a joined Delivery record, a 90-day creation
  window from `deliveredAt`, and a 14-day edit/restore window from
  `createdAt`; a rejected delivery still allows a vendor review while flagging
  the product review (`deliveryWasRejected`, computed at read time).
- `review_audit_logs` - an immutable trail of admin moderation actions,
  mirroring `compliance_audit_logs`' shape but with a STRICTER contract: the
  audit row is written in the SAME `prisma.$transaction` as the moderation
  update, so a review can never be admin-removed without an accountable
  record (a failed audit write rolls the removal back to VISIBLE). `reviewId`
  and `actorId` are Restrict.
- `vendors.complianceScoreUpdatedAt DateTime?` - written together with
  `complianceScore` so any reader can tell how fresh the score is. The score
  itself (`vendors.complianceScore`, an existing but previously never-written
  column) becomes a write-through cache: a pure formula
  (`compliance-score-formula.util`) deducts from a 100 baseline per category
  (temperature alerts / failed inspections / active recalls / certifications,
  each capped), maintained by event listeners (reusing
  `ColdChainAlertRaisedEvent`, plus new `QualityInspectionRecordedEvent`,
  `RecallStatusChangedEvent`, `RegulatoryCertificationStatusChangedEvent`)
  and a nightly `America/Jamaica` cron; a one-time `compliance:scores:
  recompute-all` CLI backfills existing APPROVED vendors via the same shared
  batch runner. The platform-wide dashboard average is scoped to APPROVED
  vendors. Recall counts are deduped per distinct recall (one recall across
  three lots deducts once).
