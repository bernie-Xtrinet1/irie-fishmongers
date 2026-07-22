#!/usr/bin/env bash
# Starts the API, storefront, and admin dashboard when the Codespace is
# attached (postAttachCommand). Runs `turbo run dev` in the background so the
# terminal stays free; ports 3000/3001/3002 auto-forward once each server binds.
set -euo pipefail

cd "$(dirname "$0")/.."

# In a browser Codespace the apps are reached at forwarded *.app.github.dev
# URLs, not localhost, so the storefront's client-side calls and the API's CORS
# allow-list must use those URLs. In VS Code Desktop (local port forwarding)
# localhost works, so we only rewrite when CODESPACE_NAME is present.
if [[ -n "${CODESPACE_NAME:-}" && -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]]; then
  base() { echo "https://${CODESPACE_NAME}-$1.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"; }
  STORE_URL="$(base 3000)"
  API_URL="$(base 3001)"
  ADMIN_URL="$(base 3002)"
  export NEXT_PUBLIC_API_URL="${API_URL}/api/v1"
  export NEXT_PUBLIC_APP_URL="${ADMIN_URL}"
  export APP_BASE_URL="${API_URL}"
  export CORS_ORIGIN="${STORE_URL},${ADMIN_URL}"
else
  STORE_URL="http://localhost:3000"
  API_URL="http://localhost:3001"
  ADMIN_URL="http://localhost:3002"
fi

LOCK=/tmp/irie-dev.pid
if [[ -f "$LOCK" ]] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
  echo "Dev servers already running (pid $(cat "$LOCK")). Logs: /tmp/irie-dev.log"
else
  echo "Starting dev servers (backend :3001, storefront :3000, admin :3002)…"
  nohup npm run dev >/tmp/irie-dev.log 2>&1 &
  echo $! >"$LOCK"
  echo "Started. Tail logs with:  tail -f /tmp/irie-dev.log"
fi

cat <<BANNER

============================================================
 Irie Fishmongers - demo environment (v1.0.0-rc.1)
------------------------------------------------------------
 URLs (also in the Ports tab; forwarded ports are PRIVATE):
   Customer Storefront : ${STORE_URL}
   Backend API         : ${API_URL}  (/api/v1, Swagger at /api/v1/docs)
   Admin Dashboard     : ${ADMIN_URL}

 Demo logins (password for all:  DemoPass!23):
   Administrator : admin@demo.iriefishmongers.test
   Vendor        : vendor@demo.iriefishmongers.test
   Customer      : customer@demo.iriefishmongers.test
   Driver        : driver@demo.iriefishmongers.test

 Live email/push/WiPay are DISABLED (demo keys). Pay with Cash On Delivery.
 In a BROWSER Codespace, if the storefront cannot reach the API, set port 3001
 (and 3002) to "Public" in the Ports tab. VS Code Desktop needs no change.
 Reset demo data:  cd backend && npx prisma migrate reset --force && npm run demo:seed
============================================================
BANNER
