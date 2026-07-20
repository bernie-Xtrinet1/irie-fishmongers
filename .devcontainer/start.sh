#!/usr/bin/env bash
# Starts the API, storefront, and admin dashboard when the Codespace is
# attached (postAttachCommand). Runs `turbo run dev` in the background so the
# terminal stays free; ports 3000/3001/3002 auto-forward once each server binds.
set -euo pipefail

cd "$(dirname "$0")/.."

LOCK=/tmp/irie-dev.pid
if [[ -f "$LOCK" ]] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
  echo "Dev servers already running (pid $(cat "$LOCK")). Logs: /tmp/irie-dev.log"
else
  echo "Starting dev servers (backend :3001, storefront :3000, admin :3002)…"
  nohup npm run dev >/tmp/irie-dev.log 2>&1 &
  echo $! >"$LOCK"
  echo "Started. Tail logs with:  tail -f /tmp/irie-dev.log"
fi

cat <<'BANNER'

============================================================
 Irie Fishmongers — demo environment (v1.0.0-rc.1)
------------------------------------------------------------
 URLs (see the Ports tab; forwarded ports are PRIVATE):
   Customer Storefront : port 3000
   Backend API         : port 3001  (/api/v1, Swagger at /api/v1/docs)
   Admin Dashboard     : port 3002

 Demo logins (password for all:  DemoPass!23):
   Administrator : admin@demo.iriefishmongers.test
   Vendor        : vendor@demo.iriefishmongers.test
   Customer      : customer@demo.iriefishmongers.test
   Driver        : driver@demo.iriefishmongers.test

 Live email/push/WiPay are DISABLED (demo keys). Pay with Cash On Delivery.
 Reset demo data:  cd backend && npx prisma migrate reset --force && npm run demo:seed
============================================================
BANNER
