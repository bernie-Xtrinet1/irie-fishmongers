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

## Verification tooling added along the way

- `scripts/verify-codespaces-demo.sh`: now checks (2b) no frontend
  `NEXT_PUBLIC_*` in docker-compose, (5c) the first catalog product's
  image loads 200 through `/_next/image`, (6) no `localhost:3001` in
  either app's compiled client bundle.
- `backend/prisma/demo-seed.spec.ts`: regression guard - local raster
  paths only, referenced files exist on disk.
