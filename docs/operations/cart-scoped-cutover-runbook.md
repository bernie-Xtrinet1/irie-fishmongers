# CART_SCOPED Cutover Runbook

Status: **operational-readiness review only. No execution has occurred.**

Scope: everything needed to rehearse the `MIRROR -> CART_SCOPED` activation
(commit `2a1a8f8`, "feat(reservations): add CART_SCOPED activation gate")
against a disposable staging environment. This document does not authorize,
and its author did not perform, any production `setMode()` call, any live
authority transition, or any run of the activation CLI against any
non-disposable database. Producing this runbook and rehearsing it in staging
are both explicitly separate from - and prerequisites to - the later,
separate decision to activate CART_SCOPED for real. That later decision
requires its own explicit authorization and is out of scope here.

---

## Operational findings from the 2026-08-16 staging rehearsal — read first

A full isolated-staging rehearsal (native Postgres 16 + standalone Redis, never
production/dev) exercised both the forced-failure and successful cutover paths.
Every documented gate behavior held. Three durable operational findings:

1. **The CLI bootstraps its own event-bus infrastructure.**
   `CutoverOrchestrationModule` transitively imports `InventoryModule →
   AuthModule → AuthService`, whose constructor requires `EventEmitter2`; that
   provider comes only from `EventEmitterModule.forRoot()`. Because the CLI
   boots standalone (never through `AppModule`, which supplies it in the running
   app), the module registers `EventEmitterModule.forRoot()` itself — without
   it, `NestFactory.createApplicationContext` throws
   `UnknownDependenciesException` before Step 1. This is covered by a regression
   test (`cutover-orchestration.module.spec.ts`) that compiles the module's full
   graph standalone; keep that test alongside any future change to the module's
   imports.
2. **Expect a long, variable startup before Step 1 logs.** Under `ts-node` the
   cutover logic itself ran in ~4 seconds, but end-to-end wall-clock was 46–128
   seconds (variable) because `ts-node` compiles the whole transitively-imported
   app graph on each invocation. Silence before `Step 1/7` is normal, not a
   hang. (Whether to move the CLI to a precompiled execution model is a separate
   packaging decision, not yet taken — this behavior is documented, not yet
   changed.)
3. **Provision an isolated Postgres as UTF-8.** Create the cluster/database with
   `-E UTF8 -T template0`; a default WIN1252 cluster fails `prisma:seed` on an
   emoji in the vendor-tier config seed.

## 0. What this procedure actually does

Single administrative CLI process (`src/scripts/activate-cart-scoped-mode.ts`,
booted via `CutoverOrchestrationModule` - never `AppModule`, never a
controller, never a scheduler) that runs seven steps in one uninterrupted
Node process:

1. Activate the cart mutation barrier (blocks `addItem`/`updateItemQuantity`/
   `removeItem`/`checkout` cart-clear with an HTTP 503 for the duration of
   the run - see §8, customer impact).
2. Drain the DA.1B `CartReservationSyncState` backlog to zero.
3. Drain the C4 `CartReservationCompensation` backlog (including
   `PERMANENT_FAILURE`) to zero.
4. Enumerate every durable positive `CartItem` and backfill it directly into
   the cart-scoped Redis engine (mode is still MIRROR throughout).
5. Discover and release orphaned cart-scoped Redis holds with no
   corresponding positive `CartItem`.
6. Run a freshness sweep (atomic epoch reset) over every backfilled target
   and build a `CutoverAttestation`.
7. Call `ReservationEngineModeService.setMode({ targetMode: 'CART_SCOPED',
   cutoverAttestation })`, which re-verifies barrier revision, DA.1B
   backlog, C4 backlog, target count, and freshness atomically under the
   existing exclusive transition advisory lock before writing the new mode
   row.

Failure at **any** step - including a rejected `setMode()` call - leaves
mode at MIRROR and the mutation barrier **active**. Nothing in this CLI ever
lifts the barrier automatically. Lifting it is a separate, deliberate
action: `npm run cutover:lift-mutation-barrier`.

---

## 1. Staging preflight checklist

Complete every item before invoking `cutover:activate-cart-scoped` in
staging. None of these steps touch production.

- [ ] Confirm the target database is the disposable staging instance, not
      production - verify `DATABASE_URL`'s host/port/db name out loud
      before running anything, and confirm it does not match any known
      production connection string.
- [ ] Confirm `REDIS_URL` similarly points at the disposable staging Redis
      instance.
- [ ] `npx prisma migrate status` against staging reports "Database schema
      is up to date!" (all 36 migrations applied, including
      `20260815223836_add_cart_mutation_barrier_config`).
- [ ] `npm run typecheck`, `npm run lint`, and the full `npm run test:cov`
      suite pass against the exact commit being rehearsed (`2a1a8f8` or
      later) - do not rehearse against an unverified working tree.
- [ ] Staging is seeded with a realistic mix of state: some carts with
      positive `CartItem` rows (varied quantities, multiple vendors/
      products), at least one deliberately-orphaned cart-scoped Redis
      reservation (see §10, rehearsal step 2), and - ideally - staging's
      current mode is MIRROR already (the gate only fires from MIRROR; see
      §3 for how to get there if staging starts at LEGACY).
- [ ] Confirm no other process is concurrently writing to this staging
      database/Redis pair during the rehearsal window (a second CI run, a
      second developer's session, a load-test script) - the barrier
      protects durable correctness, but a concurrent, unrelated load
      generator would make the rehearsal's observations meaningless.
- [ ] Identify (or create) a real `User` row in staging to use as
      `CUTOVER_OPERATOR_USER_ID` (see §3) - it becomes a permanent,
      `Restrict`-protected foreign-key reference on every barrier/mode-
      config row the run creates, so it can never be deleted afterward
      without first clearing those rows.
- [ ] Confirm you have a terminal with the full staging `.env` available
      (see §3 - the CLI validates the *entire* `EnvironmentVariables`
      class, not just `DATABASE_URL`/`REDIS_URL`).
- [ ] Confirm §2's backup has been taken and its restore path has itself
      been rehearsed at least once (not merely assumed to work).
- [ ] Block out an uninterrupted window for the rehearsal - once the
      barrier activates, cart-mutating requests in staging start failing
      with 503 until it is lifted (§8).

---

## 2. Required backups/snapshots and rollback prerequisites

The cutover is not destructive to durable truth (`CartItem` rows are only
ever read, never mutated, by this CLI) but it does write new rows to three
tables and rewrites/deletes Redis reservation keys. Rehearse the restore
path, not just the backup:

- **Postgres**: take a full logical backup immediately before the
  rehearsal begins - `pg_dump` (or the staging provider's own
  point-in-time-recovery/snapshot feature if staging runs on managed
  Postgres). Confirm the backup file is non-empty and confirm you can
  actually restore it into a scratch database before trusting it as your
  rollback path.
- **Redis**: take an `RDB` snapshot (`BGSAVE` or the provider's snapshot
  feature) immediately before, purely for forensic comparison - Redis
  reservation state is derived/ephemeral by design (`CartItem` is the
  durable source of truth), so a Redis restore is not load-bearing for
  correctness, only useful for diffing "what changed."
- **Rollback prerequisite check**: confirm `verifyRollbackSafe()`'s
  `DRAINING -> LEGACY` gate is understood by whoever is running the
  rehearsal - it is the *existing*, separate emergency-rollback path for
  after a mode has already reached CART_SCOPED and needs to be walked back
  (`CART_SCOPED -> DRAINING -> LEGACY`), not part of this cutover script.
  It is unchanged by this unit (verified byte-identical in the commit-gate
  review) but is the mechanism you would reach for if a *post*-cutover
  problem is discovered. Confirm it, too, is exercised at least once
  against staging as part of this rehearsal (see §10, step 6).
- Record the pre-rehearsal state before starting: `SELECT * FROM
  reservation_engine_mode_configs ORDER BY revision DESC LIMIT 1;` and
  `SELECT * FROM cart_mutation_barrier_configs ORDER BY revision DESC
  LIMIT 1;` - so a "no rows" or "inactive" baseline is on record to compare
  against afterward.

---

## 3. CLI invocation order and required environment variables

Two npm scripts, both defined in `backend/package.json`:

```bash
npm run cutover:activate-cart-scoped   # ts-node src/scripts/activate-cart-scoped-mode.ts
npm run cutover:lift-mutation-barrier  # ts-node src/scripts/lift-cart-mutation-barrier.ts
```

**Environment.** `CutoverOrchestrationModule` boots with
`ConfigModule.forRoot({ validate: validateEnv })` against the *complete*
`EnvironmentVariables` class (`src/config/environment-variables.ts`) -
`validateSync` runs with `skipMissingProperties: false`, so **every**
required field must be present in `.env`, not only the ones this CLI
actually uses. In practice: run it from the same directory, with the same
`.env` file, that the main staging app itself uses. The one variable this
CLI needs that the main app does not require is:

- `CUTOVER_OPERATOR_USER_ID` - a real `User.id` in the target database.
  Both `activate-cart-scoped-mode.ts` and `lift-cart-mutation-barrier.ts`
  refuse to start (exit code 1, before touching the database) if it is
  unset.

**Invocation order for a rehearsal:**

1. If staging's current mode is not already MIRROR, get it there first
   (this is *not* part of the cutover gate - it is ordinary
   `LEGACY -> MIRROR` via the existing, unrelated
   `ReservationEngineModeService.setMode()` call, e.g. through a scratch
   script or an admin action already available in the codebase - never the
   cutover CLI, which only ever targets `CART_SCOPED`).
2. `CUTOVER_OPERATOR_USER_ID=<staging-admin-user-id> npm run
   cutover:activate-cart-scoped` - runs to completion or exits non-zero.
3. Perform post-cutover verification (§9) if it succeeded, or the retry/
   abort decision (§6/§7) if it did not.
4. Only after verification: `CUTOVER_OPERATOR_USER_ID=<same-user-id> npm
   run cutover:lift-mutation-barrier`.

Never run step 4 before step 3 is complete and deliberate.

---

## 4/5. What to observe at each step, and what proves progress

There is no metrics/dashboard system for this CLI today - **this is a known
observability gap**, not an oversight to paper over. The only signals are
(a) the CLI's own `Logger` lines on stdout in the single terminal running
it, and (b) manual DB/Redis queries run in a second terminal, in parallel.
For a one-time rehearsal this is workable if a second person/terminal is
watching the queries below while the CLI runs; if this procedure becomes
routine, adding structured metrics is worth a future unit - not attempted
here.

Run the CLI with a second terminal open, watching the queries in the
"prove progress" column as each step's log line appears.

| Step | Exact log line(s) | What it means | Query/command that independently proves it |
|---|---|---|---|
| 1/7 | `Step 1/7: activating mutation barrier` then `Mutation barrier active at revision N` | Exclusive lock acquired, barrier row inserted | `SELECT revision, active, "activatedById" FROM cart_mutation_barrier_configs ORDER BY revision DESC LIMIT 1;` -> `active = true`, revision matches the logged N. Also: a live `addItem`/`updateItemQuantity`/`removeItem`/checkout call against staging now returns HTTP 503. |
| 2/7 | `Step 2/7: draining DA.1B sync backlog`, then repeating `DA.1B sync backlog: N unresolved - running a recovery batch` until `DA.1B sync backlog drained to zero` | DA.1B recovery worker converging every unresolved marker | `SELECT COUNT(*) FROM cart_reservation_sync_states WHERE "resolvedAt" IS NULL;` - should trend to 0, matching the logged N each iteration |
| 3/7 | `Step 3/7: draining C4 compensation backlog`, repeating `C4 compensation backlog: N unresolved/PERMANENT_FAILURE - running a recovery batch` until `C4 compensation backlog drained to zero` | C4 mirror-compensation batch service converging every backlog row | `SELECT COUNT(*) FROM cart_reservation_compensations WHERE status IN ('PENDING','PROCESSING','BLOCKED','PERMANENT_FAILURE');` - should trend to 0 |
| 4/7 | `Step 4/7: enumerating durable positive targets and backfilling` then `N positive CartItem target(s) found` | Every positive CartItem system-wide is the backfill's target set | `SELECT COUNT(*) FROM cart_items WHERE quantity > 0;` should equal the logged N at the instant this line prints (it can drift afterward only if the barrier were not truly blocking writes - it is, per step 1) |
| 5/7 | `Step 5/7: discovering and releasing orphan cart-scoped reservations` then `N orphan reservation(s) released` | Stale cart-scoped Redis holds with no matching CartItem are cleared | `redis-cli --scan --pattern 'inv:reserved:cart-index:{*}'` before/after - member count should shrink by exactly N products' worth of orphaned entries |
| 6/7 | `Step 6/7: running freshness sweep and building attestation` then `Attestation built: {barrierRevision, targetCount, minimumExpiresAt, completedAt}` | Every backfilled target's Redis entry got a fresh ~15-minute epoch | For a sampled `cartId`/`productId`: `redis-cli GET "inv:reserved:{<cartId>}:<productId>"` - decode the JSON, confirm `createdAt`/`absoluteExpiresAt` are recent (within the last few seconds of this log line) |
| 7/7 | `Step 7/7: authorizing MIRROR -> CART_SCOPED transition` then either `Cutover SUCCEEDED: mode is now CART_SCOPED (id X, timestamp)` or `Cutover REJECTED: {...}` | The final locked transition committed or was correctly refused | `SELECT mode, revision, "createdAt" FROM reservation_engine_mode_configs ORDER BY revision DESC LIMIT 1;` - `mode = 'CART_SCOPED'` only on success; unchanged (still MIRROR) on rejection |

Additional signal available at every step: staging application logs (the
main API process, if running) for any `ServiceUnavailableException` /
`CartMutationBarrierActiveError` entries - confirms real cart traffic is
correctly being refused, not silently dropped or silently admitted.

---

## 6. Explicit abort conditions

Treat any of the following as a hard stop - do not let the CLI continue or
retry automatically, and do not proceed to §8 (lift):

- Step 2 or 3 logs the same non-decreasing (or increasing) backlog count
  across several consecutive iterations - a genuine stuck marker, not slow
  convergence, and continuing to loop wastes the barrier window without
  making progress. (The script itself gives up after `MAX_DRAIN_ITERATIONS
  = 200` batches and throws - but an operator watching should abort well
  before that if the count is visibly not decreasing.)
- `Backfill did not fully converge: [...]` - thrown when any backfill
  outcome is `BLOCKED` or `RETRY` (e.g. `PRODUCT_SUSPECT`,
  `CHECKOUT_IN_PROGRESS`, `UNKNOWN_INFRA_FAILURE`). Investigate the listed
  target(s) before ever re-running.
- `Freshness sweep did not fully converge: [...]` - same shape, at step 6.
- Any `Cutover REJECTED: {...}` result from `setMode()` - see §7 for the
  code-specific retry decision; never blindly re-run without understanding
  which of the six precondition codes fired.
- The process throws anything unhandled (`Cutover activation failed` with
  a stack trace) - read the stack before doing anything else.
- The rehearsal is taking meaningfully longer than expected and cart
  traffic is genuinely time-sensitive (in staging, this is a rehearsal
  concern about realistic timing data; in a real activation, this would be
  a customer-impact concern - see §8).
- Any doubt at all about which database/Redis instance the terminal is
  actually pointed at - stop and re-verify `DATABASE_URL`/`REDIS_URL`
  before typing anything further.

In every abort case: mode remains MIRROR and the barrier remains active by
construction (nothing auto-lifts it). The only decision left is whether to
retry (§7) or lift and stand down (§8).

---

## 7. Retry procedure after a failed gate

1. Read the exact failure - either a thrown `Error` (steps 2-6) or a
   structured `Cutover REJECTED: { ok: false, code: '...' }` (step 7).
2. Do **not** re-run `cutover:activate-cart-scoped` immediately. The
   barrier is still active from the failed attempt (`activate()` is
   idempotent - re-running the CLI would re-acquire the same barrier state,
   not create a second one), so ordinary cart traffic is still blocked
   while you investigate.
3. Diagnose by failure code:
   - `CUTOVER_ATTESTATION_REQUIRED` - should be structurally unreachable
     (the CLI always builds one); if seen, treat as a code-level defect,
     not an operational retry case.
   - `CUTOVER_BARRIER_REVISION_MISMATCH` - the barrier was deactivated/
     reactivated (a new revision) between attestation and transition,
     most likely by a second, concurrent operator action. Confirm nobody
     else ran `cutover:lift-mutation-barrier` or re-activated concurrently,
     then retry from step 1 (backfill/freshness must be redone against the
     new revision).
   - `CUTOVER_SYNC_BACKLOG` / `CUTOVER_COMPENSATION_BACKLOG` - the drain
     loop (steps 2/3) somehow didn't fully drain by the time step 7 ran, or
     a marker went unresolved *after* draining but before the transition.
     Re-run the CLI from the top; steps 1-3 are idempotent against the
     already-active barrier and will re-drain whatever remains.
   - `CUTOVER_TARGET_COUNT_MISMATCH` - a positive `CartItem` was created,
     deleted, or changed quantity between enumeration (step 4) and the
     final transition (step 7) - should be impossible while the barrier is
     genuinely active; if seen, this is the single highest-priority finding
     to escalate before ever retrying, since it means either the barrier
     failed to block a write path or something wrote directly to `cart_items`
     bypassing `CartService` entirely (a direct DB write, a migration, a
     different, un-audited code path).
   - `CUTOVER_BACKFILL_STALE` - the freshness window (§0 step 6, ~15
     minutes) expired before the final transaction ran, most likely because
     steps 2-6 took too long (large backlog, slow environment). Simply
     re-run the CLI from the top - `reserveWithFreshEpoch` is idempotent
     and will re-freshen every target's epoch.
   - `INVALID_TRANSITION` - current mode was not actually MIRROR when the
     CLI ran (e.g. staging was still at LEGACY, or someone else already
     moved it). Confirm current mode via `getCurrentMode()`/the DB query in
     §5's table before retrying anything.
4. Once the root cause is understood and addressed, re-running
   `cutover:activate-cart-scoped` from the top is always safe - every step
   is either idempotent (barrier activation, backfill, freshness sweep) or
   self-healing (backlog drains re-derive current state rather than
   assuming prior progress).
5. If retries are not converging after 2-3 informed attempts, stop and
   lift the barrier (§8) rather than repeatedly extending the customer-
   impact window while investigating.

---

## 8. Barrier-lift procedure

`npm run cutover:lift-mutation-barrier` (requires the same
`CUTOVER_OPERATOR_USER_ID`). This is **always** a separate, deliberate,
human-initiated action - the activation CLI never calls it, on success or
failure.

**Customer impact while the barrier is active** (real in any real
environment, including a shared staging instance other people are using):
`addItem`, `updateItemQuantity`, `removeItem`, and `checkout` all return
HTTP 503 (`CartMutationBarrierActiveError` -> `ServiceUnavailableException`,
message: see `CART_MUTATION_BARRIER_ACTIVE_MESSAGE` in `cart.service.ts`/
`orders.service.ts`). Product browsing and availability reads are
unaffected - only cart writes and checkout. This window should be treated
as real, measurable downtime for that slice of functionality, and its
duration during the rehearsal is itself useful data for estimating the real
activation's customer-impact window.

**When to lift:**
- **Success path**: only after §9's post-cutover verification is fully
  complete and satisfactory.
- **Abort/failure path**: after a deliberate operator decision to stand
  down (not mid-investigation - see §7 step 5) - mode remains MIRROR,
  nothing about the failed attempt needs to be undone in Postgres/Redis
  (backfilled cart-scoped entries and released orphans are harmless
  leftover state either way; the source of truth, `CartItem`, was never
  touched).

**Verify the lift:**
`SELECT revision, active FROM cart_mutation_barrier_configs ORDER BY
revision DESC LIMIT 1;` -> `active = false`, revision incremented from the
activation row. Then confirm a live `addItem` call against staging succeeds
again (200, not 503).

---

## 9. Post-cutover verification (success path only)

After `Cutover SUCCEEDED` and before lifting the barrier:

1. `getCurrentMode()` (or the DB query in §5's table) confirms
   `CART_SCOPED` is current.
2. For a sample of carts with positive `CartItem` rows (including at least
   one that existed before the run and one added *during* MIRROR just
   before the barrier activated): confirm
   `InventoryReservationsService.getActiveReservation(cartId, productId)`
   (or the raw `GET inv:reserved:{cartId}:productId` key) reflects the
   correct quantity.
3. Confirm `ReservationAvailabilityService.getCartAdmissionAvailability`
   now reports `source: 'CART_SCOPED'` (not `'LEGACY'`) for a sampled
   product - proves routing, not just the mode flag, actually changed.
4. With the barrier still active, confirm the orphan-release outcome from
   step 5 was correct: no cart-scoped Redis entry exists for a cart-index
   member with no positive `CartItem`.
5. Only then: lift the barrier (§8), and immediately re-verify with a
   **live** `addItem` call that:
   - it succeeds (200, not 503),
   - the resulting Redis entry was written via `reserveOrRenew` (cart-
     scoped engine), not the legacy hash - i.e. genuinely new CART_SCOPED
     routing, not just a mode string that nothing reads yet.
6. Leave the DRAINING->LEGACY rollback path (§2) available and understood,
   but do not exercise it unless a real problem is found - it is the
   emergency path, not a routine step.

---

## 10. Staging-only rehearsal plan

The rehearsal must exercise the **real** CLI against a **real** Postgres +
Redis pair on the **same code path** production will eventually use -
never a mock, never an in-memory substitute. The existing
`.devcontainer/docker-compose.yml` (Postgres 16-alpine + Redis 7-alpine,
the same images `.github/workflows/ci.yml` already uses) is the right base:
spin up an isolated instance of that stack - a scratch Codespace, a
throwaway `docker compose -p cutover-rehearsal up`, or an equivalent
disposable staging deployment - pointed at its own throwaway volumes, never
at any shared or production database.

1. **Provision**: bring up the disposable stack, run `prisma migrate
   deploy`, seed realistic data (existing `prisma/demo-seed.ts` as a
   starting point, extended with enough cart/reservation variety to be
   meaningful - see §1's seeding checklist item).
2. **Seed a deliberate orphan**: directly write a cart-scoped Redis
   reservation (`reserveOrRenew`) for a cart/product pair, then delete the
   corresponding `CartItem` - proves step 5 actually finds and releases it,
   not just that it runs without error on a trivial case.
3. **Move to MIRROR**: via the ordinary, unrelated `setMode()` path (not
   the cutover CLI) if the seed data starts at LEGACY.
4. **Full preflight** (§1) against this disposable instance.
5. **Run the activation CLI**, with a second terminal watching every query
   in §5's table in real time, and record wall-clock duration per step -
   this is the data point that will inform how the real activation gets
   scheduled/communicated later.
6. **Verify** per §9, then **lift** per §8.
7. **Deliberately break it once**, on a second rehearsal pass, to prove the
   abort/retry path is real, not just the happy path - e.g. seed a
   `PERMANENT_FAILURE` C4 row that can't auto-resolve and confirm the CLI
   correctly refuses to proceed, or seed an unresolved DA.1B marker with no
   valid recovery path and confirm `CUTOVER_SYNC_BACKLOG`/drain-exhaustion
   behaves exactly as §7 describes.
8. **Exercise the emergency rollback once**: after a successful rehearsal
   cutover, deliberately run `CART_SCOPED -> DRAINING -> LEGACY` via
   `verifyRollbackSafe()`'s existing gate, to confirm that path still works
   post-cutover (it is unchanged by this unit, but "unchanged in the diff"
   is not the same as "rehearsed").
9. **Tear down** the disposable stack entirely - it should never be reused
   or promoted; the next rehearsal (or the real activation) gets a fresh
   instance.
10. **Write up** actual observed timings, any surprises, and any runbook
    corrections this document needs, before treating operational readiness
    as demonstrated rather than merely designed.

---

## 11. Confirmation

No production `setMode()` call, no live authority transition, and no
invocation of `cutover:activate-cart-scoped` or `cutover:lift-mutation-
barrier` against any non-disposable environment occurred in the production
of this runbook. This document is a readiness artifact only. Activating
CART_SCOPED - in staging via the rehearsal above, or later in production -
remains a separate, explicit authorization boundary, not an implicit
continuation of this review.
