#!/usr/bin/env bash
# spec/independence/03 §3, 04 §3 — "pull + up now" (manually forces the same
# image-pull-and-recreate Watchtower already does automatically every ~5 min)
# and `--rollback` (pins the compose service back to the previous image — the
# answer to "an update broke my site" without Josh). spec/independence/04 §3's
# sync workflow, milestone 4, is what CREATES the `:rollback` tag this script
# consumes; running --rollback before any update has ever landed one fails
# with a clear message, not a confusing docker error.
set -euo pipefail

INSTALL_ROOT="${WIXY_INSTALL_ROOT:-/opt/wixy}"
COMPOSE_DIR="${WIXY_COMPOSE_DIR:-$INSTALL_ROOT/engine/deploy/standalone}"
ENV_FILE="$INSTALL_ROOT/.env"

cd "$COMPOSE_DIR"
dc() { docker compose --env-file "$ENV_FILE" "$@"; }

current_image() {
  grep -E '^WIXY_IMAGE=' "$ENV_FILE" | head -1 | cut -d= -f2-
}

image_base() {
  # ghcr.io/joshcomley/wixy:latest -> ghcr.io/joshcomley/wixy (strip any tag).
  local image
  image="$(current_image)"
  printf '%s' "${image%%:*}"
}

set_image() {
  sed -i.bak "s#^WIXY_IMAGE=.*#WIXY_IMAGE=$1#" "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
}

do_update() {
  echo "Pulling the latest image and recreating the wixy service..."
  # Bring watchtower back too, in case a previous --rollback stopped it.
  dc pull wixy
  dc up -d
  echo "Done. Run verify.sh to confirm the new version is serving."
}

do_rollback() {
  local base rollback_ref
  base="$(image_base)"
  rollback_ref="${base}:rollback"
  echo "Checking for a :rollback image..."
  if ! docker image inspect "$rollback_ref" >/dev/null 2>&1 \
     && ! docker pull "$rollback_ref" >/dev/null 2>&1; then
    echo "No :rollback image found (${rollback_ref}) -- there's nothing to undo yet." >&2
    echo "A :rollback tag is created automatically the first time you use 'Get engine updates.'" >&2
    exit 1
  fi
  echo "Pausing auto-updates (stopping watchtower) so it doesn't immediately undo this..."
  dc stop watchtower
  echo "Pinning wixy to ${rollback_ref}..."
  set_image "$rollback_ref"
  dc up -d --no-deps wixy
  echo "Rolled back to ${rollback_ref}. Run verify.sh to confirm."
  echo "To resume normal updates later, run: update.sh"
}

case "${1:-}" in
  --rollback)
    do_rollback
    ;;
  "")
    do_update
    ;;
  *)
    echo "Usage: update.sh [--rollback]" >&2
    exit 2
    ;;
esac
