#!/usr/bin/env bash
# Phase 17F — Azure staging post-deployment smoke tests.
#
# Pure verification: it never mutates Azure, prints no secrets, and reaches the
# apps only over their public HTTPS ingress. Used both by
# .github/workflows/deploy-staging.yml (per-step subcommands) and by an operator
# manually (`all` resolves the FQDNs via `az`).
#
# Subcommands:
#   health   <backend-health-url>            # 200 => backend + PostgreSQL + Redis OK
#   frontend <frontend-url> <web|admin>      # real app (not Azure placeholder), no localhost
#   all      <resource-group>                # resolve FQDNs via az, run every check
#
# Exit non-zero on the first failed check.
set -euo pipefail

CURL_MAX_ATTEMPTS="${CURL_MAX_ATTEMPTS:-20}"
CURL_SLEEP="${CURL_SLEEP:-15}"

# Azure Container Apps' default placeholder page markers — presence means the
# real image is NOT yet serving.
PLACEHOLDER_MARKERS='Your Azure Container App is live|Welcome to Azure Container Apps|Congratulations on deploying'

log()  { printf '%s\n' "$*"; }
fail() { printf '::error::%s\n' "$*" >&2; exit 1; }

# curl the URL, retrying until it returns the expected HTTP status or attempts
# run out. Echoes the final HTTP code.
wait_for_http() {
  local url="$1" want="$2" attempt=1 code=000
  while [ "$attempt" -le "$CURL_MAX_ATTEMPTS" ]; do
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 20 "$url" || echo 000)"
    if [ "$code" = "$want" ]; then
      echo "$code"; return 0
    fi
    log "  attempt ${attempt}/${CURL_MAX_ATTEMPTS}: ${url} -> HTTP ${code} (want ${want})"
    attempt=$((attempt + 1)); sleep "$CURL_SLEEP"
  done
  echo "$code"; return 1
}

check_health() {
  local url="$1"
  log "Backend health: ${url}"
  local code; code="$(wait_for_http "$url" 200)" \
    || fail "Backend health did not return 200 (last HTTP ${code}). PostgreSQL/Redis may be down or the revision is unhealthy."
  local body; body="$(curl -sk --max-time 20 "$url" || true)"
  case "$body" in
    *'"down"'*) fail "Backend health 200 but a dependency reports down: ${body}" ;;
  esac
  case "$body" in
    *postgres*) : ;;
    *) log "  note: health body did not contain 'postgres' key; accepting on HTTP 200. body=${body}" ;;
  esac
  log "  OK: backend healthy (implies PostgreSQL + Redis reachable)."
}

# Fetch the HTML, then a bounded set of referenced /_next/static JS chunks, and
# assert none contain a development API URL.
check_no_localhost() {
  local base="$1" name="$2" html chunk found=0
  html="$(curl -sk --max-time 20 "$base" || true)"
  case "$html" in
    *localhost:3001*|*'localhost:'*) fail "${name}: served HTML references a localhost API URL (build baked the wrong NEXT_PUBLIC_API_URL — rebuild the image)." ;;
  esac
  # Origin for resolving relative chunk URLs (scheme://host[:port]).
  local origin; origin="$(printf '%s' "$base" | sed -E 's#(https?://[^/]+).*#\1#')"
  local chunks; chunks="$(printf '%s' "$html" | grep -oE '/_next/static/[^"'"'"' ]+\.js' | sort -u | head -12 || true)"
  if [ -z "$chunks" ]; then
    log "  note: no /_next/static chunks referenced in ${name} HTML; localhost check limited to HTML."
    return 0
  fi
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    chunk="$(curl -sk --max-time 20 "${origin}${path}" || true)"
    case "$chunk" in
      *localhost:3001*) fail "${name}: JS chunk ${path} references localhost:3001 — the image was built with a dev API URL. Rebuild with the correct STAGING_NEXT_PUBLIC_API_URL." ;;
      *//localhost*) fail "${name}: JS chunk ${path} references a localhost API URL. Rebuild the image." ;;
    esac
    found=$((found + 1))
  done <<EOF
$chunks
EOF
  log "  OK: ${name} — scanned ${found} JS chunk(s), no localhost/dev API URL found."
}

check_frontend() {
  local url="$1" name="${2:-frontend}"
  log "${name} app: ${url}"
  local code; code="$(wait_for_http "$url" 200)" \
    || fail "${name} did not return 200 (last HTTP ${code})."
  local html; html="$(curl -sk --max-time 20 "$url" || true)"
  if printf '%s' "$html" | grep -Eq "$PLACEHOLDER_MARKERS"; then
    fail "${name} is still serving the Azure Container Apps PLACEHOLDER page, not the Irie Fishmongers app. The image update did not take effect."
  fi
  check_no_localhost "$url" "$name"
  log "  OK: ${name} serves a real application (not the Azure placeholder)."
}

cmd_all() {
  local rg="$1"
  command -v az >/dev/null 2>&1 || fail "'az' CLI not found; 'all' mode needs Azure CLI + an authenticated session."
  local be we ad
  be="$(az containerapp show -n "${AZURE_BACKEND_APP:-ca-irie-backend}" -g "$rg" --only-show-errors --query properties.configuration.ingress.fqdn -o tsv)"
  we="$(az containerapp show -n "${AZURE_WEB_APP:-ca-irie-web}"        -g "$rg" --only-show-errors --query properties.configuration.ingress.fqdn -o tsv)"
  ad="$(az containerapp show -n "${AZURE_ADMIN_APP:-ca-irie-admin}"    -g "$rg" --only-show-errors --query properties.configuration.ingress.fqdn -o tsv)"
  check_health   "https://${be}/api/v1/health"
  check_frontend "https://${we}/"       web
  check_frontend "https://${ad}/login"  admin
  log "All staging smoke tests passed."
}

main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    health)   [ $# -ge 1 ] || fail "usage: $0 health <backend-health-url>"; check_health "$1" ;;
    frontend) [ $# -ge 1 ] || fail "usage: $0 frontend <url> <web|admin>"; check_frontend "$1" "${2:-frontend}" ;;
    all)      [ $# -ge 1 ] || fail "usage: $0 all <resource-group>"; cmd_all "$1" ;;
    *) fail "unknown subcommand '${sub}'. Use: health | frontend | all" ;;
  esac
}

main "$@"
