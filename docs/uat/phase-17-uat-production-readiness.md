# Phase 17 — UAT & Production Readiness

Status: **Planning** · Branch: `feature/uat-production-readiness` · Baseline: `v1.0.0-rc.1`

## Purpose

The platform is **feature-complete and CI-green** (all phases merged to `main`,
tagged `v1.0.0-rc.1`). Phase 17 does **not add marketplace features**. Its sole
goal is to stand up a UAT environment, validate the complete workflow with
realistic data, prove operational readiness (backup/restore, monitoring,
rollback), and produce a signed acceptance record before any production ship.

**Guiding rule:** production remains blocked until the Production Approval gate
(§17G) is fully satisfied. RC1 is a *release candidate*, not a production build.

## Sequence

```
Publish GitHub prerelease (v1.0.0-rc.1)
  → 17A UAT infrastructure
  → 17B external-service (sandbox) configuration
  → 17C demo users + seed data
  → 17D role-based UAT scripts
  → 17E operational readiness
  → 17F UAT issue management
  → 17G production approval
  → promote to v1.0.0 (or cut v1.0.0-rc.2 on release-changing fixes)
```

---

## 17A — UAT infrastructure

- Select hosting provider (target: same topology as intended production, smaller
  tier). Record the decision in `docs/decisions/`.
- Provision a **dedicated UAT PostgreSQL** instance and **dedicated Redis** —
  never share the production or a developer's local DB.
- Configure object/file storage for uploads (vendor documents, product images,
  compliance documents, proof-of-delivery photos).
- Manage environment variables and secrets through the host's secret store — the
  same names the app already validates (`env.validation.ts` /
  `environment-variables.ts`): `DATABASE_URL`, `REDIS_URL`, `JWT_*`,
  `CORS_ORIGIN`, `APP_BASE_URL`, `WIPAY_*`, `SENDGRID_*`, `FCM_SERVER_KEY`,
  `ENABLE_SCHEDULER`, and the frontend `NEXT_PUBLIC_*`. **No secrets in git.**
- HTTPS + a UAT domain (e.g. `uat.iriefishmongers.…`); set `CORS_ORIGIN` and the
  apps' `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_APP_URL` to the UAT hostnames.
- Deployment pipeline: build → `prisma migrate deploy` → `prisma db seed` (once)
  → start. `ENABLE_SCHEDULER=true` in UAT so cron sweeps run (unlike CI/e2e).

**Exit:** UAT URL reachable over HTTPS; `/health` and admin `/health/status`
green for postgres + redis.

## 17B — External service configuration (sandbox only)

- **WiPay sandbox** credentials; verify the checkout → webhook → paid flow end
  to end against the sandbox (signature verification already enforced).
- **Cash-on-Delivery** test flow (admin confirm-cash path).
- **SendGrid** test sender + template verification (or sandbox mode).
- **Firebase / FCM** test project for push tokens.
- Maps/geolocation service keys if used by zone/route features.
- **Disable real financial or customer-facing production actions** — no live
  charges, no real emails/SMS to non-test addresses.

**Exit:** a sandbox payment reaches `PAID`; a test notification is delivered to a
test recipient; no path can touch a production/live external account.

## 17C — Demo users & seed data

Create controlled accounts (test credentials stored in the team's secret store,
**never** in git), one per role/variant:

- Administrator
- Customer
- Community Fisher vendor
- Established (Enterprise Supplier) vendor
- Driver — personal vehicle
- Driver — company (fleet) vehicle

Seed a representative dataset: products, seafood lots (with catch/species),
delivery zones, fleet assets, orders across the status workflow, temperature
readings (including a breach), reviews, and compliance records (so compliance
scores render across bands). Reuse the existing `prisma db seed` + the
`compliance:scores:recompute-all` backfill; extend the seed with a UAT fixture
set rather than hand-entering data.

**Do not use real customer personal information.** Use synthetic names, emails
(`+uat` aliases), and Jamaica-format but fictitious addresses/phones.

## 17D — Role-based UAT scripts

Prepare test cases covering: customer registration & purchasing; vendor
onboarding & fulfilment; driver assignment & delivery; admin approvals &
moderation; payments & settlements; food safety & traceability; cold-chain
monitoring; recalls; reviews & compliance scores.

Each case records:

| Field | |
|---|---|
| Test ID | e.g. `UAT-CUST-001` |
| Role | Customer / Vendor / Driver / Admin |
| Preconditions | seed state / prior steps |
| Steps | numbered actions |
| Expected result | |
| Actual result | filled during execution |
| Pass/Fail | |
| Evidence | screenshot / API response / log ref |
| Tester | |
| Date | |

A per-run results log lives under `docs/uat/runs/<date>-rc1/`. The test-case
catalogue is authored in this phase as `docs/uat/scripts/` (one file per role).

**Cross-check against existing guarantees** — many of these flows already have
e2e coverage (auth, orders, delivery, payments, food-safety, reviews, vendor
tiers, analytics, passport). UAT validates them *as a human operator through the
real UI*, not as a replacement for the automated suite.

## 17E — Operational readiness

- **Backup & restore test** — take a UAT DB backup, restore to a scratch
  instance, verify integrity. This is a hard gate (§17G).
- **Migration rehearsal** — `prisma migrate deploy` from an empty DB and from the
  prior schema; confirm no drift (`prisma migrate status`).
- **Logging & monitoring** — structured logs shipped; dashboards for error rate,
  latency, queue depth.
- **Alerting** — on health-check failure, error spikes, cold-chain
  EMERGENCY/CRITICAL alerts, payment failures.
- **Health checks** — `/health` (public) and `/health/status` (admin) wired to
  the host's uptime monitor.
- **Incident-response** & **rollback** procedures documented (redeploy previous
  image + `prisma migrate resolve` guidance).
- **Data retention & privacy review** — confirm the retention rules
  (traceability/inspection/temperature 7y; audit logs permanent) and that
  personal data is masked where required (reviews already mask author names).
- **Access-control review** — spot-check role guards and cross-tenant isolation
  (vendor/driver/customer data separation) in the running environment.

## 17F — UAT issue management

Severity levels: **Critical · High · Medium · Low · Cosmetic**.

Agree on: issue template (id, severity, role, steps, expected/actual, evidence,
owner, target date, retest status), assigned owner, target resolution SLAs,
retest process, and the acceptance sign-off record. Track under
`docs/uat/issues/`.

## 17G — Production approval gate

Production stays blocked until **all** of:

- [ ] All **Critical** and **High** UAT defects closed.
- [ ] Required **Medium** defects resolved or formally accepted (documented).
- [ ] Backup **restoration** verified successful.
- [ ] **Payment** testing (WiPay sandbox + COD) successful.
- [ ] **Security review** complete (auth, RBAC, secrets handling, input
      validation, dependency scan).
- [ ] **Business owner sign-off** recorded.
- [ ] Release candidate **promoted** to a final version tag.

## Versioning policy

- **Tags are immutable.** Do **not** move `v1.0.0-rc.1` after the prerelease is
  published.
- Release-changing fixes during UAT → cut a **new** candidate `v1.0.0-rc.2`
  (repeat the relevant UAT).
- UAT passes with no release-changing fixes → tag **`v1.0.0`** and publish a
  non-prerelease GitHub Release.

## Out of scope

New marketplace features, schema changes beyond fixing UAT defects, and the
deferred items already recorded (customer web review-submission UI; admin
restore / customer appeal workflow). Address those in a later feature phase,
not during stabilization.
```
