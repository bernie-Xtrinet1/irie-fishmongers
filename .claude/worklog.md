# Worklog

## 2026-07-30 - Codespaces/demo troubleshooting arc (closed out via reconciliation)

Chain of issues chased in sequence, each fix verified before moving to the
next. All commits below are on `develop` and `origin/develop`.

1. **Admin dashboard 502 in Codespaces** -> traced to `apps/admin-dashboard`
   client bundle inlining the wrong API URL. `next.config.js` itself was
   fine (guarded `new URL()`, `API_PROXY_TARGET` ordering correct).
   Fix: `5df5216` - `lib/env.ts`'s `readEnv()` used a *dynamic*
   `process.env[name]` lookup, which Next's build-time inlining cannot
   substitute, so it always fell back to the hardcoded
   `http://localhost:3001/api/v1`. Rewrote to reference each
   `NEXT_PUBLIC_*` as a static literal.

2. **Same-origin proxy design** (this was the mechanism the admin fix
   plugged into): `b062d8d` - added `API_PROXY_TARGET`-driven rewrites in
   both `next.config.js` files so the browser calls its own origin
   (`/api/v1`) and Next forwards server-side to the backend - avoids the
   Codespaces cross-port interstitial, CORS, and the SameSite cookie hop.

3. **Cache-staleness hardening**: `fd7b93a` - the original cache-clear
   heuristic only fired when the *API URL* changed, missing a `git pull`
   that changed *source* (e.g. the env.ts fix itself). Added a per-app git
   tree-hash fingerprint stamped inside `.next` so any source OR URL
   change forces a rebuild.

4. **Storefront catalog CORS failure** ("We couldn't load the catalog") ->
   proxy verification showed 200, but the browser Network tab showed the
   real request going to `http://localhost:3001/api/v1/products` (cross-
   origin, refused). Root cause found by tracing every place
   `NEXT_PUBLIC_API_URL` is defined: `.devcontainer/docker-compose.yml` was
   exporting it into the container's `process.env`, which takes PRECEDENCE
   over `.env.local` in Next - so the generated `.env.local` (`/api/v1`)
   was silently ignored at every rebuild, no matter how many times `.next`
   was cleared.
   Fix: `3676cd2` - removed the three frontend `NEXT_PUBLIC_*` lines from
   docker-compose (backend vars kept - those aren't inlined so are safe);
   changed the `api-client.ts`/`next.config.js`/`env.ts` fallbacks from
   absolute `http://localhost:3001/api/v1` to relative `/api/v1`; start
   script now unsets any stray shell-level `NEXT_PUBLIC_*`; verify script
   hard-fails if `localhost:3001` is compiled into either app's client
   bundle; README documents the `process.env` > `.env.local` precedence
   trap so "clear .next" stops being the reflexive (wrong) fix.

5. **Guard refinement** (user-requested hardening, two rounds):
   - `489c23b` - scoped the shell-level unset to only fire inside a
     managed demo container (`CODESPACES` or a devcontainer marker),
     never on a bare host, so it can't erase a developer's intentional
     config; bare host now warns instead of erasing.
   - `f3f6f8a` - replaced the broad `/.dockerenv` probe (matches ANY
     container) with an explicit project marker `IRIE_DEMO_CONTAINER=true`
     set only in this repo's docker-compose; added an automated compose-
     override check to the verify script (regex-anchored to real YAML
     assignments, ignores comments/marker).

6. **Broken product images** ("Fresh Red Snapper" etc. render as alt text
   only) -> traced fetch -> component: catalog API and JSON shape were both
   fine; the failure was `next/image`'s optimizer rejecting the seed's
   `placehold.co` URLs because that service serves `image/svg+xml`, and
   Next blocks SVG optimization by default (HTTP 400 "image type is not
   allowed"). Reproduced locally end-to-end (confirmed 400 for the SVG
   URL, 200 for a `/png` variant).
   Fix, two iterations:
   - `3d4a742` - switched seed URLs to `placehold.co/.../png?...` (raster);
     made per-product seeding idempotent (`findFirst` by (vendorId, name)
     -> update/create) instead of "skip if any product exists", since the
     old guard meant a re-seed never actually refreshed a stale URL;
     exported `DEMO_PRODUCTS` + guarded `main()` with
     `require.main === module` so a unit test can import it; added
     `demo-seed.spec.ts` asserting raster-only URLs; added verify-script
     `5c` (fetch first catalog imageUrl through `/_next/image`, require
     200).
   - `a3fc043` (final, preferred solution) - replaced the remote
     placeholder dependency entirely with three bundled local PNGs under
     `apps/web/public/demo-products/`, referenced as `/demo-products/*.png`.
     Removes external-service downtime, SVG behavior, remote-domain config,
     and outbound networking as failure modes in one move. Updated the
     regression test to assert local-raster-path + file-exists-on-disk
     (root-safe via `path.resolve(__dirname, ...)`, not CWD-dependent;
     verified Linux/CI-safe: matching lowercase filenames, no backslashes).

7. **CI investigation** (a screenshot showed `Error: boom` in
   `compliance-score-cron.service.spec.ts`) -> confirmed that spec passes
   3/3 locally, in serial AND parallel (`CI=true`) mode - the boom is
   expected negative-path logging, not a failure. Reproduced every other
   CI step locally against current HEAD: lint, typecheck, build, and
   `test:cov` (187 suites / 1409 tests, coverage 96.7/91.9/96.5/96.6%,
   thresholds 90/80/90/90) all pass. Ran `--detectOpenHandles` on the full
   suite per explicit instruction to identify the leak owner before
   attributing cause: zero open handles reported; ruled out the cron
   (inert under unit tests - no spec registers `ScheduleModule.forRoot()`),
   Redis (fully mocked in its spec), and Prisma teardown (every real-DB
   repository spec connects/disconnects symmetrically). No code change
   was made based on this - the actual cause turned out to be unrelated
   (see next item).

8. **Actual CI failure identified**: `GenerateManifest did not succeed` -
   a GitHub-managed Codespaces Prebuilds pipeline failure, NOT the app CI
   workflow (`ci.yml`). Reviewed `.devcontainer/devcontainer.json` and
   `docker-compose.yml` only, per instruction, with no code/test changes:
   `devcontainer.json` is valid JSON, `docker-compose.yml` parses as valid
   YAML (including the `IRIE_DEMO_CONTAINER` marker + comment added in
   step 5), all referenced paths exist, `postCreateCommand`
   (`setup.sh`) needs no user secrets, and the `require.main === module`
   guard added to `demo-seed.ts` in step 6 was verified to still execute
   `main()` under `ts-node` (so `npm run demo:seed` in the prebuild is
   unaffected). Concluded no repo-side defect was found; the decisive next
   step is the first detailed error line in the Prebuilds log before the
   manifest-generation wrapper failure, or the GitHub Settings-level
   prebuild branch/path configuration - neither is visible from repo files.
   Awaiting that log / a scope decision from the user.

## 2026-07-31 - Development reconciliation + roadmap resequencing (docs-only)

1. **Reconciliation check**: confirmed `develop` clean, in sync with
   `origin/develop` at `a3fc043`, only the 6 untracked session/instruction
   files pending. Verified Phase 13/14/15 status directly against code
   (not either stale status doc): Notifications module complete (15
   specs), Analytics complete (backend module + 5 admin screens, 17
   passing tests), AI Marketplace correctly not started. Inspected the
   unmerged `phase-17-uat-production-readiness` branch (3 commits,
   `.claude/roadmap.md` + `docs/roadmap.md` + a new
   `docs/uat/phase-17-uat-production-readiness.md`) without merging it.

2. **User approved a resequencing**: Marketplace Operating Model now
   precedes UAT; the old AI Marketplace phase moves to the end. This landed
   in two passes within the same session - an initial correction numbered
   the new phases 17/18/19, then a follow-up correction closed the gap
   left between Phase 15 and the new phases, producing the final
   continuous sequence: Phase 16 (Marketplace Operating Model), Phase 17
   (UAT & Production Readiness), Phase 18 (AI Marketplace). See
   [[decisions]] for full rationale.

3. **Documentation-only change set executed** (no app code/schema/
   migrations touched):
   - `.claude/roadmap.md`, `.claude/project-status.md` reduced to short
     pointers at `docs/roadmap.md` (which is now the sole authoritative
     roadmap) - both had drifted stale and used a numbering scheme that
     didn't match `docs/roadmap.md`.
   - `docs/roadmap.md`: corrected Phase 13 status line; added Phase 14
     (Notifications, COMPLETE), Phase 15 (Analytics, COMPLETE + tracked
     doc gap), Phase 16 (Jamaican Seafood Marketplace Operating Model,
     NOT STARTED, sub-phases 16A-16F), Phase 17 (UAT & Production
     Readiness, renumbered from the branch's draft), Phase 18 (AI
     Marketplace, deferred, renumbered).
   - `docs/api-spec.md`: added a "Known Documentation Gaps" section
     listing the 5 undocumented analytics endpoints.
   - Removed `.claude/brief handoff instructions for claude.md`
     (superseded by `.claude/next-session.md`); renamed "Instructions to
     claude before continuing implementation of codes.md" to
     `.claude/pending-documentation-audit.md` (content unchanged, not
     executed).
   - Ten new design documents: `docs/product/jamaican-seafood-marketplace-
     requirements.md` (requirement-to-sub-phase index),
     `docs/operations/marketplace-operating-model.md` (16F),
     `docs/operations/platform-managed-pickup-policy.md` (16E),
     `docs/ux/customer-seafood-marketplace.md` (16C),
     `docs/ux/vendor-daily-catch-listing.md` (16B),
     `docs/domain/seafood-inventory-weight-and-reservation-rules.md`
     (16D), `docs/testing/marketplace-fulfilment-acceptance-plan.md` (20
     end-to-end scenarios, Phase 16's own acceptance gate),
     `docs/uat/phase-17-uat-production-readiness.md` (renumbered/revised
     from the branch draft, now validates the full Phase 16 chain and
     tags every task CIP/LOC/AZ/SEC/OPS/GATE so Azure-blocked work is
     explicit), `docs/integrations/ADR-005-master-catalogue-vs-vendor-
     daily-listing.md`, `docs/integrations/ADR-006-platform-managed-
     pickup-verified-collection.md`.

4. Tracked the 4 session-continuity files (`current-task.md`,
   `worklog.md`, `decisions.md`, `next-session.md`) that were previously
   untracked.

5. **Committed as three separate commits, then pushed to `develop`**,
   after two housekeeping rounds requested by the user: removing the
   (never-in-repo) `renumber.py`/`renumber.js` scratchpad scripts, fixing
   one pre-existing trailing-whitespace line in
   `.claude/pending-documentation-audit.md` (content unchanged), and a
   targeted audit of the retired `.claude/roadmap.md`/`project-status.md`
   for any still-valid unique content before finalizing - see the next
   entry.

## Final commit + push (2026-07-31)

- `e2ba223` `chore(docs): consolidate roadmap and session planning files`
  (7 files: the 4 session files, the renamed
  `pending-documentation-audit.md`, and both `.claude` files reduced to
  pointers).
- `e60a743` `docs(roadmap): schedule marketplace operations before
  production UAT` (3 files: `docs/roadmap.md`, `docs/api-spec.md`,
  `docs/uat/phase-17-uat-production-readiness.md`).
- `516d207` `docs(marketplace): define daily listings purchasing and
  managed pickup` (9 files: the seven Phase 16 design docs + ADR-005 +
  ADR-006).
- Retired-content audit before finalizing: cross-checked every flagged
  gap in the old `.claude/roadmap.md` against current code. Most were
  already closed (`Product.weightLbs` now exists and dispatch scoring
  enforces it against `Driver.capacityLbs`; `DeliveryRejectedEvent` now
  reaches `NotificationEventsListener`; the mobile driver app exists at
  `apps/driver-app`) and were correctly NOT carried forward.
  Three were still genuinely current and were added to `docs/roadmap.md`
  as a "Carried-forward technical notes" section: `OrderItem` has no
  weight field though `Product` does (relevant to Phase 16D); no
  role-wide "notify all administrators" recipient lookup exists in
  Notifications (relevant to Phase 16F); `VendorStatus`/`DriverStatus`/
  `FishermanStatus` remain three deliberately-unconsolidated identical
  enums. `.claude/project-status.md` was confirmed to hold nothing
  unique beyond what is now in `docs/roadmap.md` Phase 13-15.
- Pushed: `a3fc043..516d207 develop -> develop`. Post-push fetch confirmed
  `origin/develop` at `516d207`, 0 ahead / 0 behind, working tree clean.

## 2026-07-31 (cont.) - ADR-005 design correction and acceptance

Following the roadmap-resequencing push, ADR-005 (master catalogue vs.
vendor daily listing) went through five rounds of correction based on direct
research against the actual codebase, then was accepted:

1. Mapped every relationship to `Product` (Cart, Order, Review, Inventory,
   FulfillmentDecision, VendorScore, VendorAssignment) and proved, by
   reading the actual scoring code, that "Best Available Vendor" picks
   exactly one winner today (`pickWinner()` returns a single object via
   `.reduce()`; `VendorAssignment` is schema-enforced one-to-one with
   `FulfillmentDecision`) - true multi-vendor split fulfilment is unbuilt,
   not merely incomplete.
2. Revised the catalogue model from "extend `Species` directly" to a new
   `SeafoodCatalogueItem` joined to `Species` via a `CatalogueItemSpecies`
   join table, after establishing a single optional FK cannot represent a
   mixed seafood pack and could let a regulated species hide undetected
   inside a composite item.
3. Established `Product` stays the persistent, one-vendor offer (unchanged
   shape); a new `VendorDailyListing` (not `Product` itself) is the actual
   dated, priced, photographed, expiring stock - multiple simultaneously
   active per `Product` (separate lots/grades/sources landing the same day).
4. Corrected an inventory-authority design that initially let a stored
   `Product.quantityAvailable` cache be defined by predicates that changed
   merely because time passed or regulatory status changed elsewhere -
   settled on a strict split between a durable, event-driven projection
   (compatibility/search only, never authoritative) and a dynamically
   computed purchasable quantity (always live, per listing, gates every
   real sale).
5. Found and fixed a real, currently-live defect in the process:
   `cart.service.ts` reads `item.product.price` live at cart-read time with
   no lock at all - moved the fix into its own first-shipped stage,
   Phase 16A.0, ahead of any catalogue/listing work.
6. Corrected a customer-aggregation design that conflated "2 sellers" with
   a single `Product`'s several listings - since `Product.vendorId` means
   one product is always exactly one vendor, cross-vendor aggregation must
   happen at the `SeafoodCatalogueItem` level, not the `Product` level.
7. Walked back an overclaimed reservation-atomicity guarantee ("no visible
   partial state") to an honestly-stated one (conservative under-reporting
   possible, overselling never possible) after being pushed to prove every
   read path actually consulted the orchestration record - it hadn't been
   proven, so the claim was withdrawn.
8. Left the compliance-approval mechanism (new role vs. existing permission
   model) as an explicit open question for Phase 16A.3, rather than
   committing to a new `RoleName` value in the design record - confirmed no
   `ComplianceOfficer` role exists in the current `RoleName` enum before
   even considering that framing.

**ADR-005 status: Accepted.** Committed separately from the design docs, as
its own commit:

- `d22afe4` `docs(architecture): accept catalogue and daily listing design`
  (1 file: the ADR itself, 704 insertions / 142 deletions against the
  originally-committed first-round draft in `516d207`).

`.claude/decisions.md` corrected in the same pass - its existing ADR-005
summary described the superseded first-round design (extend `Species`
directly); added a note pointing to the actual accepted shape.

Verified before committing: `git diff --check` clean; all 24 `##` section
headers in the assembled ADR unique (no duplicate replaced sections); no
`.ts`/`.tsx`/`.js`/`.jsx`/`.prisma`/migration file in the diff; `ADR-006`
untouched; the implementation prohibition section retained verbatim.

**No Prisma schema, migration, or application code has been written for any
part of Phase 16.** Next roadmap unit: Phase 16A.0 (Cart Price Integrity),
gap analysis and plan only - see `.claude/next-session.md`.

## 2026-07-31 (cont.) - Phase 16A.0 (Cart Price Integrity) planning session

Verified repository state at session start: `develop` at `8d928e1`, in sync
with `origin/develop`, working tree clean, `ADR-005` status confirmed
`Accepted`.

**Completed a read-only inspection** of the cart, reservation, order,
payment, `Product` price/currency, `OrderItem`, and storefront code -
no file was modified. Findings:

- `CartItem` has no price/currency columns; `CartService.toResponse()`
  reads `item.product.price` live on every cart fetch.
- `OrdersService.checkout()` re-reads `item.product.price` live a second
  time inside the transaction, and **hardcodes `currency: 'JMD'**` when
  calling `paymentsService.initiatePayment()` - `Product.currency` is never
  actually consulted at checkout, a previously-unconfirmed gap.
- `InventoryReservationsService`: confirmed 15-minute rolling TTL
  (`RESERVATION_TTL_SECONDS = 900`), lazy-expiry-on-read, no proactive
  sweep, `reserve()` overwrites the expiry on every add/quantity-update -
  no existing maximum lifetime cap.
- `OrderItem` has no `currency` column; `VendorOrder`/`Order` have none
  either; `Payment` **already has** `currency` (default `"JMD"`) but its
  value is never sourced from anywhere real.
- No customer-facing cart page exists anywhere in `apps/web` - only an API
  client wrapper. Any cart UX work in this phase is new construction, not
  a modification.
- Zero existing test coverage for a price change occurring between
  add-to-cart and checkout.

**Produced a first Phase 16A.0 implementation specification** (schema
changes, reconfirmation flow, checkout validation, sequence/state diagrams,
API examples, migration timeline, rollback procedure, test matrix) -
reviewed and found materially correct in direction, but with real
operational gaps.

**Review surfaced further design corrections, now resolved in a revised
specification**:

- Reservation and price-lock timers are independent, not shared - a valid
  reservation can coexist with an expired lock, and vice versa; checkout
  must check both.
- Maximum reservation lifetime corrected from an initially-proposed 24
  hours down to **60 minutes** for ordinary retail - flagged as not yet
  approved as a permanent decision (see `.claude/decisions.md`).
- Checkout invariants expanded to 8 explicit per-item checks (lock present
  and valid; Redis reservation exists; belongs to this cart; reserved
  quantity matches cart quantity; durable stock sufficient; product
  purchasable; currency matches cart currency) - a valid lock alone was
  established as never sufficient on its own.
- Reconfirmation sequence corrected: inventory availability must be checked
  **before** a new lock is written, not after - an unchecked reconfirmation
  could otherwise re-lock a price for stock that no longer exists.
- Added an explicit Redis/PostgreSQL compensation strategy (release a
  leaked reservation if the DB write fails; roll back the DB write if
  reservation reacquisition fails), idempotency keys, and bounded retries.
- `Cart.currency` (nullable) adopted as the one-cart-one-currency source of
  truth; verified via direct schema inspection that `Order`/`OrderItem`
  need new currency columns, `VendorOrder` does not, and `Payment`'s
  existing column just needs its value source fixed.
- The original rollback plan ("revert to today's live-read behavior") was
  explicitly withdrawn - it silently reinstated the exact defect this phase
  exists to fix. Replaced with a fail-closed rollback (block checkout
  rather than fall back to live pricing) and an explicit maintenance-mode
  response for if the reconfirmation flow itself breaks.
- Defined 7 structured, machine-readable error codes
  (`PRICE_LOCK_MISSING`, `PRICE_LOCK_EXPIRED`, `RESERVATION_EXPIRED`,
  `PRICE_CHANGED_AGAIN`, `OUT_OF_STOCK`, `PRODUCT_UNAVAILABLE`,
  `CURRENCY_MISMATCH`) and differentiated customer-facing UX language so
  "lock/reservation expired, price unchanged" is never phrased as "price
  changed."

**No Prisma schema, migration, TypeScript, JavaScript, or test file was
changed at any point today.** No implementation has begun.

**Commits or pushes performed today: none.** (The `d22afe4`/`b880cf2`/
`e668a1e`/`8d928e1` commits referenced above were made and pushed in the
prior session, already reflected in `origin/develop` before today's work
began.)

## Verification tooling added along the way

- `scripts/verify-codespaces-demo.sh`: now checks (2b) no frontend
  `NEXT_PUBLIC_*` in docker-compose, (5c) the first catalog product's
  image loads 200 through `/_next/image`, (6) no `localhost:3001` in
  either app's compiled client bundle.
- `backend/prisma/demo-seed.spec.ts`: regression guard - local raster
  paths only, referenced files exist on disk.

## 2026-07-31 (cont.) - Phase 16A.0 operational policy Accepted

The full Phase 16A.0 reservation/lock timing policy was reviewed, corrected
across several rounds, and **Accepted** - recorded in `.claude/decisions.md`:
15-minute rolling reservation TTL, 60-minute absolute ordinary-retail
maximum (`expiresAt = min(now + 900, absoluteExpiresAt)`, never extended by
renewal), no wholesale exception in this phase, price locks never auto-renew,
one-cart-one-currency, and checkout requiring both a valid lock and a valid
Redis reservation as independent conditions.

Five further implementation-plan corrections were resolved before any
source work begins:

- **Cart-level atomic checkout marking**: replaced per-item preflight reads
  with one Redis Lua script validating every reservation the checkout needs
  and marking them all `CHECKOUT_PENDING` atomically, or none - closing a
  real concurrent-checkout race the preflight-only design couldn't prevent.
- **Idempotency model**: rejected one shared mutable `idempotencyKey` field
  on the reservation entry - cart mutation, reconfirmation, and checkout
  consumption get separate idempotency semantics; the reservation entry
  itself carries only what reservation/checkout consumption actually needs.
- **Item removal**: compared three designs (release-then-delete,
  delete-then-outbox-cleanup, a removal-pending state) and selected
  release-Redis-first-then-delete - an invisible leaked reservation is a
  worse failure mode than a briefly-still-visible cart row with released
  stock; compensation is a bounded, idempotent delete retry, never a
  re-reservation.
- **Deployment gate**: tightened from an open-ended "compatibility window
  where unlocked carts silently use live `Product.price`" to a short,
  scheduled checkout **maintenance window** around the enforcement flip -
  bounded duration, an accountable owner, monitoring, and automatic
  expiry/removal of the compatibility code, not an indefinite fallback.
- **Durable decrement proof**: confirmed in the execution plan that
  checkout performs exactly one Postgres stock decrement per successful
  order; Redis reservation deletion is never itself inventory consumption -
  with explicit test scenarios for the successful/failed/retried cases.

**No Prisma schema, migration, TypeScript, JavaScript, or test file has been
changed.** No implementation has started. `.claude/current-task.md`,
`.claude/next-session.md`, and `.claude/decisions.md` were updated to
reflect the Accepted policy; not yet committed, pending approval.

## 2026-08-02 - Commit Unit 1 shipped; reservation lifecycle architecture finalized

**Commit Unit 1** (`feat(schema): add cart price locks and checkout
attempts`, `57c73b4`) shipped and pushed: additive Prisma schema only
(`Cart.currency`, `CartItem.lockedUnitPrice`/`lockedCurrency`/
`priceLockedAt`, `Order.currency`, `OrderItem.currency`, new
`CheckoutAttempt` model + `CheckoutAttemptStatus` enum, all foreign keys
`ON DELETE RESTRICT` so checkout-attempt audit history can never be
silently cascade-erased). Six pre-existing spec files needed fixture-only
updates (new nullable fields added to typed object literals) to keep
`develop` typechecking green - no test assertion, mock, or application
logic was touched in any of them. Migration drift verified empty against
the shadow database both before and after the fixture fixes.

**Reservation lifecycle architecture** was then designed, corrected across
several rounds, and finalized as `docs/architecture/reservation-lifecycle.md`
(`docs(architecture): define reservation lifecycle and recovery`,
`2068d9f`):

- Finalized the cart-scoped Redis key format (`inv:reserved:{cartId}:{productId}`),
  the `ReservationEntry` shape (including a `version: 1` field), and the
  whole-cart atomic `checkoutMark` Lua contract.
- **Corrected an initial design flaw**: the first draft treated the
  product-side reservation index/total as a best-effort, eventually-
  consistent step, justified by preserving Redis Cluster compatibility.
  This was wrong - `getAvailableToPurchase`/`getReservedByOthers`
  participate directly in reservation admission (`CartService`,
  `ProductsService`), so the product-side projection cannot tolerate
  missing updates. Revised to make the reservation entry, cart index,
  product index, and product reserved-total all atomically maintained by
  one Lua script on the current single (non-cluster) Redis instance.
- **Removed silent total clamping.** A `RESERVATION_TOTAL_UNDERFLOW`
  invariant-violation path was defined instead: the specific reservation
  mutation still succeeds (never blocking a customer/checkout action),
  but the total's arithmetic is skipped (not clamped), a suspect flag is
  set on the product, and new reservation admission fails closed
  (`getAvailableToPurchase` returns `0`) until reconciliation repairs and
  verifies the total.
- **Documented both reconciliation drift directions**, correcting an
  earlier overclaim that drift could only ever be conservative: OVERCOUNT
  (stored higher than reality - conservative, repaired routinely) versus
  UNDERCOUNT (stored lower than reality - a live overselling risk, fails
  closed via the same suspect flag until repaired and verified).
- **Verified the availability formula against the real callers**, not by
  assumption: `CartService.assertQuantityAvailable` already holds a real
  `cart.id`; `ProductsService.getAvailability` already passes `''` to mean
  "exclude no cart's own hold," which the new add-back formula
  (`Product.quantityAvailable - productReservedTotal +
  requestingCartActiveReservationQuantity`) preserves by construction. No
  caller signature change is required in Commit Unit 2.
- Restated the Redis Cluster position explicitly and narrowly: valid only
  because the current deployment is a single non-cluster instance; Cluster
  migration is prohibited until a separate, approved design exists for
  orchestration, co-location, product-based sharding, or Postgres-durable
  accounting.
- Established the document's own authority scope (§13): defers to
  `docs/roadmap.md` for the roadmap, ADR-005 for catalogue/listing/
  inventory domain boundaries, and `.claude/decisions.md` for approved
  operating decisions - this file is the technical reference for Redis
  reservation lifecycle and recovery only.

**No TypeScript, Redis, Lua, or test implementation for Commit Unit 2 has
begun.** Both commits (`57c73b4`, `2068d9f`) are pushed and present on
`origin/develop`.

## 2026-08-02/03 - Units 2.1, 2.2, and 2.3 shipped

**Unit 2.1** (`feat(redis): add Lua script execution support`, `c757bdd`):
`RedisService.eval()`/`loadScript()`/`evalsha()`/`runScript()`, with a
NOSCRIPT reload-and-retry that uses the freshly-returned SHA on retry
(never the stale one) and never falls back to a plain `EVAL`. First Lua
usage anywhere in this codebase.

**Unit 2.2** (`feat(inventory): add cart-scoped reservation key helpers`,
`393c970`): `reservationKey`/`isLegacyReservationKey`/
`isCurrentReservationKey` (rejecting empty, whitespace-containing, and
delimiter-containing identifiers) plus `RESERVATION_ENTRY_VERSION`,
`MAX_RESERVATION_LIFETIME_SECONDS`, `CHECKOUT_PENDING_INITIAL_LEASE_SECONDS`,
`MAX_CHECKOUT_PENDING_SECONDS` - additive to `inventory.constants.ts`,
reusing the existing `RESERVATION_TTL_SECONDS` unchanged.

**Unit 2.3** (`feat(inventory): add cart-scoped reservation accounting`,
`a27cb65`) - the largest unit so far:

- Implemented the additive cart-scoped reservation structures: the
  reservation entry itself, a cart index, a product index, a product
  reserved-total projection, and a product suspect flag - all four
  secondary structures added to `inventory.constants.ts` alongside the
  Unit 2.2 key helpers.
- Implemented `ReservationEntry` version 1 (`version`, `quantity`,
  `cartId`, `customerId`, `status`, `createdAt`, `lastRenewedAt`,
  `expiresAt`, `absoluteExpiresAt`, `checkoutIdempotencyKey`,
  `checkoutPendingAt`, `checkoutPendingExpiresAt`).
- Implemented atomic `reserveOrRenew` and `releaseReservation` as Lua
  scripts (`inventory/lua/reservation-lua-scripts.ts`) - each atomically
  updates the reservation entry, both indexes, and the product
  reserved-total together on the current single Redis instance.
- Implemented fail-closed underflow handling: before any negative
  adjustment, the stored total must already be `>=` the reservation
  quantity being subtracted (not merely `>= abs(delta)`) - if not, the
  entry mutation still completes (never blocking the customer) but the
  total's arithmetic is skipped (never clamped), the suspect flag is set,
  and `RESERVATION_TOTAL_UNDERFLOW` with structured details is returned.
- Implemented cart-aware availability (`getReservedTotalExcludingCart`/
  `computeAvailableToPurchase`): the fast-path product total minus the
  requesting cart's own active quantity, with an empty/falsy cartId
  correctly treated as "exclude nothing" without ever constructing a
  reservation key with an empty segment.
- Implemented atomic `reconcileProductReservedTotal` as a single Lua
  script (not a client-side SMEMBERS-then-GET-loop-then-SET, which could
  overwrite a concurrent mutation) - classifies NO_DRIFT/OVERCOUNT/
  UNDERCOUNT, sets the suspect flag before repairing an UNDERCOUNT, writes
  the repaired total, and clears the flag only after verifying the write.
- Malformed/version-mismatched entries are never treated as "no
  reservation" - they set the suspect flag, are excluded from calculated
  totals without guessing a quantity, and are preserved (not deleted) for
  diagnostics, distinct from a genuinely expired entry's self-heal path.
- Split the test files to comply with the repository's 400-line file
  limit: `inventory-reservations.service.spec.ts` (legacy-only, reverted to
  its original content), `cart-scoped-reservations.service.spec.ts`
  (reserveOrRenew/releaseReservation/getActiveReservation),
  `cart-scoped-availability-reconciliation.service.spec.ts`
  (getReservedTotalExcludingCart/computeAvailableToPurchase/
  reconcileProductReservedTotal), `inventory-reservations.redis.integration.spec.ts`
  (lifecycle/accounting, real Redis), `inventory-reservations-reconciliation.redis.integration.spec.ts`
  (malformed/version-mismatch/reconciliation/concurrency, real Redis), and
  a small shared `inventory-reservations.redis-test-helpers.ts` (ID
  generation, client construction, key tracking/cleanup, raw-state access
  helpers only - no assertions).
- Executed the Lua scripts against a real Redis 8.8.0 instance (no
  ioredis-mock exists in this repo) after the mocked unit suite could only
  validate the TypeScript-to-Lua calling contract, not the scripts' actual
  arithmetic. Found zero Lua defects; one test-assertion bug in the
  integration spec itself, fixed.
- **Passed 18/18 real-Redis scenarios** covering first-reservation,
  increase/decrease/no-op renewal, the 60-minute absolute cap, release/
  duplicate-release, underflow, suspect fail-closed admission, own-cart/
  global availability, expired-entry self-heal, malformed JSON, version
  mismatch, OVERCOUNT/UNDERCOUNT reconciliation, stale-index cleanup, and
  two concurrency scenarios (concurrent reserves converging correctly;
  concurrent reconciliation + mutation never losing an update).
- **Passed the full backend suite: 192/192 test suites, 1501/1501 tests.**
- **Passed CI-equivalent coverage** (`npm run test:cov -w backend` with
  `NODE_ENV=test` and the same env-var names/Redis/Postgres services CI
  uses): 96.79% statements, 91.83% branches, 96.64% functions, 96.68%
  lines - all above the 80/90/90/90 threshold, exit 0.
- **Confirmed no caller cutover occurred**: `grep` across the cart, orders,
  and products modules found zero references to any of the six new
  methods; the legacy methods remain byte-for-byte unchanged.

Commit hashes: Unit 2.1 `c757bdd`, Unit 2.2 `393c970`, Unit 2.3 `a27cb65` -
all pushed and present on `origin/develop`.

## 2026-08-05 - Unit 2.4.3: checkout reservation recovery (`e907998`)

- Moved `ReservationUnderflowDetails` into the neutral
  `reservation-accounting.types.ts` file, so `InventoryReservationsService`
  no longer depends on a checkout-specific types module.
- Implemented `CheckoutReservationRecoveryService` (sibling of
  `CheckoutReservationStateService`/`CheckoutLeaseStateService`, not a
  method addition to either).
- Implemented `CHECKOUT_REVERT_SCRIPT`.
- Implemented `FINALIZE_CHECKOUT_CONSUMPTION_SCRIPT`.
- Implemented two-pass classify-then-mutate recovery for both operations -
  Pass 1 classifies every cart-index member with zero writes, Pass 2
  mutates each classified bucket independently.
- Preserved malformed and unsupported-version evidence (never guessed,
  never deleted) and set the product suspect flag on each.
- Implemented stale cart-index cleanup for missing reservations - internal
  only, never reported in any result array.
- Implemented exact reservation-accounting decrement matching Unit 2.3's
  rule.
- Implemented no-clamp underflow behavior: skip the arithmetic, set
  suspect, report the underflow - never round to zero, never guess.
- Implemented product suspect flags and `admissionSuspended` semantics:
  true whenever malformed, version-mismatch, or underflow handling sets
  suspect state - not calculated from `underflow.length` alone (verified
  by dedicated tests where `admissionSuspended: true` occurs alongside an
  empty `underflow` array).
- Implemented naturally idempotent duplicate revert/finalize behavior - no
  explicit duplicate-detection branch; a repeat call's Pass 1 simply finds
  nothing left to act on.
- Added mixed-corruption chaos-cart testing proving one bad entry never
  blocks another product's independently-resolvable outcome in the same
  call.
- Executed both recovery Lua scripts against real Redis 8.8.0 - zero Lua
  defects found. One test-fixture bug found and fixed in-session
  (lexicographic- vs numeric-sort confusion in a unit-test expectation,
  not a service defect).
- **Passed 48 Unit 2.4.3 targeted tests** (31 unit + 17 real-Redis, across
  `checkout-reservation-recovery.service.spec.ts`,
  `checkout-revert.redis.integration.spec.ts`,
  `checkout-revert-corruption.redis.integration.spec.ts`,
  `checkout-finalize.redis.integration.spec.ts`).
- **Passed 275 inventory tests across 21 suites.**
- **Passed the full backend suite: 204/204 test suites, 1675/1675 tests.**
- **Passed CI-equivalent coverage**: 96.98% statements, 92.61% branches,
  96.86% functions, 96.87% lines - all above the 80/90/90/90 threshold,
  exit 0. Both new Lua scripts and `CheckoutReservationRecoveryService`
  itself at 100/100/100/100.
- **Confirmed no caller or module wiring**: `CheckoutReservationRecoveryService`
  is referenced nowhere outside the inventory module and is not registered
  in `inventory.module.ts`; `checkoutMark` and lease inspection/extension
  (Units 2.4.1-2.4.2) remain byte-for-byte untouched.
- Commit `e907998` (`feat(inventory): add checkout reservation recovery`),
  pushed to `origin/develop`.

## 2026-08-06 - Unit 2.4.4: durable checkout-pending reconciliation orchestration (`ad89219`)

- Created `CheckoutPendingReconciliationService`
  (`reconcileExpiredCheckoutPending`) - a pure orchestrator over
  `CheckoutLeaseStateService`/`CheckoutReservationRecoveryService`, no
  Redis calls of its own, no Prisma dependency.
- Implemented durable-state branching: `PROCESSING` / `COMMITTED` /
  `FAILED` / `NOT_FOUND`, each mapped to its own action.
- Implemented hard-ceiling-first recovery for `PROCESSING`: checked before
  any other condition, using both `hardLimitViolationProductIds` and an
  independent `earliestCheckoutPendingAt`-based cart-wide check.
- Implemented active Redis lease -> `NONE` (structurally complete, not
  expired).
- Implemented fresh durable heartbeat -> `RESYNC_LEASE` (the one case
  that calls `extendCheckoutLease`, at exactly
  `CHECKOUT_PENDING_INITIAL_LEASE_SECONDS` = 180s).
- Implemented unsafe/incomplete Redis state (missing/malformed/
  version-mismatch/active/conflicting-key members, or `found: false`) ->
  direct revert, never attempting an extension that would be guaranteed to
  fail.
- Implemented stale/missing durable heartbeat -> revert.
- Implemented extension-failure fallback to `checkoutRevert`, preserving
  the exact `extensionFailureCode` for every one of `extendCheckoutLease`'s
  seven possible failure codes.
- Implemented future-heartbeat input rejection
  (`durableLastHeartbeatAt > now` -> `INVALID_INPUT`), validated after
  `now` itself to avoid an `NaN`-masking correctness bug.
- Implemented strict dependency-contract-error handling: an unexpected
  `INVALID_INPUT` from any sibling service throws (never mapped to
  `REVERTED`, never retried); infrastructure exceptions propagate
  unchanged.
- Defined the result as a true discriminated union on `action`/`reason` -
  each branch requires exactly its matching nested result, no optional
  fields standing in for a missing one.
- Added real-Redis corruption and concurrency coverage: a corrupted
  stored deadline alone, the cart-wide earliest-timestamp ceiling alone,
  every unsafe-state category, and four race scenarios (resync-vs-revert,
  duplicate reconciliation, reconciliation-vs-finalize,
  reconciliation-vs-revert) - each asserting a single consistent final
  Redis state, never a partial one.
- **Passed 58 Unit 2.4.4 targeted tests** (40 unit across
  `checkout-pending-reconciliation.service.spec.ts` (33) and
  `checkout-pending-reconciliation-contract.service.spec.ts` (7); 18
  real-Redis across `checkout-pending-reconciliation.redis.integration.spec.ts`
  (6), `checkout-pending-reconciliation-corruption.redis.integration.spec.ts`
  (7), and `checkout-pending-reconciliation-concurrency.redis.integration.spec.ts`
  (5) - each file's count independently re-verified in isolation after an
  earlier report mislabeled the contract file's count, before any commit).
- **Passed the full backend suite: 209/209 test suites, 1733/1733 tests**
  (1675 prior baseline + 58 new, exactly accounted for).
- **Passed CI-equivalent coverage**: 97.04% statements, 92.84% branches,
  96.88% functions, 96.93% lines - all above the 80/90/90/90 threshold,
  exit 0. `CheckoutPendingReconciliationService` itself at
  100/100/100/100.
- **Confirmed no caller, scheduler, Prisma, or module wiring**:
  `CheckoutPendingReconciliationService` is referenced nowhere outside the
  inventory module, is not registered in `inventory.module.ts`, imports no
  `PrismaService`/`@prisma/client`, and contains no `@Cron`.
- Commit `ad89219` (`feat(inventory): add checkout pending reconciliation`),
  pushed to `origin/develop`.

## 2026-08-06 - Caller-cutover architecture review and ADR-007 (`15bbacf`)

- Completed a repository review of the current cart, checkout, payment,
  scheduler, module, and Redis transition flows - `CartService`,
  `OrdersService`, `PaymentsService`/`WiPayAdapter`/`CashOnDeliveryAdapter`,
  the two existing crons (`sla-breach-detection.service.ts`,
  `compliance-score-cron.service.ts`), `isSchedulerEnabled()`,
  `InventoryReconciliationService`, and every module's provider/export
  list - confirming the checkout reservation engine (Units 2.4.1-2.4.4) is
  still fully unwired and `CheckoutAttempt` is still schema-only.
- Created `ADR-007` recording the caller-cutover architecture, revised
  after review.
- Recorded the service boundary: `CheckoutAttemptRepository` ->
  `CheckoutAttemptService` -> `CheckoutCoordinatorService`, with
  `CheckoutAttempt` access owned exclusively by the repository layer.
- Recorded `CheckoutReservationFacade` (isolating `CheckoutCoordinatorService`
  from the four checkout-state services plus `InventoryReservationsService`)
  and `PriceLockService` (dedicated price-lock ownership, not embedded in
  `CartService`).
- Recorded PostgreSQL advisory locking as the approved scheduler-lock
  direction, rejecting a Redis distributed lock.
- Recorded the combined-availability formula exactly:
  `Available = Product.quantityAvailable - LegacyReserved - NewReserved`.
- Recorded the phased rollout A-H, with `CartService`'s own cutover
  deferred behind a feature flag, shadow mode, and an old-vs-new
  reservation-total comparison before any legacy call is replaced.
- Carried every open decision forward as an explicit phase gate - 11
  items, each marked OPEN (with the phase it blocks) or RESOLVED (with its
  resolution and source decision), including two gaps a validation pass
  surfaced before commit: the rollout-flag *mechanism* (direction
  approved, exact implementation still open) and the combined-availability-
  bridge ownership (resolved, but had gone unrecorded as such).
- Confirmed no production implementation began - `ADR-007` is a design
  record only; its own Implementation Prohibition section states this
  explicitly, item by item.
- Commit `15bbacf`
  (`docs(architecture): define checkout cutover and integration boundaries`),
  pushed to `origin/develop`.

## 2026-08-07 - Phase 16A.0-A: CheckoutAttempt persistence (`5acbb4b`, `c8ccdf3`)

- Implemented `CheckoutAttemptRepository` and `CheckoutAttemptService` per
  ADR-007's Decision 1 layering, exactly one repository owning
  `prisma.checkoutAttempt.*` access.
- `createOrGetByIdempotencyKey`: unique-constraint-as-concurrency-authority
  (plain `create()` first, P2002-then-reread on race) - confirmed the
  P2002 handling only treats a violation whose `meta.target` includes
  `idempotencyKey` as the expected race; any other P2002 target or Prisma
  error code rethrows unchanged. Added a dedicated mocked-Prisma spec
  (`checkout-attempt.repository.unit.spec.ts`) for this branch, since a
  non-idempotencyKey P2002 cannot be manufactured through genuine
  concurrent Postgres calls against this schema - the one deliberate
  exception to this codebase's real-Postgres repository-spec convention.
- `markCommittedInTransaction` requires a caller-owned
  `Prisma.TransactionClient` - never defaulted - per ADR-007's hard
  transactional-write requirement.
- `markFailed`'s `failureMessage` handling was corrected mid-round from
  reject-based validation to sanitize-then-store: unsafe message content
  (stack traces, bearer tokens, JWTs, password/secret/token/api-key
  key-value pairs) must never block the `PROCESSING` -> `FAILED`
  transition. Sanitization order (stack-frame strip -> secret redaction ->
  trim -> truncate to 500, truncation always last) is now recorded in
  ADR-007 itself, not just in code comments.
- Introduced `CheckoutAttemptSummary`, a narrow projection returned by
  `createOrResume` that deliberately excludes `failureMessage` - proven by
  a test that an `ALREADY_FAILED` result never exposes the raw stored
  message.
- `findStalePage`: keyset pagination on the new additive
  `[status, lastHeartbeatAt, id]` index, confirmed via `pg_indexes` to
  coexist with the pre-existing `[status, lastHeartbeatAt]` index (no
  accidental replacement).
- Split the spec suite into 4 files to respect the 400-line cap:
  `checkout-attempt.service.spec.ts` (createOrResume),
  `checkout-attempt-transitions.service.spec.ts` (heartbeat + commit),
  `checkout-attempt-failure-pagination.service.spec.ts` (markFailed +
  findStalePage), `checkout-attempt-module-boundary.spec.ts` (structural:
  no Prisma access outside the repository, no production-module
  references) - the last one split out when closing two coverage gaps
  pushed the failure/pagination file over 400 lines.
- 66 new tests; full backend suite 1733 -> 1799 (216 suites, all passing);
  `checkout-attempt.service.ts` at 100% lines/functions/branches.
  Confirmed via `git grep` that `CheckoutAttemptService`/`Repository`/
  `Module` are referenced nowhere outside the module itself except in
  documentation - zero production wiring.
- Commit `5acbb4b` (`feat(checkout): add checkout attempt persistence`),
  followed by `c8ccdf3`
  (`docs(architecture): record failure-message sanitization contract in
  ADR-007`), then `b10da0b`
  (`chore(docs): close Phase 16A.0-A checkout attempt persistence
  session`). All three pushed to `origin/develop` (the first push attempt
  failed with `Could not resolve host: github.com`; a retry after the
  closeout commit succeeded).

## 2026-08-07 (cont.) - Phase 16A.0-B: PriceLockService (`16fc405`)

- Implemented a standalone, unwired `PriceLockModule`
  (`PriceLockService`, `PriceLockRepository`) per ADR-007 Decision 7 -
  imports `CartModule`/`ProductsModule` for their already-exported
  repositories (`CartRepository`, `ProductsRepository`); no new
  production-module exports were needed, verified by direct inspection
  before implementation.
- `PRICE_LOCK_TTL_SECONDS = 900` - an independent constant, deliberately
  never aliased to or derived from `RESERVATION_TTL_SECONDS`, resolving
  ADR-007 open decision 4.
- Confirmed `Product.currency` (`String @default("JMD")`) is a real
  per-row column, not a global constant - resolving ADR-007 open decision
  8 and establishing it as the authoritative source for `CartItem.
  lockedCurrency` and `Cart.currency`.
- `Cart.currency` established atomically via
  `CartRepository.establishCurrencyIfCompatible` - one conditional
  `updateMany` (`id = cartId AND customerId = customerId AND (currency IS
  NULL OR currency = productCurrency)`) before any `CartItem` lock write,
  never a read-then-write.
- `createLockIfMissing` conditions on all three lock fields being null
  (not `priceLockedAt` alone), so a partially-corrupted row can never be
  silently treated as missing and overwritten.
- **Existing-lock classification always precedes any `Product` read** -
  corrected mid-round: an existing `COMPLETE` lock is not valid merely
  because all three fields are non-null, it must also agree with the
  *stored* `Cart.currency` (never current `Product.currency`) -
  `CART_CURRENCY_MISSING`/`CART_CURRENCY_MISMATCH` take priority over the
  TTL check, so an existing lock can fail closed on the cart-wide
  invariant without ever consulting vendor pricing. The identical
  three-way check applies to race-loss winner reclassification, reusing
  the already-loaded `product.currency` rather than re-reading `Cart` or
  `Product`.
- `reconfirmPrice` is the only operation that may replace a `COMPLETE`
  lock's values - gates on `Cart.currency` being non-null *before* ever
  reading `Product` (`CART_CURRENCY_MISMATCH`/`CART_CURRENCY_MISSING`,
  zero `Product` reads, zero writes for `MISSING`/`PARTIAL`/missing-cart-
  currency states); never used as an automatic corruption-repair path.
- A partially-populated lock (any combination other than all-null or
  all-non-null) is `PRICE_LOCK_STATE_INVALID` and fails closed everywhere
  - `createPriceLock`, `reconfirmPrice`, `getPriceLockState`,
  `validateCartPriceLocks` - never silently repaired.
- `validateCartPriceLocks` never reads `Product.price` to authorize an
  existing lock - `PriceLockRepository.findCartWideLockState`'s narrow
  select structurally has no `Product` join.
- `Prisma.Decimal` used throughout reads/writes/comparisons; string
  conversion only at result boundaries. Noted `Decimal.toString()`
  normalizes trailing zeros (`'500.00'` -> `'500'`).
- Real-Postgres concurrency proven: two `createPriceLock` calls racing
  different-currency products against a null-currency cart produce
  exactly one `CREATED`/one `CART_CURRENCY_MISMATCH`, final `Cart.currency`
  matches the winner, loser's lock fields stay `null`; two concurrent
  `createPriceLock` calls on the same missing `CartItem` produce exactly
  one `CREATED`/one `ALREADY_LOCKED`, winner's `priceLockedAt` never
  renewed; a partial lock is never overwritten under concurrency either.
- 54 new tests across 7 files (`price-lock-creation.service.spec.ts`,
  `price-lock-creation-errors.service.spec.ts`,
  `price-lock-reconfirm.service.spec.ts`,
  `price-lock-state-validation.service.spec.ts`,
  `price-lock-concurrency.service.spec.ts` (real Postgres),
  `price-lock.repository.spec.ts` (real Postgres), plus 4 new
  `CartRepository.establishCurrencyIfCompatible` tests). Full backend
  suite 1799 -> 1853 (222 suites, all passing). CI-equivalent parallel
  coverage: 97.21% statements, 93.55% branches, 96.97% functions, 97.12%
  lines (80/90/90/90 threshold), exit 0 - passed cleanly on the first
  attempt this round (an earlier `test:cov` run had flaked in unrelated,
  untouched `payments.repository.spec.ts`/`orders.repository.spec.ts`
  under parallel workers; confirmed non-deterministic via two clean
  retries before this round even began). `price-lock.service.ts` itself
  at 100% lines/functions/branches/statements.
- Confirmed no production wiring: `git grep` for
  `PriceLockService`/`PriceLockRepository`/`PriceLockModule` outside
  `backend/src/modules/price-lock/` returns only a code comment in
  `cart.repository.ts` and documentation. `CartService` and
  `OrdersService` were not touched.
- Commit `16fc405` (`feat(checkout): add price lock service`), pushed to
  `origin/develop`.

## 2026-08-08 - Phase 16A.0-C, Units C0 and C1: reservation-engine mode control (`357e35b`, `8978f03`)

- **C0**: registered `CheckoutReservationStateService`/
  `CheckoutLeaseStateService`/`CheckoutReservationRecoveryService`/
  `CheckoutPendingReconciliationService` as `InventoryModule` providers/
  exports - these four classes existed since Units 2.4.1-2.4.4 but were
  never part of the Nest DI graph, only constructed directly in their own
  spec files. Pure wiring, verified zero behavior change by running the
  full `AppModule`/`health.e2e-spec.ts` bootstrap before and after (would
  fail loudly on any DI resolution error). Still no production caller.
- **C1**: `ReservationEngineModeConfig` (append-only, `MarketplaceModeConfig`-
  shaped) + `ReservationEngineModeService`/`ReservationEngineModeConfigRepository`,
  standalone unwired `ReservationEngineModeModule`.
  - `ReservationEngineMode` enum: `LEGACY`/`MIRROR`/`CART_SCOPED`/
    `DRAINING`. `DRAINING` is a dedicated state (never a reuse of
    `MIRROR`) - legacy stays authoritative, but the new engine receives
    zero new writes at all during an in-progress rollback, so existing
    holds can only shrink, never grow.
  - Full transition graph enforced via an explicit `VALID_TRANSITIONS`
    set, no self-loops: `LEGACY<->MIRROR`, `MIRROR->CART_SCOPED`,
    `CART_SCOPED<->DRAINING`, `DRAINING->LEGACY` (gated).
    `CART_SCOPED->LEGACY` directly is structurally impossible, not merely
    discouraged - confirmed by both a unit test and a real-Redis
    integration test.
  - **Append-only concurrency race closed**: `setMode`'s entire
    read-validate-write sequence runs inside one Postgres transaction,
    serialized by a transaction-scoped advisory lock
    (`pg_advisory_xact_lock(hashtext('reservation_engine_mode_transition'))`) -
    without it, two concurrent admin calls could both read the same stale
    "current" mode and both succeed, leaving an ambiguous current state.
    Proven with a real-Postgres test: two transitions racing from the
    same starting mode produce exactly one winner and one loser correctly
    classified `INVALID_TRANSITION` (the loser is serialized behind the
    winner, re-reads the *new* current mode, and its own stale intent is
    no longer valid). `PrismaService` is injected into the service solely
    to open `$transaction` - confirmed via direct inspection that every
    actual `reservationEngineModeConfig` read/write goes through the
    repository, never `this.prisma.reservationEngineModeConfig.*`
    directly.
  - **Rollback gate checks two independent Redis signals** - aggregated
    `product-total` keys and the cart-scoped reservation index - reusing
    `InventoryReservationsService.getActiveReservation` for genuine
    liveness rather than trusting raw index membership (which can go
    stale). Distinguishes a genuine outstanding hold (`ROLLBACK_BLOCKED`)
    from the two signals disagreeing (`ROLLBACK_STRUCTURE_DRIFT` - a
    distinct, data-integrity-flavored condition that takes priority and
    fails closed until reconciled, per ADR-007 Decision 8's "outstanding
    reservations vs. data-structure drift" distinction).
  - Real-Redis test matrix (5 scenarios, all passing): both structures
    empty -> allowed; both non-zero and agreeing -> `ROLLBACK_BLOCKED`;
    total-only non-zero (manufactured) -> `ROLLBACK_STRUCTURE_DRIFT`;
    index-only live (manufactured) -> `ROLLBACK_STRUCTURE_DRIFT`;
    `CART_SCOPED->LEGACY` direct -> `INVALID_TRANSITION`. Test isolation
    uses a dedicated logical Redis DB (index 1, `FLUSHDB`'d per test) -
    the shared dev/test instance's default DB 0 is known to carry ~1350
    leftover `inv:reserved:*` keys from unrelated prior test runs across
    this codebase's history (a pre-existing test-hygiene gap, flagged as
    its own background task, not fixed here); production code still
    scans the real `inv:reserved:product-total:{*}`/
    `inv:reserved:cart-index:{*}` prefixes unchanged.
  - 39 new tests across 4 files (service unit spec, repository real-
    Postgres spec, rollback-gate real-Redis spec, mode-change real-
    Postgres concurrency spec). Full backend suite 226 suites / 1892
    tests, exit 0. CI-equivalent coverage 97.26%/93.66%/97.00%/97.18%
    (80/90/90/90 threshold), exit 0 - `reservation-engine-mode.service.ts`
    itself at 100/100/100/100. `AppModule` bootstrap 4/4. Prisma
    validate/generate/migrate-status/drift all clean, no drift.
  - Confirmed no C2 work exists: no `CheckoutReservationFacade`,
    `ReservationGateway`, or combined-availability bridge file anywhere;
    `CartService`/`ProductsService`/`OrdersService` untouched.
- Added a new Decision 8 section to `ADR-007` (state-transition table,
  rollback invariants, compensation-reconciler ownership intent for the
  not-yet-built C4, the recovery-idempotency invariant, and the
  "outstanding reservations vs. data-structure drift" distinction) -
  written *before* any C0/C1 code, per explicit instruction.
- Commit `357e35b` (`chore(inventory): register checkout reservation
  services`), followed by `8978f03` (`feat(checkout): add reservation
  engine mode control`) - both pushed to `origin/develop` as two separate
  commits, exactly as proposed.
