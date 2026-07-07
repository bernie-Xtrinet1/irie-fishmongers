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
  driver-claim-based with no fleet to schedule.
- Driver compensation/settlement calculations
  (docs/integrations/driver-settlement-engine.md) - a separate later phase;
  this phase only captures the data (proof of delivery, timestamps) that
  settlement will eventually need.
- Cold-chain temperature logging (docs/compliance/cold-chain-requirements.md) -
  belongs to the Food Safety/Compliance phase.

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

- Separate Fisherman/Vessel/Landing-Site registration entities - the source
  docs describe an independent fisherman-onboarding layer with its own
  identity verification, vessel records, and banking information distinct
  from vendor onboarding. This platform has no such layer; vendors register
  seafood lots directly under their existing approved vendor profile.
  `catchLocation`/`landingSite` are captured as free-text fields on the lot
  rather than as foreign keys to dedicated Fisherman/Vessel/LandingSite
  tables.
- Real IoT sensor ingestion (cold-chain-management.md's Bluetooth/cellular
  telemetry) - no hardware exists to integrate with. Temperature readings are
  point-in-time, manually/driver-recorded observations, not a continuous
  stream.
- A scheduled/random vendor-audit subsystem distinct from lot inspections -
  the source docs describe periodic compliance audits of a vendor's
  facility/operations as a whole; this phase only models per-lot quality
  inspections (`QualityInspection`), not a separate audit-scheduling entity.
- Actual notification delivery (email/SMS/push for recalls, incidents,
  alerts) - no Notifications module exists yet anywhere in this codebase.
  Alerts/incidents/recalls are recorded and queryable by admins; nothing is
  auto-sent.
- Mandatory `Product.lotId` - the source docs state "no seafood product may
  be sold without traceability records," which would literally mean every
  product requires a lot. `lotId` is optional instead: making it mandatory
  would retroactively break every prior phase's e2e `createProduct()` helper
  (7 existing suites), none of which pass a lot. When a product IS linked to
  a lot, full enforcement applies (see below); this is a deliberate, revisit-
  able scope decision, not an oversight.

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
  orders/customers for manual admin follow-up, since no automated
  notification-sending exists yet.

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
