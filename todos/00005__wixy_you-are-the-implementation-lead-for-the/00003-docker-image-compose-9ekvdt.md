# 00003 [9ekvdt] M3 — Docker image + compose + scripts + GHCR (PUBLIC)

## What
- `deploy/standalone/Dockerfile`: python:3.14-slim, git/ffmpeg/openssh-client/CA-certs,
  Node LTS (Agent SDK worker wraps Node CLI, arrives fully in M6 but image built now),
  pip-install engine pinned, COPY committed bundles, non-root user, `github.com` pinned to
  known_hosts, healthcheck GET /healthz. Build args baked: WIXY_ENGINE_SHA, WIXY_SYNC_BASE.
- `docker-compose.yml`: wixy (volume wixy-storage:/data, WIXY_STORAGE_ROOT=/data,
  WIXY_PORT=9380, WIXY_ENV=prod, WIXY_EDITION=standalone, no published ports),
  cloudflared (tunnel run --token, routes www+apex -> http://wixy:9380), watchtower
  (polls GHCR ~5min, label-scoped), backup (M7 fills this in, stub now ok).
- Scripts (deploy/standalone/): setup.sh (idempotent, generates deploy key pairs via
  ssh-keygen per repo, prints public keys + GitHub URLs, writes /opt/wixy/.env +
  /opt/wixy/keys/* root 0600, systemd unit, runs verify.sh), verify.sh (healthz/tunnel/
  clone/version checks), update.sh (+ --rollback), logs.sh.
- GH Action: build image on main merge -> ghcr.io/<owner>/wixy:latest + :sha, package
  visibility PUBLIC (no registry auth needed for pull/Watchtower).
- CI image-boot proof (03 §5): GH Actions job builds image, docker run on runner, curl
  /healthz + /api/version asserting `edition`, once with WIXY_EDITION=standalone, once
  WIXY_EDITION=fleet (fake_cmd harness). Hub has NO Docker — this proof lives in CI only.

## Why
The actual portable deploy target — everything the drill (M9) and the real cutover run on.

## Context / current state
No Dockerfile/docker-compose/deploy/ exists anywhere in the repo today (confirmed via
Explore sweep). This is greenfield. Depends on M1's WIXY_CONTAINERIZED bind gate,
WIXY_STORAGE_ROOT=/data override, and baked-SHA /api/version already landing.

## Relevant files + commits
(fill in as PR lands)

## How to continue + acceptance
**SECURITY-GATED**: PR -> peer author with checklist 03 §4 (no secret echoed to logs;
/opt/wixy perms; no published ports; non-root; pinned known_hosts; image provenance;
WIXY_CONTAINERIZED gate refuses 0.0.0.0 outside container) -> ScheduleWakeup -> merge only
on explicit approval.

## Links
spec/independence/03 (full); spec/independence/09 row 3.
