# Azure Staging — Tier 3 Application Deployment (Phase 17F)

**Status: authored for review. NOT deployed.** No Azure resource has been
created or modified; no secret has been set; no migration has run. These files
are Infrastructure-as-Code only.

Tier 3 turns the Tier-1 FQDN-reservation foundation into a running staging
environment: real data services, secrets, identity, private-registry auth, a
migration Job, and the three real application images replacing the placeholders.

Tier-1 files (`infrastructure/azure/*.bicep`, `modules/*`) are **untouched**.
The three Container Apps are **updated in place** (same names), so their
assigned FQDNs are retained.

## Two-pass deployment (secret ordering)

Key Vault secret *values* are never in Git/Bicep/params — they are set out of
band between the two passes:

```
Pass 1  (deployApplications=false):
  az deployment group create -g rg-iriefishmongers-staging \
    --template-file infrastructure/azure/tier3/main.bicep \
    --parameters infrastructure/azure/tier3/staging.bicepparam
  -> creates Key Vault, user-assigned identity + RBAC, PostgreSQL, Redis.

  (out of band) az keyvault secret set ...   # set the 11 secret values

Pass 2  (deployApplications=true):
  az deployment group create -g rg-iriefishmongers-staging \
    --template-file infrastructure/azure/tier3/main.bicep \
    --parameters infrastructure/azure/tier3/staging.bicepparam \
    --parameters deployApplications=true
  -> updates backend/web/admin to real images, creates the migrator Job.

  az containerapp job start -n ca-irie-db-migrate -g rg-iriefishmongers-staging
  -> runs `prisma migrate deploy` before the backend serves.
```

## Resource graph (Tier-3 adds)

```
rg-iriefishmongers-staging (existing)
├─ (existing) cae-irie-staging, log-irie-staging, 3 Container Apps, budget
├─ security.bicep
│  ├─ kv-irie-staging                (Key Vault, RBAC)
│  ├─ id-irie-staging-runtime        (user-assigned identity)
│  └─ roleAssignment                 (Key Vault Secrets User → identity, KV scope)
├─ data.bicep
│  ├─ psql-irie-staging (+ db + AllowAllAzureServices firewall rule)
│  └─ redis-irie-staging (+ default database, TLS :10000)
└─ (Pass 2) backend/web/admin updated in place + ca-irie-db-migrate (Job)
```

## Files

- `main.bicep` — RG-scoped orchestrator; `deployApplications` gate.
- `modules/security.bicep` — Key Vault + user-assigned identity + RBAC.
- `modules/data.bicep` — PostgreSQL Flexible Server + Azure Managed Redis.
- `modules/containerApp.bicep` — one real app (reused 3×): image-by-digest,
  real port, KV-backed secret env, GHCR registry auth, probes.
- `modules/migratorJob.bicep` — Container Apps Job (`prisma migrate deploy`).
- `staging.bicepparam` — non-secret parameters; digests + PG password read from
  deploy-time env vars, never stored.

## Required Key Vault secrets (names only — VALUES set out of band)

| Secret name | Feeds |
|---|---|
| `database-url` | backend + migrator `DATABASE_URL` (include `sslmode=require`) |
| `redis-url` | backend `REDIS_URL` (`rediss://<host>:10000`) |
| `jwt-access-secret` | backend `JWT_ACCESS_SECRET` (≥32 chars) |
| `jwt-refresh-secret` | backend `JWT_REFRESH_SECRET` (≥32 chars) |
| `wipay-account-number` | backend `WIPAY_ACCOUNT_NUMBER` |
| `wipay-api-key` | backend `WIPAY_API_KEY` |
| `sendgrid-api-key` | backend `SENDGRID_API_KEY` |
| `firebase-project-id` | backend `FIREBASE_PROJECT_ID` |
| `firebase-client-email` | backend `FIREBASE_CLIENT_EMAIL` |
| `firebase-private-key` | backend `FIREBASE_PRIVATE_KEY` (store the PEM with literal `\n` sequences; the push adapter converts them to newlines) |
| `ghcr-pat` | GHCR `read:packages` token (all apps + job registry auth) |

Compose `database-url`/`redis-url` from the deployment outputs
(`postgresFqdn`, `postgresAdminLogin`, `databaseName`, `redisHostName`,
`redisPort`) plus the PG password and Redis access key.

## Browser topology decision — Topology A (absolute, cross-site)

Resolved from ADR-004 + `auth.controller.ts`: the Gate B2 frontend images bake
an **absolute** `NEXT_PUBLIC_API_URL` (backend FQDN), so the browser calls the
backend cross-origin. This **preserves the already-built Gate B2 images** — no
proxy rebuild (Topology B) is needed.

`REFRESH_COOKIE_SAMESITE=none` is **not chosen as "safer"** — it is the
**required compatibility setting** for this cross-site topology: the backend and
the frontends are on different registrable domains (Azure-assigned FQDNs), so a
`strict`/`lax` refresh cookie would never be sent on the dashboard's
cross-site fetch and the silent-refresh flow would break (ADR-004
"Deployment Domain Requirements" fallback). `none` is only accepted by browsers
together with `Secure`, which `auth.controller.ts` **forces on** whenever
`SameSite=none`; Container Apps serves HTTPS, satisfying it. The tradeoff is a
different CSRF posture than `strict` (documented in ADR-004), accepted here as
the price of cross-site operation. Backend env therefore sets
`CORS_ORIGIN` = web+admin FQDNs, `APP_BASE_URL` = backend FQDN (its own base URL,
used for WiPay webhook callbacks), `REFRESH_COOKIE_SAMESITE=none`.

## Deferred / decisions

- **GHCR auth = H1** (registry username + `ghcr-pat` token as a Key Vault
  secret). Managed identity cannot authenticate to GHCR. (H3/ACR remains an
  alternative but is not used here.)
- **Custom DNS**: none (Azure-assigned FQDNs).
- The **PostgreSQL public-access + "Allow Azure services"** firewall rule
  (`0.0.0.0-0.0.0.0`) admits Azure-origin traffic from **any Azure
  subscription/tenant**, not only this one — the network boundary is
  effectively "any Azure IP", with TLS (`sslmode=require`) + credentials as the
  only controls. This is an **explicit, staging-only, temporary** tradeoff for
  non-production data; **production must replace it with a private endpoint /
  VNet** (no public access).

## NOT performed here
No provisioning, no `az deployment ... create`, no secret set, no migration, no
image change, no GHCR PAT creation, no DNS. See the top-level report for the
exact next mutation-authorization boundaries.
