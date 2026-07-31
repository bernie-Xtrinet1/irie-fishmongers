# Phase 17 — UAT & Production Readiness

Status: **Planning** · Supersedes the draft on the unmerged
`phase-17-uat-production-readiness` branch. That branch assumed UAT
immediately followed Phase 13, with no marketplace phase in between; the
approved phase order instead inserts Phase 16 — Jamaican Seafood
Marketplace Operating Model — first, so this plan is revised to validate
that phase too, not just the pre-marketplace transactional skeleton. (The
number "17" is unchanged from the branch's own numbering — what changed is
the sequencing: Phase 16 now precedes it, and Phase 18 — AI Marketplace —
follows it.)

## Purpose

Phase 17 does **not add marketplace features** — Phase 16 does that. Phase
17's sole goal is to stand up a UAT environment, validate the **complete**
platform workflow (including the Phase 16 marketplace operating model) with
realistic data, prove operational readiness (backup/restore, monitoring,
rollback), and produce a signed acceptance record before any production
ship.

**Guiding rule, unchanged from the prior draft:** production remains
blocked until the Production Approval gate (§17G) is fully satisfied. A
release candidate is a release candidate, not a production build.

**Guiding rule, new:** Phase 17 cannot meaningfully begin until Phase 16 is
implemented and passes its own acceptance plan
(`docs/testing/marketplace-fulfilment-acceptance-plan.md`). Standing up UAT
infrastructure (§17A) and sandbox external-service configuration (§17B) has
no such dependency and may proceed in parallel with late Phase 16
implementation, but the role-based UAT scripts (§17D) cannot be executed
against a platform that does not yet have the marketplace operating model.

## The workflow Phase 17 must validate

This is the decisive change from the superseded draft: UAT validates the
full Phase 16 chain, not the pre-marketplace order flow alone.

```
Catalogue (16A)
  → Daily listing (16B)
  → Available-Today marketplace (16C)
  → Customer selection: Best Available Vendor or Choose Your Seller (16C)
  → Reservation (16D)
  → Payment (existing payment module)
  → Vendor acceptance (existing order workflow)
  → Preparation, incl. weight/preparation-yield adjustment (16D)
  → Delivery (existing Delivery Engine) OR Platform-managed pickup (16E)
  → QR/PIN verified collection (16E) OR existing proof-of-delivery
  → Settlement (16E/16F)
  → Reporting (Phase 15 Analytics)
```

This is the same chain `docs/testing/marketplace-fulfilment-acceptance-plan.md`
exercises as engineering acceptance; §17D below is that same chain validated
by a human operator through the real UI, with realistic seeded data, as a
non-technical stakeholder would experience it.

## Secrets & credentials policy (mandatory, unchanged from the prior draft)

**No credential of any kind may be committed to git** — not UAT test-account
passwords, not API keys, not connection strings, not sandbox tokens. This
applies to source, config, seed files, docs, and CI. All secrets are supplied
at runtime from a **secret manager** (the host's secret store for the running
env; **GitHub Secrets** for CI) using the variable names the app already
validates. Seed fixtures reference secrets by env-var name, never by literal
value. Any credential accidentally committed must be treated as compromised
and rotated. This is a hard gate: a PR that adds a secret does not merge.

## Task categories

Every Phase 17 task below is tagged with exactly one category, so it is
clear at a glance what can start today versus what is blocked and on what:

- **[CIP]** Credential-independent preparation — can start immediately,
  needs no Azure credentials and no live UAT environment.
- **[LOC]** Codespaces/local UAT — runs against the local/Codespaces demo
  stack (per `.devcontainer/` and `scripts/*-codespaces-demo.sh`), not
  Azure; validates workflow correctness before spending Azure resources.
- **[AZ]** Azure-dependent infrastructure — blocked on Azure credentials
  (see below).
- **[SEC]** Production-security readiness.
- **[OPS]** Operational acceptance.
- **[GATE]** Final release gate.

**Azure credentials block only [AZ]-tagged work.** They do not block Phase
16 design or implementation, and they do not block [CIP] or [LOC] work in
Phase 17 — UAT script authoring, seed-data planning, security-review
checklists, and full workflow validation against the local/Codespaces stack
can all proceed today.

## Sequence

```
Phase 16 implemented + passes its own acceptance plan
  → 17A UAT infrastructure [AZ, with CIP prep now]
  → 17B external-service (sandbox) configuration [CIP + AZ]
  → 17C demo users + seed data [CIP + LOC]
  → 17D role-based UAT scripts, incl. the full Phase 16 chain [CIP now, LOC/AZ to execute]
  → 17E operational readiness [OPS, mostly AZ]
  → 17F UAT issue management [CIP]
  → 17G production approval [GATE]
  → promote to v1.0.0 (or cut v1.0.0-rc.2 on release-changing fixes)
```

---

## 17A — UAT infrastructure [AZ, with CIP prep available now]

> **Production cloud: Azure** (decided 2026-07-19). Azure account setup and
> credentials are **not yet available** — the [AZ]-tagged parts of 17A are
> blocked until the architecture is approved *and* Azure credentials are
> provided. Claude will not provision resources, add cloud credentials, or
> modify infrastructure before then.

[CIP] now, no credentials needed:
- Document the target topology (same shape as intended production, smaller
  tier) and record the decision in `docs/decisions/`.
- Define the environment-variable/secret contract for UAT (reusing the
  existing validated names: `DATABASE_URL`, `REDIS_URL`, `JWT_*`,
  `CORS_ORIGIN`, `APP_BASE_URL`, `WIPAY_*`, `SENDGRID_*`, `FCM_SERVER_KEY`,
  `ENABLE_SCHEDULER`, the frontend `NEXT_PUBLIC_*`) — no values, just the
  contract and where each is sourced from.
- Draft the deployment pipeline shape (build → `prisma migrate deploy` →
  `prisma db seed` (once) → start), independent of which cloud actually
  runs it.

[AZ] blocked on credentials:
- Provision a **dedicated UAT PostgreSQL** instance and **dedicated Redis**
  — never share the production or a developer's local DB.
- Configure object/file storage for uploads (vendor documents, product
  images, actual-catch photographs from Phase 16B, compliance documents,
  proof-of-delivery / collection-verification evidence from Phase 16E).
- HTTPS + a UAT domain (e.g. `uat.iriefishmongers.…`); set `CORS_ORIGIN`
  and the apps' `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_APP_URL` to the UAT
  hostnames.
- `ENABLE_SCHEDULER=true` in UAT so cron sweeps (including any Phase
  16-related expiry sweeps — listing expiry, reservation expiry, pickup
  no-show detection) run realistically, unlike CI/e2e.

**Exit:** UAT URL reachable over HTTPS; `/health` and admin `/health/status`
green for postgres + redis.

## 17B — External service configuration (sandbox only) [CIP + AZ]

[CIP] now:
- Document the required sandbox accounts and the verification steps for
  each (WiPay sandbox checkout→webhook→paid flow, SendGrid test sender,
  Firebase/FCM test project, maps/geolocation keys if zone/route features
  need them).

[AZ]/credential-dependent:
- Acquire and wire the actual sandbox credentials once available.
- **Disable real financial or customer-facing production actions** — no
  live charges, no real emails/SMS to non-test addresses.

**Exit:** a sandbox payment reaches `PAID`; a test notification is
delivered to a test recipient; no path can touch a production/live
external account.

## 17C — Demo users & seed data [CIP + LOC]

Create controlled accounts (test credentials stored in the team's secret
store, **never** in git), one per role/variant — extended from the
superseded draft to include Phase 16 roles/data:

- Administrator
- Customer
- Community Fisher vendor
- Established (Enterprise Supplier) vendor
- Driver — personal vehicle
- Driver — company (fleet) vehicle

Seed a representative dataset covering the full Phase 17 workflow: master
catalogue entries across multiple categories (16A); multiple vendors with
active daily listings, including at least one multi-vendor-allocatable
item (16B, 16D); orders across the status workflow including at least one
platform-managed-pickup order with a verified collection and one with a
no-show (16E); delivery zones, fleet assets; temperature readings
(including a breach); reviews; and compliance records (so compliance
scores render across bands). Reuse the existing `prisma db seed` +
`compliance:scores:recompute-all` backfill; extend the seed with a UAT
fixture set covering Phase 16 rather than hand-entering data.

**Do not use real customer personal information.** Use synthetic names,
emails (`+uat` aliases), and Jamaica-format but fictitious
addresses/phones.

**Acceptance:** all 6 role accounts authenticate successfully against the
UAT API; the seed yields ≥10 catalogue items across ≥3 categories with
active vendor listings, ≥1 item allocatable across ≥2 vendors, ≥1 platform-
managed-pickup order successfully collected and ≥1 no-show, ≥1 lot in a
CRITICAL temperature-breach state, ≥1 order in each status of the order
workflow, and vendor compliance scores rendering across ≥3 public bands; a
reviewer confirms no seeded field contains real PII; all account passwords
come from the secret manager, none from git.

## 17D — Role-based UAT scripts [CIP to author, LOC/AZ to execute]

[CIP] now — author test cases covering: the full Phase 16 chain (catalogue
→ listing → discovery → selection → reservation → payment → acceptance →
preparation → delivery-or-pickup → verification → settlement → reporting);
customer registration & purchasing; vendor onboarding & daily-listing
management; driver assignment & delivery; **platform-managed pickup &
verified collection** (new); admin approvals & moderation; payments &
settlements (including pickup-gated settlement); food safety &
traceability; cold-chain monitoring; recalls; reviews & compliance scores.

Each case records:

| Field | |
|---|---|
| Test ID | e.g. `UAT-MKT-001` for marketplace-chain cases, `UAT-CUST-001` etc. for the rest |
| Role | Customer / Vendor / Driver / Admin |
| Preconditions | seed state / prior steps |
| Steps | numbered actions |
| Expected result | |
| Actual result | filled during execution |
| Pass/Fail | |
| Evidence | screenshot / API response / log ref |
| Tester | |
| Date | |

A per-run results log lives under `docs/uat/runs/<date>-rc1/`. The
test-case catalogue is authored in this phase as `docs/uat/scripts/` (one
file per role, plus a dedicated marketplace-chain file mirroring
`docs/testing/marketplace-fulfilment-acceptance-plan.md`'s twenty
scenarios in business-readable form).

[LOC] — execution can run against the local/Codespaces demo stack once
Phase 16 is implemented there, before Azure infrastructure exists. [AZ] —
a full pre-production run also executes against the actual UAT environment
once §17A/17B are complete.

**Cross-check against existing guarantees** — many flows already have e2e
coverage (auth, orders, delivery, payments, food-safety, reviews, vendor
tiers, analytics, passport) and Phase 16 will have its own
(`docs/testing/marketplace-fulfilment-acceptance-plan.md`). UAT validates
them *as a human operator through the real UI*, not as a replacement for
either automated suite.

**Acceptance:** a test-case catalogue exists under `docs/uat/scripts/`
covering all flow areas above including the full Phase 16 marketplace
chain, ≥1 case per role; every case has its preconditions/steps/expected-
result fields populated before execution begins; the catalogue is reviewed
and approved before an execution run starts.

## 17E — Operational readiness [OPS, mostly AZ]

- **Backup & restore test** — take a UAT DB backup, restore to a scratch
  instance, verify integrity. Hard gate (§17G). [AZ]
- **Migration rehearsal** — `prisma migrate deploy` from an empty DB and
  from the prior schema (including Phase 16's new migrations —
  `Species` extensions, `Product.speciesId`, `CustomerCollection` per
  ADR-005/ADR-006); confirm no drift (`prisma migrate status`). [AZ]
- **Logging & monitoring** — structured logs shipped; dashboards for error
  rate, latency, queue depth. [AZ]
- **Alerting** — on health-check failure, error spikes, cold-chain
  EMERGENCY/CRITICAL alerts, payment failures, and (new) pickup no-show
  rate spikes / off-platform-leakage signals per
  `docs/operations/marketplace-operating-model.md`. [AZ]
- **Health checks** — `/health` (public) and `/health/status` (admin)
  wired to the host's uptime monitor. [AZ]
- **Incident-response** & **rollback** procedures documented (redeploy
  previous image + `prisma migrate resolve` guidance). [CIP to draft, AZ to rehearse]
- **Data retention & privacy review** — confirm retention rules
  (traceability/inspection/temperature 7y; audit logs permanent, now
  explicitly including the Phase 16 collection audit history per
  `docs/operations/platform-managed-pickup-policy.md`) and that personal
  data is masked where required. [CIP to draft the checklist, OPS to sign off]
- **Access-control review** — spot-check role guards and cross-tenant
  isolation (vendor/driver/customer data separation) in the running
  environment. [OPS]

**Acceptance:** a backup is taken and restored to a scratch instance with
row-count and referential-integrity parity to the source (evidence
recorded); `prisma migrate status` reports no drift on the UAT DB; a
simulated health-check failure fires an alert to the configured channel; a
rollback to the prior release image is rehearsed and documented; retention/
privacy and access-control reviews are signed off with findings logged.

## 17F — UAT issue management [CIP]

Severity levels: **Critical · High · Medium · Low · Cosmetic**.

Agree on: issue template (id, severity, role, steps, expected/actual,
evidence, owner, target date, retest status), assigned owner, target
resolution SLAs, retest process, and the acceptance sign-off record. Track
under `docs/uat/issues/`.

**Acceptance:** the issue template and per-severity resolution SLAs are
agreed and committed under `docs/uat/`; at least one issue is taken
end-to-end through the workflow (open → fix → retest → close) as a process
dry-run; the acceptance sign-off record template exists and names the
business-owner signatory.

## 17G — Production approval gate [GATE]

Production stays blocked until **all** of:

- [ ] Phase 16 (Jamaican Seafood Marketplace Operating Model) implemented
      and passing `docs/testing/marketplace-fulfilment-acceptance-plan.md`.
- [ ] All **Critical** and **High** UAT defects closed.
- [ ] Required **Medium** defects resolved or formally accepted (documented).
- [ ] Backup **restoration** verified successful.
- [ ] **Payment** testing (WiPay sandbox + COD) successful, including
      pickup-gated settlement (§O of
      `docs/operations/marketplace-operating-model.md`).
- [ ] **Security review** complete (auth, RBAC, secrets handling, input
      validation, dependency scan, QR/PIN credential handling per ADR-006).
- [ ] **Business owner sign-off** recorded.
- [ ] Release candidate **promoted** to a final version tag.

## Versioning policy (unchanged from the superseded draft)

- **Tags are immutable.** Do **not** move a release-candidate tag after the
  prerelease is published.
- Release-changing fixes during UAT → cut a **new** candidate (increment
  the `-rcN` suffix), repeating the relevant UAT.
- UAT passes with no release-changing fixes → tag the final version and
  publish a non-prerelease GitHub Release.

## Out of scope

New marketplace features beyond Phase 16's defined sub-phases, schema
changes beyond fixing UAT defects, and any deferred item recorded elsewhere
(customer web review-submission UI; admin restore / customer appeal
workflow; Phase 18 AI Marketplace). Address those in their own phase, not
during stabilization.
