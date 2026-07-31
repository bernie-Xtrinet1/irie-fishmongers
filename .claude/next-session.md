# Next Session

## Entry point

The `phase-17-uat-production-readiness` branch decision is made (re-draft,
not merge) and the roadmap is resequenced: **Phase 16 = Jamaican Seafood
Marketplace Operating Model, Phase 17 = UAT & Production Readiness, Phase
18 = AI Marketplace**. A documentation-only change set implementing this is
staged locally but **not yet committed** - the user asked to review
`git status`/`git diff --stat`/the proposed commits first. See
`.claude/current-task.md` and `.claude/decisions.md` for what changed and
why.

## First question to ask the user

**Does the user approve committing and pushing the staged documentation
change set?** If yes: commit as the three planned commits (see
`.claude/worklog.md`'s 2026-07-31 entry for the exact file list per
commit) and push to `develop`. If the user wants changes first, make them
before committing - do not commit partway through a requested revision.

## After that decision

- Once committed and pushed: the next actual implementation work is
  **Phase 16A (Catalogue and Regulatory Foundation)**, starting with
  ADR-005's decision (extend `Species` with `alternativeNames`,
  `referenceImageUrl`, typical weight range; add `Product.speciesId`) -
  migration + DTO validation + tests, per `.claude/CLAUDE.md`'s Database/
  API Rules.
- Do not start Phase 16B or later sub-phases before 16A's own acceptance
  criteria (in `docs/product/jamaican-seafood-marketplace-requirements.md`)
  are met - each sub-phase builds on the previous one's data model.
- Azure credentials are still pending (see prior memory:
  azure-production-target). This blocks only the [AZ]-tagged tasks in
  `docs/uat/phase-17-uat-production-readiness.md` - it does not block
  Phase 16 implementation, which has no Azure dependency.
- Phase 17 (UAT) cannot meaningfully begin until Phase 16 passes
  `docs/testing/marketplace-fulfilment-acceptance-plan.md`'s 20 scenarios.
- Before relying on CI e2e as a gate for anything, consider pinning
  `maxWorkers: 1` in `backend/test/jest-e2e.json` - still an open,
  unmitigated risk flagged in `docs/roadmap.md`'s Phase 13 notes.

## Do NOT do

- Do not begin Phase 16 (or any) application/schema implementation before
  the documentation commit above is approved and landed - the roadmap and
  ADRs are the reference Phase 16 work should be built against.
- Do not treat `.claude/roadmap.md` or `.claude/project-status.md` as
  authoritative even after this session - both are now permanent short
  pointers to `docs/roadmap.md` by design; do not add phase/status content
  back into them.
- Do not re-open the resolved Codespaces items (proxy, env override, image
  pipeline) without a new concrete symptom report.
