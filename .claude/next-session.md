# Next Session

## Entry point - read these first

- `docs/roadmap.md`
- `docs/integrations/ADR-005-master-catalogue-vs-vendor-daily-listing.md`
- `.claude/current-task.md`
- `.claude/next-session.md` (this file)
- `.claude/decisions.md`
- `.claude/worklog.md`

## Confirm before doing anything else

- Branch is `develop`.
- Working tree is clean.
- Local `develop` and `origin/develop` are synchronized (0 ahead / 0
  behind).
- ADR-005 status is `Accepted`.

## Continue only with the final Phase 16A.0 design correction

Do not begin implementation. Resolve, in one final specification:

- `GET /cart` never renews a reservation or a price lock.
- Rolling reservation TTL stays 15 minutes.
- Ordinary retail's **absolute maximum** hold is 60 minutes (proposed, not
  yet a permanent decision - confirm/approve this explicitly this session).
- Quantity-changing operations may renew the reservation, capped by that
  maximum - the price lock never renews merely because quantity changed.
- Checkout validates, per item: lock present and valid; the Redis
  reservation exists; it belongs to this cart; reserved quantity matches
  cart quantity; durable stock is sufficient; the product remains
  purchasable; currency matches `Cart.currency`. A valid lock alone must
  never be sufficient to authorize checkout.
- Reconfirmation reacquires/renews the reservation and checks inventory
  **before** writing a new lock - never after.
- Redis/PostgreSQL compensation and idempotency for add/update/
  reconfirmation operations - no leaked reservation, ever.
- `Cart.currency` (nullable) as the one-cart-one-currency authority.
- Rollback stays fail-closed - never falls back to silent live-price
  charging under any circumstance.
- Structured, per-item API error codes.
- Customer-facing UX language that is accurate about *why* an item needs
  attention (expired lock with unchanged price vs. an actual price change
  vs. an expired reservation vs. an unavailable product) - never a blanket
  "price changed."

## Produce only

- Corrected lifecycle rules.
- Corrected sequence diagrams.
- Exact schema proposal.
- `Cart.currency` decision.
- Compensation strategy.
- Structured API error examples.
- Corrected rollback plan.
- Revised/affected test cases.

## Do NOT do

- Do not edit any Prisma schema, migration, TypeScript, JavaScript, or test
  file until the specification above is presented and explicitly approved.
- Do not treat the 60-minute maximum-hold figure as settled until it is
  approved and moved into `.claude/decisions.md`.
- Do not say Phase 16A.0 implementation has begun, or that the design is
  fully approved for coding - neither is true as of this handoff.
