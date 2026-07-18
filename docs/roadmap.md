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
Customer Trust — COMPLETE (marketplace transparency)
- Reviews & Ratings: Review model tied to a completed VendorOrder,
  eligibility windows, one-review-per-purchase (partial unique indexes),
  soft-delete + author restore.
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
- Backend e2e cross-suite DB isolation — the full in-band run flakes on a
  shared Postgres (each spec passes in isolation). Tracked as its own
  task; make the run deterministic (per-worker DB / transactional reset /
  awaited-or-graceful async handlers).
