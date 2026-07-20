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

echo "==> Waiting for PostgreSQL"
for i in $(seq 1 30); do
  if pg_isready -h db -U iriefishmongers >/dev/null 2>&1; then
    echo "    database is ready"
    break
  fi
  sleep 2
done

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
