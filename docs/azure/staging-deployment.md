# Azure Staging Deployment — `deploy-staging.yml` (Phase 17F)

Deploys a specific commit's already-published GHCR images to the existing
Azure staging Container Apps, **by immutable digest**, over the committed
GHCR-direct architecture. It provisions nothing and introduces no Azure
Container Registry.

```
GitHub Actions ──OIDC──▶ Azure
     │
     └─ ghcr.io/bernie-xtrinet1/irie-fishmongers/<svc>:<sha>
             └─▶ resolve to <svc>@sha256:<digest>   (immutable)
                     └─▶ az containerapp {job,} update --image <digest>
                             └─▶ Azure Container Apps pull from GHCR
                                 via the `ghcr-pat` Key Vault secret
```

> **Registry decision.** Per `docs/uat/phase-17a-azure-staging-architecture.md`
> (line 370, "ghcr.io for images — skip ACR") and the Tier-3 Bicep, staging pulls
> **directly from GHCR**. A live `acririefishmongersstaging` ACR exists in the
> subscription but is **not** part of the repository IaC; it is treated as
> out-of-band drift to reconcile separately and is intentionally unused here.

## What the workflow does (stages)

1. **Validate input** — require a hex commit SHA; reject empty/`latest`.
2. **Resolve digests** — verify all four GHCR images (`backend`, `migrator`,
   `web`, `admin`) exist for the SHA and resolve each to `@sha256:<digest>`.
3. **Azure OIDC login** — no client secret.
4. **Verify Azure resources** — `group`, three Container Apps, migrator Job exist (read-only).
5. **Verify GHCR registry auth** — each app has a `ghcr.io` registry configured
   (the `ghcr-pat` Key Vault secret from Bicep); the PAT is never read or printed.
6. **Frontend build-URL guard** — `STAGING_NEXT_PUBLIC_API_URL` must equal
   `https://<backend-fqdn>`; otherwise **stop** (the images were baked with the
   wrong API URL and must be rebuilt — a runtime env var cannot fix it).
7. **Capture rollback state** — record each app's current image + revision.
8. **Migration gate** — `az containerapp job update/start` on the migrator digest
   (`prisma migrate deploy`); require `Succeeded` before any app changes.
9. **Deploy backend** → gate on `GET /api/v1/health` (200 ⇒ backend + PostgreSQL + Redis OK).
10. **Deploy web** (only if backend healthy) → verify real app, no `localhost`.
11. **Deploy admin** → verify `/login`, no `localhost`.
12. **Summary** — deployed digests + rollback commands.

Fail-closed: if migration or backend health fails, **web/admin are not touched**.

## Required GitHub `staging` environment configuration

Configure under **Settings → Environments → `staging`**.

### Variables (non-secret)
| Variable | Value | Purpose |
|---|---|---|
| `AZURE_CLIENT_ID` | app registration client id | OIDC login |
| `AZURE_TENANT_ID` | tenant id | OIDC login |
| `AZURE_SUBSCRIPTION_ID` | subscription id | OIDC login |
| `AZURE_RESOURCE_GROUP` | `rg-iriefishmongers-staging` | target RG *(has a default)* |
| `AZURE_BACKEND_APP` | `ca-irie-backend` | *(default)* |
| `AZURE_WEB_APP` | `ca-irie-web` | *(default)* |
| `AZURE_ADMIN_APP` | `ca-irie-admin` | *(default)* |
| `AZURE_MIGRATOR_JOB` | `ca-irie-db-migrate` | *(default)* |
| `IMAGE_NAMESPACE` | `ghcr.io/bernie-xtrinet1/irie-fishmongers` | *(default)* |
| `STAGING_NEXT_PUBLIC_API_URL` | `https://<backend-fqdn>` | build-URL guard; also consumed by `build-images.yml` |

### Secrets
| Secret | When needed |
|---|---|
| `GHCR_READ_PAT` | **Optional.** Only if the default `GITHUB_TOKEN` cannot read the GHCR packages (e.g. cross-owner). Scope: `read:packages`. Never written to Azure or logs. |

No Azure client secret, PostgreSQL password, Redis key, or ACR credential is used
by this workflow — those live only in Key Vault / Azure.

## One-time Azure setup the operator must perform (not done by this repo)

These are **identity/RBAC changes** — run them with an authorised account; the
repo does not and cannot execute them here.

1. **OIDC federated credential** restricted to this repo's `staging` environment:
   ```bash
   az ad app federated-credential create --id <APP_OBJECT_ID> --parameters '{
     "name": "gh-staging",
     "issuer": "https://token.actions.githubusercontent.com",
     "subject": "repo:bernie-Xtrinet1/irie-fishmongers:environment:staging",
     "audiences": ["api://AzureADTokenExchange"]
   }'
   ```
2. **Least-privilege RBAC** for the deployer identity on the RG (update apps + run
   the job). Simplest: `Contributor` scoped to the RG; preferred: a custom role
   limited to `Microsoft.App/containerApps/write`, `Microsoft.App/jobs/write`,
   `Microsoft.App/jobs/start/action`, plus read.
   ```bash
   az role assignment create --assignee <AZURE_CLIENT_ID> \
     --role Contributor \
     --scope /subscriptions/<SUB>/resourceGroups/rg-iriefishmongers-staging
   ```
3. **Tier-3 Bicep applied** (`infrastructure/azure/tier3/`): Pass 1 (KV, identity,
   PostgreSQL, Redis) and Pass 2 (the three apps + migrator Job configured with
   the `ghcr-pat` registry credential and Key Vault secret refs). The workflow
   **verifies** this and fails clearly if absent — it never provisions it.
4. **Key Vault secrets set** — the 11 secrets (incl. `firebase-project-id`,
   `firebase-client-email`, `firebase-private-key`, and `ghcr-pat` = a GHCR
   `read:packages` PAT). See `infrastructure/azure/tier3/README.md`.
5. **Frontend images built for staging** — run `build-images.yml` for the SHA with
   `include_frontend=true`, and ensure `STAGING_NEXT_PUBLIC_API_URL` = the backend
   FQDN **before** that build (it is compiled into the bundle).

## Operator run procedure

1. Publish images for the target commit: run **`build-images.yml`** (`include_frontend=true`).
2. Run **`deploy-staging.yml`** with `image_tag = <that commit SHA>`.
3. The workflow migrates, then deploys backend → web → admin, gating on health.
4. Post-deploy manual re-check (optional):
   ```bash
   AZURE_BACKEND_APP=ca-irie-backend AZURE_WEB_APP=ca-irie-web AZURE_ADMIN_APP=ca-irie-admin \
     bash scripts/verify-azure-staging.sh all rg-iriefishmongers-staging
   ```

## Rollback

Container Apps run in **single-revision** mode; rollback = re-point the app to the
previously deployed image (captured in the run's *Rollback state* summary):

```bash
az containerapp update -n ca-irie-backend -g rg-iriefishmongers-staging --image <previous-backend-image>
az containerapp update -n ca-irie-web     -g rg-iriefishmongers-staging --image <previous-web-image>
az containerapp update -n ca-irie-admin   -g rg-iriefishmongers-staging --image <previous-admin-image>
```

The migrator runs **forward-only** (`prisma migrate deploy`); it never resets or
drops data. A schema rollback is **not** automated — restore from a PostgreSQL
backup if ever required. Prior healthy revisions are not deleted by this workflow.

## Security posture
- GitHub→Azure auth is **OIDC only** (no client secret in the repo).
- No PostgreSQL/Redis/ACR credential and no GHCR PAT is committed; the GHCR read
  token stays inside the runner and is never persisted to Azure or logs.
- Container Apps pull from GHCR using the **`ghcr-pat` Key Vault secret** (Bicep),
  resolved by the user-assigned identity `id-irie-staging-runtime`.
