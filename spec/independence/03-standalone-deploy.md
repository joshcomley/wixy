# 03 — Standalone deploy target (SECURITY-GATED milestone)

`deploy/standalone/` — everything to run Wixy anywhere Docker runs, tuned for the DO
droplet. Same image serves both editions (`WIXY_EDITION`); fleet deploy untouched.

## 1. Image

- `Dockerfile`: `python:3.14-slim`; system deps `git`, `ffmpeg`, `openssh-client`, CA
  certs; **Node LTS** (the Agent SDK worker wraps the Node CLI — 05 §2; one image, two
  services); pip-install the engine (pinned); COPY committed bundles (no node build);
  non-root user; `github.com` pinned into `known_hosts` (SSH-URL repos — 01 §2.2);
  healthcheck `GET /healthz` (its edge-header guard is container-internal-safe).
- **Build args baked at build time**: `WIXY_ENGINE_SHA`, `WIXY_SYNC_BASE` —
  `/api/version` prefers these envs and falls back to git (REQUIRED change: today it
  shells `git rev-parse` and would 500 in a gitless image).
- Publish: GH Action on main merge → `ghcr.io/<owner>/wixy:latest` + `:sha`. Package
  visibility **PUBLIC** (01 §5 d7) — droplet pull and Watchtower need no registry auth.

## 2. Compose stack (`docker-compose.yml`)

- `wixy`: the image; volume `wixy-storage:/data` (**`WIXY_STORAGE_ROOT=/data`** — the
  real setting name); env from `.env` incl. `WIXY_PORT=9380` (settings default is
  8000), `WIXY_ENV=prod`, `WIXY_EDITION=standalone`; **no published ports**.
  Bind mechanism (new work — no bind setting exists today; the host is hardcoded
  loopback): the server binds `0.0.0.0` **only when `WIXY_CONTAINERIZED=1`** (set by
  the compose file); otherwise the loopback hardcode stands.
- `cloudflared`: `tunnel run --token ${CF_TUNNEL_TOKEN}`; routes `www` + apex →
  `http://wixy:9380`.
- `watchtower`: polls GHCR ~5 min, label-scoped to `wixy` — this IS deploy (01 §5 d3).
- `backup` (06). (`worker` for the AI backend arrives in milestone 6 — 05 §2.)

## 3. Scripts (the only commands the guide ever shows)

Fetched as a one-liner (DO web-console paste of long scripts is flaky):
`curl -fsSL https://raw.githubusercontent.com/<org>/wixy-engine/main/deploy/standalone/setup.sh | bash`
- `setup.sh` (idempotent): prompts for `.env` values; **generates the deploy key pairs**
  (`ssh-keygen` per repo) and prints each public key + the exact GitHub URL to paste it
  at, pausing until she confirms; writes `/opt/wixy/.env` + `/opt/wixy/keys/*`
  (root, 0600); installs the stack as a systemd unit; starts; runs `verify.sh`.
- `verify.sh`: healthz, tunnel connected, site clone OK, version/edition — ✅/❌ per
  check with the guide step to revisit.
- `update.sh` (pull+up now) / `update.sh --rollback` (04 §3) / `logs.sh`.

## 4. Secrets doctrine

Every secret exists only under `/opt/wixy/` (root, 0600 — `.env` + `keys/`) and in her
password manager. CI holds no droplet credentials; nothing pushes into the droplet.
Fable review checklist: no secret echoed to logs; perms; no published ports; non-root;
pinned known_hosts; image provenance; the `WIXY_CONTAINERIZED` gate refuses `0.0.0.0`
outside a container.

## 5. Image proof lives in CI (the hub has NO Docker — measured; Slots deploys source)

A GH Actions job (upstream + inherited by the fork) on every main merge: build the
image, `docker run` it on the runner, curl `/healthz` + `/api/version` asserting
`edition` — once with standalone env, once with `WIXY_EDITION=fleet` (cmd backend faked
via the existing `fake_cmd` harness). This is also what makes the staging-before-her-
pull promise honest for the container path. No local-Docker proof is asked of the
implementer anywhere.

## 6. DigitalOcean specifics (guide-facing)

Marketplace "Docker on Ubuntu", Basic Regular 2 GB/1 vCPU, LON1, IPv4, no extras; DO's
**browser console only** (no local SSH teaching); reserved IP unnecessary (tunnel
egress-only); DO droplet metrics + 06's external uptime check.
