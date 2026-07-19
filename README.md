# Wixy

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Self-hosted CMS engine + live visual editor + embedded AI chat + one-click publisher.
Git is the database — every edit, publish, and rollback is a commit; no separate
content store, no vendor lock-in.

Wixy exists because Cottage Aesthetics, a small aesthetics clinic in the UK, needed a
site its owner could run herself: edit copy and images from a live visual editor, get
AI help with content changes, publish with one click, and never depend on a developer
to keep the lights on. `ca.cinnamons.uk` is Wixy's first production deployment; the
engine is released here under the MIT license so anyone with a similar need — full
ownership of a small business's web presence, on infrastructure they control — can run
it too. See `CLAUDE.md` for dev commands and layout, `spec/README.md` for the full
build specification, and `spec/independence/README.md` for how a second, fully
independent deployment (its own hosting, domain, and AI billing) works end to end.

## Quickstart

Wixy runs anywhere Docker runs — see [`deploy/standalone/`](deploy/standalone/) for the
one-line setup script and full instructions.

## What's here

- `builder/` — pure Python library: parse templates, resolve `data-wx-*` bindings,
  build/validate/serve the static output. No server imports; importable standalone.
- `wixy_server/` — FastAPI app: public serving, `/admin` + `/api/admin/*`, draft
  overlay, publish pipeline, pluggable AI chat.
- `admin-ui/` / `editor/` — the admin shell + the live visual editor overlay (strict
  TypeScript, no framework, self-hosted assets only).
- `deploy/standalone/` — the portable Docker deployment target.
- `guide/` — a step-by-step, non-technical guide for running your own independent
  deployment.
- `spec/` — the full, decided build specification.

## This deployment: Cottage Aesthetics

The `ca.cinnamons.uk` production instance runs on Josh Comley's own fleet as a staging
environment for engine development — a second, fully independent deployment for the
site's actual owner is the subject of `spec/independence/`. This section documents that
fleet instance's own operational detail (internal hostnames/ports are loopback- or
Access-gated, not a security concern).

Fleet service **`Wixy`**, `D:\Servers\Wixy\`, loopback port **9380**, blue/green via
Slots (spec/07-hosting-deploy.md — the full runbook). Summary:

- **Engine deploy = merge to `main`.** Slots polls `origin/main`, builds the inactive
  slot's own `.venv` (`launcher.py`, `deploy.py`, `slots.wixy.yaml`, `requirements.txt`
  at the repo root), smoke-probes it, then flips `active.txt`. No manual deploy step.
- **Site publish** is a separate pipeline (the admin's Publish button, or a restore) —
  it survives engine deploys/restarts because builds live in the shared `Storage\` tree,
  never inside a slot.
- **First install**: `python install.py` (idempotent) creates the blue/green layout,
  builds both slots' venvs, seeds `Storage\.env`, clones the site repo, and bootstraps
  serving (builds `origin/main` HEAD as version 0) so the site has something to serve
  immediately. It prints the remaining Devfleet/Slots/Cloudflare registration steps —
  see spec/07 §2-3, or run `tooling/provision_ca_cloudflare.py` (elevated) for the
  Cloudflare leg.
- **Logs**: `D:\Servers\Wixy\Storage\logs\`. **Bounce**: Devfleet
  `POST http://127.0.0.1:9999/restart/Wixy` (never `Start-Service`/NSSM directly).
- **Health**: `curl http://127.0.0.1:9380/healthz`; `GET /api/version` reports the
  engine's own git SHA + active slot + the currently published site version.

## License

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Josh Comley.
