# ADR-006 Platform-Managed Pickup and Verified Collection

Status:
Proposed

Date:
2026-07-31

---

## Context

Phase 16E requires a **customer** collection flow: a customer collects
their own order directly from a vendor or a consolidated collection point,
verified by a QR code or a 6-digit PIN, with vendor settlement gated on a
confirmed handover.

The platform already has a **driver** pickup concept: the existing order
status workflow includes a "Ready For Pickup" → "Assigned To Driver" →
"In Transit" → "Delivered" sequence (`.claude/rules/business-rules1.md`'s
Order Status Workflow), where "pickup" means a driver collecting a prepared
order from a vendor for onward delivery to a customer. This is a
completely different actor and a completely different event from a
customer collecting their own order.

Reusing the same status/model vocabulary for both would create exactly the
kind of confusion `docs/operations/platform-managed-pickup-policy.md`
already warns against, and risks a genuine defect class: a customer
collection event being misrecorded as (or triggering the same downstream
effects as) a driver pickup event, or vice versa.

## Options considered

**Option 1 — Reuse the existing order-status "Ready For Pickup" step and
existing `Delivery` model for customer collection, distinguished only by a
flag.** Add a boolean like `Delivery.isCustomerCollection` to the existing
delivery/driver model.

*Pro*: no new model.
*Con*: `Delivery` is structurally about a driver-executed leg (driver
assignment, vehicle, route, in-transit tracking, proof-of-delivery photo/
signature) — none of which applies to a customer walking up to a vendor.
Forcing customer collection through this model means every `Delivery`
consumer (driver assignment services, route optimization, fleet dispatch)
must now branch on "is this actually a driver delivery," which is exactly
the kind of hidden special-casing `.claude/CLAUDE.md`'s "never create God
services" principle warns against. High risk of a driver-side query
accidentally including customer-collection rows, or vice versa.

**Option 2 — New `CustomerCollection` model, entirely separate from
`Delivery`, sharing only the `Order` it fulfills.** A customer-collection
order references `Order` the same way a `Delivery` does, but through its
own model: pickup location, collection window, QR/PIN credential, verified
handover record (who/when/where/method), late/no-show state.

*Pro*: structurally honest — a customer walking up to a vendor genuinely
is not a driver-executed delivery leg, and modeling it separately means
neither system needs to special-case the other. Matches the explicit
instruction that "customer pickup must not be confused with the existing
driver pickup workflow." Settlement-gating logic (§O of
`docs/operations/marketplace-operating-model.md`) can check "does a
verified `CustomerCollection` OR a `Delivery` proof-of-delivery exist for
this order" as two clearly separate conditions, rather than one
overloaded condition with a hidden flag.
*Con*: introduces one new model; any place that currently assumes "an
order's fulfillment record is a `Delivery`" must be updated to check for
either type — an explicit, reviewable change rather than an implicit one.

**Option 3 — Generalize `Delivery` into an abstract "fulfillment event"
model covering both driver delivery and customer collection.**

*Pro*: theoretically unifies reporting across both fulfillment methods.
*Con*: a large, speculative rework of an already-shipped, tested model
(Phase 7/10's Delivery Engine) for a benefit (unified reporting) that
Phase 15's existing Analytics infrastructure can already achieve by
querying across two clearly-named models instead. This is the premature
abstraction `.claude/CLAUDE.md`'s engineering principles warn against —
building a shared interface before there are two genuinely similar
concrete cases justifying it, when the two cases here are not actually
similar in mechanism (driver-executed vs. self-service).

## Decision

**Option 2.** A new `CustomerCollection` model, structurally independent
from `Delivery`, sharing only its reference to `Order`. This keeps the
existing, already-tested driver/Delivery Engine completely untouched by
Phase 16, and gives customer collection its own honest shape:

- `CustomerCollection` fields (indicative, finalized at implementation):
  `orderId`, `pickupLocationId` (vendor location or consolidated collection
  point), `collectionWindowStart`/`collectionWindowEnd`, `qrCodeToken`,
  `pin` (6-digit, hashed at rest same as any credential per
  `.claude/rules/security.md`), `status` (Pending / ReadyForPickup /
  Collected / LateCollected / NoShow), and a `CollectionEvent` audit-trail
  child record (verifying party, method used, timestamp, location) — the
  permanent collection audit history
  `docs/operations/platform-managed-pickup-policy.md` requires.
- An `Order` can have **either** a `Delivery` **or** a `CustomerCollection`
  fulfillment record (per the customer's checkout selection in
  `docs/ux/customer-seafood-marketplace.md`), never both for the same
  order-level fulfillment; a multi-vendor split order
  (`docs/domain/seafood-inventory-weight-and-reservation-rules.md`) may
  have one type per vendor portion.
- Settlement-eligibility logic checks for a confirmed `Delivery`
  proof-of-delivery **or** a `CustomerCollection` verified `CollectionEvent`
  — two explicit, separately-testable conditions (directly enabling
  MKT-04/MKT-05/MKT-06 in
  `docs/testing/marketplace-fulfilment-acceptance-plan.md`).

## Consequences

Positive

- The existing Delivery Engine, driver assignment, route optimization, and
  fleet dispatch code is untouched by Phase 16 — zero risk of a customer-
  collection order accidentally entering driver-assignment logic.
- QR/PIN verification, collection-window handling, and no-show/late
  handling get their own focused, testable model rather than overloaded
  conditionals inside `Delivery`.
- Reporting (Phase 15 Analytics) can query `CustomerCollection` and
  `Delivery` as two distinct, clearly-named fulfillment channels — closer
  to how the business actually thinks about "delivered" vs. "picked up,"
  and avoiding a misleading unified label.

Negative

- Any future genuinely-shared behavior between driver delivery and
  customer collection (e.g. a shared "fulfillment method" reporting rollup)
  must be built as a query-time join or a thin reporting view, not a shared
  base model — an intentional constraint given Option 3's rejection above,
  not an oversight.
- Two settlement-eligibility checks (`Delivery` vs. `CustomerCollection`)
  must both be kept correct and tested independently, rather than one
  check with an if-branch — slightly more code, in exchange for each path
  being independently reasoned about and independently testable
  (MKT-04/05/06 specifically depend on this separation being real).

## Implementation directive

Claude shall:

- Create `CustomerCollection` as its own Prisma model with its own
  migration, DTOs, and validation, per `.claude/CLAUDE.md`'s Database and
  API Rules — not as a field bolted onto `Delivery`.
- Never let driver-assignment, route-optimization, or fleet-dispatch
  services query or mutate `CustomerCollection` — those remain
  `Delivery`-only, unchanged.
- Hash the 6-digit PIN at rest and treat both the QR token and PIN as
  single-use, expiring credentials per `docs/operations/platform-managed-
  pickup-policy.md` — never log either in plaintext
  (`.claude/rules/security.md`'s logging rule).
- Gate vendor settlement on an explicit check for a confirmed `Delivery`
  OR a verified `CustomerCollection` — implemented as two conditions, not
  one overloaded flag.

This ADR takes precedence over an implementation that reuses `Delivery` for
customer collection without revisiting this decision.
