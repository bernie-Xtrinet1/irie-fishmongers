# Vendor Daily Catch and Stock Listing

Status: **Design, Phase 16 not started**
Roadmap: `docs/roadmap.md` Phase 16B (Vendor Daily Catch and Stock Listings)
Related: requirements C, D, E, I from
`docs/product/jamaican-seafood-marketplace-requirements.md`

## Purpose

Define how a vendor (Community Fisher, Fish Vendor, Commercial Supplier —
tier-aware per `.claude/CLAUDE.md`'s Vendor Tier Directive) publishes what
they actually have available *today*. This is the vendor-facing counterpart
to `docs/ux/customer-seafood-marketplace.md` and is what populates the
Available-Today marketplace.

## Reuse posture

A daily listing is **not** a new top-level domain object competing with
`Product`. It is:

- a reference to a master-catalogue entry (`Species`/`Category`, per
  ADR-005),
- backed by a `Product` row (the sellable unit: price, unit, vendor,
  quantity — the existing commerce shape already fits this),
- optionally backed by a `Catch`/`CatchItem`/`SeafoodLot` chain when the
  vendor is publishing a specific traceable catch (per
  `.claude/rules/seafood-compliance-rules.md`'s traceability chain: Sea →
  Fisherman → Landing Site → Vendor), for vendors/tiers where that chain
  applies.

ADR-005 decides exactly which fields belong on `Product` vs. a new
lightweight "daily listing" wrapper vs. reused `SeafoodLot` fields — this
document specifies the vendor-facing behavior those fields must support,
not the final schema.

## Creating a listing

1. **Select from master catalogue** — vendor picks a `Species`/catalogue
   entry (16A) rather than free-typing a product name; this is what makes
   the "standardized categories and names" requirement (B) actually enforced
   at the point of listing, not just aspirational.
2. **Catch or stock date** — when the seafood was landed/received. For a
   Community Fisher this is typically the catch date; for a vendor
   reselling received stock, the stock-receipt date. Required, drives
   freshness display and expiry defaults.
3. **Landing or source location** — where it was landed (fisherman/vessel
   flow, per the existing `Catch`/`Vessel` models) or received from (vendor
   restocking flow). Feeds the existing traceability disclosure
   (`.claude/rules/seafood-compliance-rules.md`'s Customer Safety
   Disclosures: catch date, vendor, landing site, freshness grade).
4. **Quantity uploaded** — the vendor's stated starting quantity for this
   listing.
5. **Selling unit and price** — one of pound, kilogram, item, package, case
   (existing `ProductUnit`, extended if ADR-005 finds a gap); price set per
   unit, per `.claude/rules/business-rules1.md`'s Product Rules.
6. **Expiry time** — when this listing stops being purchasable (see
   "Automatic expiry" below). Must not exceed any regulatory/seasonal
   constraint on the underlying catalogue item (16F enforces this).
7. **Actual-catch photograph(s)** — required, distinct from the catalogue's
   reference image; this is what the customer sees labelled as "today's
   catch" (`docs/ux/customer-seafood-marketplace.md`).
8. **Preparation options and fees** (optional per listing) — e.g. scaled,
   gutted, filleted; each option carries a fee the vendor sets, itemized
   separately from product price at checkout (per
   `docs/ux/customer-seafood-marketplace.md`).
9. **Pickup and/or delivery availability** — vendor declares which
   fulfillment method(s) this listing supports; feeds the checkout
   constraint in `docs/ux/customer-seafood-marketplace.md`.

## Quantity lifecycle

A listing's quantity moves through five states, all vendor- and
customer-visible on the listing (vendor sees the breakdown; customer sees
only quantity available):

```
Quantity Uploaded (vendor's starting figure)
  → Quantity Available  (uploaded minus reserved minus sold)
  → Quantity Reserved   (soft-held against in-progress checkouts, see
                          docs/domain/seafood-inventory-weight-and-reservation-rules.md)
  → Quantity Sold       (confirmed orders)
  → Quantity Remaining  (available, restated for vendor-facing clarity)
```

This must reuse, not duplicate, the existing Inventory Management event
trail (`InventoryEvent`: DECREMENTED / RESTOCKED / MANUAL_ADJUSTMENT) and
the Redis-backed soft-hold reservation system already gating
`POST /cart/items` — see
`docs/domain/seafood-inventory-weight-and-reservation-rules.md` for exactly
how a daily listing's quantity fields map onto that existing system.

## Repeat previous listing

A vendor who lists the same catalogue item routinely (e.g. snapper, every
day they fish) can create a new day's listing by copying yesterday's
listing's static fields (catalogue item, selling unit, default preparation
options, default pickup/delivery availability) and only re-entering what
actually changes daily: catch date, quantity, price, expiry time, and a
new actual-catch photo (the photo must never be silently carried over from
a prior day — it is required fresh, every listing, per requirement E). This
is a vendor-experience convenience feature, not a data-model requirement;
it must not create a shared/linked record between the two days' listings
that could cause one day's edit to affect another.

## Automatic expiry

A listing automatically stops being purchasable at its expiry time without
requiring vendor action:

- it disappears from the Available-Today marketplace immediately upon
  expiry (no stale-listing display window),
- any unconfirmed reservation against it at expiry is released per
  `docs/domain/seafood-inventory-weight-and-reservation-rules.md`'s
  reservation-expiry rule,
- any remaining unsold quantity does not roll over into a new listing
  automatically — the vendor must explicitly create tomorrow's listing
  (via "repeat previous listing" or fresh entry), consistent with seafood
  being perishable and each day's stock being a distinct food-safety event
  (new catch/stock date, new freshness assessment).

## Acceptance (Phase 16B)

- A vendor cannot create a listing without selecting a master-catalogue
  item, a catch/stock date, a selling unit and price, an expiry time, and
  at least one actual-catch photograph.
- The five quantity states (uploaded/available/reserved/sold/remaining)
  are consistent with each other at all times and reconcile against the
  existing `InventoryEvent` audit trail.
- A listing cannot be created or remain live if it violates the underlying
  catalogue item's current regulatory/seasonal status (16F enforcement).
- "Repeat previous listing" produces a genuinely new, independent listing
  record — editing today's copy never mutates yesterday's original.
- An expired listing is unpurchasable and invisible in Available-Today
  discovery from the moment it expires, with no manual vendor action
  required.
