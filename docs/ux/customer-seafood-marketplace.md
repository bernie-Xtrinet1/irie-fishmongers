# Customer Seafood Marketplace — Available Today

Status: **Design, Phase 16 not started**
Roadmap: `docs/roadmap.md` Phase 16C (Customer Available-Today Marketplace)
Related: requirements F, G, H, I from
`docs/product/jamaican-seafood-marketplace-requirements.md`

## Purpose

Define the customer-facing experience for discovering and purchasing what
is actually available *today*, across all vendors, rather than browsing a
static product catalog. This replaces/extends the current storefront home
page (`apps/web/components/home/home-view.tsx`), which today lists products
without a "today" or multi-vendor-availability concept.

## Available Today Near You

The primary customer entry point. Shows, for the customer's location (or a
selected delivery/pickup area):

- catalogue items (per ADR-005) that have at least one active vendor daily
  listing (per `docs/ux/vendor-daily-catch-listing.md`) today,
- for each item: total quantity available across all vendors, number of
  distinct sellers offering it, and a representative price range,
- ranked using the existing search-ranking rules
  (`.claude/rules/business-rules1.md`'s Search Rules: availability →
  vendor rating → distance → freshness), not a generic relevance sort.

This is a *today* view: a catalogue item with zero active listings today
(even if it has historical listings) does not appear here — it may still
be findable via category browsing as "not currently available."

## Category browsing, search, filters

- **Category browsing**: catalogue categories (16A) as the primary
  navigation, consistent with `Category`'s existing role in `Product`.
- **Search**: free-text search across catalogue common name, alternative/
  local Jamaican name(s), and scientific name (so a customer searching
  "snapper," a local name, or the scientific name all resolve to the same
  catalogue entry) — extends the existing search rather than introducing a
  parallel index.
- **Filters**: category, price range, selling unit, preparation available
  (yes/no), pickup available, delivery available, freshness grade (reusing
  the existing freshness-grade/quality-score fields), vendor tier/badge.

## Per-item detail: availability, sellers, images

For a specific catalogue item's Available-Today detail:

- **Total quantity available** — sum of `quantityAvailable` across all
  active vendor listings for this item today.
- **Number of sellers** — count of distinct vendors with an active listing.
- **Catalogue reference image** — the master-catalogue image (ADR-005),
  shown as the default/fallback illustration for the species.
- **Actual-catch images** — each vendor's own listing photo(s) (16B),
  shown per-vendor and **clearly labelled as the actual catch** (e.g. a
  "Today's Catch" badge/caption), so a customer never mistakes a generic
  catalogue reference photo for a photo of the specific fish they are about
  to buy. This distinction is a customer-trust requirement, not a cosmetic
  one — it is what makes the "actual-catch photographs" requirement (E)
  meaningful rather than decorative.

## Best Available Vendor and Choose Your Seller

Two selection modes, both must be offered, consistent with the existing
Marketplace Selection Engine (`MarketplaceModeConfig`,
`FulfillmentDecision`/`VendorScore`/`VendorAssignment`):

- **Best Available Vendor** — the platform selects the vendor(s) for the
  customer using the existing vendor-scoring/allocation engine (distance,
  rating, price, freshness, per
  `.claude/rules/location-based multi-vendor fulfillment rules.md`'s
  vendor-selection process). If the requested quantity exceeds any single
  vendor's stock, this mode is what performs multi-vendor allocation (see
  `docs/domain/seafood-inventory-weight-and-reservation-rules.md`).
- **Choose Your Seller** — the customer browses the list of vendors
  currently offering this item today (with each vendor's price, quantity
  available, rating, and actual-catch photo) and picks one directly,
  bypassing the scoring engine's selection for this order. Choosing a
  single seller who cannot fully cover the requested quantity is a
  customer-visible constraint (partial-fulfillment or reduce-quantity
  prompt), not a silent fallback to Best Available Vendor.

## Purchasing units

A listing is sold in the unit the vendor set (16B): pound, kilogram, item,
package, or case (extends the existing `ProductUnit` enum — see ADR-005 for
whether new unit values are needed). The customer purchase flow must
present quantity input appropriate to the unit (e.g. a weight input with
sensible increments for pound/kilogram vs. a whole-number count for
item/package/case) and must carry the exact-weight vs. estimated-weight
distinction through to checkout (see
`docs/domain/seafood-inventory-weight-and-reservation-rules.md` for the
estimated/final-weight reconciliation this implies for weight-sold items).

## Preparation selections

If the vendor's listing offers preparation options (16B — e.g. scaled,
gutted, filleted, cut into steaks), the customer selects from the vendor's
offered options at add-to-cart/checkout time, and the associated
preparation fee (set by the vendor per item) is itemized separately from
the seafood price in the order summary — never bundled silently into a
single line, so both the customer and the vendor's settlement report can
distinguish product revenue from preparation-service revenue.

## Pickup or delivery selection

At checkout, the customer chooses fulfillment method per the vendor's/
listing's declared availability (16B declares whether a given listing
supports pickup, delivery, or both):

- **Delivery** — the existing Delivery Engine, unchanged.
- **Platform-managed pickup** — per
  `docs/operations/platform-managed-pickup-policy.md`; the customer selects
  a collection window at this point (constrained by that document's rules).

If a multi-vendor allocation occurs and the vendors' fulfillment
capabilities differ (one delivery-only, one pickup-only), the customer must
be shown this before confirming — silently splitting fulfillment method
without disclosure is not acceptable (same disclosure principle as
multi-vendor allocation generally).

## Acceptance (Phase 16C)

- Available Today Near You shows only catalogue items with at least one
  active listing today, ranked per the existing search-ranking rules, with
  correct total-quantity and seller-count aggregation.
- Catalogue reference images and vendor actual-catch images are visually
  and label-distinguishable in every surface that shows both.
- Both Best Available Vendor and Choose Your Seller are reachable for any
  purchasable item; Choose Your Seller correctly constrains quantity to the
  selected single vendor's stock.
- Checkout correctly handles all five selling units end to end, with
  preparation fees itemized separately from product price.
- A customer sees and can select pickup or delivery consistent with what
  the underlying listing(s) actually support, with disclosure if a
  multi-vendor split affects fulfillment method.
