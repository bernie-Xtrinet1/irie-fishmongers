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

echo "== 2b. Docker Compose has no frontend NEXT_PUBLIC_* assignments =="
# A NEXT_PUBLIC_* assigned in the container environment takes precedence over
# .env.local and gets inlined into the bundle - the override bug. Match only real
# YAML assignments ('  KEY:'), so the explanatory comment in the compose file
# does not trip this check.
COMPOSE=.devcontainer/docker-compose.yml
PUB_ASSIGN='^[[:space:]]+(NEXT_PUBLIC_API_URL|NEXT_PUBLIC_ENVIRONMENT|NEXT_PUBLIC_APP_URL):'
if [[ -f "$COMPOSE" ]]; then
  if grep -qE "$PUB_ASSIGN" "$COMPOSE"; then
    bad "$COMPOSE assigns a frontend NEXT_PUBLIC_* (overrides .env.local in-container) - remove it and REBUILD the container:"
    grep -nE "$PUB_ASSIGN" "$COMPOSE" | sed 's/^/          /'
  else
    ok "no frontend NEXT_PUBLIC_* assignments in $COMPOSE"
  fi
else
  note "$COMPOSE not found - skipping compose override check"
fi

echo "== 3. Generated .env.local (customer + admin) =="
ENVFILE=apps/admin-dashboard/.env.local
WEBENV=apps/web/.env.local
if [[ -f "$ENVFILE" ]]; then
  cat "$ENVFILE" | sed 's/^/    admin  /'
  API_URL="$(grep -h '^NEXT_PUBLIC_API_URL=' "$ENVFILE" | cut -d= -f2-)"
  ADMIN_URL="$(grep -h '^NEXT_PUBLIC_APP_URL=' "$ENVFILE" | cut -d= -f2-)"
  [[ "$API_URL" == *localhost:3001* ]] && bad "admin NEXT_PUBLIC_API_URL still points at localhost:3001" || ok "admin API URL is not localhost"
  [[ "$API_URL" == *"..."* ]] && bad "admin NEXT_PUBLIC_API_URL contains a literal '...'" || ok "no placeholder in admin API URL"
else
  bad "$ENVFILE does not exist - run scripts/start-codespaces-demo.sh first"
  API_URL=""; ADMIN_URL=""
fi
if [[ -f "$WEBENV" ]]; then
  cat "$WEBENV" | sed 's/^/    web    /'
  WEB_API_URL="$(grep -h '^NEXT_PUBLIC_API_URL=' "$WEBENV" | cut -d= -f2-)"
  WEB_ORIGIN="$(echo "$WEB_API_URL" | sed -E 's#(https?://[^/]+).*#\1#')"
  [[ "$WEB_API_URL" == *localhost:3001* ]] && bad "customer NEXT_PUBLIC_API_URL still points at localhost:3001 (the catalog fetch will fail)" || ok "customer API URL is not localhost"
else
  bad "$WEBENV does not exist - the storefront catalog fetch has no API URL"
  WEB_ORIGIN=""
fi

echo "== 4. Live health (localhost is correct INSIDE the Codespace) =="
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || echo 000; }
[[ "$(code http://localhost:3001/api/v1/health)" == "200" ]] && ok "API /health 200" || bad "API /health not 200"
c3002="$(code http://localhost:3002/login)"; [[ "$c3002" =~ ^(200|3..)$ ]] && ok "admin /login $c3002" || bad "admin /login $c3002"
c3000="$(code http://localhost:3000)";       [[ "$c3000" =~ ^(200|3..)$ ]] && ok "storefront / $c3000" || bad "storefront / $c3000"

echo "== 5a. Public catalog GET /products (what the storefront calls) =="
prod_code="$(code 'http://localhost:3001/api/v1/products?pageSize=1')"
if [[ "$prod_code" == "200" ]]; then
  n="$(curl -s --max-time 5 'http://localhost:3001/api/v1/products' | grep -o '"id"' | wc -l | tr -d ' ')"
  ok "GET /products 200 (public, no auth) - ~$n items"
else
  bad "GET /products returned $prod_code (expected 200) - the catalog endpoint itself is the problem"
fi

if [[ "${API_URL:-}" == /* ]]; then
  echo "== 5b. Same-origin proxy path (the browser calls the app's own origin) =="
  # In Codespaces the frontends call /api/v1 on THEIR own origin and Next
  # forwards to the backend server-side - so the decisive check is that the
  # storefront's own port serves the catalog through the proxy.
  wc="$(code 'http://localhost:3000/api/v1/products?pageSize=1')"
  [[ "$wc" == "200" ]] && ok "storefront proxy GET :3000/api/v1/products 200 (no cross-origin needed)" || bad "storefront proxy returned $wc - check API_PROXY_TARGET in apps/web/.env.local + rewrites"
  ac="$(code 'http://localhost:3002/api/v1/health')"
  [[ "$ac" == "200" ]] && ok "admin proxy GET :3002/api/v1/health 200" || bad "admin proxy returned $ac"
  note "same-origin proxy means NO cross-port GitHub interstitial / CORS in the browser - just set 3000/3001/3002 Public and refresh"
else
  echo "== 5b. CORS allow-origin for BOTH the customer and admin origins =="
  check_cors() { curl -s -D - -o /dev/null --max-time 5 -H "Origin: $1" http://localhost:3001/api/v1/products 2>/dev/null | grep -i '^access-control-allow-origin:' | tr -d '\r'; }
  [[ -n "${WEB_ORIGIN:-}" ]] && { a="$(check_cors "$WEB_ORIGIN")"; [[ "$a" == *"$WEB_ORIGIN"* ]] && ok "customer origin allowed ($a)" || bad "customer origin NOT allowed (got: '${a:-none}')"; }
  [[ -n "${ADMIN_URL:-}" ]] && { a="$(check_cors "$ADMIN_URL")"; [[ "$a" == *"$ADMIN_URL"* ]] && ok "admin origin allowed ($a)" || bad "admin origin NOT allowed (got: '${a:-none}')"; }
fi

echo "== 5c. Seeded product images load through the Next optimizer =="
# Regression guard for the broken-images bug: next/image rejects SVG with HTTP
# 400 ("image type is not allowed"), so seeded product images must be raster.
# Pull the first product's imageUrl from the live catalog, run it through the
# storefront's /_next/image optimizer, and require 200. node (present in the
# devcontainer image) does the JSON parse + URL-encode - no python dependency.
FIRST_IMG="$(curl -s --max-time 5 'http://localhost:3001/api/v1/products?page=1&pageSize=1' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).data?.items?.[0]?.imageUrl||"")}catch{process.stdout.write("")}})' 2>/dev/null || true)"
if [[ -z "$FIRST_IMG" ]]; then
  note "no product imageUrl in the catalog - skipping optimizer check (seed data?)"
else
  # Works for both a local path (/demo-products/x.png) and an absolute URL -
  # /_next/image takes either in its url param.
  ENC="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$FIRST_IMG" 2>/dev/null || true)"
  img_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://localhost:3000/_next/image?url=${ENC}&w=640&q=75" 2>/dev/null || echo 000)"
  if [[ "$img_code" == "200" ]]; then
    ok "storefront optimizer served the seeded image 200 ($FIRST_IMG)"
  else
    bad "storefront optimizer returned $img_code for '$FIRST_IMG' - product images are broken (SVG rejected by next/image, missing local file, or unreachable remote host)"
  fi
fi

echo "== 6. No forbidden localhost API URL in the executable client bundles =="
# The frontends must reach the API via the same-origin proxy ("/api/v1"); the
# literal backend host must NEVER be compiled into a client chunk. If it is, a
# shell/container NEXT_PUBLIC_API_URL is overriding .env.local (see
# .devcontainer/README.md) - and clearing .next will NOT fix it. Scan executable
# JS only (*.js, not .map source maps). An empty .next/static just means next dev
# has not compiled a page yet - open each app once, then re-run.
FORBIDDEN='localhost:3001'
scan_bundle() {
  local app="$1" dir="apps/$1/.next/static"
  if [[ ! -d "$dir" ]]; then
    note "$app: $dir not built yet - open the app once so next dev compiles a page, then re-run"
    return
  fi
  local hit
  hit="$(grep -rl --include='*.js' "$FORBIDDEN" "$dir" 2>/dev/null | head -1)"
  if [[ -n "$hit" ]]; then
    bad "$app: forbidden '$FORBIDDEN' compiled into a client bundle ($hit) - a shell/container NEXT_PUBLIC_API_URL is overriding .env.local; remove it from .devcontainer/docker-compose.yml and REBUILD the container (clearing .next alone will not fix it)"
  else
    ok "$app: no '$FORBIDDEN' in executable client chunks"
  fi
}
scan_bundle web
scan_bundle admin-dashboard

echo ""
if [[ "$fail" == "0" ]]; then
  echo "RESULT: all hard checks passed. In the browser, set ports 3000/3001/3002 to Public,"
  echo "        hard-refresh, and confirm the login POST hits ${API_URL:-the forwarded API} (not localhost)."
else
  echo "RESULT: one or more checks FAILED (see FAIL lines above)."
fi
exit "$fail"
