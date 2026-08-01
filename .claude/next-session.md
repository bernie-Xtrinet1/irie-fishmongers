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
- Phase 16A.0's operational policy is `Accepted` in `.claude/decisions.md`
  (15-minute rolling TTL, 60-minute absolute maximum, no wholesale
  exception, locks never auto-renew, one-cart-one-currency, checkout
  requires both lock and reservation).

## Status: policy Accepted, implementation not yet started

The full Phase 16A.0 execution plan (schema/migration sequence, backend
work units, Redis Lua interfaces, idempotency model, operation-specific
compensation, API contracts, storefront work units, deployment sequence,
test suites, commit boundaries, rollback plan, acceptance criteria) has
been produced and presented for review. **No Prisma schema, migration,
TypeScript, JavaScript, or test file has been touched.**

## Next session must

1. Confirm whether the execution plan itself has been approved (check for
   an explicit approval message before assuming so - do not infer approval
   from silence or from the plan simply existing).
2. If approved: begin implementation strictly in the commit-boundary order
   the plan defines - additive schema first, then backend work units, then
   storefront, per the deployment sequence (schema -> lock-capable backend
   -> cart/reconfirmation UI -> short checkout maintenance window -> strict
   enforcement enabled -> checkout reopened -> compatibility code removed).
3. Do not skip ahead to enforcement before the storefront cart/
   reconfirmation UI exists and has been operationally verified - the
   deployment gate is a hard sequencing requirement, not a suggestion.
4. Do not treat the Redis Lua checkout-marking script, the idempotency
   model, or the item-removal compensation design as open questions - all
   three were resolved this session; implement exactly what was specified,
   or flag a concrete conflict if the real code reveals one.

## Do NOT do

- Do not begin any source-code edit before this session's execution plan is
  explicitly approved in a subsequent message.
- Do not reintroduce a "silent live-price charging" fallback at any stage,
  including during the short checkout maintenance window - that window is
  a scheduled pause, not a permissive fallback.
- Do not treat the deployment gate's temporary compatibility step (if one
  is used) as indefinite - it has a hard maximum duration, an accountable
  owner, monitoring, and automatic removal, per the execution plan.
- Do not say Phase 16A.0 implementation has begun until source files have
  actually been edited.
