# ADR-005 Master Catalogue, Vendor Daily Listing, and Inventory Authority

Status:
Accepted

Date:
2026-07-31

---

## Implementation prohibition (read first)

This ADR is a design record, not an implementation authorization. No Prisma
schema, migration, or application code may be written against this ADR until
each numbered migration stage (see "Migration stages") is separately
approved at the time it is about to begin. Approving this ADR approves the
architecture, not permission to start building any specific stage.

---

## Context

Phase 16 (Jamaican Seafood Marketplace Operating Model) requires a master
catalogue, a vendor's persistent offer, and a time-bound daily listing to be
three genuinely different things - conflating any two breaks review
continuity, search deduplication, price history, or traceability (proven
during this ADR's research: `Product.price` is read live into the cart today
with no lock at all; `Product.quantityAvailable` is the only inventory
signal that exists; `findMatchingCandidates` matches vendors by a fragile
case-insensitive name string with no catalogue key; `VendorAssignment` is
schema-enforced one-to-one with `FulfillmentDecision`, so "Best Available
Vendor" can only ever pick one winning vendor today, never a split).

## Decision

- **Catalogue**: a new `SeafoodCatalogueItem`, linked to `Species` through a
  `CatalogueItemSpecies` **join table** (many-to-many). Strictly scoped to
  seafood and seafood-derived products - not a general commerce catalogue
  (see "Catalogue scope").
- **Persistent vendor offer**: `Product`, unchanged in existing shape, gains
  a nullable `catalogueItemId` and an `inventoryMode` enum.
- **Daily listing**: a new `VendorDailyListing`. A `Product` may have
  multiple simultaneously active listings.
- **Images**: a new `ListingPhoto`, separate from the catalogue's own
  reference image.
- **Regulatory authority**: `Species` remains the sole biological/regulatory
  record.
- **Provenance**: `SeafoodLot` becomes the near-universal batch-provenance
  anchor for every listing.
- **Multi-vendor split fulfilment**: confirmed unbuilt today; not
  implemented by this ADR, but not blocked by it either (Phase 16D).

## Domain boundaries

| Concept | Owning model | Changes over |
|---|---|---|
| What species/products exist, standardized names, regulatory/seasonal status | `Species` (unchanged columns) + `SeafoodCatalogueItem` (new) | Rarely |
| What a vendor generally sells | `Product` (unchanged shape) | Occasionally |
| What is actually for sale today, at what price/quantity/photo | `VendorDailyListing` (new) | Daily, sometimes hourly |
| The physical batch's real-world origin and food-safety chain | `SeafoodLot` (existing, extended) | Per batch |

## Model relationship diagram

```
Species
  ↑  (many CatalogueItemSpecies rows may reference one Species)
CatalogueItemSpecies         <- pure join table: (catalogueItemId, speciesId)
  ↓  (one SeafoodCatalogueItem has many CatalogueItemSpecies rows)
SeafoodCatalogueItem          categoryId, compositionMode, lifecycle status
  ↓  (Product.catalogueItemId, nullable)
Product                       inventoryMode: LEGACY_PRODUCT | MIGRATION_PENDING | LISTING_BACKED
                               categoryId (derived mirror once linked)
                               quantityAvailable (durable-stock PROJECTION ONLY - see "Product aggregate cache")
  ↓  (VendorDailyListing.productId, required)
VendorDailyListing             MULTIPLE simultaneously active per Product
                               lotId (required for every perishable-relevant source)
  │
  ├──> ListingPhoto[]
  │
  └──> VendorDailyListingSpecies  <──> Species
         Listing-level composition join - primarily for VARIABLE_COMPOSITE,
         where the catalogue-level set is only "typical," not authoritative.

SeafoodLot  <───────────────── VendorDailyListing.lotId
   originType / acquisitionType
   catchItemId (optional)
   ↑
CatchItem -> Catch -> Fisherman / Vessel / LandingSite

CartItem   vendorDailyListingId, lockedUnitPrice, lockedCurrency, priceLockedAt

VendorAssignment (16D, future) <── AllocationAttempt (orchestration record)
```

## Provenance and Species

**Species remains the sole biological and regulatory authority. Phase 16A
does not initially require changing its existing columns, although new
relationships and enforcement services consume its data.** `originType`
(`WILD_CAUGHT | AQUACULTURE | IMPORTED | PROCESSED`) and `acquisitionType`
(`DIRECT_CATCH | WHOLESALE_PURCHASE | TRANSFER | CONSIGNMENT | OTHER`) live
on `SeafoodLot`, separating physical origin from acquisition channel so a
reseller stays traceable to the real origin even though they didn't catch it
themselves.

**Near-universal `SeafoodLot` requirement**: perishable, cold-chain-relevant
sources require it as a hard publication gate; shelf-stable processed stock
also gets one (cold-chain fields simply never populated), carrying
`manufacturerBatchNumber`/`supplierReference`/a shelf-stable expiry date
instead. Null lot must never mean no traceability. (See "Migration stages",
16B.1, for the required pre-flight validation of this assumption.)

## Catalogue scope

**`SeafoodCatalogueItem` is strictly for seafood and seafood-derived
products.** It is not a general commerce catalogue and never holds gear,
accessories, or any non-seafood item - those, if the platform ever sells
them, belong to a wholly separate, out-of-scope catalogue concept with no
relationship to this one.

## Inventory-mode transition

`Product.inventoryMode` is a three-state transition:

```
LEGACY_PRODUCT ──(vendor creates first listing)──> MIGRATION_PENDING ──(fence resolved + closeout confirmed)──> LISTING_BACKED
```

**This is a fenced, cross-system coordination - not a single PostgreSQL
transaction, and no cross-system atomicity is claimed:**

1. **Mode changes to `MIGRATION_PENDING`** in one Postgres transaction,
   which also creates a `MigrationSnapshot` skeleton carrying a unique
   `migrationId` and a `fenceTimestamp`. This is the only step that is a
   real database transaction.
2. **Every legacy reservation entry point rejects new holds** from the
   instant that transaction commits - an application-level check, not a
   database or Redis lock, and this is the actual fence.
3. **Existing Redis holds are enumerated** - only *after* the fence is in
   place (so nothing new can appear), the legacy reservation hash for this
   product is read in full.
4. **In-flight checkout is identified** separately (any order/payment
   process already underway against this product's legacy path).
5. **Redis is rechecked after the fence** - because steps 2 and 3 are not
   atomic with each other, a second enumeration is taken shortly after the
   first. If the two reads agree, the observed set is treated as stable
   enough to proceed to snapshot recording; if they differ, enumeration
   repeats (bounded retries) or the migration attempt aborts with a
   retry-later reason.

   **This two-read check is necessary but not sufficient on its own, and
   must not be presented as proof of stability.** A request that read
   `inventoryMode == LEGACY_PRODUCT` before the fence committed could still
   attempt to write its Redis hold at any arbitrary later time - not
   necessarily within the narrow window between the two enumeration reads.
   Two matching reads prove the set was stable *at that moment*; they do
   not prove no delayed straggler write can still land afterward. **A
   fencing token or generation number (exact mechanism not specified here)
   is therefore a required invariant**: each inventory-mode transition
   advances a generation value, and every legacy reservation write must be
   validated against the generation current at write time, not merely at
   the time the mode was originally read. A write attempted under a stale
   generation must be rejected outright, and if one is ever detected to
   have landed regardless, it must be compensated (released) rather than
   left standing.
6. **`MigrationSnapshot` is completed** once a stable read is reached,
   recording: the observed reservation IDs and quantities, and the
   `InventoryEvent` sequence boundary (the most recent event ID/timestamp
   for this product at the moment of the stable read) - this boundary is
   what lets a later rollback (below) know exactly what happened before vs.
   after the migration.
7. **Finalization to `LISTING_BACKED` occurs only after every observed hold
   has resolved** (completed as a real order, or expired) **and** any
   identified in-flight checkout has resolved, **and** the vendor has
   explicitly confirmed legacy closeout.

`MigrationSnapshot` fields: `migrationId` (unique, for idempotency - a
retried migration-initiation request checks for an existing non-aborted
migration for this product before starting a new one), `fenceTimestamp`,
`inventoryEventSequenceBoundary`, observed reservation IDs and quantities,
pending checkout/cart references, vendor confirmation (timestamp), and a
nullable `abortReason`.

**Rollback is not a blind restore.** `MigrationSnapshot` is **evidence**,
not a value to reapply as-is. A rollback recomputes the correct legacy
quantity from: the original snapshot, every order completed since,
every reservation that has since expired, every cancellation, the full
`InventoryEvent` history since the recorded sequence boundary, and any
remaining legacy carts/holds still outstanding. **Rollback must never
recreate already-sold stock** - if the recomputed figure would imply
resurrecting sold inventory, the rollback fails closed rather than
overstating availability.

## Product aggregate cache

`Product.quantityAvailable`, for `LISTING_BACKED` products, is **semantically
deprecated as an authoritative availability signal** - not merely
non-authoritative for purchase gating, but not to be treated as meaningful
live availability anywhere a customer can see it.

**Concise final definition**: *`Product.quantityAvailable` is a best-effort
internal projection of durable listing stock. It may be refreshed to
exclude expired or ineligible listings, but it is never authoritative and
may temporarily be stale.*

**A. Durable listing-stock projection** (what the field actually is): the
sum of `quantityAvailable` across listings whose **stored** status is
`PUBLISHED`, as of the last explicit write-event. Written by: a listing
quantity change, a listing's own stored-status transition, or an **optional
projection-refresh job**.

**The projection-refresh job is strictly a cache utility, never a lifecycle
mutation - this must not be confused with expiry itself:**

- Expiry remains, unconditionally, `expiresAt <= now` - a derived, read-time
  fact about a specific listing. No job ever writes a listing to `EXPIRED`;
  doing so would contradict the standing "expiry is derived, not stored"
  decision (see "Listing lifecycle").
- An optional, periodic **projection-refresh job** may recompute and rewrite
  the `Product`-level compatibility cache, factoring in currently-expired
  and currently-regulatory-ineligible listings **for the purpose of that
  recomputation only**. It never touches any listing's own stored status
  field.
- **Regulatory sweeps are categorically different and correctly do write
  `SUSPENDED`** - a regulatory suspension is a real enforcement action (an
  actor/system decision), not a passive fact about time having passed.

**B. Dynamically purchasable quantity** (always computed live, per listing,
never stored): at the moment of an actual purchase or reservation attempt,

```
durable listing quantity (the listing's own live column)
  minus active Redis reservations against that listing (read live from Redis)
  filtered through, evaluated live at that instant:
    - lifecycle check (is the listing's stored status still PUBLISHED, checked now)
    - expiry check (current time vs. expiresAt, checked now)
    - availability-window check (checked now)
    - regulatory eligibility (RegulatoryEligibilityService called now, not from any cache)
```

**Explicit statements**:

- `Product.quantityAvailable` is **never authoritative for listing-backed
  purchase authorization** and **cannot cause a sale or reservation to
  succeed** - the actual reserve/checkout path for a `LISTING_BACKED`
  product never reads it; it always computes B directly.
- **No transactional authorization may ever read from it.**
- It is **only a compatibility/search/analytics projection** - for legacy
  consumers (search ranking, admin dashboards, low-stock alerts) reading a
  plain column that haven't been rewritten to query listings directly.
- **Customer-facing DTOs and APIs must not expose it as live availability.**
  Any customer-visible "quantity available" for a `LISTING_BACKED` product
  must be sourced from the live listing-based computation (B) or the
  catalogue-item-level aggregation (see "Customer aggregation"), never from
  this raw column - even for read-only display.
- Time-based and regulatory changes are evaluated **directly from
  listings**, live, never from this Product-level cache.
- **Eventually** (out of scope for this ADR) the field should be renamed or
  replaced with an explicitly-named projection field (e.g.
  `legacyQuantityProjection`) once every consumer has migrated off treating
  it as live availability, so the schema itself signals "projection," not
  "truth."

**Which listings the cache should include**: only lifecycle-active stock,
updated through explicit write-events - not "all PUBLISHED stock as of
whenever it was last touched." A projection-refresh job or a regulatory
sweep is what keeps the cache's *freshness* reasonable by writing explicit
updates when they run - but **no purchase's correctness ever depends on
these jobs having run recently**, since the purchase path (B) never
consults the cache at all.

Two mechanisms guard the cache: **report-only reconciliation** (recomputes
the durable aggregate and compares to the stored mirror, logging any
mismatch, never auto-correcting) and **authorized audited repair** (a
separate, explicit administrator action that deliberately recomputes and
overwrites the mirror, logged with actor/reason/before-after). Detection and
correction are never the same operation.

## Composition mode

`SeafoodCatalogueItem.compositionMode` - shipped in Phase 16A with four
values:

| Mode | `CatalogueItemSpecies` rule |
|---|---|
| `SINGLE_SPECIES` | Exactly one row, enforced |
| `FIXED_COMPOSITE` | Two or more rows, the standard recipe; a listing must contain at least the complete declared set |
| `VARIABLE_COMPOSITE` | Catalogue-level set is "typical" only, not authoritative; **`VendorDailyListingSpecies` is mandatory** per listing |
| `UNVERIFIED_COMPOSITION` | Zero rows, no administrator classification - the **default, unsafe** state, evaluated as ineligible-pending-review |

**`SPECIES_NOT_APPLICABLE` is omitted entirely - not reserved, not planned,
not a future enum value this ADR anticipates.** No genuine, reviewed example
could be constructed within a strictly seafood-scoped catalogue. If a real
need is ever identified, it requires its own separate, reviewed ADR
amendment supported by a concrete seafood-catalogue case - it is not carried
forward here as an expected addition.

**Future extension, not built now**: `CatalogueItemSpecies` and
`VendorDailyListingSpecies` may later need component proportion/weight
metadata (e.g. "60% snapper, 40% shrimp by weight") for customer
transparency and for assessing a regulated species' actual volume within a
composite product, not just its binary presence. Noted as an open extension
point on both join tables; no field is added now, since nothing in Phase
16A.1's requirements currently calls for it.

## Category authority

`SeafoodCatalogueItem.categoryId` is authoritative once a `Product` links to
it. `Product.categoryId` becomes a **read-only derived mirror** for linked
products:

- **API read rule**: always read category through `catalogueItem.categoryId`
  for a linked product; unlinked products read `Product.categoryId` exactly
  as today.
- **API write rule**: a request supplying `categoryId` for a catalogue-linked
  product is rejected, not silently overwritten.
- **Mismatch reconciliation**: the same reconciliation job detects drift
  between the two.
- **Migration completion condition**: every seafood `Product` has a
  non-null `catalogueItemId`, and reconciliation reports zero mismatches
  across N consecutive runs.
- **Eventual deprecation**: dropping `Product.categoryId` is a later,
  separate migration, out of scope here.

## Catalogue lifecycle

```
DRAFT ──> UNDER_REVIEW ──> PUBLISHED ──> RETIRED
```

Only a `PUBLISHED` catalogue item may be linked to by a newly published
vendor listing.

**Retirement requires a `retirementReason`**, and the outcome for existing
active listings differs by reason - retirement is never one uniform action:

| Reason | Existing active listings |
|---|---|
| `COMMERCIAL_RETIREMENT` | Remain until their own natural expiry - no forced disruption; simply no new listing may reference this item going forward |
| `DUPLICATE_CONSOLIDATION` | **Reassign `Product.catalogueItemId` to the surviving item - not a per-listing rewrite.** Since `VendorDailyListing` references `Product`, and `Product` references `SeafoodCatalogueItem`, every listing under a reassigned product is transitively consolidated without touching any `VendorDailyListing` row directly. Requires: category validation before reassignment (triggering the same category-sync rule as any other `catalogueItemId` change), an audit record of which products moved and when, a **retired-to-surviving alias** on the retired item (e.g. `consolidatedIntoId`) so historical references still resolve, and preservation of every historical reference to the retired item - its row is never deleted, only marked `RETIRED` with the alias set, so historical reporting remains fully reconstructable. |
| `SAFETY_REGULATORY_RETIREMENT` | **Suspended immediately** - a safety/regulatory issue with the catalogue item itself is a no-exceptions case, not a graceful wind-down |
| `DATA_CORRECTION` | The retiring administrator must explicitly choose one of the three outcomes above - a data-correction retirement's urgency is not knowable from the reason alone, so no default is assumed |

## Listing lifecycle

Only actor-driven states are stored; everything time/quantity-derived is
computed at read time:

| State | Stored or derived |
|---|---|
| `DRAFT`, `PUBLISHED`, `WITHDRAWN`, `SUSPENDED` | **Stored** |
| `EXPIRED` | **Derived** from `expiresAt` vs. now - never written by any job (see "Product aggregate cache") |
| `SOLD_OUT` | **Derived** from quantity, mirroring the existing (unstored) `ProductAvailability.computeAvailability()` pattern |
| `UPCOMING` | **Open** - only if look-ahead scheduling is a confirmed 16B requirement |

## Pricing authority

- `Product.price` / `VendorDailyListing.price`: reference price vs. the
  actual per-day transaction price - the daily row sequence is the price
  history.
- **`CartItem` price locking**: `lockedUnitPrice`, `lockedCurrency`,
  `priceLockedAt`, populated at add-to-cart time for **every new** cart
  item, legacy or listing-backed, from the moment Phase 16A.0 ships.
  `lockedCurrency` is included because `currency` is a per-row `String`
  field today (`Product.currency`, default `"JMD"`), not a schema-enforced
  platform constant, and multi-currency support is an explicit future
  requirement elsewhere in this project's own business rules.

### Existing cart migration (no silent backfill)

Pre-existing `CartItem` rows (created before Phase 16A.0 ships) have no
lock. **They are never silently backfilled with a current price the
customer was never shown.** Instead:

1. Any cart item lacking a lock is treated as **`PRICE_RECONFIRMATION_REQUIRED`**
   (derived from `lockedUnitPrice IS NULL` - no separate stored flag needed).
2. On the customer's next cart access, the current price and currency are
   fetched fresh.
3. The customer is **shown** this current value explicitly (never silently
   applied).
4. Only after the customer **explicitly confirms** are `lockedUnitPrice`,
   `lockedCurrency`, and `priceLockedAt` populated.
5. **Checkout remains blocked** for any cart item still lacking a lock until
   this confirmation happens - a customer cannot check out past an
   unconfirmed legacy item.

New cart items never go through this path - they lock immediately at
add-to-cart time.

- **Repricing while a lock is valid**: the locked value holds regardless of
  upstream changes. If the lock has since expired (reservation TTL lapsed)
  and the customer resumes, this is the *same* reconfirmation flow as above,
  not a separate mechanism.
- **Checkout validation / audit / final `OrderItem` snapshot**: unchanged
  from the existing order workflow - checkout re-verifies `priceLockedAt +
  TTL > now`; a reprice/reconfirmation event is logged whenever it fires;
  `OrderItem.unitPrice` continues to freeze the price at order-creation
  time regardless of anything upstream.

## Image governance

`ListingPhoto` requirements, explicitly preserved:

- Multiple images per listing.
- Exactly one primary image - enforced at two layers: service validation,
  **and** a database-level partial unique index:
  ```sql
  CREATE UNIQUE INDEX listing_photos_one_primary_idx
    ON listing_photos (vendor_daily_listing_id) WHERE is_primary = true;
  ```
  Prisma's schema DSL cannot express a partial index directly - the
  migration for this will include the above as raw SQL, the same treatment
  already required for `CartItem`'s partial unique indexes.
- Moderation status (`PENDING`/`APPROVED`/`REJECTED`).
- Upload timestamp (always present) and optional capture timestamp
  (nullable).
- Historical preservation - never overwritten, since each day is its own
  listing row.
- Structural separation from `SeafoodCatalogueItem.referenceImageUrl` -
  never shared or substitutable.
- A recorded source/license for catalogue reference imagery.

**Photo removal is soft-delete/withdrawal, never hard deletion** - a
`ListingPhoto` row is never physically removed by an ordinary vendor or
moderation action:

- `withdrawnAt`/`deletedAt` (nullable timestamp), plus the withdrawing
  **actor and reason**, recorded on the row.
- **Public visibility** is removed immediately - a withdrawn photo stops
  being served to customers the moment this is set, regardless of the
  row's continued existence.
- **Preservation**: the row (and its underlying storage object, for now)
  remains fully queryable for historical orders that reference that day's
  listing, moderation history, disputes, and the standard food-safety
  retention period - none of which a hard-deleted row could satisfy.
- **Primary-photo promotion** considers only photos that are both
  `APPROVED` **and not withdrawn** - a withdrawn photo is never a promotion
  candidate even if it was previously approved. This applies identically
  whether the primary photo was rejected by moderation or withdrawn/deleted
  by the vendor.
- **Storage-object deletion** (the actual file) happens only **after the
  applicable evidence-retention period has elapsed**, never immediately upon
  withdrawal - the soft-delete timestamp starts that retention clock, it
  does not end anything.
- If no `APPROVED` and non-withdrawn photo remains at all, the listing
  cannot be, or cannot remain, `PUBLISHED` until at least one exists again.

## Regulatory enforcement

`RegulatoryEligibilityService.evaluate(context)` takes a transaction-context
object (`catalogueItemId`, `vendorDailyListingId?`, `seafoodLotId?`,
`atDate?`), returning `{ eligible, reasons[] }`. Each field has a distinct
evaluation role: `catalogueItemId` resolves the catalogue-level species set
and `compositionMode`; `vendorDailyListingId`, when present, resolves the
listing-level `VendorDailyListingSpecies` declaration, which takes
precedence over the catalogue-level set for `VARIABLE_COMPOSITE` items;
`seafoodLotId`, when present, allows evaluation against the lot's own
provenance and, in the future, its approved measurement evidence; `atDate`
fixes the point in time seasonal/regulatory status is evaluated against,
defaulting to now.

**Enforcement points** (all call this same service): listing publication
(primary gate), discovery (re-checked at query time), cart (re-checked at
add-to-cart), vendor selection (ineligible candidates excluded from scoring
entirely), checkout (final gate), vendor acceptance (re-verified), and admin
suspension (the one proactive point - a species-status change can sweep and
suspend every listing that becomes ineligible as a result).

### Regulatory approval workflow

- **A confirmed legal prohibition or closed season cannot be overridden for
  business continuity, under any circumstance.** No administrator role may
  bypass an actual legal restriction.
- Only a **data-correction** override is possible - correcting a system
  error, never bypassing a real restriction. Requires bounded mandatory
  expiry, attached documentary evidence, and full audit.
- **Administrator requests; a separate compliance-authorized person
  approves; the requester can never be the approver.** High-risk cases
  (touching a `PROHIBITED`-status species) require this same two-party path
  as a non-negotiable requirement, not optional dual sign-off.
- **The compliance-approval mechanism is an open implementation question
  for Phase 16A.3, not decided here.** The business rule is fixed regardless
  of mechanism: an Administrator requests; a separate, compliance-authorized
  person approves; the requester can never be the approver. Phase 16A.3 must
  determine whether that compliance authority is (a) a new `RoleName` value,
  or (b) a permission/capability granted through the existing authorization
  model. **Whichever is chosen, the authorization capability must be
  distinct and separately auditable** - this ADR does not commit to
  introducing a new role.
- Reason codes are a fixed enumerated set, never freeform-only.
- **When an override expires, every affected listing re-evaluates
  immediately** against the normal rules (no override in effect) - if still
  ineligible, it is suspended/blocked again automatically. The expiry is an
  enforced boundary, not an unmonitored timestamp.

### Safe-mode wording (not an ordinary enable/disable flag)

Regulatory enforcement is **not** framed as an ordinary feature flag with a
valid "off" state. It operates in exactly one of two modes, neither of
which is fail-open:

- **`ENFORCING`** (normal operation, in every environment including
  development, staging, and CI - tests use fixtures/mocked eligible and
  ineligible scenarios, never a service-level allow-all mode).
- **`DEGRADED_FAIL_CLOSED`** (used only if the service itself has an
  operational problem) - even here, every evaluation defaults to
  ineligible-pending-review. There is no configuration value, in any mode,
  that causes something to be treated as eligible without an actual
  eligibility check having passed.

**Known limitations**: `seasonalStartMonth`/`seasonalEndMonth` are
month-granularity only - 16A enforces month-level seasonal blocking
correctly; precise day/year-varying windows are a future enhancement.
**Minimum-size enforcement remains deferred** - no measured catch size
exists anywhere today. The planned future path: detailed size evidence
belongs on inspection/measurement records; `SeafoodLot` may expose a derived
summary projected from those records; `RegulatoryEligibilityService` will
only ever trust **approved** measurement evidence, which is exactly why the
`evaluate()` signature above already carries `seafoodLotId` - so the
lot-level measurement path can be wired in later without another signature
change.

## Customer aggregation

**A `Product` belongs to exactly one `Vendor` (`Product.vendorId`) - it can
never represent multiple sellers.** Three aggregation levels exist, and the
customer category/search card is always the first of them:

- **`SeafoodCatalogueItem`-level aggregation** (the customer category/search
  card): all eligible active listings across **every `Product`, and
  therefore every vendor**, linked (via `Product.catalogueItemId`) to this
  catalogue item. This is where a figure like "2 sellers across 4 listings"
  genuinely lives - seller count here means the count of **distinct
  vendors** with at least one eligible listing under this catalogue item.
- **`Product`-level aggregation**: one vendor's own several active listings
  (e.g. that vendor's morning and afternoon catch). Useful inside "Choose
  Your Seller" or a vendor's own dashboard. **Seller count does not apply at
  this level** - it is definitionally always one vendor - and must never be
  displayed as if it were a marketplace-wide figure.
- **`VendorDailyListing`-level view**: one exact batch - specific price,
  lot, catch date, photo.

When one catalogue item's active listings differ in price, freshness, size,
catch date, source lot, or delivery estimate:

- Price: **"From JMD X"** (minimum across active listings), simplifying to a
  bare price only when every listing genuinely shares one.
- **Seller count and listing count are never used interchangeably** - two
  vendors might each have two active listings of the same item. The
  aggregate card states both explicitly, for example:

  > **42 lb available from 2 sellers across 4 active listings.**

- Freshness/size: a genuine range when values differ, never an average.
- Catch date, specific source lot, and delivery estimate are listing-
  specific and never shown on the aggregate card - only once a customer
  drills into a specific listing.

**Implications this corrects for existing/future mechanisms**:

- **Search / discovery**: the Available-Today query aggregates by joining
  through `catalogueItemId` to every linked `Product` and its eligible
  listings - it is not a per-`Product` query.
- **Quantity**: at catalogue-item level, the sum spans every vendor's
  eligible listings; at product level, only that one vendor's own.
- **Price**: at catalogue-item level, the minimum across every vendor; at
  product level, the minimum across just that vendor's own listings
  (relevant once a customer has navigated into one vendor's storefront).
- **Best Available Vendor**: candidate gathering must operate at the
  catalogue-item level too - every eligible listing across every `Product`
  linked to the requested catalogue item, scored individually (listing-level
  scoring, per "Cart/order identity" below) - not `findMatchingCandidates`'s
  current fragile per-`Product` name match. This is the concrete fix that
  decision implies for that existing code path.

This entire computation is live against active, eligible listings at render
time - never against the `Product`-level compatibility cache (see "Product
aggregate cache").

## Cart/order identity

`CartItem` gains nullable `vendorDailyListingId` plus the pricing-lock
fields above. Two partial unique indexes (not one composite constraint,
since Postgres treats `NULL` as distinct from every other `NULL`):

```sql
UNIQUE (cartId, vendorDailyListingId) WHERE vendorDailyListingId IS NOT NULL
UNIQUE (cartId, productId)            WHERE vendorDailyListingId IS NULL
```

A listing's identity already implies exactly one product, so
`(cartId, vendorDailyListingId)` alone is sufficient even accounting for
multiple simultaneously-active listings per product.

**`CartItem.productId` can never disagree with its listing's `productId` by
construction, not by validation**: the listing-backed add-to-cart service
method accepts `(cartId, vendorDailyListingId, quantity)` only - never a
client-supplied `productId` - and derives it internally from the listing.

`OrderItem` gains nullable `vendorDailyListingId`, alongside its existing
frozen snapshot fields (unchanged). `VendorScore` / `VendorAssignment` gain
nullable `vendorDailyListingId`; when populated, scoring reads listing-level
price/quantity/freshness; null falls back to reading straight off `Product`,
unchanged from today. Every addition is nullable and additive - no existing
row requires backfill, no existing row's meaning changes.

## Multi-vendor forward compatibility (Phase 16D - not built now)

**Allocation policy**, in strict priority order: (1) prefer one eligible
listing that satisfies the entire quantity; (2) if splitting is required,
minimize vendor count first; (3) delivery/pickup/preparation/timing/
minimum-order feasibility is a hard filter, not a scoring input; (4) among
equal-vendor-count feasible plans, minimize delivered customer cost; (5)
among equal-cost plans, maximize the existing weighted marketplace score;
(6) deterministic tie-breaking (lexicographic `vendorId`).

**Bounded combination search**, not pure greedy - greedy-by-score cannot
guarantee "minimize vendor count" globally. Given a realistic single-digit-
to-low-tens candidate count per catalogue item, an exhaustive search bounded
to a practical split size (e.g. up to 4 vendors, falling back to
greedy-by-score past that cap) is feasible and actually satisfies the
policy.

`VendorAssignment`'s one-to-one constraint is dropped; `allocatedQuantity`
added.

**Reservation atomicity - the honest Stage 1 guarantee**: no customer
receives success until every required hold commits; temporary conservative
under-reporting is possible (never over-reporting); overselling is not
possible; a failed partial hold is compensated quickly, not instantly; every
hold carries its allocation-attempt ID; operations are idempotent and
auditable via `AllocationAttempt`.

`AllocationAttempt` states: `PENDING → RESERVING → COMMITTED`, or
`RESERVING → FAILED`, or `RESERVING → ROLLING_BACK → ROLLED_BACK`; `EXPIRED`
triggers the same rollback path as a failure. Fields: idempotency key,
cart/customer reference, requested catalogue item + quantity, attempt count,
structured failure reason, the resolved plan, timestamps per transition.

A genuine multi-key Lua transaction is documented as a **future upgrade**,
only if Stage 1's guarantee proves insufficient under real concurrency.

## Alternatives considered

Extending `Species` directly instead of a new catalogue item was rejected -
forces every mixed/processed item to fabricate a misrepresentative species
link or have no catalogue entry, reproducing the same gap one layer down. A
single optional `speciesId` was rejected in favor of the join table - it
cannot represent a mixed pack and would let a regulated component hide
undetected. Generalizing `Delivery` into an abstract fulfillment model
(ADR-006's reasoning) remains rejected as premature abstraction.

## Consequences

Positive: every existing `Product` relationship continues to reference it
exactly as today. Regulatory enforcement gets a single, reusable,
fail-closed service instead of the currently-nonexistent enforcement found
during research. Price history and per-day traceability become free
byproducts.

Negative: a genuinely larger schema surface than a single-round design - a
three-state inventory-mode transition, two composition join tables, and an
orchestration record are all new complexity, each justified by a specific
failure mode it closes.

## Migration stages

| Stage | Scope |
|---|---|
| **16A.0 - Cart Price Integrity** | `lockedUnitPrice`/`lockedCurrency`/`priceLockedAt` for new cart items immediately; explicit reconfirmation flow (not silent backfill) for pre-existing cart items, with checkout blocked until confirmed; dedicated tests for both the new-item and reconfirmation paths. Ships independently, first. |
| **16A.1 - Catalogue Foundation** | Verified Jamaican seafood seed catalogue; scientific-name validation; local-name review; duplicate detection; image licensing/source records; regulatory review; the `DRAFT/UNDER_REVIEW/PUBLISHED/RETIRED` lifecycle with `retirementReason` and its per-reason listing-outcome rules; full audit history. |
| **16A.2 - Product Anchoring** | `Product.catalogueItemId`, `Product.inventoryMode` (default `LEGACY_PRODUCT`), category-sync rule. |
| **16A.3 - Regulatory Service** | `RegulatoryEligibilityService` with the transaction-context signature; `ENFORCING`/`DEGRADED_FAIL_CLOSED` safe-mode operation in every environment; the two-party (requester/approver) override workflow. **Must determine whether compliance-approval authority is a new role or an existing-permission-model capability** - not decided by this ADR. |
| **16B.1 - Daily Listings and Images** | `VendorDailyListing`, `ListingPhoto` (soft-delete/withdrawal model, DB-enforced one-primary-photo partial index), `VendorDailyListingSpecies`, `SeafoodLot.originType`/`acquisitionType`, near-universal lot requirement. **Prerequisite validation**: confirm `SeafoodLot` can truthfully serve as a general batch abstraction for fresh, frozen, *and* shelf-stable processed products without violating its existing cold-chain/freshness invariants (`foodSafetyStatus`, `freshnessGrade`, temperature-reading apparatus) before processed stock is implemented on top of it. If it cannot, an amended batch abstraction must be proposed separately - not introduced in this ADR. |
| **16B.2 - Listing-Backed Inventory** | The full fenced, multi-step `inventoryMode` transition (with the required fencing-generation check, never a single cross-system transaction); the durable-projection-vs-purchasable-quantity split for the aggregate cache; report-only reconciliation; audited repair; recompute-based rollback. |
| **16C - Customer Marketplace** | Honest, cache-independent, correctly-leveled aggregation (catalogue-item vs. product vs. listing); `CartItem` partial unique indexes. |
| **16D - Weight Adjustment and Split Fulfilment** | Six-step allocation policy, bounded combination search, `AllocationAttempt`. |
| **16E - Platform-Managed Pickup** | Unchanged from ADR-006. |
| **16F - Marketplace Protection and Operations** | Schema impact to be determined - six candidate records identified, none committed. |

## Feature flags

`catalogueEnabled`, `dailyListingsEnabled`, `listingBackedInventoryEnabled`,
`marketplaceDiscoveryEnabled`, `splitFulfilmentEnabled`,
`weightReconciliationEnabled`, `platformPickupEnabled` - ordinary flags.
**Regulatory enforcement is explicitly not one of these** - it operates in
the `ENFORCING`/`DEGRADED_FAIL_CLOSED` safe-mode model described above, never
an ordinary on/off toggle. Cart price integrity (16A.0) ships
unconditionally, not behind a flag.

## Rollback and safety rules

Every stage's rollback returns to its prior *working* state, never an unsafe
one. Regulatory enforcement has no rollback to "disabled" - only a
transition between the two safe modes above, both fail-closed.
Inventory-mode rollback recomputes from `MigrationSnapshot` plus everything
that happened since, and refuses to proceed rather than resurrect
already-sold stock.

## Open/deferred decisions

- Whether `UPCOMING` (look-ahead listing scheduling) is a real 16B
  requirement.
- The exact mechanism for a same-day, within-listing price edit's audit
  trail.
- Whether `SUSPENDED` listings need their own appeal/reinstatement workflow.
- Exact placement of the future measured-size field.
- The full schema for Phase 16F.
- Whether `SeafoodLot` can truthfully generalize to shelf-stable processed
  products without violating its cold-chain/freshness invariants - a
  required pre-flight validation for Phase 16B.1, not resolved here.
- Component proportion/weight metadata on `CatalogueItemSpecies` /
  `VendorDailyListingSpecies` - noted, not built.
- The concrete mechanism for detecting "in-flight checkout" during the
  migration fence (step 4 of "Inventory-mode transition") - flagged as
  needing a specific implementation approach at 16B.2 build time, not fully
  specified in this ADR.
- The exact fencing-token/generation-number mechanism for migration-fence
  writes (step 5 of "Inventory-mode transition") - the invariant is
  required; the implementation is left to 16B.2.
