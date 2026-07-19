#!/usr/bin/env bash
# spec/independence/03 §3 — the one command the guide ever shows for "what's
# going on". Forwards any extra args straight to `docker compose logs` (e.g.
# `logs.sh wixy`, `logs.sh -f`, `logs.sh --tail 50 cloudflared`).
set -euo pipefail

INSTALL_ROOT="${WIXY_INSTALL_ROOT:-/opt/wixy}"
COMPOSE_DIR="${WIXY_COMPOSE_DIR:-$INSTALL_ROOT/engine/deploy/standalone}"
ENV_FILE="$INSTALL_ROOT/.env"

cd "$COMPOSE_DIR"

if [ "$#" -eq 0 ]; then
  exec docker compose --env-file "$ENV_FILE" logs -f --tail 200
fi
exec docker compose --env-file "$ENV_FILE" logs "$@"
