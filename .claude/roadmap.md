# IRIE FISHMONGERS PLATFORM
# IMPLEMENTATION ROADMAP

Version: 2.1

Last reviewed: 2026-07-12 - audited every phase's STATUS against the
actual codebase (schema, modules, apps/ directories) rather than trusting
prior status text alone. Corrected several phases that had no STATUS
marker at all despite being substantially built (11, 12, 14), and phases
that claimed nothing despite being real gaps (10A-10E, 15). Added Phase
12B (Operational Readiness) as a new gating phase before Phase 13, plus a
Platform Maturity Matrix as a standing decision-making tool.

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

~ Operationally Ready (core workflow shipped; dispatch automation, live
ops UI, and mobile driver app remain open - see Phase 12B)

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

~ Partially Shipped - no automatic dispatch algorithm exists yet
(assignment is still driver-initiated claim); see Phase 12B execution
plan.

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

~ Partially Shipped - backend data/endpoints exist, no dispatcher UI, no
real-time updates; see Phase 12B execution plan.

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

~ Mostly Shipped - scaffolding and DI seam exist, but the only registered
strategy is a no-op passthrough (no real optimization algorithm); see
Phase 12B execution plan.

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

~ Partially Shipped - on-time/driver performance metrics exist; no SLA
breach tracking, fleet utilization, or zone performance rollups; see
Phase 12B execution plan.

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

~ Partially Shipped - extended checkpoints, fleet maintenance, and
rejection-triggered incidents exist; no telemetry hooks, vehicle
sanitation records, or driver cold-chain certification tracking; see
Phase 12B execution plan.

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

PHASE 12B

Operational Readiness

STATUS

Not Started - this phase gates Phase 13. No new customer-facing scope;
it closes the operational gaps left open across Phases 10A-10E, 11, and
15 before the roadmap moves on to Customer Trust.

Purpose

Bring every already-shipped module from "backend exists" to "operations
staff can actually run the business on it" before starting new-scope
work. Phases 10A-10E and 15 were built with honest partial-completion
notes rather than silently claimed done - this phase is where those
notes get resolved, not accumulated further.

Deliverables

- Close the Phase 10A-10E gaps that are essential for operations (see
  the dedicated "PHASE 10A-10E EXECUTION PLAN" section below for the
  itemized breakdown per sub-phase).
- Build the four Analytics deliverables from Phase 15 that don't exist
  yet: Vendor Dashboard, Sales Analytics, Delivery Analytics, Inventory
  Analytics. (The fifth Phase 15 deliverable, Admin Dashboard, is
  already substantially built: apps/admin-dashboard ships Dashboard
  Overview, Vendor Management, Driver Management, Delivery Zone & Fleet
  Management, Cold Chain Monitoring, and Recall Management.)
- Verify the Digital Product Passport / QR flow end-to-end (scan a
  generated QR, confirm it resolves to the correct public traceability
  page, confirm it degrades sensibly for a recalled/quarantined lot).
- Verify every dashboard and report shipped so far actually renders
  correct data against a realistic seeded dataset, not just against
  the narrow fixtures used in unit/e2e tests.
- Run a full architecture review across everything shipped since the
  last such review (data model, module boundaries, security posture,
  N+1 query risk, dead code) - not just a regression test pass.
- Run the full monorepo regression suite (typecheck, lint, unit, e2e,
  frontend component tests) clean, on top of the architecture review's
  findings being addressed.

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

(Referenced by Phase 12B's Deliverables above - itemized per sub-phase,
in dependency order. Each item closes a gap explicitly called out in
that sub-phase's own STATUS note earlier in this document.)

10A - Fleet Dispatch Engine

1. Design and implement an actual dispatch-scoring algorithm (zone
   match, driver availability, cold-chain eligibility, current load,
   distance-to-pickup) that ranks candidate driver/fleet-asset pairs
   for a given delivery run - replacing today's driver-initiated claim
   as the only assignment path. Keep claim-based assignment available
   as a fallback/manual-override, not a hard replacement.
2. Link FleetAsset records to individual DeliveryRun/delivery
   assignments (today fleet assets exist but aren't attached to a
   specific delivery).
3. Enforce Driver.capacityLbs against real order weight - requires
   adding a weight field to Product/OrderItem first (does not exist
   today), then wiring the capacity check into assignment.
4. Dispatch audit log: record every automated assignment decision
   (candidates considered, score, why the winner won) for later review
   and for Phase 12B's architecture-review verification pass.
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
begins.

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