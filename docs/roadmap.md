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
Customer Trust — FEATURE-COMPLETE; final regression sign-off PENDING
(marketplace transparency)

Status precisely:
- Features + isolated verification: complete (typecheck, lint, unit,
  component, and each e2e spec pass on its own).
- Full backend e2e regression: NOT yet reliably green. The whole suite
  run together produces nondeterministic cross-suite failures (shared
  Postgres). CI runs these specs in PARALLEL with no maxWorkers cap, so
  this must be fixed before the phase is signed off as regression-green.
  Blocked on the "Fix backend e2e cross-suite DB isolation" task.
  Sign-off bar: two consecutive clean full-suite runs locally AND in CI.
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
- Backend e2e cross-suite DB isolation (HIGH priority; blocks Phase 13
  regression sign-off) — the full suite flakes on a shared Postgres (each
  spec passes in isolation; failures vary run to run with the signature
  "No record was found for an update"). CI runs `test:e2e` in PARALLEL
  (jest-e2e.json sets no maxWorkers) against one DB, so this surfaces as
  nondeterministic CI red. Tracked as its own task. Acceptance criteria:
  every spec uses isolated data / no suite mutates another's records /
  async event listeners settle before cleanup / the full suite exits
  non-zero on any failure / two consecutive full-suite runs pass locally
  AND in GitHub Actions. Note: the CI command itself does NOT mask the
  exit code (`npm run test:e2e -w backend`, no tail/`|| true`); the
  earlier "exit 0 with failures" was an artifact of ad-hoc local command
  wrappers, not a CI or Jest defect.
