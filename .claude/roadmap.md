# IRIE FISHMONGERS PLATFORM
# IMPLEMENTATION ROADMAP

Version: 2.2

Last reviewed: 2026-07-12 - Phases 10A-10E (Fleet Dispatch Engine,
Delivery Operations Center, Advanced Route Optimization, Delivery
Analytics & SLA, Advanced Cold Chain & Fleet Sanitation) all completed
and marked ✓ Complete, closing every gap Phase 12B.0's verification
identified. Remaining Phase 12B scope is now exactly: the 4 Analytics
admin screens (Vendor Dashboard, Sales/Delivery/Inventory Analytics),
Digital Product Passport end-to-end verification, dashboard verification
against seeded data, a full architecture review, and a final regression
pass - see PHASE 12B below.

Previous review (2026-07-12, earlier pass): audited every phase's STATUS
against the actual codebase (schema, modules, apps/ directories) rather
than trusting prior status text alone. Corrected several phases that had
no STATUS marker at all despite being substantially built (11, 12, 14),
and phases that claimed nothing despite being real gaps (10A-10E, 15).
Added Phase 12B (Operational Readiness) as a new gating phase before
Phase 13, plus a Platform Maturity Matrix as a standing decision-making
tool.

This document is the master implementation roadmap for the
Irie Fishmongers Marketplace.

Claude must follow this roadmap unless explicitly instructed otherwise.

No phase may begin until all acceptance criteria of the previous
phase are satisfied.

Never skip dependencies.

Never build future modules prematurely.

------------------------------------------------------------

# PROJECT OBJECTIVES

Build Jamaica's leading seafood marketplace supporting:

• Community Fishers
• Fish Vendors
• Commercial Seafood Suppliers
• Enterprise Suppliers

while maintaining:

• Food Safety
• Traceability
• Cold Chain Compliance
• Marketplace Trust
• Multi-vendor Fulfillment
• Driver Logistics
• Customer Transparency

------------------------------------------------------------

# CORE DESIGN PRINCIPLES

The platform is NOT a generic e-commerce system.

The platform is a seafood marketplace with:

✓ Multi-vendor fulfillment

✓ Fresh inventory

✓ Cold-chain monitoring

✓ Food traceability

✓ Vendor compliance

✓ Marketplace settlement

✓ Driver management

✓ Customer transparency

Every module must reinforce these principles.

------------------------------------------------------------

PHASE 1

Repository Foundation

STATUS

✓ Complete

Deliverables

Repository

Branch Strategy

CLAUDE Configuration

Coding Standards

Documentation

Acceptance

Repository builds successfully.

------------------------------------------------------------

PHASE 2

Infrastructure

STATUS

✓ Complete

Deliverables

NestJS

PostgreSQL

Redis

Prisma

Swagger

Health Checks

Environment Validation

Acceptance

Infrastructure operational.

------------------------------------------------------------

PHASE 3

Authentication

STATUS

✓ Complete

Deliverables

JWT

Refresh Tokens

RBAC

Password Reset

Roles

Acceptance

Authentication fully secured.

------------------------------------------------------------

PHASE 4

Marketplace

STATUS

✓ Complete

Deliverables

Vendor Registration

Products

Categories

Search

Inventory

Acceptance

Marketplace operational.

------------------------------------------------------------

PHASE 5

Vendor Management

STATUS

✓ Complete

Deliverables

Vendor Profiles

Public Vendor Pages

Approval Workflow

Parish Management

Acceptance

Vendor lifecycle operational.

------------------------------------------------------------

PHASE 6

Order Management

STATUS

✓ Complete

Deliverables

Cart

Checkout

Vendor Orders

Order Splitting

Atomic Stock Updates

Acceptance

Orders complete successfully.

------------------------------------------------------------

PHASE 7

Inventory Management

STATUS

✓ Complete

Purpose

Prevent overselling.

Deliverables

Stock Reservation

Reservation Expiration

Inventory Allocation

Inventory Events

Inventory Audit

Inventory Reconciliation

Acceptance

Customers cannot purchase reserved stock.

Reservations expire automatically.

Inventory remains accurate.

Dependencies

Redis

Orders

Products

------------------------------------------------------------

PHASE 8

Vendor Tier Architecture

STATUS

✓ Complete

Purpose

Support multiple vendor types.

Deliverables

Community Fisher

Verified Vendor

Commercial Supplier

Enterprise Supplier

Vendor Permissions

Feature Flags

Compliance Rules

Tier Upgrades

Acceptance

Vendor permissions become configuration-driven.

------------------------------------------------------------

PHASE 9

Marketplace Intelligence

STATUS

✓ Complete

Purpose

Support hybrid marketplace.

Deliverables

Vendor Selection Engine

Marketplace Modes

Fulfillment Strategy

Best Available Vendor

Vendor Scoring

Acceptance

Customer may:

Choose Vendor

OR

Allow platform selection.

------------------------------------------------------------

PHASE 10

Delivery & Logistics

STATUS

~ Operationally Ready (core workflow shipped; 10A-10E dispatch
automation, ops UI, route optimization, SLA/fleet metrics, and
sanitation/certification tracking are now all built - see each phase's
own STATUS below. Only the mobile driver app remains open, tracked
separately, not part of 10A-10E)

Purpose

Implement delivery network.

Deliverables

Delivery Zones

Driver Assignment

Driver Mobile App

Pickup Workflow

Delivery Workflow

Driver Settlement

GPS Tracking

Acceptance

Orders reach customers through complete logistics workflow.

IMPLEMENTATION NOTE (shipped)

Built: Delivery Zones (DeliveryZone/DeliveryZoneParish, seeded from
jamaica-delivery-zones.md, resolved server-side at checkout), Driver
Assignment (claim-based, gated on ONLINE availability + cold-chain
capability), Pickup/Delivery Workflow (scheduling windows, vendor pickup
confirmation, customer accept/reject with a FoodSafetyIncident raised on
rejection, delivery exceptions), Driver Settlement and GPS Tracking
(pre-existing, unchanged) plus new Route History reusing
DriverSettlementEngine.computeDistanceKm(). This pass also delivered a
meaningful slice of 10A/10C/10D/10E below - see each phase's own note.
Not built: Driver Mobile App (no React Native/Expo app exists for any
role yet; out of scope for this backend-only pass).

------------------------------------------------------------

------------------------------------------------------------

PHASE 10A

Fleet Dispatch Engine

STATUS

✓ Complete (2026-07-12) - real dispatch-scoring algorithm built:
DispatchService (new backend/src/modules/dispatch/ module) computes hard
eligibility (zone match, APPROVED+ONLINE driver, cold-chain capability,
capacity sufficiency, not already engaged on another IN_PROGRESS run) and
soft ranking (computeCapacityFitScore - tighter capacity fit scores
higher) for both drivers and fleet assets, then calls the existing
PATCH /delivery-runs/:id/assign seam. Every decision (including
no-eligible-candidate failures) is recorded in a new DispatchDecisionLog
table. POST /delivery-runs/:id/dispatch (admin) is the new endpoint.
Product.weightLbs (new nullable field) closes the capacity-check blind
spot for PER_PACKAGE/PER_ITEM units. Scope decision: zone-match
substitutes for real distance-to-pickup (no Vendor lat/long exists
anywhere in the schema); "current load" is a hard eligibility filter, not
a soft score, mirroring DeliveriesRepository.countActiveByDriverId's
existing precedent.

Purpose

Automatically assign the best available driver and fleet asset to a delivery run.

Deliverables

- Fleet asset selection
- Driver shift/availability checks
- Zone-aware dispatch logic
- Capacity checks
- Cold-chain eligibility checks
- Dispatch audit logs

Acceptance

Every delivery run can be assigned to a valid driver/vehicle combination using configured rules.

IMPLEMENTATION NOTE (partially shipped, in Phase 10's pass)

Built: Driver shift/availability checks (ONLINE/OFFLINE/BUSY state
machine), zone-aware data model (DeliveryZone, Driver.assignedZoneId),
capacity checks (Driver.capacityLbs captured, not yet enforced against
real order weight - no weight field on Product/OrderItem), cold-chain
eligibility checks (enforced at POST /delivery/assign), fleet assets exist
(FleetAsset CRUD). Not built: an actual automatic dispatch algorithm that
picks the "best" driver/asset - assignment is still driver-initiated
claim, not admin/system dispatch; fleet assets are not yet linked to
individual deliveries.

Dependencies

- Phase 10
- Delivery Zones
- Driver Availability
- Fleet Assets
- Cold-chain capability

------------------------------------------------------------

PHASE 10B

Delivery Operations Center

STATUS

✓ Complete (2026-07-12) - new /delivery-operations admin-dashboard screen
with three live sections: Needs Dispatch (PLANNED delivery runs, one-click
dispatch via the 10A engine with a confirmation dialog), Active Runs
(IN_PROGRESS, informational), Open Exceptions (unresolved, enriched with
vendor/customer/driver/address context - closes the 12B.0 finding that
the plain exception list under-fetched for a dispatcher screen; the old
plain findMany()/entity were removed as dead code). New GET /delivery-runs
list endpoint (previously only GET :id existed). "Real-time" is React
Query polling (refetchInterval), not WebSockets - same call as the 12A
dashboard widgets, no new backend infrastructure needed. Vehicle
maintenance alerts: FleetMaintenanceOverdueEvent notifies the asset's
currently assigned driver when a record becomes OVERDUE (both on create
and on update) - deliberately does not attempt an "all administrators"
push notification, since no role-wide recipient lookup exists yet (same
gap ColdChainAlertRaisedEvent already noted); operations-wide visibility
comes from this screen surfacing overdue records directly instead.

Purpose

Provide operations staff with a live control view of delivery execution.

Deliverables

- Dispatcher dashboard
- Live delivery queue
- Pickup queue
- Exception queue
- Vehicle maintenance alerts
- Driver online/busy/offline visibility
- Delivery run monitoring

Acceptance

Operations staff can monitor, intervene, and resolve delivery issues from one place.

IMPLEMENTATION NOTE (backend data/endpoints partially shipped, no UI)

Built: pickup queue (GET /vendors/me/pickup-queue), exception queue
(GET /delivery/exceptions), driver online/busy/offline visibility
(Driver.availabilityStatus, admin-visible). Not built: any dispatcher
UI/dashboard (no admin frontend exists for delivery ops), live/real-time
queue updates (no websocket layer), vehicle maintenance alerts (records
exist via FleetMaintenance but nothing pushes an alert).

Dependencies

- Phase 10A
- Fleet Dispatch Engine
- Delivery Runs
- Delivery Exceptions

------------------------------------------------------------

PHASE 10C

Advanced Route Optimization

STATUS

✓ Complete (2026-07-12) - the honest no-op (SingleStopRouteOptimization
Strategy, preserved input order) is replaced by
ParishClusteringRouteOptimizationStrategy: a real deterministic ordering
heuristic that sorts stops by delivery Parish first (finish one
geographic cluster before moving to the next) and vendor second
(consecutive same-vendor pickups aren't split apart). Explicit scope
decision, documented in the strategy's own file comment: this is not a
haversine distance-minimizing solver - no Vendor/Order/Customer lat/long
exists anywhere in this schema (the only coordinates on record are
DriverLocation GPS pings and food-safety catch/landing-site/reading
locations), so real distance-based sequencing would require adding
geocoding infrastructure, which is out of scope here. Same "zone-match
substitutes for distance" scope decision 10A already made.

Purpose

Improve routing efficiency for single-stop and future multi-stop delivery runs.

Deliverables

- Route planning hooks
- Route history
- Route optimization runs
- Multi-stop scaffolding
- Zone-based route planning
- Travel-distance metrics

Acceptance

The system can generate and store route plans without breaking the existing claim-based delivery flow.

IMPLEMENTATION NOTE (mostly shipped, in Phase 10's pass)

Built: route planning hooks (injectable RouteOptimizationStrategy DI
token), route history (one row per delivery, real GPS-distance
computation reused from DriverSettlementEngine), route optimization runs
(audit table), multi-stop scaffolding (DeliveryRun/DeliveryRunStop),
zone-based route planning (POST /delivery/zones/:zoneId/optimize-route).
Not built: a real optimization algorithm - the only registered strategy
is an honest no-op (single-stop passthrough); actual multi-stop
sequencing logic is future work behind the same DI seam.

Dependencies

- Phase 10A
- Delivery Runs
- GPS Tracking
- Route History

------------------------------------------------------------

PHASE 10D

Delivery Analytics & SLA

STATUS

✓ Complete (2026-07-12) - SLA breach tracking and fleet/zone rollup
metrics built. SLA = Delivery.customerDeliveryWindowEnd, the same
promised-by deadline DriversService.getPerformanceMetrics() already used
for its per-driver on-time/late ratio - now persisted as queryable
SLABreach records via two detection paths: LATE_DELIVERY (created
synchronously inside DeliveriesService.updateStatus's existing DELIVERED
transition, when deliveredAt lands after the promised window) and
OVERDUE_IN_TRANSIT (a delivery still in-flight past its window can't be
caught by any state transition, so SLABreachDetectionService runs a new
@Cron(EVERY_5_MINUTES) scan - this backend's first cron job,
@nestjs/schedule added fresh). SLABreach has @@unique([deliveryId, type])
and the repository always upserts, so the cron never creates duplicate
rows for a delivery that stays overdue across ticks. Fleet/zone rollups:
FleetAssetsRepository.countByZoneAndStatus() (GET /fleet-assets/
zone-summary) and SLABreachesRepository.getBreachCountsByZone()
(GET /sla-breaches/zone-summary). Both rollups are backend-only in this
pass - wiring them into a Delivery Analytics screen is Phase 12B's
separate, not-yet-started deliverable (see Phase 15 below).

Purpose

Measure delivery performance and operational reliability.

Deliverables

- On-time pickup rate
- On-time delivery rate
- Driver performance metrics
- Delivery duration metrics
- SLA breach tracking
- Fleet utilization metrics
- Zone performance metrics

Acceptance

The platform can report delivery performance by driver, vehicle, and zone.

IMPLEMENTATION NOTE (partially shipped, in Phase 10's pass)

Built: on-time delivery rate, driver performance metrics (pickup delay,
customer acceptance rate, failed delivery rate, temperature compliance
rate, average delivery duration) via GET /drivers/me|:id/performance,
computed on read from data this phase introduced. Not built: SLA breach
tracking (no job-queue/scheduler exists to detect a missed window after
the fact), fleet utilization metrics, zone performance metrics (rollups
across drivers/zones, not per-driver).

Dependencies

- Phase 10B
- Phase 10C
- Route History
- Delivery Windows
- Customer Acceptance

------------------------------------------------------------

PHASE 10E

Advanced Cold Chain & Fleet Sanitation

STATUS

✓ Complete (2026-07-12) - the two concrete remaining gaps are closed.
Vehicle sanitation: new FleetSanitationRecord model (POST/GET
/fleet-assets/:id/sanitation, admin), deliberately distinct from
FleetMaintenance - mechanical soundness and cold-chain hygiene are
different compliance concerns. Driver cold-chain certification: new
DriverColdChainCertification model with issuedBy/issuedAt/expiresAt
(POST/GET /drivers/:id/cold-chain-certifications, PATCH /drivers/
cold-chain-certifications/:id/revoke, all admin), separate from
Driver.coldChainCapable (a vehicle-capability flag 10A's dispatch
eligibility already reads).
DriverColdChainCertificationsService.computeIsCertified() mirrors
VendorDocumentsService.computeCanSell()'s "does this party currently
satisfy a compliance requirement" precedent, but is deliberately not
wired into 10A's dispatch eligibility in this pass - that would change
already-shipped 10A behavior and is a real, separate integration
decision left for its own explicit choice. Cold-chain telemetry hooks
are an explicit non-decision, not an oversight: no physical IoT sensor
hardware exists to integrate against, and every other compliance record
in this codebase (TemperatureReading, QualityInspection, etc.) is
human-entered too - nothing here blocks wiring real hardware in later.

Purpose

Strengthen seafood safety during transport and handling.

Deliverables

- Extended temperature checkpoints
- Cold-chain telemetry hooks
- Vehicle sanitation records
- Driver cold-chain certification tracking
- Fleet maintenance records
- Spoilage and contamination alerts
- Food-safety event integration

Acceptance

Seafood deliveries remain auditable across transport, sanitation, and temperature checkpoints.

IMPLEMENTATION NOTE (partially shipped, in Phase 10's pass)

Built: extended temperature checkpoints (VEHICLE_LOADING,
CUSTOMER_ACCEPTANCE added to the existing 6), fleet maintenance records
(FleetMaintenance, admin CRUD, IN_PROGRESS auto-flips the parent asset to
MAINTENANCE), food-safety event integration for the customer-rejection
path (DeliveryRejectedEvent -> one FoodSafetyIncident per distinct lot).
Not built: cold-chain telemetry hooks (no IoT/device integration exists),
vehicle sanitation records (no schema for this), driver cold-chain
certification tracking (no schema for this), spoilage/contamination
alerts beyond the existing TemperatureAlert mechanism.

Dependencies

- Phase 10A
- Food Safety
- Cold Chain
- Fleet Assets
- Temperature Logging

------------------------------------------------------------

PHASE 11

Food Safety & Cold Chain

STATUS

~ Operationally Ready - traceability chain, species management,
cold-chain IoT thresholds/alerts (including vendor notification on
alert), compliance dashboard/reporting/audit log/documents, regulatory
certifications, emergency response workflow, waste disposal tracking,
recall management with customer notification, and a Digital Product
Passport (QR) module are all built and tested. Digital Product Passport
completeness (QR scan flow end-to-end) still needs an explicit
verification pass - tracked in Phase 12B, not marked Production Ready
until that pass runs clean.

Purpose

Protect seafood quality.

Deliverables

Temperature Logging

Cold Chain Tracking

Quality Inspections

Seafood Compliance

Recall Management

Acceptance

Every seafood item is traceable.

------------------------------------------------------------

PHASE 12

Payments & Settlement

STATUS

✓ Complete - Payment/Refund schema with a PaymentProvider abstraction,
WiPay and Cash-on-Delivery adapters, checkout/acceptance/rejection
wiring, DriverSettlementEngine, and VendorSettlementsService all built
and tested.

Purpose

Marketplace financial engine.

Deliverables

Customer Payments

Vendor Settlement

Driver Settlement

Commission Engine

Refunds

Settlement Reports

Acceptance

Payments reconcile correctly.

------------------------------------------------------------

PHASE 12B.0

Architecture Verification

STATUS

✓ Complete (2026-07-12) - one-time pre-flight checkpoint, not a recurring
phase. Ran before any 10A-10E implementation began, per reviewer
recommendation, to catch wrong assumptions before code was written on top
of them.

Purpose

Verify every operational module is internally consistent before Phase
12B implementation begins: schema vs. ADRs, API readiness for 10A-10E,
event-flow correctness, and no duplicate/dead models.

Findings

- Schema vs. ADRs: all four ADRs (001-004) are schema-accurate, no
  drift. ADR-001 names two providers (Fygaro, Stripe Connect) that don't
  exist in code yet - expected/documented as backup/future, not a
  contradiction.
- 10A readiness: PATCH /delivery-runs/:id/assign already links
  driverId+fleetAssetId to a DeliveryRun (admin-only, zero scoring) -
  this is the seam the new dispatch algorithm should feed into, not a
  seam to build from scratch. No weight field exists on Product/
  OrderItem (confirmed gap). No lat/long exists on Vendor anywhere in
  the schema - "distance-to-pickup" cannot be computed today; only
  zone-level proximity is available without first adding vendor
  coordinates (explicit scope decision needed, see 10A execution plan
  update below). FleetAssetsRepository/DriversRepository need new
  filters (coldChainCapable, availabilityStatus, assignedZoneId) for
  candidate queries.
- 10B readiness: GET /vendors/me/pickup-queue and GET /delivery/
  exceptions have no Swagger/runtime drift, but the exceptions endpoint
  under-fetches relative to what a dispatcher screen needs (bare
  deliveryId, no vendor/customer/driver context) - the query/entity
  needs to grow before that screen is built, not after.
- 10C readiness: DI seam and no-op strategy confirmed exactly as
  documented; RouteStop also has no lat/long, same gap as 10A.
- 10D readiness: zero cron infrastructure exists anywhere in the
  backend (no @nestjs/schedule) - confirmed needs to be introduced from
  scratch. GET /drivers/:id/performance is per-driver only, computed via
  in-process array operations, not SQL aggregation - fleet/zone rollups
  need genuinely new repository methods, not a parameter change to the
  existing one.
- 10E readiness: no sanitation or driver-certification schema exists.
  VendorDocumentsService.computeCanSell()/assertCanSell() (computed-on-
  read + assert-at-point-of-action, not a stored flag) is the confirmed
  precedent to replicate for driver cold-chain-cert gating.
- Event flow: exactly 2 listener classes, 13 emit sites, 13 matching
  listeners - zero dead-end emits. Analytics is confirmed 100% pull-
  based (no @OnEvent anywhere in that module). ColdChainAlertRaisedEvent
  has zero reverse coupling into Delivery/dispatch today, confirming
  10A's planned integration is genuinely new, not a regression.
  REAL GAP FOUND: DeliveryRejectedEvent (customer rejects a delivery)
  reaches FoodSafetyEventsListener but does NOT reach
  NotificationEventsListener - a customer rejecting a delivery today
  raises a FoodSafetyIncident but notifies no one via the notification
  pipeline. Tracked as a new Phase 12B deliverable (see below), not
  silently left open.
- Duplicate/dead models: VendorStatus/DriverStatus/FishermanStatus are
  three separately-declared enums with identical value sets (cosmetic
  duplication, not a bug - noted, not scheduled for consolidation, since
  it carries real migration risk for zero functional benefit).
  Fisherman.bankAccountName/bankAccountNumber are written but never read
  anywhere (write-only, ahead of an unbuilt fisherman-payout feature) -
  noted per this document's "never generate dead code" principle, left
  in place since it's forward-compatible infrastructure, not accidental
  dead code, and removing it would block whoever builds fisherman
  settlement later.

------------------------------------------------------------

PHASE 12B

Operational Readiness

STATUS

~ In Progress - gates Phase 13. No new customer-facing scope; closes the
operational gaps left open across Phases 10A-10E, 11, and 15 before the
roadmap moves on to Customer Trust. Phase 12B.0 (above) is complete;
10A-10E is now fully complete (see each phase's own STATUS above). All
that remains is the Analytics screens, DPP verification, dashboard
verification, architecture review, and final regression listed below.

Deliverables (added after Phase 12B.0)

- [DONE 2026-07-12] Wire DeliveryRejectedEvent into
  NotificationEventsListener (customer rejection currently notifies no
  one via the notification pipeline - found during Phase 12B.0,
  confirmed not previously known). The vendor (not the customer) is
  notified, since the customer already knows they rejected their own
  delivery, and a food-safety incident is simultaneously raised against
  their product via the pre-existing FoodSafetyEventsListener.

Purpose

Bring every already-shipped module from "backend exists" to "operations
staff can actually run the business on it" before starting new-scope
work. Phases 10A-10E and 15 were built with honest partial-completion
notes rather than silently claimed done - this phase is where those
notes get resolved, not accumulated further.

Deliverables

- [DONE 2026-07-12] Close the Phase 10A-10E gaps that are essential for
  operations (see the dedicated "PHASE 10A-10E EXECUTION PLAN" section
  below for the itemized breakdown per sub-phase - all five items
  shipped and independently committed).
- [DONE 2026-07-12] Build the four Analytics deliverables from Phase 15:
  Vendor Dashboard, Sales Analytics, Delivery Analytics, Inventory
  Analytics. Each ships as a GET /analytics/* endpoint (composing
  existing repositories/services, no duplicated aggregation logic) plus
  an apps/admin-dashboard screen following the established
  loading/error/empty-state + Card/Table pattern. (The fifth Phase 15
  deliverable, Admin Dashboard, was already substantially built:
  apps/admin-dashboard ships Dashboard Overview, Vendor Management,
  Driver Management, Delivery Zone & Fleet Management, Delivery
  Operations Center, Cold Chain Monitoring, and Recall Management.)
- [DONE 2026-07-12] Verify the Digital Product Passport / QR flow
  end-to-end. Confirmed: SeafoodLot.publicTraceToken is a required,
  unique, DB-default UUID (never left null); a real scannable QR PNG is
  generated server-side (qrcode package, GET /seafood-lots/:id/qr-code,
  vendor/admin only) encoding the public passport URL; the public
  GET /passport/:token endpoint resolves it with no auth. Existing e2e
  coverage: happy path (QR generation, 403 for a non-owning vendor, and
  the public passport lookup resolving lot/custody/coldChainSummary/
  certifications), plus 404 for an unknown token. Gap identified (not
  blocking): no e2e case yet covers a lot with a full linked
  catchItem/origin/certifications chain, only the catchItem-less
  partial-passport case - tracked as a follow-up, not silently dropped.
- [DONE 2026-07-12] Verify every dashboard and report shipped so far
  renders correct data. All 1283 backend unit tests and the full e2e
  suite (which hits real Postgres with real data assertions, and whose
  success proves the complete NestJS module graph - including this
  phase's DeliveryModule/FleetModule/ProductsModule/InventoryModule
  export changes - bootstraps cleanly) pass. 5 of 11 admin screens
  (Dashboard Overview, Vendor Dashboard, Sales Analytics, Delivery
  Analytics, Inventory Analytics) were additionally live-verified in
  browser against real accumulated dev-DB data with zero console
  errors; the other 6 had no frontend changes this phase beyond an
  additive, test-covered nav item and were live-verified in their
  original build phases (12A, 10B). Gap identified (not blocking):
  backend/prisma/seed.ts only seeds reference/config data (roles,
  categories, zones, tier configs, species, thresholds), not
  transactional data (vendors/orders/deliveries) - the realistic data
  observed in the dev DB comes from accumulated real e2e-test fixtures,
  not a dedicated seed script.
- [DONE 2026-07-12] Run a full architecture review across everything
  shipped in Phase 12B (data model, module boundaries, API envelope/DTO
  consistency, business-logic duplication, frontend consistency, dead
  code). No CLAUDE.md violations found (no any/@ts-ignore/eslint-disable/
  TODO/mock/dead code; all files well under the 400-line file / 500-line
  service caps; no duplicated aggregation logic - the 4 new Analytics
  methods are pure composers reusing existing repositories/services);
  no circular module imports introduced. Two non-blocking style items
  noted: ProductsRepository.findAllForAvailability() does a full table
  scan with no pagination (fine at current scale, revisit if catalog
  volume grows materially), and VendorOrdersRepository's two revenue-
  ranking methods sort via slightly different Decimal-comparison idioms.
- Run the full monorepo regression suite (typecheck, lint, unit, e2e,
  frontend component tests) clean on top of the architecture review's
  findings being addressed. In progress - each individual Phase 12B
  commit was already independently fully verified (typecheck/lint/unit/
  e2e clean across all 5 workspaces at commit time), but the single
  final pass across everything together has not yet run.

Acceptance

- Every item in the Phase 12B Deliverables list above is closed or has
  an explicit, documented reason it was deferred (never silently
  dropped).
- The Platform Maturity Matrix (below) shows Delivery, Food Safety, and
  Admin Dashboard all upgraded from their current Phase 12B-start
  classification to Production Ready or Operationally Ready with no
  open essential-for-operations gaps.
- Full monorepo typecheck/lint/unit/e2e/component-test suite passes
  clean.
- No regression in any previously-shipped phase.

Dependencies

- Phase 10, 10A-10E
- Phase 11
- Phase 15 (Admin Dashboard slice)

------------------------------------------------------------

PHASE 10A-10E EXECUTION PLAN

STATUS: ✓ All 5 sub-phases complete (2026-07-12) - kept below as the
historical record of what was planned and the scope decisions made along
the way; see each phase's own STATUS block above for what actually
shipped.

(Referenced by Phase 12B's Deliverables above - itemized per sub-phase,
in dependency order. Each item closes a gap explicitly called out in
that sub-phase's own STATUS note earlier in this document.)

10A - Fleet Dispatch Engine

SCOPE DECISION (Phase 12B.0 finding): no Vendor lat/long exists anywhere
in the schema, so literal distance-to-pickup cannot be computed. Using
zone-match as the proximity proxy instead of real distance - adding
geocoding is a separate, larger scope decision left for later, not
smuggled into this pass.

1. Design and implement an actual dispatch-scoring algorithm (zone
   match, driver availability, cold-chain eligibility, current load) that
   ranks candidate driver/fleet-asset pairs for a given delivery run, and
   feeds the winning candidate into the existing
   PATCH /delivery-runs/:id/assign seam (already links driverId+
   fleetAssetId to a DeliveryRun - not being rebuilt from scratch).
   Claim-based assignment (POST /delivery/assign) remains available as
   fallback/manual-override, not replaced.
2. FleetAsset-to-DeliveryRun linking already exists via the assign seam
   above - no separate linking work needed, confirmed by Phase 12B.0.
3. Add a weightLbs field to Product (source of truth) and enforce
   Driver.capacityLbs against it - Driver.capacityLbs is nullable, so
   null capacity must have a defined behavior (treat as unlimited, not
   as excluded from candidates, since most seeded drivers have no
   capacity set and excluding them all would starve the candidate
   pool). Reuse/replace DriverSettlementEngine.computePoundsEquivalent()
   rather than building a second, parallel weight-estimation path.
4. New DispatchDecisionLog table (not a repurposed ComplianceAuditLog -
   different module, different entity semantics per Phase 12B.0):
   records every automated assignment decision (candidates considered,
   score, why the winner won) for later review and for Phase 12B's
   architecture-review verification pass.
5. Unit + e2e tests for the scoring algorithm and capacity enforcement.

10B - Delivery Operations Center

1. Build the dispatcher-facing admin-dashboard screen(s): live delivery
   queue, pickup queue, exception queue, vehicle maintenance alerts,
   driver online/busy/offline visibility - reusing the existing
   GET /vendors/me/pickup-queue and GET /delivery/exceptions endpoints
   plus whatever new endpoints 10A's dispatch audit log needs.
2. Decide and implement a "live enough" update strategy - a real
   WebSocket layer is likely out of scope for this pass; polling on a
   short interval (matching the admin-dashboard's existing React Query
   refetch pattern) is an acceptable interim answer, but the choice
   must be explicit and documented, not silently deferred again.
3. Wire vehicle-maintenance alerts to actually notify (FleetMaintenance
   records exist; nothing today pushes a notification when one is
   created/status changes) - reuse the NotificationEventsListener
   pattern established for cold-chain/recall events.
4. Component tests for the new dispatcher screens, matching the
   existing admin-dashboard screen test pattern.

10C - Advanced Route Optimization

1. Replace the no-op RouteOptimizationStrategy with a real single-stop
   implementation at minimum (e.g. straight-line/haversine-based ETA
   plus zone-aware sequencing); full multi-stop TSP-style optimization
   can remain a documented stretch goal behind the same DI seam if time
   does not allow it in this phase, but the no-op must not ship as the
   final state of Phase 12B.
2. Confirm the existing DeliveryRun/DeliveryRunStop scaffolding is
   actually exercised by the new strategy, not still dead code.
3. Unit tests for the new strategy's distance/sequencing logic.

10D - Delivery Analytics & SLA

1. Define what "SLA" means concretely for this platform (e.g. pickup
   within N minutes of ready-for-pickup, delivery within the customer's
   selected window) - this does not exist as a concept anywhere yet.
2. Build SLA breach detection. This needs *some* form of scheduled
   check since there is no job-queue/scheduler in this codebase today -
   evaluate the smallest viable option (a cron-triggered NestJS
   @Cron task is the natural fit given the existing stack) rather than
   introducing a new infrastructure dependency for this alone.
3. Add fleet utilization metrics (asset idle vs. active time) and zone
   performance metrics (rollups across drivers/zones, distinct from the
   existing per-driver performance endpoint).
4. Surface SLA/fleet/zone metrics in the Delivery Analytics admin
   dashboard screen from Phase 12B's Deliverables above - this sub-item
   and that dashboard screen should ship together, not separately.

10E - Advanced Cold Chain & Fleet Sanitation

1. Confirm whether real IoT device telemetry integration is actually
   in scope for this platform's current stage, or whether "telemetry
   hooks" should instead mean a well-defined ingestion API contract
   that a future device integration can call - resolve this as a scope
   question before writing code, since it changes the shape of the
   work substantially.
2. Add a vehicle sanitation record schema + admin/driver-facing
   recording flow (no schema exists for this today).
3. Add driver cold-chain certification tracking (no schema exists for
   this today) - status, issue/expiry date, and a compliance gate
   consistent with how vendor compliance already gates selling.
4. Confirm whether the existing TemperatureAlert mechanism is
   sufficient for "spoilage and contamination alerts" as originally
   scoped, or whether a distinct alert type is warranted - likely the
   former, but state the decision explicitly rather than leaving it
   ambiguous.

------------------------------------------------------------

PLATFORM MATURITY MATRIX

Decision-making tool for choosing the next phase based on overall
platform readiness, not just original sequencing. Update this table
whenever a phase's status materially changes - it should never go stale
the way phase STATUS markers did before this revision.

| Module          | Status               |
| --------------- | --------------------- |
| Authentication  | Production Ready      |
| Marketplace     | Production Ready      |
| Orders          | Production Ready      |
| Inventory       | Production Ready      |
| Vendor Tiers    | Production Ready      |
| Delivery        | Operationally Ready   |
| Food Safety     | Operationally Ready   |
| Payments        | Production Ready      |
| Notifications   | Production Ready      |
| Admin Dashboard | In Progress           |
| Reviews         | Not Started            |
| AI              | Planned                |

Definitions:

- Production Ready: fully built, tested, and verified against real
  data; no known essential gaps.
- Operationally Ready: the core workflow is real and safe to run, but
  documented gaps remain in automation, tooling, or edge-case coverage
  (see that module's phase STATUS note for the specific list).
- In Progress: partially built; a meaningful slice is shipped and
  usable, but stated deliverables remain incomplete.
- Not Started: no implementation exists.
- Planned: intentionally deferred to a future phase; not expected yet.

Phase 12B's Acceptance criteria requires moving Delivery, Food Safety,
and Admin Dashboard off their current classifications before Phase 13
begins. Delivery's remaining gap, now that 10A-10E is fully shipped
(2026-07-12), is narrow: the mobile driver app (Phase 10's own remaining
item, unrelated to 10A-10E) and the DeliveryRejectedEvent notification
gap above. Not yet promoted to Production Ready here, deliberately - that
promotion is reserved for Phase 12B's own verification-against-seeded-
data and architecture-review passes, not claimed early just because the
backend work landed.

------------------------------------------------------------

PHASE 13

Customer Trust

STATUS

Not Started - no Review or Rating model exists anywhere in the schema;
VendorProfile's recentReviews field is a permanently-empty placeholder.
Blocked on Phase 12B (see that phase's Acceptance criteria) before
starting, per this document's own "never skip dependencies" rule.

Deliverables

Reviews

Ratings

Vendor Badges

Freshness Scores

Compliance Scores

Acceptance

Marketplace transparency completed.

------------------------------------------------------------

PHASE 14

Notifications

STATUS

✓ Complete - centralized NotificationsService, event-driven listener
(NotificationEventsListener), seeded templates, and Email/Push/In-App
channel adapters all built; SMS remains explicitly future-scope per
notification-standards.md, not a gap in this phase.

Deliverables

Email

SMS

Push Notifications

Driver Alerts

Vendor Alerts

Customer Alerts

Acceptance

All workflow events generate notifications.

------------------------------------------------------------

PHASE 15

Analytics

STATUS

~ In Progress - Admin Dashboard is substantially built
(apps/admin-dashboard: Dashboard Overview, Vendor Management, Driver
Management, Delivery Zone & Fleet Management, Cold Chain Monitoring,
Recall Management, backed by a new AnalyticsModule). Vendor Dashboard,
Sales Analytics, Delivery Analytics, and Inventory Analytics do not
exist yet - these four are Phase 12B's Deliverables, not deferred
indefinitely.

Deliverables

Admin Dashboard

Vendor Dashboard

Sales Analytics

Delivery Analytics

Inventory Analytics

Acceptance

Operational reporting complete.

------------------------------------------------------------

PHASE 16

AI Marketplace

STATUS

Planned - correctly not started; nothing in this phase should begin
before Phase 15 (Analytics) is Production Ready, since AI features
depend on the analytics data this phase produces.

Future

Deliverables

Demand Forecasting

Inventory Prediction

Dynamic Pricing

Route Optimization

Vendor Recommendations

Customer Recommendations

Acceptance

AI modules operational.

------------------------------------------------------------

GLOBAL RULES

Before beginning any phase:

Review previous phase.

Confirm dependencies.

Review related markdown specifications.

Never duplicate functionality.

------------------------------------------------------------

IMPLEMENTATION ORDER

Infrastructure

↓

Authentication

↓

Marketplace

↓

Vendor Management

↓

Orders

↓

Inventory

↓

Vendor Tiers

↓

Marketplace Intelligence

↓

Delivery

↓

Food Safety

↓

Payments

↓

Operational Readiness (Phase 12B)

↓

Reviews

↓

Notifications

↓

Analytics

↓

AI

------------------------------------------------------------

DO NOT IMPLEMENT EARLY

Do not build:

Payment logic before Inventory.

Driver settlement before Delivery.

Vendor settlement before Payments.

Reviews before Orders.

Reviews before Phase 12B (Operational Readiness) is complete - see that
phase's Acceptance criteria and the Platform Maturity Matrix.

Traceability before Inventory.

AI before Analytics.

------------------------------------------------------------

CLAUDE EXECUTION RULE

Before implementing any feature:

1. Locate the current roadmap phase.

2. Verify dependencies are complete.

3. Review all related specification files.

4. Generate an implementation plan.

5. Modify existing code before creating new code.

6. Preserve backward compatibility.

7. Write tests before marking the phase complete.

8. Update documentation after implementation.

No implementation may violate this roadmap.