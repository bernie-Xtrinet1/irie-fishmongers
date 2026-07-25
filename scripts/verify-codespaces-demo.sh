#!/usr/bin/env bash
# Verify the running Codespaces demo end to end: branch, generated env, live
# HTTP health on all three services, a real CORS preflight from the admin
# origin, and whether the compiled admin bundle contains the forwarded API
# host. Read-only - it changes nothing. Run it after
# scripts/start-codespaces-demo.sh. Exit code is non-zero if a hard check fails.
set -uo pipefail

cd "$(dirname "$0")/.."

fail=0
ok()   { echo "  OK   - $*"; }
bad()  { echo "  FAIL - $*"; fail=1; }
note() { echo "  note - $*"; }

echo "== 1. Branch =="
branch="$(git branch --show-current 2>/dev/null || echo '?')"
[[ "$branch" == "develop" || "$branch" == "main" ]] && ok "on $branch" || bad "on '$branch' (expected develop or main)"

echo "== 2. Demo scripts present =="
[[ -f scripts/start-codespaces-demo.sh && -f scripts/stop-codespaces-demo.sh ]] \
  && ok "start/stop scripts present" || bad "start/stop scripts missing - this branch lacks the fixes"

echo "== 3. Generated admin .env.local =="
ENVFILE=apps/admin-dashboard/.env.local
if [[ -f "$ENVFILE" ]]; then
  cat "$ENVFILE" | sed 's/^/    /'
  API_URL="$(grep -h '^NEXT_PUBLIC_API_URL=' "$ENVFILE" | cut -d= -f2-)"
  ADMIN_URL="$(grep -h '^NEXT_PUBLIC_APP_URL=' "$ENVFILE" | cut -d= -f2-)"
  [[ "$API_URL" == *localhost:3001* ]] && bad "NEXT_PUBLIC_API_URL still points at localhost:3001" || ok "API URL is not localhost"
  [[ "$API_URL" == *"..."* ]] && bad "NEXT_PUBLIC_API_URL contains a literal '...'" || ok "no placeholder in API URL"
else
  bad "$ENVFILE does not exist - run scripts/start-codespaces-demo.sh first"
  API_URL=""; ADMIN_URL=""
fi

echo "== 4. Live health (localhost is correct INSIDE the Codespace) =="
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || echo 000; }
[[ "$(code http://localhost:3001/api/v1/health)" == "200" ]] && ok "API /health 200" || bad "API /health not 200"
c3002="$(code http://localhost:3002/login)"; [[ "$c3002" =~ ^(200|3..)$ ]] && ok "admin /login $c3002" || bad "admin /login $c3002"
c3000="$(code http://localhost:3000)";       [[ "$c3000" =~ ^(200|3..)$ ]] && ok "storefront / $c3000" || bad "storefront / $c3000"

echo "== 5. CORS preflight from the admin origin =="
if [[ -n "${ADMIN_URL:-}" ]]; then
  acao="$(curl -s -D - -o /dev/null --max-time 5 -X OPTIONS \
    -H "Origin: ${ADMIN_URL}" \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' \
    http://localhost:3001/api/v1/auth/login 2>/dev/null \
    | grep -i '^access-control-allow-origin:' | tr -d '\r')"
  if [[ "$acao" == *"$ADMIN_URL"* ]]; then ok "preflight allows admin origin ($acao)"; else bad "preflight did not echo the admin origin (got: '${acao:-none}')"; fi
else
  note "skipped - no admin origin resolved"
fi

echo "== 6. Compiled admin bundle uses the forwarded API host =="
# Positive proof (per the runbook): the ACTIVE backend host should appear in
# the compiled client chunks. Grepping for localhost can false-positive on
# source maps, so it is informational only.
if [[ -n "${API_URL:-}" ]]; then
  HOST="$(echo "$API_URL" | sed -E 's#https?://([^/]+).*#\1#')"
  if grep -rlq "$HOST" apps/admin-dashboard/.next/static 2>/dev/null; then
    ok "forwarded host '$HOST' found in the compiled bundle"
  else
    note "'$HOST' not yet in .next/static - next dev compiles on first page load; open the admin URL once, then re-run"
  fi
  grep -rlq "localhost:3001" apps/admin-dashboard/.next/static 2>/dev/null \
    && note "localhost:3001 also present (often a source-map fallback - the browser Network tab is authoritative)" || true
fi

echo ""
if [[ "$fail" == "0" ]]; then
  echo "RESULT: all hard checks passed. In the browser, set ports 3000/3001/3002 to Public,"
  echo "        hard-refresh, and confirm the login POST hits ${API_URL:-the forwarded API} (not localhost)."
else
  echo "RESULT: one or more checks FAILED (see FAIL lines above)."
fi
exit "$fail"
