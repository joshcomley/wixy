# 03 — Standalone deploy target (SECURITY-GATED milestone)

`deploy/standalone/` in the engine repo — everything needed to run Wixy anywhere Docker
runs, tuned for the DigitalOcean droplet but provider-agnostic. Same image serves fleet
staging later if wanted; nothing here touches the fleet deploy.

## 1. Image

- `deploy/standalone/Dockerfile`: `python:3.14-slim` base; system deps `git`, `ffmpeg`
  (Studio-ready), CA certs; pip install the engine (pinned requirements); COPY committed
  frontend bundles (no node in the image — bundles are committed per the CMS spec);
  non-root user; `CMD python -m wixy_server`. Healthcheck: `GET /healthz`.
- Build/publish: GH Action in the engine repo (and inherited by her fork) — on main
  merge: build, tag `ghcr.io/<owner>/wixy:latest` + `:sha`, push with the workflow's
  GITHUB_TOKEN. Her fork's action publishes to HER org's GHCR — that image is what her
  droplet runs; the upstream's image is what fleet staging can run.

## 2. Compose stack (`deploy/standalone/docker-compose.yml`)

- `wixy`: the image; volume `wixy-storage:/data` (`WIXY_STORAGE_DIR=/data` — the
  existing storage-root setting); env from `.env`; binds only the compose network
  (never a host port).
- `cloudflared`: `cloudflare/cloudflared`, `tunnel run --token ${CF_TUNNEL_TOKEN}`;
  routes her hostname → `http://wixy:9380`. Zero inbound ports on the droplet.
- `watchtower`: polls GHCR every 5 min for `wixy` image updates, restarts on change —
  this IS the deploy mechanism (01 §5 d3). Scoped by label to the wixy container only.
- `backup` (06): tiny cron container in the same stack.
- Loopback-bind note: the server's `WIXY_BIND` refuses `0.0.0.0` today by spec; add
  compose-network awareness — the container binds `0.0.0.0` INSIDE the network
  namespace but the compose file publishes no ports; the startup assertion becomes
  "either loopback, or containerized with no published ports"
  (`WIXY_CONTAINERIZED=1` set by the compose file; assert refuses `0.0.0.0` without it).

## 3. Provisioning script (`deploy/standalone/setup.sh`)

Idempotent, run once on the droplet by copy-paste from the guide: prompts for (or reads
a pasted heredoc of) the `.env` values — tunnel token, Access AUD + team domain, three
deploy keys, org PAT, Anthropic key, site/media repo URLs — writes `/opt/wixy/.env`
(0600), installs the compose stack as a systemd unit (survives reboot), starts it, then
runs `verify.sh`: healthz OK, tunnel connected, site repo clone succeeded, prints a
green ✅ per check with the guide's step number to revisit on any ❌. The guide never
shows raw compose/systemd commands — only `setup.sh`, `verify.sh`, `update.sh`
(compose pull+up now), `logs.sh`.

## 4. Secrets doctrine

Everything secret exists ONLY in `/opt/wixy/.env` on her droplet (and her password
manager, where the guide has her save each value as she creates it — 1Password/Bitwarden
step early in the Purdi track). CI holds no droplet credentials (Watchtower pulls; nothing
pushes in). Fable review checklist for this milestone: no secret ever echoed to logs,
`.env` perms, no published ports, non-root container, image provenance pinned.

## 5. DigitalOcean specifics (guide-facing)

Marketplace "Docker on Ubuntu" image, Basic Regular 2 GB/1 vCPU, LON1, IPv4, no extras;
SSH via DO's browser console ONLY (no local SSH keys asked of her — the guide avoids
teaching SSH: every command is pasted into the DO web console). Reserved IP not needed
(tunnel egress-only). Monitoring: DO's free droplet metrics + 06's external uptime check.
