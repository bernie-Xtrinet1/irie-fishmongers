# Next Session

## Entry point - read these first

- `docs/roadmap.md`
- `docs/integrations/ADR-005-master-catalogue-vs-vendor-daily-listing.md`
- `docs/architecture/reservation-lifecycle.md`
- `.claude/current-task.md`
- `.claude/next-session.md` (this file)
- `.claude/decisions.md`
- `.claude/worklog.md`

## Confirm before doing anything else

- Branch is `develop`.
- Working tree is clean.
- Local `develop` and `origin/develop` are synchronized (0 ahead / 0
  behind).
- Commit Unit 1 (`57c73b4`) and the reservation-lifecycle architecture
  document (`2068d9f`) are both present on `origin/develop`.

## The next session must begin with repository confirmation, then Unit 2.1 only

Do not begin the reservation business scripts yet. Unit 2.1 is narrowly
scoped:

- `RedisService.eval()`
- `RedisService.loadScript()`
- `RedisService.evalsha()`
- `NOSCRIPT` reload-and-retry (a blind `evalsha` call is not correct - see
  `reservation-lifecycle.md` §11)
- Focused `RedisService` unit tests for all of the above

**Explicitly excluded from Unit 2.1** (later, separate commits per
`reservation-lifecycle.md`'s commit-boundary plan):

- Reservation-key changes
- `ReservationEntry` implementation
- Lua business scripts (`reserveOrRenew`, `release`, `checkoutMark`,
  `checkoutRevert`, `extendCheckoutLease`, `finalizeCheckoutConsumption`,
  `reconcileExpiredCheckoutPending`, `reconcileProductReservedTotal`)
- Product index / cart index
- Product reserved-total projection
- `CartService`
- `OrdersService`
- Payment services
- Controllers
- Frontend

## Do NOT do

- Do not begin any Unit 2 source-code edit beyond the Unit 2.1 scope above
  without a subsequent, explicit approval message.
- Do not say Commit Unit 2 implementation has begun in any broader sense
  than Unit 2.1 until the corresponding files have actually been edited.
- Do not duplicate `docs/architecture/reservation-lifecycle.md`'s content
  into session files - reference it, don't restate it.
- Do not treat the reservation lifecycle document's design (key format,
  `ReservationEntry` shape, atomic mutation contracts, underflow handling,
  reconciliation, Cluster limitation) as open questions - all were
  resolved and approved this session; implement exactly what is specified
  when the corresponding later commit begins, or flag a concrete conflict
  if the real code reveals one.
