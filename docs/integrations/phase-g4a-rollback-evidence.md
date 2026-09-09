# G.4a — Failure matrix and controlled rollback evidence

Baseline: `08fbac8`, `feat/phase-g-limited-rollout`. This is test and documentation
work. It neither completes G.4 nor authorizes production rollout. A passing
characterization test can prove an **ACTIVATION BLOCKER**, not safe behavior.
No production failure hooks, path rewrites, schema changes, provider retries,
refunds, dispatcher imports, or checkout route changes belong to this slice.

## Running the evidence

Use a newly created local disposable PostgreSQL database, apply the repository's
existing migrations (`npm.cmd run prisma:deploy -w backend`), and run its normal
seed. Supply complete test configuration, including `WIPAY_FEE_STRUCTURE`.
Use only `redis://127.0.0.1:16479` with persistence disabled; the G.4a guard
rejects other hosts/ports and ambiguous URLs before any connection or destructive
fixture setup. Direct guard and failure-cleanup tests run without external connections. do not point this drill
at the ordinary local/shared Redis service. Existing regression fixtures own
different logical Redis databases and some reset those fixture databases.
Run integration suites serially (`--runInBand`); do not share this disposable
database with another Jest invocation. `ENABLE_SCHEDULER=false` prevents ambient
cron races in tests; worker cycles are explicitly invoked. It is NOT the
production new-admission stop.

Focused command, with this configuration supplied to the process:

```powershell
npm.cmd run test -w backend -- --runInBand --testPathPatterns=checkout-rollback
```

The new suites are under `backend/src/modules/checkout-rollback/tests/`:

- `rollback-saga.integration.spec.ts` (S): real operation/coordinator/payment
  persistence and Redis; narrowly injected boundary faults.
- `rollback-admission.integration.spec.ts` (A): real atomic admission and durable
  stop-state matrix, including lost responses.
- `rollback-drain.integration.spec.ts` (D): real mode transitions, Redis, and
  cart-sync recovery with promise barriers before/after external writes.
- `rollback-evidence-test-helpers.ts`: explicitly scoped, bounded evidence and
  fresh worker construction with fresh Prisma/Redis connections and the real
  session advisory lock. No production imports reference this helper.

Additional executable matrix evidence is retained in existing suites (not copied
or weakened):

- R: `checkout-recovery/services/checkout-recovery-restart.integration.spec.ts`
- L: `checkout-recovery/services/checkout-recovery-lock.integration.spec.ts`
- G: `checkout-dispatch/services/atomic-checkout-admission.integration.spec.ts`
- F: `checkout-reservation/services/checkout-reservation-facade.redis.integration.spec.ts`
- P: `payments/services/payments.service.spec.ts`, WiPay adapter/return tests and
  payment reconciliation suites.
- X: `checkout-dispatch/services/checkout-dispatch.integration.spec.ts` and its
  unit tests (replay/execution boundary).

R/L/G/P/X are part of the required regression run, not implied by the focused
command above. A service reconstruction models restart; R's crash boundary is
simulated by stopping after a real durable fence. L separately terminates the
PostgreSQL backend to prove lock release. This does not claim OS kill testing at
every saga boundary.

## State and ownership conventions

The matrix below specifies operation (O), attempt (A), order/payment (D/P), and
Redis (R). Unless explicitly stated otherwise, `D/P=none` means **both absent**;
`R=ACTIVE` is the known seeded hold, not a new effect of issuance/admission.
Every scenario preserves stored selectedPath; none permits fallback or rewrite.
Fixtures without an operation say `O=none`; they exercise lower-layer ownership.

Retry/recovery profiles supply the remaining assertions and operational meaning
for every row:

- **PRE**: retry the same operation key. Policy is read only while O is NULL;
  after assignment it is bypassed. No attempt recovery exists/needed before an
  attempt. Infrastructure may need operator restoration; price changes need
  customer reconfirmation, not path changes.
- **OWNED**: same-key retry follows stored path or returns existing attempt state.
  No policy reread. Stop is not cancellation. Operator must account for delayed
  pre-attempt execution before final drain; no operation expiry owner exists.
- **PROCESSING**: retry returns in-progress; G.PR0 must fence stale ownership
  before G.PR1 cleanup. No policy reread. Healthy worker recovery is automatic
  when cron is enabled; unavailable/corrupt infrastructure requires intervention.
- **FENCED**: retry returns terminal failure, no new attempt/order. Fresh G.PR1
  discovers the durable row, independently of policy. Cleanup is automatic but
  restored ACTIVE inventory still requires release/expiry before drain.
- **UNOWNED**: retry cannot repair the terminal boundary; no current automatic
  owner for the stated gap. No policy reread or path change. Operator/reviewed
  follow-up required. Never manually erase the obligation to make a test pass.
- **COMMITTED**: replay reads the same order; no admission/preparation/payment
  initiation. No policy reread/path change. Payment and Redis obligations must
  be assessed separately; committed is not a whole-saga completion certificate.
- **PAYMENT**: durable payment claim prevents repeating provider creation.
  Reconciliation is independent of rollout policy and ownership; WiPay lookup is
  unsupported. Ambiguity requires external evidence/intervention. No speculative
  retry/refund; verified browser success can transition the matching stored row.
- **MODE**: mode service/repair protocols own the decision, not rollout policy.
  Retry re-reads reservation mode/revision, never CheckoutPath. Redis failure,
  drift, old writers, or unknown obligations block operational acceptance even
  if the current gate incorrectly reports clear.

## Executable failure matrix

`SAFE` below means the named invariant is proved, not production activation.
Blocker assertions deliberately expect the actual unsafe/incomplete state.
After hardening, replace the characterization with the stated acceptance proof;
do not delete it or mark it skipped.

| ID | Boundary / executable evidence | Durable and Redis state asserted or characterized | Retry / owner profile | Current classification |
|---|---|---|---|---|
| 01 | Issuance before commit — S M01 | New O insert rolls back; existing fixture O unchanged; A/D/P none; R ACTIVE | PRE | SAFE: no partial issuance |
| 02 | Issuance lost response — S M02 | One new NULL O mapping; same retry resolves same key; A/D/P none; R unchanged | PRE | SAFE |
| 03 | Admission before commit — A M03 | O NULL after attempted assignment rollback; A/D/P none; no Redis work | PRE | SAFE |
| 04 | Admission lost response — A M04 | O CART_SCOPED committed, no A; stop does not revoke it | OWNED | SAFE ownership; drain blocker if executor unaccounted |
| 05 | Price preparation exception — S M05 | O CART_SCOPED unchanged; A/D/P none; R ACTIVE | PRE | SAFE failure boundary |
| 06 | Bound price expiry/change — S M06 | Fingerprint retained, reconfirmation required; A/D/P none; R ACTIVE | PRE | SAFE |
| 07 | Coordinator before attempt — S M07 | O assigned, no A/D/P, R ACTIVE | PRE | SAFE |
| 08 | Uncertain successful checkoutMark — S M08 | O assigned; A PROCESSING; D/P none; R CHECKOUT_PENDING | PROCESSING | SAFE with durable fencing/recovery |
| 09 | Order transaction rollback — S M09 | No order/payment or stock decrement survives; A becomes FAILED; R ACTIVE after revert | OWNED | SAFE rollback |
| 10 | Transaction failure + revert success — S M10 | FAILED/ORDER_TRANSACTION_FAILED; no D/P; R ACTIVE | OWNED | SAFE compensation, not drained |
| 11 | Transaction failure + revert failure — S M11 | FAILED/ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE; no D/P; R pending after restart | UNOWNED | BLOCKER-2 |
| 12 | COMMITTED before finalize — S M12 | Order+COMMITTED; normal payment can establish; R pending if finalize failed | COMMITTED / UNOWNED | BLOCKER-4 |
| 13 | COMMITTED before initiation — S M13 | Order+COMMITTED; P absent; R finalized; replay returns same order | COMMITTED / UNOWNED | BLOCKER-3 |
| 14 | Ambiguous initiation — S M14, P | One payment; NOT_STARTED/INITIATING/RECONCILE_REQUIRED classified; null reference not automatically initiated; create invoked once | PAYMENT | Ambiguity retained; BLOCKER-3 for missing initiation owner |
| 15 | Duplicate/invalid return — S M15, P | Stored order/amount/currency/reference unchanged; duplicate success emits once; unsigned failure cannot downgrade PAID | PAYMENT | SAFE authentication/idempotent transition |
| 16 | Stale fence — S M16, R | PROCESSING becomes FAILED/STALE_RECOVERY_FENCED; no D/P created | FENCED | SAFE |
| 17 | Heartbeat wins fence race — R “concurrent H2 heartbeat” | New heartbeat retains PROCESSING; pending hold not cleaned; no new D/P | PROCESSING | SAFE |
| 18 | Commit wins fence race — R “concurrent commit” | COMMITTED/order/PAID preserved; stale fence refused | COMMITTED | SAFE ownership |
| 19 | Crash after fence before cleanup — S M19, R | Durable fenced failure; pending R survives crash boundary | FENCED | SAFE rediscovery |
| 20 | Redis cleanup failure — S M20, R | Same durable fence remains; pending R remains until successful next cycle | FENCED | SAFE retry ownership |
| 21 | Fresh worker restart — S M21, R | Fresh connections discover row, cleanup repeats without double decrement | FENCED | SAFE; ACTIVE may remain |
| 22 | Distributed recovery contention — L | One session owns actual cycle; contender skips; release/termination permits replacement | FENCED | SAFE lock scope, not cross-store atomicity |
| 23 | Participant disable race — G | Assignment or disable wins serialized order; no retroactive path rewrite | PRE / OWNED | SAFE atomic decision |
| 24 | Emergency stop race — G | Assignment before stop survives; stop before new assignment denies | PRE / OWNED | SAFE atomic decision |
| 25 | Assigned O after stop — A M25 | CART_SCOPED O/no A survives; no automatic retirement | OWNED | SAFE ownership; BLOCKER-1 operational obligation |
| 26 | NULL O after stop — A M26 | Denied; O stays NULL; no A/order execution | PRE | SAFE |
| 27 | SHADOW after stop — A M27, X | SHADOW does not assign path; later stop denies NULL O; comparison itself read-only | PRE | SAFE; already-running legacy invocation not cancelled |
| 28 | DRAINING/ACTIVE — D M28, F | Reserve refused; full release permitted; live totals/index block LEGACY | MODE | SAFE for observed coherent state |
| 29 | DRAINING/pending — D M29 | Pending hold blocks gate; test has no live attempt and explicitly releases fixture | MODE | SAFE observed blocking; not permission to release live attempts |
| 30 | Scan vs delayed writer — D M30 | LEGACY commits while old writer paused; subsequent ACTIVE hold/total appears; marker requeued | MODE | BLOCKER-1 |
| 31 | Malformed/missing structures — D M31 | One missing signal blocks; both missing can hide hold; malformed+zero can set suspect yet pass | MODE | BLOCKER-5 |
| 32 | Cart-sync revision race — D M32 | Redis write persists; changed revision refuses marker resolution; next reserve repair blocked in DRAINING | MODE | SAFE marker fence; BLOCKER-1 external-write gap |
| 33 | Terminal non-fenced discovery — S M33 | Fenced row discoverable; non-fenced failed row excluded and pending hold survives | UNOWNED | BLOCKER-2 |
| 34 | More than one page — S M34 | 105 real fenced rows, 100 then 5 calls; tied heartbeat IDs neither skipped nor duplicated; no D/P writes | FENCED | SAFE bounded progress |
| 35 | Finalization failure/restart — S M35 | COMMITTED replay and fresh worker leave matching pending hold unchanged | COMMITTED / UNOWNED | BLOCKER-4 |
| 36 | Post-order/pre-payment restart — S M36 | Fresh coordinator replays; fresh checkout/payment workers do not create missing payment | COMMITTED / UNOWNED | BLOCKER-3 |

Rows 17/18 and 22–24 exercise existing production algorithms with their existing
real-database suites. They must be present in the validation record before G.4a
is considered complete. Layer-specific fixtures do not claim an operation row
exists when the scenario constructs only an attempt/reservation.

## Stop-state matrix

| State at stop | Expected behavior | Evidence |
|---|---|---|
| NULL operation | Denied; stays NULL | A M26 |
| Assigned CART_SCOPED/no attempt | Stored ownership survives; no reroute/automatic retirement | A M25 |
| PROCESSING CART_SCOPED | Attempt remains authoritative; no cancellation | A state matrix; X in-progress replay; R fencing |
| COMMITTED CART_SCOPED | Attempt/order preserved; replay does not re-admit | A state matrix; X replay; S M36 |
| FAILED fenced | Terminal retry; durable cleanup discovery remains | A state matrix; S M19–21 |
| SHADOW | No durable path; subsequent policy can deny | A M27 |
| Assigned LEGACY | Remains LEGACY | A LEGACY case; X; exactly-once NOT claimed |

## Evidence boundaries

The helper bounds fixture customers, holds, operations, attempts, orders, and
payments to 250, failing loudly rather than silently truncating. It observes
latest global control/mode/barrier revisions, groups operation paths and failure
codes, joins operation ownership, counts processing attempts/oldest heartbeat,
checks committed-order presence/payment initiation class, and summarizes scoped
sync/compensation state. Redis reads only declared UUID fixture keys, including
index membership, sanitized totals, reservation presence/state and suspect presence. It does not
call `getActiveReservation`, which can mutate expired/malformed data.

These are sequential observations, **not an atomic DB+Redis snapshot**. Scope
must cover every fixture obligation; absence outside that scope is not proven.
Raw identifiers, retry/idempotency keys, provider references, and Redis JSON
are correlated internally, never returned in evidence. Output uses fixture
aliases and bounded state/count/presence summaries. Production metrics should
use bounded path/status/reason dimensions.

## Controlled drill runbook — NOT production-ready

1. Commit `newAdmissionStopped=true` using the existing control service with its
   expected revision and trusted actor. This is a NEW-ADMISSION STOP only.
2. Prove NULL/new operations are denied executable ownership. Issuance itself
   may still persist an unassigned operation. Do not mistake this for execution.
3. Inventory already assigned operations and attempts, including LEGACY and
   NULL historical paths. Never infer or rewrite ownership from current policy.
4. Settle the controlled assigned work. Keep recovery/payment reconciliation
   independent of stop; stale PROCESSING requires G.PR0 fencing before cleanup.
   Non-fenced failure and committed-finalize obligations currently block full
   automated acceptance (BLOCKER-2/4).
5. Prove no delayed pre-attempt executor remains. The test harness can join its
   promises; current production code provides no global proof (BLOCKER-1).
6. Call guarded `CART_SCOPED -> DRAINING`; never write configuration directly to
   skip the service or transition straight to LEGACY.
7. Run required recovery/reconciliation/release work. Fenced recovery can restore
   ACTIVE holds; this is not drain completion. Positive cart-sync/compensation
   targets can be BLOCKED while DRAINING. Never blindly release live pending work.
8. Establish target-changing writer quiescence before final verification. The
   mutation barrier fences ordinary target-changing SQL transactions, not every
   old external writer. It also blocks order creation, so activating it earlier
   and expecting pending checkouts to commit is invalid. General production
   quiescence remains unproven (BLOCKER-1).
9. Collect bounded DB/Redis evidence and account for all obligations. Do not treat
   a clear current scan as proof against missing/corrupt structures (BLOCKER-5).
10. Attempt `DRAINING -> LEGACY` through the guard only. Record the actual result
    and mode revision. A passing transition with a known gap is failed operational
    acceptance, even when its characterization test passes.
11. Join/release all deliberately delayed fixture writers and check for late
    cart-scoped state. Current delayed-writer characterization produces it.
12. Only in the controlled safe branch of the drill, release the mutation barrier
    and verify isolated legacy behavior. Preserve the one-authority invariant;
    no production rollback or legacy key deletion is authorized.
13. Verify stock/order/payment counts, path immutability, duplicate-cleanup
    invariants and unresolved payment classifications. Preserve ambiguity; no
    second provider create/refund and no manufactured PAID result.

### Required final drain proof

The final transition's acceptance record must establish all of the following;
the existing guard does not automatically enforce this complete proof:

- The recorded stop revision is still current, and every assigned operation is
  accounted for. No delayed pre-attempt executor or old-mode writer can resume
  after the final observation. A NULL path is never inferred from policy.
- Every controlled PROCESSING attempt has settled or been durably fenced before
  cleanup. Every terminal cleanup/finalization obligation is accounted for.
  Historical fenced rows may remain: zero rows is not required, but no unresolved
  reservation obligation may be hidden by treating those rows as completed.
- No live ACTIVE or CHECKOUT_PENDING holds remain in the complete drill scope;
  totals and both indexes agree with reservation entries. No unexplained
  malformed, missing, orphaned, suspect, or non-numeric structure remains.
  The bounded helper alone does not establish completeness of its caller's scope.
- Sync/compensation work cannot later reintroduce an old-authority hold. Blocked
  and permanently failed records require explicit disposition, not deletion or
  a claim that a scheduler's successful tick settled the backlog.
- Guard result and persisted mode revision agree, and a follow-up observation
  after all controlled delayed work completes shows no late cart-scoped write.
  Observations without writer quiescence are not an atomic cross-store proof.
- Order/stock/path invariants hold. Payment ambiguity and missing initiation are
  classified separately and remain activation blockers where identified; making
  inventory empty never authorizes payment recreation, refunds, or forced PAID.

BLOCKER-1/2/4/5 currently prevent treating this as a generally automated production
certificate. The negative characterization branches deliberately demonstrate
failure of these criteria even when the current mode guard permits LEGACY.

## Acceptance blockers and follow-up

- **BLOCKER-1:** final transition lacks proven fencing/quiescence against every
  old-mode Redis writer and delayed assigned executor. G.4b must propose and
  prove a globally cooperating protocol; the test must then assert no late hold
  after LEGACY commits, or that transition is refused until the writer settles.
- **BLOCKER-2:** FAILED/ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE is excluded
  from G.PR1 discovery. G.4b must define bounded durable ownership for this
  terminal cleanup without broad unsafe processing of unrelated failures.
- **BLOCKER-3:** committed-before-initiation and uninitiated rows lack a proven
  automatic owner. G.4c must design payment liveness separately while preserving
  provider ambiguity and the prohibition on speculative create retries.
- **BLOCKER-4:** COMMITTED finalization failure is likewise not discovered by
  G.PR1. Include bounded durable finalization ownership in the G.4b design.
- **BLOCKER-5:** missing structures together and malformed/zero state can evade
  the current Redis guard. G.4b must define conservative authoritative drain
  evidence and non-destructive failure classification.

LEGACY lost-response exactly-once and unsupported WiPay lookup/refund remain
explicit limitations. No production fix is smuggled into G.4a. G.5 requires the
complete isolated regression record plus reviewed acceptance thresholds; G.6
requires separate explicit activation approval. Passing the evidence harness
does not mark G.4 or rollout activation complete.

Harness review corrections: Redis/Prisma cleanup is independently settled, with
primary failures retained as the cause if cleanup also fails. Delayed writers are
released and joined before fixture teardown, including assertion failures.
Fresh recovery evidence counts both discovery queries, selected candidates,
cleanup calls, skips, and processing errors. Missing-ownership characterizations
require zero candidates and zero errors; the payment batch also requires zero
attempts and zero WiPay initiation/verification calls. An adapter or cleanup
failure is not evidence of non-discovery. These checks do not resolve any of the
five activation blockers or approve activation.
