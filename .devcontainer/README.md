# Irie Fishmongers — one-click demo (GitHub Codespaces / devcontainer)

A disposable, self-contained demonstration of the **v1.0.0-rc.1** release
candidate: NestJS API + PostgreSQL 16 + Redis 7 + the customer storefront and
admin dashboard, pre-seeded with demo accounts and showcase data.

> **Demo only — not UAT, not production.** Structured UAT runs on Azure with
> stable URLs, persistent services, backups, and monitoring (Phase 17). This
> Codespace is a quick preview/demo bridge.

## One-click startup

1. On GitHub: **Code → Codespaces → Create codespace** on this branch (or
   `develop`/`main` once merged). Locally: *Dev Containers: Reopen in Container*
   in VS Code.
2. Wait for the container to build. `postCreate` (see `setup.sh`) automatically:
   installs dependencies → generates the Prisma client → applies migrations →
   seeds reference data → seeds demo accounts.
3. On attach, `start.sh` launches all three apps (`npm run dev`) in the
   background and prints the URLs + logins. If you need to start them by hand:
   ```bash
   npm run dev
   ```

## Expected URLs

Open these from the **Ports** tab (forwarded ports are **private by default** —
only you can reach them unless you change visibility):

| App | Port | Notes |
|---|---|---|
| Customer Storefront | **3000** | opens a preview automatically |
| Backend API | **3001** | base `/api/v1`; Swagger at `/api/v1/docs` |
| Admin Dashboard | **3002** | log in with the admin account below |

**Browser vs. VS Code Desktop:** in a browser Codespace the apps are served at
forwarded `https://<name>-<port>.app.github.dev` URLs, so `start.sh` detects the
Codespace and automatically points the storefront's API calls (`NEXT_PUBLIC_API_URL`)
and the API's CORS allow-list at those URLs. In VS Code Desktop, `localhost`
forwarding is transparent and nothing is rewritten. If the storefront can't reach
the API in a **browser** Codespace, set port **3001** (and **3002**) to **Public**
in the Ports tab — cross-origin calls to a private forwarded port can be blocked.

## Demo logins

All accounts use the password **`DemoPass!23`** (demonstration only):

| Role | Email |
|---|---|
| Administrator | `admin@demo.iriefishmongers.test` |
| Vendor | `vendor@demo.iriefishmongers.test` |
| Customer | `customer@demo.iriefishmongers.test` |
| Driver | `driver@demo.iriefishmongers.test` |

The vendor is **approved** with three products; the driver is **approved and
online**. Place an order as the customer, accept/prepare it as the vendor,
assign and deliver as the driver, and moderate/administer as the admin.

## Disabled external services (safe demo)

Live integrations are **off** so nothing real is sent or charged:

- **Email (SendGrid)** and **Push (FCM)** — configured with intentionally
  invalid demo keys, so the providers reject any attempt; **in-app**
  notifications work fully (they are database-backed).
- **WiPay online payments** — placeholder credentials; use **Cash On Delivery**,
  which needs no external call, for the demo checkout.

No real secrets are committed — the values in `docker-compose.yml` are throwaway
demo strings for an ephemeral container.

## Reset the demo data

The demo seed is idempotent (re-running tops the accounts back up). For a full
reset (drop, re-migrate, re-seed reference + demo):

```bash
cd backend
npx prisma migrate reset --force   # drops, re-applies migrations, runs the reference seed
npm run demo:seed                  # re-creates demo accounts + showcase data
```

## Stop / restart

- **Stop apps:** `kill "$(cat /tmp/irie-dev.pid)"` (or close the Codespace).
- **Restart apps:** `npm run dev` (or re-run `bash .devcontainer/start.sh`).
- **Stop the whole Codespace:** GitHub **Codespaces → … → Stop** (keeps the
  volume so data persists on restart).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Storefront/admin can't reach the API | Confirm port **3001** is forwarded and the API is up: `curl localhost:3001/api/v1/health`. Check `tail -f /tmp/irie-dev.log`. |
| `Environment validation failed` on API start | The container env is set in `docker-compose.yml`; rebuild the container (*Dev Containers: Rebuild Container*). |
| Prisma "Environment variable not found: DATABASE_URL" | Same as above — env comes from the compose `app` service; rebuild. |
| Migrations didn't run / empty DB | Re-run `bash .devcontainer/setup.sh`. |
| Login fails | Re-seed: `npm run demo:seed -w backend`. Password is `DemoPass!23`. |
| Ports not appearing | Start the apps: `npm run dev`; ports forward once each server binds. |

## Cost & usage notes

- GitHub Codespaces bills **compute per hour** and **storage per month**; free
  monthly quotas exist on personal accounts. A 2-core machine is sufficient here.
- **Stop the Codespace when idle** — it keeps billing compute while running.
- Codespaces **auto-suspend** after an inactivity window, but stopping it
  manually is the reliable way to avoid charges.
- **Delete** the Codespace when the demo is over to release storage.
- This environment is ephemeral: don't put real data or real credentials in it.
