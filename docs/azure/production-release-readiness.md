# Dedicated Production Release Readiness — `iriefishmongers.com`

**Status:** Code-only preparation on `feat/production-release-prep` (branched from `c24316ced3fce264f18c9a1e0cee1f368ad629a5`). **No Azure resources have been provisioned and no GoDaddy DNS records have been changed.**

---

## 1. Storefront Redesign Handoff Status

- **Required merge/cherry-pick before production frontend build:** `feat/platform-access-branding` at `0a7e1da805f2da373e4dcf3df4bf2ce08df6ac5a` was **not present** in local Git refs, `.git/worktrees`, sibling directories, or `origin` (`https://github.com/bernie-Xtrinet1/irie-fishmongers.git`).
- Per release policy, the redesign was **not** rebuilt here. Once Bernard pushes or shares `0a7e1da805f2da373e4dcf3df4bf2ce08df6ac5a`, merge or cherry-pick it onto `feat/production-release-prep` while keeping:
  - `7689016` (`OPERATIONS_STAFF` RBAC + primary-admin vendor settlement authorization)
  - `2f2c510` / `7cdda96` / `c24316c` (live telemetry, cargo matching, `AuthModule` DI startup fix)
  - Production workflows and `infrastructure/azure/production/` IaC added by this branch.

---

## 2. Production Architecture & Release Pipeline Isolation

| Aspect | Staging (`rg-iriefishmongers-staging`) | Dedicated Production (`rg-iriefishmongers-prod`) |
|---|---|---|
| Bicep templates | `infrastructure/azure/main.bicep` + `tier3/` | `infrastructure/azure/production/` (`main.bicep`, `deployment.bicep`, `modules/*`) |
| GHCR image tag namespace | `:<sha>` | `:prod-<sha>` (`build-images.yml` `target_environment=production`), deployed by `@sha256:<digest>` |
| GitHub Environment gate | `environment: staging` | `environment: production` + explicit `confirm_production == 'PRODUCTION'` |
| Azure OIDC identity | Staging federated identity | **Separate** Entra App Registration (`environment:production` subject, RBAC scoped strictly to `rg-iriefishmongers-prod`) |
| Data plane network | PG `AllowAllAzureServices` `0.0.0.0`, Redis public TLS | PG & Redis `publicNetworkAccess: 'Disabled'`, zero firewall rules, Private Endpoints (`snet-private-endpoints`) + Private DNS inside `vnet-irie-prod` |
| Container Apps Env | Consumption (public managed VNet) | Workload Profiles (`Consumption` profile only) VNet-injected (`snet-aca` `/23`), reaching Private Link DB/Redis internally |
| Key Vault | `kv-irie-staging` (RBAC, 7d soft-delete) | `kv-irie-prod` (RBAC, 90d soft-delete, Purge Protection enabled, IP ACL restricted) |
| Admin access | `ca-irie-admin` IP allowlist (`63.245.90.66/32`) | `ca-irie-admin-prod` enforces `@minLength(1)` `adminAllowedIpCidrs` in Bicep (`63.245.90.66/32`) + HTTP 403 public check in `deploy-production.yml` |
| Monitoring & budget | `log-irie-staging`, `$75` budget | `log-irie-prod`, `appi-irie-prod` App Insights, Monthly Budget (`80%` Forecasted + `100%` Actual) |

---

## 3. East US 2 Capacity & Network Compatibility Comparison (Before Choosing Tier)

### Verified Private-Networking & SLA Compatibility
1. **Azure Container Apps (`Workload Profiles` with `Consumption` profile in `snet-aca` `/23`):** Supports custom VNet integration and Private Link DNS resolution with **\$0 fixed Dedicated management fee** (Consumption active/idle billing only).
   - *Irreversible choice note:* `zoneRedundant: true` on `Microsoft.App/managedEnvironments` can **only** be set at creation time (cannot be toggled on later without recreating `cae-irie-prod`).
2. **Azure Database for PostgreSQL 16 Flexible Server (`eastus2`):**
   - `Burstable` (`Standard_B1ms` / `Standard_B2s`): **Supports** `publicNetworkAccess: 'Disabled'` + Private Link (`postgresqlServer`, DNS `privatelink.postgres.database.azure.com`) and automated 7–35d PITR backups (plus optional geo-redundant storage). **Does NOT support** High Availability (`ZoneRedundant` / `SameZone`), **on-demand manual backups**, or read replicas.
   - `GeneralPurpose` (`Standard_D2ds_v5`): **Supports** `publicNetworkAccess: 'Disabled'` + Private Link, **`ZoneRedundant` HA (99.99% SLA, `2×` compute + `2×` storage)**, on-demand backups, 7–35d PITR, geo-redundant backups, and read replicas.
3. **Azure Managed Redis (`Microsoft.Cache/redisEnterprise@2025-04-01`, `eastus2`):**
   - Private networking requires **Private Link** (`groupId: 'redisEnterprise'`, Private DNS Zone `privatelink.redis.azure.net`, `publicNetworkAccess: 'Disabled'`).
   - `Balanced_B0` (0.5 GB, 2 vCPU) single-node (`highAvailability: 'Disabled'`) carries **no uptime SLA** and loses volatile data/locks on maintenance restarts.
   - `Balanced_B3` (3 GB) with `highAvailability: 'Enabled'` runs **2 nodes across Availability Zones (`2×` hourly rate)** with a **99.9% SLA** and supports RDB/AOF persistence or Active Geo-Replication (mutually exclusive). *(`Balanced_B1` 1 GB 2-node HA at \$46.72/mo supports 2-node HA without active geo-replication as a middle tier.)*

### Option Comparison (`eastus2`, 730 hrs/month PAYG Azure Retail Prices API baseline)

| Component | Option A — Lowest-Cost Private (`production.cost-optimized.bicepparam`) | Option B — High-Availability (`production.ha.bicepparam`) |
|---|---|---|
| **PostgreSQL Compute** | `Standard_B1ms` (1 vCore, 2 GiB, Burstable, No HA): `\$0.017/hr` = **\$12.41/mo** *(or `B2s` 2 vCore/4 GiB: \$49.64/mo)* | `Standard_D2ds_v5` (2 vCore, 8 GiB, General Purpose, `ZoneRedundant` HA `2×`): `2 × \$0.178/hr` = **\$259.88/mo** |
| **PostgreSQL Storage** | `32 GiB` single-node (`\$0.115/GiB/mo`): **\$3.68/mo** | `2 × 32 GiB` primary+standby: **\$7.36/mo** (+ GRS extra backup beyond `1×` storage at `\$0.095/GB/mo` LRS equivalent / GRS delta) |
| **Azure Managed Redis** | `Balanced_B0` (0.5 GB, 1-node Non-HA): `\$0.016/hr` = **\$11.68/mo** *(calculator variance ~\$13.14)* | `Balanced_B3` (3 GB, 2-node HA): `2 × \$0.065/hr` = **\$94.90/mo** *(or `Balanced_B1` HA: `2 × \$0.032/hr` = \$46.72/mo)* |
| **Private Link + DNS** | 2 PEs (`\$7.30/mo × 2`) + 2 Private DNS Zones (`\$0.50 × 2`) = **\$15.60/mo** (+ `\$0.01/GB` data, `\$0.40/1M` queries) | Same Private Link topology: **\$15.60/mo** (+ `\$0.01/GB` data, `\$0.40/1M` queries) |
| **Container Apps (`cae-irie-prod`)** | Consumption VNet (`backend` `1..2`, `web` `1..2`, `admin` `0..1`, non-ZR): **~\$8–20/mo** after free grant | Consumption VNet (`zoneRedundant: true`, `backend` `2..4`, `web` `1..4`, `admin` `0..2`): **~\$18–35/mo** after free grant |
| **Monitoring & Key Vault** | `Log Analytics` (30d, 1 GB/d cap) + `App Insights` + `Key Vault`: **~\$3–8/mo** | `Log Analytics` (90d, 2 GB/d cap) + `App Insights` + `Key Vault`: **~\$8–20/mo** |
| **Fixed Data + Net Floor** | **~\$43.37/mo** (`\$80.60/mo` with `B2s`) | **~\$377.74/mo** (`\$329.56/mo` with `Balanced_B1` HA) |
| **Estimated Monthly Total** | **~\$55–72/mo** (`~\$92–110/mo` w/ `B2s`) | **~\$404–433/mo** (`~\$356–385/mo` w/ `Balanced_B1` HA) |
| **Backup & Restore** | 14d automated PITR backups only; **no on-demand backups** | 35d automated PITR + **Geo-Redundant backup** (`geoRedundantBackup: Enabled`) + **on-demand manual backups** |
| **Availability Trade-off** | **No Redis SLA**; maintenance/node fault drops DB and Redis locks until restarted | **99.99% PG Zone-Redundant SLA + 99.9% Redis HA SLA + Multi-AZ ACA** |

---

## 4. Production Configuration Checklist & Secrets

Store **only** secret names in IaC/CI; populate values **out of band** via `az keyvault secret set --vault-name kv-irie-prod` (never in GitHub Secrets/Vars except optional `GHCR_READ_PAT` if needed, and never echoed in logs).

### A. Key Vault (`kv-irie-prod`) Secrets (12 Required When Email Enabled)
1. `database-url` — `postgresql://<admin>:<url-encoded-pw>@psql-irie-prod.postgres.database.azure.com:5432/iriefishmongers?sslmode=require`
2. `redis-url` — `rediss://:<access-key>@redis-irie-prod.eastus2.redis.azure.net:10000`
3. `jwt-access-secret` — Fresh CSPRNG >= 32 chars (distinct from staging)
4. `jwt-refresh-secret` — Fresh CSPRNG >= 32 chars (distinct from staging)
5. `checkout-quote-signing-secret` — Fresh CSPRNG >= 32 chars (must reject documented placeholders)
6. `wipay-account-number` — Live WiPay merchant account number
7. `wipay-api-key` — Live WiPay API key
8. `sendgrid-api-key` — Live SendGrid API key (`EMAIL_ENABLED=true`)
9. `firebase-project-id` — Production Firebase project ID
10. `firebase-client-email` — Production Firebase service account client email
11. `firebase-private-key` — Production Firebase PEM private key (literal `\n` sequences)
12. `ghcr-pat` — Fine-grained GitHub PAT (`read:packages` only) for Container Apps & migrator GHCR pulls

### B. External Service Prerequisites & Code Gate Warning
- **CRITICAL WIPAY LIVE BLOCKER (`backend/src/modules/payments/providers/wipay.adapter.ts`):**
  - `WiPayAdapter.createPayment()` currently checks `if (apiUrl !== WIPAY_SANDBOX_API_URL ...)` (lines 57–59) and hardcodes `environment: 'sandbox'` (line 88). Passing `WIPAY_API_URL=https://jm.wipayfinancial.com/plugins/payments` **fails payment initiation with HTTP 400** until a dedicated live-payments change updates `WiPayAdapter` (sending `environment: 'live'`, verifying live status/refund reconciliation policy, and completing owner sign-off per `docs/uat/phase-17-uat-production-readiness.md` §17G).
  - Configure `WIPAY_FEE_STRUCTURE` (`customer_pay`, `merchant_absorb`, or `split`) explicitly (`merchant_absorb` in staging was sandbox-only).
- **Transactional Email (`SendGrid`):**
  - `EMAIL_ENABLED=true`, `SENDGRID_FROM_EMAIL=notifications@iriefishmongers.com`.
  - Authenticate `iriefishmongers.com` in SendGrid (add SendGrid SPF/DKIM CNAME records in GoDaddy **before** `EMAIL_ENABLED=true` sends live customer emails).
- **Authentication & Clean Production Data:**
  - `ENABLE_SCHEDULER=true` with `backendMinReplicas >= 1` so reservation expiry and SLA/payment sweeps fire continuously.
  - Run `ca-irie-db-migrate-prod` (`prisma migrate deploy`) followed by `prisma db seed` (`backend/prisma/seed.ts` — seeded roles, delivery zones, categories, compliance defaults, catalogue photo metadata **only**). **Never run `demo-seed.ts`** and **never seed `@iriefishmongers.test` accounts** in `rg-iriefishmongers-prod`. Provision primary administrator and initial operational accounts manually with private credential handoff.

### C. GitHub `production` Environment Config (`Settings -> Environments -> production`)
- **Protection rules:** Require manual reviewer approval + restrict deployment branches.
- **OIDC identity (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`):** Separate Entra App Registration with federated credential subject `repo:bernie-Xtrinet1/irie-fishmongers:environment:production` and RBAC scoped **solely** to `rg-iriefishmongers-prod`.
- **Non-secret variables:**
  - `AZURE_RESOURCE_GROUP`: `rg-iriefishmongers-prod`
  - `PROD_NEXT_PUBLIC_API_URL`: `https://api.iriefishmongers.com/api/v1`
  - `PROD_NEXT_PUBLIC_WEB_APP_URL`: `https://iriefishmongers.com`
  - `PROD_NEXT_PUBLIC_ADMIN_APP_URL`: `https://admin.iriefishmongers.com`
  - `PROD_NEXT_PUBLIC_ENVIRONMENT`: `production`
  - `PROD_ADMIN_VERIFY_RUNNER` *(optional)*: approved workstation/self-hosted runner label inside `adminAllowedIpCidrs`

---

## 5. Browser CORS & Refresh-Cookie Verification

Verified against `backend/src/main.ts`, `backend/src/modules/auth/controllers/auth.controller.ts`, `apps/web/lib/api-client.ts`, and `apps/admin-dashboard/lib/api-client.ts`:
- **Origin vs. Site topology:** `https://iriefishmongers.com`, `https://www.iriefishmongers.com`, `https://admin.iriefishmongers.com`, and `https://api.iriefishmongers.com` are distinct **origins** (so `main.ts` requires `CORS_ORIGIN=https://iriefishmongers.com,https://www.iriefishmongers.com,https://admin.iriefishmongers.com` with `credentials: true` — wildcard `*` is rejected by `validateEnv`).
- **Same-Site Refresh Cookie:** All four hosts share the `iriefishmongers.com` registrable domain (`eTLD+1`). Both frontends issue `fetch(..., { credentials: 'include' })` for `/auth/login`, `/auth/refresh`, and `/auth/logout`.
- Therefore **`NODE_ENV=production` + `REFRESH_COOKIE_SAMESITE=strict`** issues a host-only `api.iriefishmongers.com` cookie with `httpOnly: true`, `secure: true`, `sameSite: 'strict'`, `path: '/api/v1/auth'`, blocking third-party CSRF while supporting silent refresh across web, `www`, and admin subdomains.
- *(Pre-cutover note: if testing temporary `*.azurecontainerapps.io` FQDNs before binding `iriefishmongers.com`, `azurecontainerapps.io` subdomains remain cross-site from custom domains or `eastus2.azurecontainerapps.io` PSL rules — test final custom-domain login/refresh immediately after GoDaddy cutover.)*

---

## 6. Migration, Backup, Restore & Rollback Checks

1. **Pre-deploy Migration Check:**
   - `build-images.yml` validates the `migrator` target against disposable PostgreSQL (`prisma migrate deploy` + `prisma migrate status`).
   - `deploy-production.yml` triggers `ca-irie-db-migrate-prod` (inside `vnet-irie-prod`, talking to `psql-irie-prod` over Private Link) and aborts before touching `backend`, `web`, or `admin` if status is not `Succeeded`.
2. **Pre-cutover Backup & Scratch Restore Drill (§17E hard gate):**
   - Take/identify a snapshot timestamp on `psql-irie-prod` (note: Option B `GeneralPurpose` supports on-demand restore tests + geo-restore; Option A `Burstable` uses scheduled PITR points only).
   - Restore to a temporary scratch server (`psql-irie-prod-restore-test`) in `rg-iriefishmongers-prod`, run `prisma migrate status` + row-count/referential integrity verification, verify application read connectivity, then delete the scratch server after recording evidence.
3. **Rollback Procedure:**
   - **Application rollback:** Single-revision mode preserves prior healthy revisions. `deploy-production.yml` prints exact `prev_*_image` `@sha256:<digest>` refs:
     ```bash
     az containerapp update -n ca-irie-backend-prod -g rg-iriefishmongers-prod --image <previous-backend-image>
     az containerapp update -n ca-irie-web-prod     -g rg-iriefishmongers-prod --image <previous-web-image>
     az containerapp update -n ca-irie-admin-prod   -g rg-iriefishmongers-prod --image <previous-admin-image>
     ```
   - **Database rollback:** Prisma migrations are forward-only (`prisma migrate deploy` never runs destructive down-migrations). Recover schema defects via a forward-fix migration or PostgreSQL PITR restore to the captured pre-migration timestamp.

---

## 7. Post-Provisioning GoDaddy Cutover & HTTPS Verification Plan

*(Do **not** configure GoDaddy until Option A/B is approved, `cae-irie-prod` + apps are provisioned, and `ca-irie-web-prod` / `ca-irie-backend-prod` FQDNs and verification IDs are inspected directly from `rg-iriefishmongers-prod`.)*

1. Capture exact production targets after Pass 1/Pass 2 deployment:
   - `PROD_ENV_IP=$(az containerapp env show -n cae-irie-prod -g rg-iriefishmongers-prod --query properties.staticIp -o tsv)`
   - `PROD_ASUID=$(az containerapp env show -n cae-irie-prod -g rg-iriefishmongers-prod --query properties.customDomainVerificationId -o tsv)`
   - `PROD_WEB_FQDN`, `PROD_API_FQDN`, `PROD_ADMIN_FQDN` from `az containerapp show ... -g rg-iriefishmongers-prod`
2. Configure GoDaddy DNS (preserving any MX/TXT/SPF/DKIM email records; baseline currently `A @ 15.197.148.33 / 3.33.130.190`, `CNAME www -> iriefishmongers.com`, no MX/TXT):
   - `A` `@` -> `<PROD_ENV_IP>`
   - `TXT` `asuid` -> `<PROD_ASUID>`
   - `CNAME` `www` -> `<PROD_WEB_FQDN>` + `TXT` `asuid.www` -> `<PROD_ASUID>`
   - `CNAME` `api` -> `<PROD_API_FQDN>` + `TXT` `asuid.api` -> `<PROD_ASUID>`
   - `CNAME` `admin` -> `<PROD_ADMIN_FQDN>` + `TXT` `asuid.admin` -> `<PROD_ASUID>`
3. Bind hostnames & issue Azure Managed TLS certificates on `ca-irie-web-prod`, `ca-irie-backend-prod`, and `ca-irie-admin-prod` (`az containerapp hostname add` + `bind --validation-method CNAME/HTTP`).
4. Post-cutover verification:
   - Verify valid HTTPS certs & 200 responses on `https://iriefishmongers.com/`, `https://iriefishmongers.com/platform`, `https://www.iriefishmongers.com/`, and `https://api.iriefishmongers.com/api/v1/health`.
   - Verify browser login + silent `/auth/refresh` + cart/API calls across `iriefishmongers.com` and `admin.iriefishmongers.com`.
   - Verify `https://admin.iriefishmongers.com/login` returns HTTP 403 from unapproved IPs and HTTP 200 from approved `adminAllowedIpCidrs`, and confirm `OPERATIONS_STAFF` / settlement authorization restrictions still enforce 403/stripped financials.
