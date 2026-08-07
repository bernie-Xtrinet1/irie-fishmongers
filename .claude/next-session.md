# Next Session

## Entry point - read these first

- `docs/roadmap.md`
- `docs/integrations/ADR-005-master-catalogue-vs-vendor-daily-listing.md`
- `docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md`
- `docs/architecture/reservation-lifecycle.md`
- `.claude/current-task.md`
- `.claude/next-session.md` (this file)
- `.claude/decisions.md`
- `.claude/worklog.md`

## Confirm before doing anything else

- Branch is `develop`.
- Working tree is clean.
- **Local `develop` is 2 commits ahead of `origin/develop`**: `5acbb4b`
  (`feat(checkout): add checkout attempt persistence`) and `c8ccdf3`
  (`docs(architecture): record failure-message sanitization contract in
  ADR-007`). These were committed but never pushed - the implementing
  environment had no network access (`git push` failed with
  `Could not resolve host: github.com`). **Push these first**, before any
  new work, and confirm `origin/develop` matches local `develop` (0 ahead
  / 0 behind) before proceeding.
- Commit Unit 1 (`57c73b4`) through Unit 2.4.4 (`ad89219`) and `ADR-007`
  (`15bbacf`, plus the `c8ccdf3` amendment above) are all present on
  `origin/develop` once the push above completes.

## Phase 16A.0-A is complete

`CheckoutAttemptRepository` and `CheckoutAttemptService` exist, are fully
tested (66 tests, `checkout-attempt.service.ts` at 100%
lines/functions/branches), and remain completely unwired - see
`.claude/current-task.md` for the full delivery summary.

## Choosing Phase 16A.0-B - re-check ADR-007's gates, do not assume C/D

A prior review of the Phase A completion report recommended starting the
next session with `CheckoutCoordinatorService` and
`CheckoutReservationFacade`. **Do not do this without re-confirming the
gates first** - those are ADR-007's Phase C and Phase D, and per the
ADR's own "Implementation sequence" table:

- **Phase C** (`CheckoutReservationFacade`) is blocked on open decisions
  1 (Redis-first vs. Postgres-first cart writes), 9 (`addItem` idempotency,
  dependent on 1), and 10 (rollout-flag mechanism) - **none resolved**.
- **Phase D** (`CheckoutCoordinatorService`) is blocked on **both** A and
  C - C is not done, so D cannot start either.

Phases actually unblocked by Phase A alone:

- **Phase F** (scheduler, heartbeat recovery, Postgres advisory lock) -
  blocked only on A. Ready now.
- **Phase B** (`PriceLockService`, cart currency enforcement) - blocked on
  open decisions 4 (price-lock TTL value - no business-supplied value
  exists yet) and 8 (does `Product` carry its own currency field?). Needs
  those answered first.

**Ask the user which to start** - most likely Phase F (no open decisions
block it), or resolving open decisions 4/8 to unblock Phase B. Do not
silently begin Phase C/D work.

## Do NOT do

- Do not push assuming network access is available - confirm connectivity
  first (the previous session's `git push` failed outright).
- Do not begin Phase C/D (`CheckoutReservationFacade`/
  `CheckoutCoordinatorService`) implementation while open decisions 1, 9,
  10 remain unresolved - re-read ADR-007's "Open decisions" section before
  scoping any new work.
- Do not begin any new phase's source-code edit before a plan is presented
  and explicitly approved, matching the discipline used through Phase
  16A.0-A.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s or
  `ADR-007`'s content into session files - reference them, don't restate
  them.
- Do not treat `CheckoutAttemptRepository`/`CheckoutAttemptService`
  (Phase A) as authorizing any caller wiring - they remain fully additive
  and unwired; do not assume otherwise or begin implementation without a
  separate, explicit approval.
