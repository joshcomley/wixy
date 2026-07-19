#!/usr/bin/env bash
# spec/independence/03 §3 — healthz, tunnel connected, site clone OK,
# version/edition: one [OK]/[FAIL] line per check, printed even when a check
# fails (never aborts early) so a single run always shows the FULL picture and
# names which guide step to revisit. Runs FROM the droplet, against the
# container — no ports are published (spec's own design), so every app-level
# check goes through `docker compose exec` rather than curling a host port.
set -uo pipefail

INSTALL_ROOT="${WIXY_INSTALL_ROOT:-/opt/wixy}"
COMPOSE_DIR="${WIXY_COMPOSE_DIR:-$INSTALL_ROOT/engine/deploy/standalone}"
ENV_FILE="$INSTALL_ROOT/.env"
# The one project this image ships (projects/ca.json's own slug — the
# independence phase makes repo/domain/indexable overridable per deployment,
# not the slug itself; see wixy_server/registry.py, spec/independence/01 §2.2).
PROJECT_SLUG="ca"
WIXY_PORT="${WIXY_PORT:-9380}"

cd "$COMPOSE_DIR"

pass_count=0
fail_count=0

dc() {
  docker compose --env-file "$ENV_FILE" "$@"
}

check() {
  # $1 = description, $2 = guide-step name shown on failure, $3 = a function
  # name to call (no extra args — each check function closes over the vars
  # above, avoiding the classic "array doesn't survive into bash -c" trap).
  # Retries for ~30s (setup.sh calls this immediately after `systemctl start
  # wixy` — cloudflared's outbound connection and the app's own startup both
  # take a few real seconds, and a single-shot check would spuriously [FAIL]
  # on a perfectly healthy first run).
  local desc="$1" guide_step="$2" fn="$3" attempt
  for attempt in $(seq 1 15); do
    if "$fn" >/tmp/wixy-verify-out 2>&1; then
      printf '[OK]   %s\n' "$desc"
      pass_count=$((pass_count + 1))
      return
    fi
    sleep 2
  done
  printf '[FAIL] %s -- revisit guide step: %s\n' "$desc" "$guide_step"
  sed 's/^/       /' /tmp/wixy-verify-out
  fail_count=$((fail_count + 1))
}

check_services_up() {
  [ -n "$(dc ps --status running -q wixy)" ]
}

check_healthz() {
  dc exec -T wixy curl -fsS "http://127.0.0.1:${WIXY_PORT}/healthz"
}

check_edition() {
  dc exec -T wixy curl -fsS "http://127.0.0.1:${WIXY_PORT}/api/version" \
    | grep -q '"edition":"standalone"'
}

check_site_checkout() {
  dc exec -T wixy test -d "/data/projects/$PROJECT_SLUG/repo/.git"
}

check_tunnel() {
  dc logs --tail 200 cloudflared 2>&1 | grep -qi 'Registered tunnel connection'
}

echo "Wixy standalone -- verify"
echo "========================="

check "docker compose services are up"          "The droplet setup"              check_services_up
check "wixy container responds on /healthz"     "The droplet setup"              check_healthz
check "wixy reports edition=standalone"         "The droplet setup"              check_edition
check "site repo checkout exists"               "Site repo deploy key"           check_site_checkout
check "cloudflared tunnel connected"            "Cloudflare Tunnel + Access"      check_tunnel

echo "========================="
echo "$pass_count passed, $fail_count failed"
if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
