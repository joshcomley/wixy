# `deploy/standalone/` — the portable Docker deployment target

Everything needed to run Wixy anywhere Docker runs, tuned for a small DigitalOcean
droplet. This is the independence-phase standalone edition's home; the fleet's
existing blue/green Slots deploy (`install.py`, `launcher.py`, `deploy.py` at the repo
root) is untouched and lives entirely outside this directory. Full specification:
`spec/independence/03-standalone-deploy.md`.

## Quickstart

On a fresh Ubuntu droplet (or the DigitalOcean "Docker on Ubuntu" marketplace image):

```bash
curl -fsSL https://raw.githubusercontent.com/<your-org>/wixy-engine/main/deploy/standalone/setup.sh \
  | WIXY_ENGINE_REPO=https://github.com/<your-org>/wixy-engine.git bash
```

`WIXY_ENGINE_REPO` must point at **your own fork** — that's what gets cloned and
deployed. Answer the prompts (domain, site repo SSH URL, Cloudflare Tunnel token);
paste each printed deploy-key public key at the GitHub URL it names when asked.
`setup.sh` finishes by running `verify.sh` — every line should read `[OK]`.

## Contents

- **`Dockerfile`** — the single image both editions run. `WIXY_EDITION` (and every
  other edition-specific setting: `WIXY_CONTAINERIZED`, `WIXY_STORAGE_ROOT`,
  `WIXY_PORT`) is deliberately NOT baked in — supplied by `docker-compose.yml` at
  runtime, so this exact image also serves the fleet unchanged
  (`WIXY_EDITION=fleet`, the `wixy_server/settings.py` default). Published to GHCR
  as `ghcr.io/joshcomley/wixy:latest` + `:<sha>` on every `main` merge
  (`.github/workflows/publish-image.yml`), package visibility **public** (the engine
  is MIT — this keeps registry auth off both the droplet and Watchtower).
- **`docker-compose.yml`** — `wixy` (no published ports — `cloudflared` is the only
  path in) + `worker` (the AI backend, milestone 6, spec/independence/05 §2 — same
  image, different `command:`, its own dedicated scratch volume, no site-repo deploy
  key of its own — it authenticates as the bot PAT instead, decisions/00060/00061) +
  `cloudflared` (the tunnel) + `watchtower` (image-pull polling **is** the deploy
  mechanism — no inbound surface, no CI credentials ever reach the droplet).
  `backup` (the nightly state mirror, milestone 7) is added by its own later PR.
  `cloudflared` and `watchtower` are pinned by **image digest**, not `:latest` —
  `watchtower` mounts the Docker socket (root-equivalent on the droplet) and
  `cloudflared` is the sole ingress path, so silently auto-upgrading either on every
  poll would be the one supply-chain hole in an otherwise zero-inbound design.
  **To bump a pinned digest deliberately**: `docker buildx imagetools inspect
  <image>:latest` for the current manifest-list digest (or the registry's own UI),
  update the pin, land it as its own reviewed PR.
- **`setup.sh`** — idempotent. Installs Docker if missing, clones your fork, generates
  the site-repo deploy key pair (printing the public half + the exact GitHub URL to
  paste it at), walks you through creating the AI bot's fine-grained PAT
  (`contents:write` + `pull_requests:write` on your site repo, decisions/00061),
  pauses for you to turn on **branch protection on both your site repo's and your
  engine fork's `main`** (see "GitHub repo protections" below), writes
  `/opt/wixy/.env` + `/opt/wixy/keys/*` (root, 0600), installs a systemd unit, starts
  the stack, runs `verify.sh`.
- **`verify.sh`** — six checks (services up — `wixy` AND `worker` — `/healthz`,
  `/api/version` reports `edition:"standalone"`, the site repo checkout exists on
  disk, the tunnel shows a registered connection in its logs), one `[OK]`/`[FAIL]`
  line each, naming which guide step to revisit on failure. Every check runs through
  `docker compose exec` (no ports are published to curl directly).
- **`update.sh`** — `update.sh` pulls the latest image and recreates the service (the
  same thing Watchtower does automatically every ~5 min, forced instantly).
  `update.sh --rollback` pins the service back to the previous image (the `:rollback`
  tag milestone 4's sync workflow creates before every update) and pauses Watchtower
  so it can't immediately undo the rollback; failing with a clear message if no
  `:rollback` image exists yet (nothing to undo).
- **`logs.sh`** — `docker compose logs`, forwarding any args (`logs.sh -f`,
  `logs.sh cloudflared`).

## GitHub repo protections

`setup.sh` pauses and asks you to turn on **branch protection on `main`** for both
your site repo and your engine fork (require a pull request + a passing status
check, no bypass actors) before it writes `.env`/starts the stack — a one-time
manual GitHub settings step (`<repo>/settings/branches`) it can't do for you (would
need repo-admin access, which the bot PAT deliberately doesn't have). This is what
makes "the AI assistant can only open pull requests, never push to `main` directly"
an actual GitHub-enforced guarantee rather than a convention: with it on, even a
leaked bot PAT in the assistant's own hands cannot push `main` — the safety of this
whole feature stops depending on that token's secrecy at all (Fable M6 gate review
R2, decisions/00065).

## Secrets doctrine

Every secret exists only under `/opt/wixy/` (`.env` + `keys/`, root-owned, mode 0600)
and in the operator's password manager — never committed, never logged. `.env` holds
the tunnel token, `ANTHROPIC_API_KEY` + `WIXY_AI_BOT_PAT` (the `worker` service only
— never reaches `wixy`'s own env, decisions/00061), and every other `WIXY_*` config;
deploy-key PRIVATE halves live as separate files under `keys/` (a multi-line PEM
doesn't fit the `.env` `KEY=VALUE` format) and are mounted read-only into the
container, consumed via `GIT_SSH_COMMAND`. The bot PAT is a plain `.env` value (a
fine-grained PAT is a single token, not a multi-line key); inside the `worker`
container it's popped from the process's own environment the instant it's read
(decisions/00065 R1) so the Agent SDK's spawned CLI child never inherits it, on top
of never touching disk in the clones the worker creates (decisions/00060) — see
`wixy_server/worker/settings.py` and `wixy_server/worker/workspace.py`'s own module
docstrings for the exact mechanism and the residual same-uid `/proc` channel this
does not close.

## CI proof

`.github/workflows/ci.yml`'s `image-boot-proof` job builds this Dockerfile and boots
it twice on every PR + `main` push — once `WIXY_EDITION=standalone`, once
`WIXY_EDITION=fleet` (the same image, proving neither edition broke the other) —
asserting `/healthz` and `/api/version`'s `edition` field both times. The hub has no
Docker (Slots deploys the fleet edition from source); this CI job is the only place
the image itself is ever proven to boot.
