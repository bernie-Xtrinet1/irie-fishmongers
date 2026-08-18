# Azure Staging — Tier 1 Foundation (Phase 17E)

**Status: authored for review. NOT deployed.** No Azure login, deployment,
resource creation, or `what-if` has been run against Azure. These files are
Infrastructure-as-Code only.

## Purpose

Create the **smallest** set of Azure resources needed to obtain the three
**authoritative Azure Container Apps FQDNs** that unblock **Gate B2** (building
the staging-specific `web`/`admin` images with real `NEXT_PUBLIC_*` URLs).

The three Container Apps are **hostname-reservation placeholders only**:
external ingress, the public MCR sample image, no Irie Fishmongers image, no
GHCR credentials, no application secrets, and no PostgreSQL/Redis dependency.

## What this template creates

| Resource | Type | Notes |
|---|---|---|
| `rg-iriefishmongers-staging` | `Microsoft.Resources/resourceGroups` | East US 2 (subscription-scoped deployment) |
| `log-irie-staging` | `Microsoft.OperationalInsights/workspaces` | 30-day retention, 0.5 GB/day cap |
| `cae-irie-staging` | `Microsoft.App/managedEnvironments` | Consumption; logs → workspace |
| `ca-irie-backend` | `Microsoft.App/containerApps` | placeholder, ingress `:80`, scale 0→1 (future app port 3001) |
| `ca-irie-web` | `Microsoft.App/containerApps` | placeholder, ingress `:80`, scale 0→1 (future app port 3000) |
| `ca-irie-admin` | `Microsoft.App/containerApps` | placeholder, ingress `:80`, scale 0→1 (future app port 3002) |
| `budget-irie-staging` | `Microsoft.Consumption/budgets` | $75/mo, alerts RG Owners by role |

### Resource graph

```
subscription
└─ rg-iriefishmongers-staging (main.bicep)
   └─ modules/foundation.bicep
      ├─ log-irie-staging   (Log Analytics)
      ├─ cae-irie-staging   (Container Apps environment) ── logs ──▶ log-irie-staging
      ├─ ca-irie-backend    (modules/containerApp.bicep, ingress :80) ──▶ cae-irie-staging
      ├─ ca-irie-web        (modules/containerApp.bicep, ingress :80) ──▶ cae-irie-staging
      ├─ ca-irie-admin      (modules/containerApp.bicep, ingress :80) ──▶ cae-irie-staging
      └─ budget-irie-staging (Consumption budget)
```

## Files

- `main.bicep` — subscription-scoped; creates the RG and calls the foundation module.
- `modules/foundation.bicep` — RG-scoped; Log Analytics, Container Apps env, 3 apps, budget.
- `modules/containerApp.bicep` — one placeholder app (reused 3×); outputs its FQDN.
- `staging.bicepparam` — non-secret parameter values.

## Design notes

- **Placeholder image `mcr.microsoft.com/k8se/quickstart:latest`** — public,
  credential-free, no app code/secrets.
- **Ingress `targetPort` is `80`** — it matches the port the placeholder image
  actually listens on, so the Tier-1 ingress configuration is internally
  consistent (Azure Container Apps expects `targetPort` to equal the running
  container's port).
- **The real application ports (`3001`/`3000`/`3002`) are Tier-3 metadata only** —
  carried as the `futureAppPort` parameter/tag on each app and surfaced in the
  `futureAppPorts` output. They are **not** used by the Tier-1 placeholder ingress.
- **Scale to zero (`minReplicas: 0`)** — the placeholder incurs ~$0 at idle.
- **No health probes** are defined, so nothing depends on `/api/v1/health` or any
  application-specific path.

### Placeholder → real-app lifecycle

1. **Tier 1:** deploy the placeholder image with ingress `targetPort: 80`
   (matching the placeholder's own port).
2. Read the outputs to obtain the **authoritative app FQDNs**.
3. **Gate B2:** build the staging `web`/`admin` images using those FQDNs
   (`STAGING_NEXT_PUBLIC_*`).
4. **Tier 3:** replace each placeholder with the real image **and** update the
   ingress `targetPort` to `3001` (backend) / `3000` (web) / `3002` (admin),
   adding application-specific probes/config. The **app-level FQDN is retained**
   across the image and port change.
- **No secrets in source.** The Log Analytics shared key is read at deploy time
  via `listKeys()`; it never appears in the template text.
- **Budget without notification infrastructure.** The alert uses `contactRoles:
  ['Owner']` so it can exist without an email address or an Action Group. Add
  real recipients later via `budgetContactEmails`.

## Parameters requiring operator values

All parameters have safe defaults. The only values an operator must supply **at
deploy time** are the **target subscription** and the **deployment metadata
location** (the `--location` for `az deployment sub create`). Optional:
`budgetContactEmails` (email delivery), otherwise the alert notifies RG Owners.

## Outputs (authoritative FQDNs → Gate B2)

Derived from Azure resource properties at deploy time (never fabricated here):

| Output | Feeds |
|---|---|
| `backendApiUrl` = `https://<backend-fqdn>/api/v1` | `STAGING_NEXT_PUBLIC_API_URL` |
| `adminUrl` = `https://<admin-fqdn>` | `STAGING_NEXT_PUBLIC_APP_URL` |
| `backendFqdn` / `webFqdn` / `adminFqdn` | raw hostnames |
| `backendUrl` / `webUrl` | derived HTTPS URLs |

`STAGING_NEXT_PUBLIC_ENVIRONMENT` = `staging` (known now; not an Azure value).

## Explicitly NOT included (deferred to a separately-authorized Tier 3)

PostgreSQL, Azure Managed Redis, Key Vault, runtime managed identity, GHCR
registry credentials, the H1/H3 registry decision, ACR, GitHub OIDC identity /
federated credential / RBAC, custom DNS, application images, migrations, and
`deploy-staging.yml`.

### Recorded Tier-3 security tradeoff (design note, NOT authorized here)

The provisional Tier-3 PostgreSQL model (public access + "Allow Azure services"
+ TLS + Key-Vault credentials) has a **broad Azure-origin network reach**,
mitigated by TLS and credentials. It is acceptable **only if separately approved
for staging / non-production data**, and is **not** implemented by this IaC.

## Deploying — LATER, only after separate authorization

> Do not run these now. Provisioning is a separate, explicit authorization.

```bash
# validate only (no Azure changes):
az bicep build --file main.bicep
az deployment sub what-if --location eastus2 \
  --template-file main.bicep --parameters staging.bicepparam

# provision (SEPARATELY AUTHORIZED ONLY):
az deployment sub create --location eastus2 \
  --template-file main.bicep --parameters staging.bicepparam
```

After a successful deployment, read the `backendApiUrl` and `adminUrl` outputs
and set the corresponding public GitHub repository variables to unblock Gate B2.
