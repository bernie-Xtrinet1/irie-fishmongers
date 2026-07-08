# IRIE FISHMONGERS
# PROJECT STATUS

Version: 2.1

Last Updated:

2026-07-07

---

# PURPOSE

Track implementation progress.

Provide Claude with the current project state.

Prevent duplicate work.

Prevent skipped dependencies.

This document must be updated whenever a phase is completed.

---

# RECONCILIATION NOTE

The numbered phase order in this file (and in `.claude/roadmap.md`) does not
match the actual build order - phases were implemented in dependency order
as the platform grew, not strictly in roadmap sequence (e.g. Delivery,
Payments, and Settlement shipped before Inventory Management and Vendor
Tier Architecture). Status below reflects what has actually been merged
into `develop`/`main`, verified via `git log --grep`, not the original
sequential plan. Always trust this file's Status field over phase order.

---

# IMPLEMENTATION STATUS

Repository Foundation

Status

✅ Complete

Branch

main

Tests

Passed

Documentation

Complete

---

Infrastructure

Status

✅ Complete

Branch

main

Tests

Passed

Documentation

Complete

---

Authentication

Status

✅ Complete

Branch

main

Tests

Passed

Documentation

Complete

---

Marketplace

Status

✅ Complete

Branch

main

Tests

Passed

Documentation

Complete

---

Vendor Management

Status

✅ Complete

Branch

main

Tests

Passed

Documentation

Complete

---

Order Management

Status

✅ Complete

Branch

main

Tests

Passed

Documentation

Complete

---

Payments

Status

✅ Complete

Branch

develop

Tests

Passed

Documentation

Complete

---

Delivery

Status

✅ Complete

Branch

develop

Tests

Passed

Documentation

Complete

---

Driver Settlements

Status

✅ Complete

Branch

develop

Tests

Passed

Documentation

Complete

---

Vendor Settlements

Status

✅ Complete

Branch

develop

Tests

Passed

Documentation

Complete

---

Food Safety / Cold Chain / Traceability

Status

✅ Complete

Branch

develop

Tests

Passed

Documentation

Complete

---

Notifications

Status

✅ Complete

Branch

develop

Tests

Passed

Documentation

Complete

---

Vendor Tier Architecture

Status

✅ Complete

Branch

develop

Tests

Passed

Documentation

Complete

Notes

Initial build (tier enum, permissions, feature flags, compliance rules,
tier upgrades/downgrades) shipped via `feature/vendor-tiers`. A
gap-closure pass later wired `VendorDocumentsService.assertCanSell()`
into `ProductsService.create()` (previously only enforced at tier-upgrade
approval) and added `GET /vendors/me/compliance-status`.

---

Marketplace Intelligence

Status

✅ Complete

Branch

develop

Tests

Passed

Documentation

Complete

Notes

Delivered as the three-part "Marketplace Selection Engine" work: mode/weight
governance config, the scoring engine + audit trail
(FulfillmentDecision/VendorScore/VendorAssignment), and the Best Available
Vendor customer-facing flow.

---

Inventory Management

Status

✅ Complete

Branch

develop

Tests

Passed

Documentation

Complete

Notes

Redis-backed soft-hold reservations (15-min TTL, lazy expiry) gate
`POST /cart/items` / `PATCH /cart/items/:itemId`. Durable, append-only
`InventoryEvent` audit trail (DECREMENTED / RESTOCKED / MANUAL_ADJUSTMENT)
written at checkout, cancellation/rejection, and manual vendor stock edits.
`POST /inventory/reconcile` is on-demand (admin-triggered), not a scheduled
job - see Reconciliation Note in `.claude/inventory/reservation-expiration.md`.
Full design rationale in `docs/database-design.md`'s "Inventory Management
Tables" section.

---

Reviews

Status

Next

Dependencies

Orders

Delivery

---

Reporting / Analytics

Status

Planned

Dependencies

All operational modules

---

AI Marketplace

Status

Future

Dependencies

Analytics

Inventory

Orders

---

# CURRENT PRIORITY

Current Phase

Reviews (Customer Trust)

Dependencies

Orders (done)

Delivery (done)

Primary Deliverables

Reviews

Ratings

Vendor Badges (partially done - tier badge exists; rating-derived badge does not)

Freshness Scores

Compliance Scores (partially done - `Vendor.complianceScore` field exists
but is not yet computed by any scoring engine)

---

# OPEN ARCHITECTURAL ITEMS

Reviews / Ratings Engine (no `Review`/`Rating` model exists yet)

Reporting / Analytics Dashboards (Admin, Vendor, Sales, Delivery, Inventory)

AI Marketplace (Future - not started)

---

# CURRENT TECH STACK

Backend

NestJS

Database

PostgreSQL

ORM

Prisma

Cache

Redis

API

REST

Documentation

Swagger

Testing

Jest

---

# IMPLEMENTATION METRICS

Modules Completed

15

Modules Planned

3 remaining (Reviews, Reporting/Analytics, AI Marketplace)

Core Domains Implemented

Authentication

Marketplace

Vendor Management

Vendor Tier Architecture

Orders

Inventory

Delivery

Payments

Settlement (Driver + Vendor)

Food Safety / Cold Chain / Traceability

Notifications

Marketplace Intelligence

Core Domains Remaining

Reviews

Reporting / Analytics

AI Marketplace

---

# CLAUDE EXECUTION RULE

Before beginning work:

Review this file.

Verify current phase.

Confirm dependencies.

Do not implement future phases early.

Update this document after completing every phase.

Mark completed phases.

Record:

Date

Branch

Tests

Coverage

Documentation

Migration Notes

Breaking Changes (if any)

This document is the authoritative implementation status for the project.
