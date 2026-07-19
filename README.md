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

To develop on the engine itself:

Python (interpreter: `pythoncore-3.14`; once: `pip install -e ".[server,dev]"` +
`playwright install --with-deps chromium`):

```
ruff check . && ruff format --check .   # lint + format
mypy                                     # strict type-check (builder/ + wixy_server/)
pytest                                   # full suite — run bare (the -n 4 cap is load-bearing)
python -m builder --help                 # builder CLI: validate / build / serve / parity
python -m wixy_server                    # run the server (loopback; default 8000, prod 9380)
```

TypeScript (in `admin-ui/` and `editor/` independently — commit the rebuilt bundle):

```
npm ci && npm run typecheck && npm test && npm run build   # esbuild → wixy_server/static/<name>/
```

E2E (`e2e/`, Playwright, against a local full stack): `npm ci && npx playwright test`.

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
- `spec/` — the full, decided build specification. `decisions/` — the architecture
  decision log.

## Documentation

- **[`docs/ai/architecture.md`](docs/ai/architecture.md)** — start here for the mental model,
  then the per-subsystem deep dives and [`docs/ai/invariants.md`](docs/ai/invariants.md).
- **[`docs/ai/contracts.md`](docs/ai/contracts.md)** — the HTTP route table + response shapes.
- **[`docs/ai/runbook.md`](docs/ai/runbook.md)** — deploy, rollback, creds, health.
- **[`spec/README.md`](spec/README.md)** — the full, authoritative build specification (00–09).
- **[`CLAUDE.md`](CLAUDE.md)** — orientation + the rules that bind this repo.

## This deployment: Cottage Aesthetics

The `ca.cinnamons.uk` production instance runs on Josh Comley's own fleet as a staging
environment for engine development — a second, fully independent deployment for the
site's actual owner is the subject of `spec/independence/`. This section documents that
fleet instance's own operational detail (internal hostnames/ports are loopback- or
Access-gated, not a security concern).

Fleet service **`Wixy`**, `D:\Servers\Wixy\`, loopback port **9380**, blue/green via Slots
(full runbook: [`docs/ai/runbook.md`](docs/ai/runbook.md) / `spec/07-hosting-deploy.md`). In
short:

- **Engine deploy = merge to `main`.** Slots polls `origin/main`, builds the inactive slot's
  own `.venv`, smoke-probes it (`/healthz` + a `/api/version` SHA match), then flips
  `active.txt`. No manual deploy step. **Never edit a slot** — branch here, PR, merge.
- **Site publish** is a separate pipeline (the admin's Publish button, or a restore) — it
  survives engine deploys because builds live in the shared `Storage\` tree, never in a slot.
- **First install**: `python install.py` (idempotent) creates the blue/green layout, builds
  both venvs, seeds `Storage\.env`, clones the site repo, and bootstraps serving (version 0).
- **Logs**: `D:\Servers\Wixy\Storage\logs\`. **Bounce**: Devfleet
  `POST http://127.0.0.1:9999/restart/Wixy` (never `Start-Service`/NSSM directly).
- **Health**: `curl http://127.0.0.1:9380/healthz`; `GET /api/version` reports the
  engine's own git SHA + active slot + the currently published site version.

## License

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Josh Comley.
