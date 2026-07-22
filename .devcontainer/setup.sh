#!/usr/bin/env bash
# One-time setup for the Irie Fishmongers demo Codespace (postCreateCommand).
# Installs deps, generates the Prisma client, applies migrations, and seeds
# reference + demo data. Idempotent enough to re-run safely.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Installing workspace dependencies (npm ci)"
npm ci

echo "==> Generating Prisma client"
npm run prisma:generate -w backend

echo "==> Waiting for PostgreSQL (db:5432)"
# Portable TCP check - the typescript-node image has no postgres client.
# (compose already gates this container on the db healthcheck, so this is fast.)
node -e '
const net = require("net");
const deadline = Date.now() + 60000;
(function attempt() {
  const s = net.connect(5432, "db");
  s.on("connect", () => { s.end(); console.log("    database is ready"); process.exit(0); });
  s.on("error", () => {
    s.destroy();
    if (Date.now() > deadline) { console.error("    timed out waiting for db"); process.exit(1); }
    setTimeout(attempt, 1500);
  });
})();
'

echo "==> Applying database migrations"
npm run prisma:deploy -w backend

echo "==> Seeding reference data (roles, categories, zones, species, thresholds)"
npm run prisma:seed -w backend

echo "==> Seeding demo accounts and showcase data"
npm run demo:seed -w backend

echo ""
echo "============================================================"
echo " Setup complete. Start the apps with:  npm run dev"
echo " (they also start automatically when you attach)"
echo " See .devcontainer/README.md for URLs, logins, and reset."
echo "============================================================"
