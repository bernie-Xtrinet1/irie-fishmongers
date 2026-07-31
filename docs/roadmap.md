Phase 1
Repository Setup

Phase 2
Infrastructure

Phase 3
Authentication

Phase 4
Marketplace

Phase 5
Orders

Phase 6
Payments

Phase 7
Delivery

Phase 8
Mobile Apps

Phase 9
Admin Dashboard

Phase 10
Delivery & Logistics (zones, fleet, route optimization)

Phase 11
Food Safety & Cold Chain Compliance (traceability chain, species
management, cold-chain IoT thresholds, compliance dashboard/reporting/
audit log/documents, regulatory certifications, emergency response,
waste disposal, recall notifications, Digital Product Passport + QR)

Phase 12
Analytics & Operational Readiness (admin dashboard analytics: vendor/
sales/delivery/inventory dashboards, dispatch scoring, delivery
operations center, SLA breach tracking, vehicle sanitation + driver
cold-chain certs)

Phase 13
Customer Trust — COMPLETE; CI green (marketplace transparency)

Status precisely:
- Features + isolated verification: complete (typecheck, lint, unit,
  component, and each e2e spec pass on its own).
- Full backend e2e regression: NOW green locally — 3 consecutive clean
  full-suite runs (19 suites / 132 tests) after the isolation fix
  (ENABLE_SCHEDULER scheduler-disable + awaited fleet emit + 60s e2e
  timeout). The nondeterministic cross-suite P2025 was two unhandled
  async DB writes outliving their request (a wall-clock @Cron tick and a
  fire-and-forget event emit) racing another suite's teardown. Remaining:
  confirm green in GitHub Actions (runs e2e in PARALLEL; jest-e2e.json
  still has no maxWorkers cap — pin maxWorkers:1 if parallel CI flakes).
- Customer review SUBMISSION UI: deferred (see below). The backend
  create/edit/delete/restore API and all read/moderation surfaces are
  complete; ordinary customers cannot yet submit a review through the web
  UI. "Reviews are live via the API + read surfaces", not via a customer
  web form.

Delivered:
- Reviews & Ratings: Review model tied to a completed VendorOrder,
  eligibility windows, one-review-per-purchase (partial unique indexes),
  soft-delete + author restore. Customer CRUD API complete and tested;
  customer web submission UI deferred.
- Moderation: admin review queue with reason-required removal committed
  transactionally with an immutable ReviewAuditLog.
- Compliance Score: composite score from temperature/inspection/recall/
  certification signals, write-through cache maintained by event
  listeners + a nightly America/Jamaica cron, one-time backfill CLI,
  public bands (Excellent/Good/Fair/Needs Improvement/Not yet assessed).
- Freshness/Quality Score surfaced publicly on product detail.
- Vendor Badges: already satisfied by the existing VendorTierBadge.
- Frontend: accessible StarRating (packages/ui), storefront ratings +
  review lists + compliance band, admin Review Moderation screen.

Deferred / follow-ups (recorded, not forgotten):
- Customer write-a-review flow on apps/web — needs a logged-in customer
  session and an order-history surface to gate on GET /reviews/eligibility
  (the storefront is anonymous browse-only today). Backend create/edit/
  delete/restore endpoints already exist and are tested.
- Admin restore of an admin-removed review + customer appeal workflow —
  explicitly out of Phase 13 scope; the audit trail already captures the
  data a future restore/appeal feature needs.
- Backend e2e cross-suite DB isolation — RESOLVED locally (commits
  76b7907 / 8ec3892 / c1299f9): the shared-Postgres P2025 flakiness came
  from two unhandled async DB writes outliving their request (a wall-clock
  @Cron tick; a fire-and-forget event emit) racing another suite's
  teardown, plus a 20s timeout too tight for heavy workflow tests. 3
  consecutive clean full-suite runs; zero P2025 across 6 runs. Remaining:
  (a) confirm green in GitHub Actions, which runs e2e in PARALLEL — if
  parallel CI flakes, pin `maxWorkers: 1` in jest-e2e.json (or move to
  per-worker DBs); (b) the broader per-worker-DB isolation task remains a
  nice-to-have for defense in depth, not a blocker. The CI command does
  NOT mask the exit code; the earlier "exit 0 with failures" was an
  artifact of ad-hoc local command wrappers (tail / trailing echo).

2026-07-31 reconciliation: lint, typecheck, build, and test:cov (187 suites
/ 1409 tests, coverage 96.7% stmts / 91.9% branch) all reproduce green
against current `develop` HEAD, run both serially and with
`--detectOpenHandles` (zero leaked handles found; the cron is inert under
unit tests — no `ScheduleModule.forRoot()` is registered by any spec). e2e
was not independently re-run in that session. Phase 13 is COMPLETE.

------------------------------------------------------------

Phase 14
Notifications — COMPLETE. Centralized NotificationsService, event-driven
listener (NotificationEventsListener), seeded templates, Email + Push +
In-App channel adapters. SMS is explicitly future-scope per
`.claude/rules/notification-standards.md`, not a gap in this phase.

------------------------------------------------------------

Phase 15
Analytics — COMPLETE. Backend AnalyticsModule
(`backend/src/modules/analytics`) plus five admin-dashboard screens:
Dashboard Overview, Vendor Dashboard, Sales Analytics, Delivery Analytics,
Inventory Analytics — each with a tested view component
(`apps/admin-dashboard/components/{vendor-dashboard,sales-analytics,
delivery-analytics,inventory-analytics}/*.test.tsx`, 17 tests passing).

Documentation close-out (tracked, not yet done): the five analytics
endpoints have no entry in `docs/api-spec.md` —
`/analytics/dashboard-summary`, `/analytics/vendor-dashboard`,
`/analytics/sales-analytics`, `/analytics/delivery-analytics`,
`/analytics/inventory-analytics`. Each has Swagger decoration in
`backend/src/modules/analytics/controllers/`, so the source of truth
exists; it just is not yet transcribed into `docs/api-spec.md`. See the
gap note in that file. This is a documentation task, not an application
gap — no analytics code needs to change.

------------------------------------------------------------

Phase 16
Jamaican Seafood Marketplace Operating Model — NOT STARTED. The core
pre-production requirement: the operational marketplace through which
community fishers, seafood vendors, and commercial fishing businesses
publish daily available seafood, and customers search, reserve, purchase,
and receive or collect those products. Full requirements, sub-phase
breakdown (16A–16F), and design docs: see
`docs/product/jamaican-seafood-marketplace-requirements.md` and the linked
operations/UX/domain documents it indexes. This phase must be implemented,
and its own acceptance criteria met, before Phase 17 (UAT) begins — UAT
must validate the platform as it is actually intended to operate, which
means the marketplace operating model has to exist first.

Sub-phases:

- 16A — Catalogue and Regulatory Foundation
- 16B — Vendor Daily Catch and Stock Listings
- 16C — Customer Available-Today Marketplace
- 16D — Weight, Reservation, and Order Adjustment
- 16E — Platform-Managed Pickup and Collection
- 16F — Marketplace Protection and Operational Controls

Dependencies: Species, Category, Product, Catch, CatchItem, SeafoodLot,
Inventory (reservations), MarketplaceModeConfig / vendor-scoring /
allocation engine — all already exist and are the intended reuse surface;
see the ADRs below for what is reused vs. newly modeled.

------------------------------------------------------------

Phase 17
UAT and Production Readiness — PLANNING (revised from the prior draft on
the now-superseded `phase-17-uat-production-readiness` branch, renumbered
to follow the Marketplace Operating Model rather than precede it). Full
plan: `docs/uat/phase-17-uat-production-readiness.md`. UAT validates the
complete Phase 16 workflow — catalogue → daily listing → available-today
marketplace → customer selection → reservation → payment → vendor
acceptance → preparation → delivery or platform-managed pickup → QR/PIN or
proof of delivery → settlement → reporting — not the pre-Phase-17
transactional flow alone. Blocked on Phase 16 being implemented.

Azure is the target production cloud (decided 2026-07-19); credentials are
not yet available. Azure credentials block only Azure infrastructure
provisioning (the Phase 17 sub-unit that stands up the UAT/production
environment) — they do not block Phase 16 design or implementation, and
they do not block the credential-independent parts of Phase 17 (UAT script
authoring, seed-data planning, security-review checklists).

------------------------------------------------------------

Phase 18
AI Marketplace — NOT STARTED, deferred. Demand Forecasting, Inventory
Prediction, Dynamic Pricing, AI Route Optimization, Vendor
Recommendations, Customer Recommendations. This phase has been renumbered
twice as planning evolved (informally "16" in the now-retired
`.claude/roadmap.md`, briefly "19" in an earlier draft of this document) —
"18" is the current and only authoritative number; see
`.claude/roadmap.md`'s pointer to this file for why the old numbering no
longer applies. Do not begin until Phase 16 (Marketplace Operating Model)
is implemented, Phase 17 (UAT) is complete, and sufficient production or
realistic marketplace data exists to train/validate against — starting
sooner has no real data to work from and risks premature, unvalidated
automation over a transactional and food-safety-sensitive marketplace.

Note: `backend/src/modules/delivery`'s existing parish-clustering route
optimization (deterministic heuristic, Phase 10's Delivery & Logistics
deliverable) is not part of this phase and is not superseded by it — this
phase's "AI Route Optimization" is a distinct, future, ML-driven
capability.

------------------------------------------------------------

Carried-forward technical notes (from the retired `.claude/roadmap.md`)

Verified against current code during the 2026-07-31 reconciliation before
that file was retired to a pointer. These three were still genuinely
current (most of the file's other flagged gaps had since been closed in
code and are correctly not carried forward — e.g. `Product.weightLbs` now
exists and dispatch scoring now enforces real order weight against
`Driver.capacityLbs`; `DeliveryRejectedEvent` now reaches
`NotificationEventsListener`; the mobile driver app exists at
`apps/driver-app`):

- **`OrderItem` still carries no weight field**, even though `Product` now
  has `weightLbs`. Relevant to Phase 16D (Weight, Reservation and Order
  Adjustment, see
  `docs/domain/seafood-inventory-weight-and-reservation-rules.md`) -
  that sub-phase's estimated/final-weight work should establish where an
  order's actual weight is captured, since today it isn't captured on the
  order at all, only inferred from the product at dispatch time.
- **No role-wide "notify all administrators" recipient lookup exists** in
  the Notifications module - `ColdChainAlertRaisedEvent` and
  `FleetMaintenanceOverdueEvent` notify only the directly-involved
  driver/vendor, not an admin broadcast list. Relevant to Phase 16F
  (Marketplace Protection and Operational Controls,
  `docs/operations/marketplace-operating-model.md`) - its off-platform-
  leakage and pickup-no-show alerting depends on *some* admin-facing
  channel, and today that is the admin dashboard's own polling, not a
  push/email broadcast, since the underlying recipient lookup does not
  exist. Not a blocker (the dashboard channel is real), but Phase 16F
  implementation should not assume a broadcast mechanism it would need to
  build first.
- **`VendorStatus`/`DriverStatus`/`FishermanStatus` remain three separate,
  identically-valued enums**, deliberately not consolidated - the original
  call was that consolidation carries real migration risk for zero
  functional benefit, still true today. Recorded so a future refactor
  doesn't "fix" this without knowing it was a deliberate decision, not an
  oversight.
