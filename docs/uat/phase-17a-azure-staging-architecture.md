# Phase 17A — Azure Staging/Training Architecture (read-only design)

Status: **DESIGN ONLY. Nothing provisioned.** No Azure login, no credentials, no
Bicep/Terraform, no resource groups, no paid resources, no deployment automation
were created in this unit. This document is the pre-provisioning architecture
proposal for approval. Azure remains gated on (a) approval of this design and
(b) Azure credentials being supplied.

Goal: the **smallest Azure environment that faithfully runs the current
software** (real PostgreSQL + real Redis, real container runtime) for
staging/training, with a monthly USD estimate and a growth path that needs **no
application redesign**.

Grounding: every recommendation below is derived from the actual repo at commit
`8cfcf95`, not assumptions. Key inspected facts are cited inline.

---

## 1. What actually has to run (from the repo)

| Component | Reality in repo | Hosting implication |
|---|---|---|
| Backend API | NestJS, `nest build` → `node dist/main.js`; binds `0.0.0.0` on `PORT`; global prefix `api/v1`; `helmet` + CORS; Swagger at `/api/v1/docs`. Health at `/api/v1/health` (liveness, checks PG `SELECT 1` + Redis `ping`) and `/api/v1/health/status`. | One container, one HTTP port, stateless. Ideal for Container Apps. |
| `apps/web` | Next.js (44 tracked files), `next start -p 3000`, **default server output** (SSR — uses `rewrites()`, dynamic `images`). Not `output: 'export'`, not `output: 'standalone'`. | Needs a Node SSR runtime, not pure static hosting. |
| `apps/admin-dashboard` | Next.js (131 files), `next start -p 3002`, default server output + per-request CSP headers. | Same — Node SSR runtime. |
| `apps/customer-app`, `driver-app`, `vendor-app` | **0 tracked files each** — empty scaffolds. | **Out of scope** for web hosting. Mobile ships via Expo/app stores later, never Azure web. |
| `packages/*` (`config`, `types`, `ui`, `utils`) | Shared workspace libs, `transpilePackages` in Next config. | Built into each app's image; no separate hosting. |
| PostgreSQL | Prisma `provider = "postgresql"`, `url = env("DATABASE_URL")`. Uses advisory locks (cutover gate), transactions, `autoincrement` revisions. | Requires **real** managed PostgreSQL. Burstable tier preserves all semantics. |
| Redis | Reservation engine uses Lua `EVAL` scripts, atomic ops, hash-tagged keys. `REDIS_URL`. | Requires **real** Redis (Lua support). Basic tier is sufficient. |
| File uploads | **None** — no `FileInterceptor`/`@UploadedFile`/`multer`/`diskStorage`/disk writes anywhere in `backend/src`. Product images are external URL strings. | **Blob Storage NOT required** by current code. Optional/future only. |
| Observability | **None wired** — no Sentry/OTel/App Insights in `backend/src` (`SENTRY_DSN` in `.env.example` is aspirational). | Platform-level logs only until code instrumentation added later. |
| Scheduler | `ScheduleModule.forRoot()` gated by `ENABLE_SCHEDULER` (default on). C4 compensation `@Cron` every minute. | Backend must run continuously if scheduler needed; conflicts with scale-to-zero (see §12). |

Node runtime: `.nvmrc` = **20.18.1**, `engines.node >=20` → base image `node:20`.

---

## 2. Text architecture diagram — "smallest sensible staging"

```
                          Internet (staff / trainees)
                                     │  HTTPS (443)
                                     ▼
        ┌──────────────────────────────────────────────────────────┐
        │        Azure Container Apps Environment (single)          │
        │        region: East US 2   networking: public ingress     │
        │        managed TLS certs (free) on *.azurecontainerapps.io │
        │        + optional custom domain uat.iriefishmongers.*      │
        │                                                            │
        │  ┌────────────┐   ┌────────────┐   ┌──────────────────┐   │
        │  │ web (SSR)  │   │ admin (SSR)│   │  backend API      │   │
        │  │ next start │   │ next start │   │  node dist/main   │   │
        │  │ :3000      │   │ :3002      │   │  :PORT /api/v1    │   │
        │  │ scale 0..1 │   │ scale 0..1 │   │  scale 0..N       │   │
        │  └─────┬──────┘   └─────┬──────┘   └───┬────────┬─────┘   │
        │        │  /api/v1 proxy │                │        │        │
        │        └───────┬────────┘                │        │        │
        └────────────────┼─────────────────────────┼────────┼───────┘
                         │ (server-side rewrite)    │        │
                         └──────────────────────────┘        │
                                     │ TLS/5432 (sslmode=require)     │ TLS/10000
                                     ▼                                ▼
                    ┌───────────────────────────┐      ┌──────────────────────────┐
                    │ Azure Database for         │      │ Azure Managed Redis       │
                    │ PostgreSQL Flexible Server │      │ Balanced B0, 1 node,      │
                    │ Burstable B1ms, 32 GB      │      │ non-HA (no replica)       │
                    │ 7-day PITR backup          │      │ (or containerized Redis   │
                    │ can be STOPPED when idle   │      │  app for rock-bottom cost)│
                    │ (auto-restarts after 7d)   │      │ always-on                 │
                    └───────────────────────────┘      └──────────────────────────┘

     Supporting (shared):
       • Azure Key Vault  ── secrets (DB/Redis conn strings, JWT secrets, provider keys)
       • Log Analytics workspace ── Container Apps logs + (future) App Insights
       • Image registry ── ghcr.io (free) OR Azure Container Registry Basic ($5)
       • Azure Monitor budget + alert on the resource group

     CI/CD:  GitHub Actions (develop) ──build images──▶ registry ──az containerapp update──▶ env
             migrations: `prisma migrate deploy` as a pre-deploy Container Apps Job
```

---

## 3. Component-by-component recommendations

### Frontend hosting
Both Next.js apps use **server output** (verified: no `output` field in either
`next.config`), so they need a Node server (`next start`), not static hosting.
- **Recommended:** each as a Container App (scale 0→1) in the same environment as
  the backend. Uniform build/deploy story, scale-to-zero at idle, free managed TLS.
- Add `output: 'standalone'` to both `next.config` before containerizing — produces
  a self-contained server bundle → much smaller images and a trivial Dockerfile.
  (Config addition, not a redesign.)
- **Rejected:** Azure Static Web Apps. Its Next.js support is hybrid/limited and
  these apps rely on SSR rewrites + per-request CSP; SWA static mode won't serve
  them faithfully.

### Backend hosting — Container Apps vs a tiny VM
- **Recommended: Azure Container Apps (Consumption).** Scale-to-zero (idle compute
  ≈ $0), managed TLS, revisions/rollback, built-in ingress + health probes
  (`/api/v1/health`), no OS patching. Fits the stateless single-port backend exactly.
- **Alternative: single Burstable VM (B2s) running the existing
  `infrastructure/docker/docker-compose.yml` + app containers.** This is the
  *absolute cheapest* (~$30/mo all-in, one box) but: always-on (no scale-to-zero),
  you own OS patching + TLS (certbot) + Docker lifecycle, and it does **not** mirror
  managed-service production behavior. Acceptable only if training fidelity to
  managed services doesn't matter.
- **Verdict:** Container Apps for production-likeness and scale-to-zero economics;
  the VM is the fallback only if minimizing dollars beats fidelity.

### PostgreSQL — Flexible Server tier/storage/backup
- **Burstable B1ms** (1 vCPU, 2 GiB), **32 GiB** storage, **7-day** point-in-time
  backup (included; no surcharge while backup ≤ 100% of storage). Burstable
  preserves every semantic the app needs — advisory locks, interactive
  transactions, sequences all work identically to production-grade tiers.
- **Cost lever + stop-state caveat:** Flexible Server can be **stopped** when not
  training. While stopped: **compute billing stops**, but **storage and automated
  backups continue to bill** (~$4/mo storage floor). Critically, a stopped Flexible
  Server **automatically restarts after 7 days** — it does not stay stopped
  indefinitely — so to keep it stopped across a long idle period you must **stop it
  again after each auto-restart** (or accept it resuming compute charges until you
  do). Budget for occasional auto-restart compute if no one is watching it.
- `DATABASE_URL` must include **`sslmode=require`** (Azure enforces TLS). Prisma
  honours it via the connection string — no code change, but a required config note.

### Redis — Azure-managed, reservation-safe
- **Recommended: Azure Managed Redis, Balanced B0, single node / non-HA (no
  replica).** Azure Managed Redis (GA 2025) is the current, forward-looking managed
  Redis offering and fully supports the Lua `EVAL` scripts, atomic ops, and
  hash-tagged keys the reservation engine depends on. The B0 tier at one node
  (non-HA) is the smallest SKU and is the correct choice for a staging/training box.
  ~$13.14/mo PAYG one-node as the budgeting baseline; **always-on (cannot stop or
  scale to zero)** — the main irreducible idle cost. Confirm the exact figure in the
  Azure Pricing Calculator for the chosen region before provisioning.
  - Default endpoint port for Azure Managed Redis is **10000** (TLS), not 6379/6380 —
    reflect this in `REDIS_URL` (`rediss://…:10000`).
- **Do NOT choose Azure Cache for Redis.** It is on a **retirement path** and must
  not be selected for a new 2026 deployment; Azure Managed Redis is its successor.
  (This supersedes the earlier Basic C0 suggestion.)
- **Rock-bottom alternative:** run `redis:7-alpine` as a Container App (scale-to-zero,
  ≈ $0 idle). Loses managed durability/fidelity but is legitimate for a throwaway
  training box. Trade-off, not a recommendation.

### Blob Storage
- **Not required by current code** (no uploads, images are URLs). Omit for staging.
- If/when uploads are added: one Storage Account, LRS Hot, a single container,
  ~$1/mo at staging volumes. Listed as future-optional only.

### Secrets / Key Vault
- **Azure Key Vault (Standard).** Store DB + Redis connection strings, `JWT_ACCESS_SECRET`,
  `JWT_REFRESH_SECRET`, and provider keys (WiPay/SendGrid/FCM). Container Apps
  reference Key Vault secrets via managed identity → no secrets in image or env
  files. Billed per-operation (~$1/mo at staging). Aligns with the repo's
  "no secrets in git" policy and `CLAUDE.md` secrets rules.

### Networking — public vs private
- **Staging: public ingress** on the Container Apps Environment; PostgreSQL and
  Redis locked by firewall rules (allow the environment's outbound IP) or, better,
  **private endpoints** if staying all-Azure. No VNet integration needed for the
  cheapest faithful setup.
- **Avoid** VNet-integrated environment + NAT Gateway at staging (~$32/mo NAT alone).
  It's part of the production growth path, not the minimal box.

### TLS / custom domain
- Container Apps gives free HTTPS on `*.azurecontainerapps.io` out of the box.
- Custom domain (`uat.iriefishmongers.*`) uses a **free managed certificate** on
  Container Apps; only cost is DNS (use the existing registrar for $0, or Azure DNS
  ~$0.50/mo). Set backend `CORS_ORIGIN` / `APP_BASE_URL` to the chosen hostnames.

### App Insights / Log Analytics retention
- Container Apps Environment needs a **Log Analytics workspace** for logs. Set a
  low daily cap (~0.5 GB/day) and **30-day retention** (first 31 days retention is
  free; ingestion ~$2.76/GB after any free allotment). Staging volume → ~$2–5/mo.
- App Insights APM would require **code instrumentation** (none wired today) — defer
  to a later unit; platform logs suffice for staging.

### CI/CD — develop → staging
- Existing `.github/workflows/ci.yml` already does install → prisma generate → lint →
  typecheck → build → `prisma migrate deploy` (against a CI DB) → test:cov → e2e, on
  `develop`/`main`. **No deploy job exists.**
- Add a **separate deploy workflow** triggered on `develop` (after CI passes):
  1. Build 3 images (backend, web, admin) — web/admin need `NEXT_PUBLIC_*` as
     **build args** (Next inlines them at build time).
  2. Push to registry (ghcr.io free, or ACR Basic).
  3. Run `prisma migrate deploy` against staging PG as a **Container Apps Job**
     (or a CI step) — must complete **before** the new backend revision serves.
  4. `az containerapp update` each app to the new image tag.
- Keep it a distinct workflow so CI stays credential-free; deploy uses an Azure
  federated-identity/OIDC service principal scoped to the staging resource group.

---

## 4. Required environment variables (authoritative, from the repo)

**Backend** — validated at boot by `backend/src/config/environment-variables.ts`
with `skipMissingProperties: false`, so every *required* var must be present or the
app refuses to start:

Required: `NODE_ENV`, `PORT`, `API_PREFIX`, `DATABASE_URL`, `REDIS_URL`,
`JWT_ACCESS_SECRET` (≥32 chars), `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_SECRET`
(≥32 chars), `JWT_REFRESH_EXPIRES_IN`, `APP_BASE_URL`, `CORS_ORIGIN`,
`WIPAY_API_URL`, `WIPAY_ACCOUNT_NUMBER`, `WIPAY_API_KEY`, `SENDGRID_API_KEY`,
`SENDGRID_FROM_EMAIL`, `FCM_SERVER_KEY`.

Optional: `ENABLE_SCHEDULER` (`'true'`/`'false'`), `REFRESH_COOKIE_SAMESITE`
(`strict`/`lax`/`none`).

Cutover CLI only: `CUTOVER_OPERATOR_USER_ID` (not needed by the running API).

**Frontend (web + admin)** — repo-authored: `API_PROXY_TARGET` (server-side
rewrite target), `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_URL`,
`NEXT_PUBLIC_ENVIRONMENT`. The `NEXT_PUBLIC_*` are build-time inlined.

---

## 5. Database migration & seed procedure (staging)
1. `prisma migrate deploy` (applies all committed migrations; **36** at this commit).
2. `npm run prisma:seed -w backend` (reference data: roles, categories, zones — required first).
3. Optional demo data: `npm run demo:seed -w backend` (idempotent, upserts by email).
Run 1–2 as a pre-deploy Container Apps Job against staging PG. Provision the
staging PG database as **UTF-8** (`-E UTF8`) — the reference seed contains an emoji
that fails on a non-UTF-8 collation (rehearsal finding).

## 6. Staging reset / demo-data procedure
- Light reset: re-run `demo:seed` (idempotent) to restore demo accounts/showcase data.
- Full reset: drop+recreate the staging database (or `prisma migrate reset` against
  staging only), then steps 1–3 above. Because staging is disposable, a scripted
  "reset staging" Container Apps Job is the clean pattern.

## 7. Backup / restore procedure
- PostgreSQL Flexible Server: automated **PITR** (7-day retention) covers staging;
  restore = "point-in-time restore" to a new server. For demo snapshots before a
  training session, take an on-demand `pg_dump` (the cutover rehearsal proved
  dump+restore round-trips cleanly).
- Redis: staging Redis is derived/ephemeral state (durable truth is Postgres), so no
  Redis backup is load-bearing; Basic tier has no persistence and that's acceptable.

---

## 8. Exact Azure resource list (what would eventually be created)
1. Resource group `rg-iriefishmongers-staging` (East US 2)
2. Log Analytics workspace
3. Container Apps Environment (consumption, public)
4. Container App: `backend`
5. Container App: `web`
6. Container App: `admin`
7. Container Apps Job: `db-migrate` (runs `prisma migrate deploy` + seed)
8. Azure Database for PostgreSQL Flexible Server (Burstable B1ms, 32 GB, 7-day PITR)
9. Azure Managed Redis (Balanced B0, single node / non-HA)  ← or a containerized Redis app instead
10. Azure Key Vault (Standard) + secrets
11. Managed identity (for Container Apps → Key Vault + registry pull)
12. Image registry: ghcr.io (external, free) **or** Azure Container Registry (Basic)
13. Azure Monitor budget + alert rule on the resource group
14. (Optional) custom-domain binding + free managed cert; (optional) Azure DNS zone
15. (Future/optional) Storage Account for Blob if uploads are added

---

## 9. Monthly cost estimate (USD, East US 2, PAYG — estimates, not quotes)

All figures are PAYG estimates; **the final regional quote must be checked in the
Azure Pricing Calculator before provisioning.**

| Component | Idle month | Training-heavy month | Notes |
|---|---|---|---|
| Container Apps — backend + web + admin | ~$0–5 | ~$8–12 | scale-to-zero; monthly free grant covers light use |
| PostgreSQL Flexible B1ms + 32 GB | ~$4 (stopped) | ~$15 (running) | stopped = storage/backups only; auto-restarts after 7 days |
| Azure Managed Redis Balanced B0 (1 node, non-HA) | ~$13.14 | ~$13.14 | **always-on**, cannot stop — the irreducible floor |
| Log Analytics | ~$2 | ~$5 | low daily cap, 30-day retention |
| Key Vault | ~$1 | ~$1 | per-operation |
| Container Registry | $0 (ghcr) | $0 (ghcr) | or +$5 for ACR Basic |
| DNS / custom domain / TLS | ~$0–0.50 | ~$0–0.50 | managed cert free |
| **Total** | **~$20/mo** | **~$44/mo** | |

- **Expected idle month: ~$18–22** (dominated by always-on Managed Redis B0
  ~$13.14 + stopped-PG storage ~$4).
- **Training-heavy month: ~$42–48.**
- **Rock-bottom variant** (containerized Redis with scale-to-zero, ghcr images,
  PG stopped when idle): idle **~$7/mo**, training-heavy **~$35/mo** — at the cost
  of managed-Redis fidelity.
- **Recommended budget alert threshold: $75/mo** (comfortably above training-heavy;
  fires well before any runaway).

## 10. What stays free vs must be paid
- **Free / near-free:** Container Apps Environment; Container Apps monthly compute
  free grant; managed TLS certificates; first 100 GB/mo egress; ghcr.io image
  hosting; small Log Analytics ingestion; Key Vault secret storage (pay only per op).
- **Must be paid (irreducible for a *faithful managed* staging):** managed Redis
  (~$16/mo always-on) and PostgreSQL storage (~$4/mo even when stopped). Everything
  else scales toward $0 at idle.

## 11. Cheapest architecture that still preserves real PostgreSQL + Redis
Container Apps (all three apps, scale-to-zero) + PostgreSQL Flexible **B1ms**
(stopped when idle) + **Azure Managed Redis Balanced B0** (1 node, non-HA) +
ghcr.io images + Key Vault + minimal Log Analytics. **~$18–22 idle / ~$42–48
training-heavy.** This keeps genuine managed PG (advisory locks, transactions) and
genuine managed Redis (Lua `EVAL`) — the two things the reservation/cutover
machinery actually needs — while everything else scales to zero.

## 12. Scaling-to-zero opportunities & caveats
- **Yes:** backend + web + admin Container Apps (min replicas 0). Cold start is
  acceptable for a training box.
- **Caveat — scheduler:** the C4 compensation `@Cron` (every minute) only fires
  while the backend runs. With scale-to-zero the backend sleeps and crons don't
  fire. For staging that's fine (set `ENABLE_SCHEDULER=false`, or keep backend
  min-replicas=1 during training weeks if the scheduler behavior is being demoed).
- **No:** PostgreSQL (can stop, not zero) and managed Redis (neither).

## 13. Production growth path (no application redesign)
The app is already cloud-portable: reads all config from env vars, binds `0.0.0.0`,
single port, stateless (no local filesystem), real PG+Redis. Growth is pure infra:
- Container Apps: min-replicas 0→1 (kill cold starts) → scale rules → blue/green revisions.
- PostgreSQL: Burstable → General Purpose (D-series) + zone-redundant HA + read
  replicas + private endpoint.
- Redis: Basic C0 → Standard C1 (HA/SLA) → Premium (clustering, persistence, VNet).
- Networking: add VNet + private endpoints + Azure Front Door/WAF (and CDN for
  Jamaica latency).
- Observability: add App Insights SDK instrumentation (code change) when APM is wanted.
None of these change the app's connection-string/env-var contract — same image,
different infra.

---

## 14. Repository gaps blocking Azure deployment — ranked in implementation order
Each item is a prerequisite for the ones below it. All are **additive
packaging/config** — none change application architecture, module structure, or
business logic.

1. **Add `output: 'standalone'` to both `next.config`** (`apps/web`,
   `apps/admin-dashboard`). Prerequisite for lean frontend images; do it first so
   the frontend Dockerfiles in step 2 are trivial. Strongly recommended (a bloated
   image is the alternative, not a hard block).
2. **Author production Dockerfiles + `.dockerignore`** (3 images: backend →
   `node dist/main.js`; web and admin → standalone `next start`). **The #1 hard
   blocker** — nothing containerizes or deploys to Container Apps without these.
3. **Add graceful shutdown to `backend/src/main.ts`** —
   `app.enableShutdownHooks()` + SIGTERM handling. One-line hardening, but land it
   with the backend image (step 2) so scale-to-zero/revision restarts drain
   in-flight requests and close PG/Redis cleanly rather than being hard-killed.
4. **Reconcile `.env.example` with the validated `EnvironmentVariables` contract.**
   Add the missing *required* vars (`APP_BASE_URL`, `CORS_ORIGIN`, `WIPAY_API_URL`,
   `WIPAY_ACCOUNT_NUMBER`); drop the unused (`AWS_*`, `STRIPE_SECRET_KEY`,
   `GOOGLE_MAPS_API_KEY`, `SENTRY_DSN`). Must precede secret/Key-Vault setup so the
   Container Apps env config is correct and complete — otherwise `validateEnv`
   fails the container at boot.
5. **Build the CD workflow** (`develop` → staging, separate from CI). Depends on
   steps 1–2 existing. Subsumes two sub-blockers:
   - **5a.** Pass `NEXT_PUBLIC_*` as **Docker build args** for web/admin (Next
     inlines them at build time, not runtime).
   - **5b.** Run **`prisma migrate deploy` as a pre-deploy Container Apps Job**
     before the new backend revision serves (`start` does not run migrations).
   Then build/push 3 images → `az containerapp update`, via an Azure OIDC
   service principal scoped to the staging resource group.
6. **Provision-time config (after approval + credentials): `DATABASE_URL` with
   `sslmode=require`.** Azure PG enforces TLS; Prisma honours it via the connection
   string (no code change). Applies when the staging connection string is set, not
   before — lowest in the order because it's a provisioning input, not a repo change.

---

## 15. Recommended "smallest sensible staging" configuration
- **1** Container Apps Environment (East US 2, public ingress, Log Analytics attached)
- **3** Container Apps: `backend`, `web`, `admin` — all min-replicas 0, managed TLS
- **1** Container Apps Job: `db-migrate` (migrate + seed)
- **PostgreSQL Flexible B1ms**, 32 GB, 7-day PITR, UTF-8, stopped when idle
  (remember: auto-restarts after 7 days; re-stop to stay off)
- **Azure Managed Redis Balanced B0**, single node / non-HA (or containerized Redis
  for the rock-bottom variant). **Not** Azure Cache for Redis (retiring).
- **Key Vault** (secrets via managed identity) + **budget alert at $75/mo**
- **ghcr.io** for images (skip ACR to save $5/mo)
- Custom domain later; free managed certs from day one
- **Expected: ~$18–22/mo idle, ~$42–48/mo training-heavy** (baseline uses Managed
  Redis B0 ~$13.14/mo; verify the regional quote in the Azure Calculator first).

**Prerequisite ordering:** land the §14 blockers (Dockerfiles + CD + env-doc
reconciliation at minimum) **before** provisioning, so the first Azure spend
immediately yields a running environment rather than an idle, unusable resource group.

---

## STOP — awaiting approval
No provisioning performed or attempted. On approval of this design (and once Azure
credentials are supplied), the natural next unit is the **§14 blocker remediation**
(Dockerfiles + CD workflow + env-doc reconciliation) as normal reviewed commits —
still no Azure resources until those exist and you explicitly authorize provisioning.
