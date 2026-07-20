#!/usr/bin/env bash
# spec/independence/03 §3 — the ONE script the guide (07) ever has her paste,
# fetched as a one-liner (long-script pastes are flaky in DO's web console):
#
#   curl -fsSL https://raw.githubusercontent.com/<her-org>/wixy-engine/main/deploy/standalone/setup.sh \
#     | WIXY_ENGINE_REPO=https://github.com/<her-org>/wixy-engine.git bash
#
# WIXY_ENGINE_REPO MUST be set to HER fork for a real deployment — the default
# below (upstream) exists only so this script is runnable standalone for the
# drill (milestone 9) and local testing. Idempotent: safe to re-run (skips an
# already-generated key, overwrites .env/the systemd unit with current answers).
set -euo pipefail
# Birth-restrictive perms: every file this script creates (.env, keys/*) is
# secret-bearing. The explicit chmod 600/700 calls below are belt-and-braces;
# this closes the whole class of "briefly world/group-readable between write
# and chmod" windows in one line, for every write this script makes.
umask 077

WIXY_ENGINE_REPO="${WIXY_ENGINE_REPO:-https://github.com/joshcomley/wixy.git}"
WIXY_ENGINE_BRANCH="${WIXY_ENGINE_BRANCH:-main}"
INSTALL_ROOT="${WIXY_INSTALL_ROOT:-/opt/wixy}"
KEYS_DIR="$INSTALL_ROOT/keys"
ENV_FILE="$INSTALL_ROOT/.env"
CHECKOUT_DIR="$INSTALL_ROOT/engine"
COMPOSE_DIR="$CHECKOUT_DIR/deploy/standalone"

log() { printf '\n==> %s\n' "$1"; }

ask() {
  # $1=prompt $2=varname $3=default(optional)
  local prompt="$1" varname="$2" default="${3:-}" value
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " value
    value="${value:-$default}"
  else
    read -r -p "$prompt: " value
  fi
  printf -v "$varname" '%s' "$value"
}

ask_secret() {
  local prompt="$1" varname="$2" value
  read -r -s -p "$prompt: " value
  printf '\n'
  printf -v "$varname" '%s' "$value"
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "setup.sh must run as root (sudo) — it writes $INSTALL_ROOT (root, 0600)." >&2
    exit 1
  fi
}

install_docker_if_missing() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker already present."
    return
  fi
  log "Docker not found — installing (the DigitalOcean 'Docker on Ubuntu' marketplace image ships it already; this is a fallback for a plain Ubuntu droplet)."
  curl -fsSL https://get.docker.com | sh
}

clone_or_update_engine() {
  log "Fetching the engine (${WIXY_ENGINE_REPO}@${WIXY_ENGINE_BRANCH}) for the compose files..."
  if [ -d "$CHECKOUT_DIR/.git" ]; then
    git -c credential.helper= -C "$CHECKOUT_DIR" fetch origin "$WIXY_ENGINE_BRANCH"
    git -c credential.helper= -C "$CHECKOUT_DIR" reset --hard "origin/$WIXY_ENGINE_BRANCH"
  else
    rm -rf "$CHECKOUT_DIR"
    git -c credential.helper= clone --branch "$WIXY_ENGINE_BRANCH" --depth 1 \
      "$WIXY_ENGINE_REPO" "$CHECKOUT_DIR"
  fi
}

generate_deploy_key() {
  # $1 = key name (file under KEYS_DIR)
  local name="$1" key_path="$KEYS_DIR/$name"
  if [ -f "$key_path" ]; then
    log "$name deploy key already exists at $key_path — skipping (idempotent)."
    return
  fi
  log "Generating the $name deploy key..."
  ssh-keygen -t ed25519 -f "$key_path" -N "" -C "wixy-$name" -q
  chmod 600 "$key_path" "$key_path.pub"
}

print_deploy_key_step() {
  # $1 = key name $2 = human label $3 = repo settings URL (https, no .git)
  local name="$1" label="$2" repo_url="$3" key_path="$KEYS_DIR/$name"
  echo
  echo "----------------------------------------------------------------------"
  echo "  Paste this PUBLIC key as a deploy key (tick 'Allow write access') on $label:"
  echo "  ${repo_url}/settings/keys/new"
  echo "----------------------------------------------------------------------"
  cat "$key_path.pub"
  echo "----------------------------------------------------------------------"
  read -r -p "Press Enter once you've pasted it and saved it there... " _
}

https_settings_url_from_ssh() {
  # git@github.com:org/repo.git -> https://github.com/org/repo
  printf '%s' "$1" | sed -E 's#^git@github\.com:#https://github.com/#; s#\.git$##'
}

print_bot_pat_step() {
  # $1 = repo settings URL (https, no .git) — spec/independence/05 §2's
  # "her bot deploy key/PAT" (decisions/00061): a fine-grained PAT, NOT a
  # locally-generated SSH keypair like the site-repo deploy key above, so
  # this is a "go create it on GitHub's website" step rather than a
  # `print_deploy_key_step`-style "paste this public key" one.
  local repo_url="$1"
  echo
  echo "----------------------------------------------------------------------"
  echo "  Your AI assistant needs its own GitHub credential to open pull"
  echo "  requests with the changes it makes. Create a fine-grained personal"
  echo "  access token:"
  echo "  https://github.com/settings/personal-access-tokens/new"
  echo
  echo "  - Repository access: Only select repositories -> your site repo"
  echo "    (${repo_url})"
  echo "  - Permissions: Contents = Read and write, Pull requests = Read and write"
  echo "  - Consider creating this under a separate 'bot' GitHub account first,"
  echo "    so AI-authored pull requests are visually distinct from your own"
  echo "    (optional, but recommended)."
  echo "----------------------------------------------------------------------"
  ask_secret "Paste the token here" WIXY_AI_BOT_PAT
}

print_branch_protection_step() {
  # $1 = human label $2 = repo settings URL (https, no .git) — Fable M6 gate
  # review R2 (decisions/00065): GitHub-ENFORCED branch protection is what
  # turns "agents can only PR, never push to main" from a convention into a
  # guarantee — with this on, even a leaked bot PAT in the agent's own hands
  # cannot push main directly, so the safety claim stops depending on the
  # PAT's secrecy at all. setup.sh can't configure this FOR you: it needs
  # repo-admin access, which the bot PAT deliberately does NOT have (scoped
  # to contents:write + pull_requests:write only, decisions/00061) — same
  # shape as the deploy-key/PAT steps above, a one-time manual GitHub
  # settings page this script pauses for rather than skips.
  local label="$1" repo_url="$2"
  echo
  echo "----------------------------------------------------------------------"
  echo "  Protect ${label}'s main branch, so nothing -- not even a leaked"
  echo "  token -- can ever push straight to it:"
  echo "  ${repo_url}/settings/branches"
  echo
  echo "  - Add a branch protection rule for 'main'"
  echo "  - Require a pull request before merging"
  echo "  - Require status checks to pass before merging"
  echo "  - Do NOT add yourself (or anyone) as a bypass actor"
  echo "----------------------------------------------------------------------"
  read -r -p "Press Enter once you've set this up on $label... " _
}

write_env_file() {
  log "Writing $ENV_FILE (root, 0600)..."
  cat > "$ENV_FILE" <<EOF
WIXY_EDITION=standalone
WIXY_ENV=prod
WIXY_PORT=9380
WIXY_DOMAIN=${WIXY_DOMAIN}
WIXY_INDEXABLE=1
WIXY_SITE_REPO=${WIXY_SITE_REPO}
WIXY_STATE_BACKUP_REPO=${WIXY_STATE_BACKUP_REPO}
WIXY_CF_TEAM_DOMAIN=${WIXY_CF_TEAM_DOMAIN}
WIXY_CF_ACCESS_AUD=${WIXY_CF_ACCESS_AUD}
CF_TUNNEL_TOKEN=${CF_TUNNEL_TOKEN}
WIXY_IMAGE=${WIXY_IMAGE}
WIXY_KEYS_DIR=${KEYS_DIR}
WIXY_AI_BACKEND=anthropic
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
WIXY_AI_BOT_PAT=${WIXY_AI_BOT_PAT}
WIXY_AI_MONTHLY_BUDGET_USD=${WIXY_AI_MONTHLY_BUDGET_USD}
EOF
  chmod 600 "$ENV_FILE"
}

install_systemd_unit() {
  log "Installing the wixy systemd unit..."
  cat > /etc/systemd/system/wixy.service <<EOF
[Unit]
Description=Wixy standalone stack (docker compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$COMPOSE_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/docker compose --env-file $ENV_FILE up -d
ExecStop=/usr/bin/docker compose --env-file $ENV_FILE down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable wixy.service
}

main() {
  require_root
  mkdir -p "$INSTALL_ROOT" "$KEYS_DIR"
  chmod 700 "$INSTALL_ROOT" "$KEYS_DIR"

  install_docker_if_missing
  clone_or_update_engine

  echo
  echo "A few questions — have your password manager open (you'll be told exactly"
  echo "what to save, and as what name, along the way)."
  ask "Your domain (e.g. www.yoursite.co.uk)" WIXY_DOMAIN
  ask "Your site repo's SSH URL (e.g. git@github.com:your-org/your-site.git)" WIXY_SITE_REPO
  ask "Your state-backup repo's SSH URL (e.g. git@github.com:your-org/ca-state-backup.git)" \
    WIXY_STATE_BACKUP_REPO
  ask_secret "Your Cloudflare Tunnel token" CF_TUNNEL_TOKEN
  ask "Your Cloudflare Access team domain (e.g. yourteam.cloudflareaccess.com)" WIXY_CF_TEAM_DOMAIN
  ask "Your Cloudflare Access app's AUD tag (from the Access app you created)" WIXY_CF_ACCESS_AUD
  ask_secret "Your Anthropic API key (console.anthropic.com -> API Keys)" ANTHROPIC_API_KEY
  ask "Monthly AI budget in USD (a friendly cap, not a hard bill — see the guide)" \
    WIXY_AI_MONTHLY_BUDGET_USD "40"
  ask "Container image to run" WIXY_IMAGE "ghcr.io/joshcomley/wixy:latest"

  generate_deploy_key "site-repo"
  print_deploy_key_step "site-repo" "your site repo" "$(https_settings_url_from_ssh "$WIXY_SITE_REPO")"
  print_bot_pat_step "$(https_settings_url_from_ssh "$WIXY_SITE_REPO")"
  print_branch_protection_step "your site repo" "$(https_settings_url_from_ssh "$WIXY_SITE_REPO")"
  print_branch_protection_step "your engine fork" "$(https_settings_url_from_ssh "$WIXY_ENGINE_REPO")"

  # write-scoped to ca-state-backup ONLY (spec/independence/06 §2, M7's
  # FABLE-light gate checklist item) — a separate keypair from the site-repo
  # one above, never reused across repos.
  generate_deploy_key "state-backup"
  print_deploy_key_step "state-backup" "your state-backup repo" \
    "$(https_settings_url_from_ssh "$WIXY_STATE_BACKUP_REPO")"

  write_env_file
  install_systemd_unit

  log "Starting the stack (systemctl start wixy)..."
  systemctl start wixy

  log "Running verify.sh..."
  bash "$COMPOSE_DIR/verify.sh"
}

main "$@"
