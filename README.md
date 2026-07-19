# wixy

Self-hosted CMS engine + live visual editor + embedded AI chat + one-click publisher for
sites that are plain HTML/CSS/JS. The first (and, in v1, only) site is **Cottage Aesthetics**,
served at [`ca.cinnamons.uk`](https://ca.cinnamons.uk).

The owner browses their site in edit mode, clicks any text or image to change it, tweaks
colours and fonts with live preview, chats with an AI that edits the site, presses **Publish**
to go live, and can restore any previous version with one click. Four principles make that
safe: **git is the database** (content lives in the site repo; every publish is a commit),
**the public site stays plain static files** (no framework on the visitor path), **one human
gate** (the editor and AI both stage into a draft — only Publish changes the live site), and
**engine ≠ content** (this repo is generic; everything site-specific is in the site repo +
`projects/ca.json`).

## Quickstart

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

## Repo layout

- `builder/` — pure Python library: parse templates, resolve `data-wx-*` bindings,
  build/validate/serve. No server imports; importable standalone (the site repo's CI installs
  just this).
- `wixy_server/` — FastAPI app: public serving, `/admin` + `/api/admin/*`, draft overlay,
  publish pipeline, cmd-powered AI chat. Imports `builder`.
- `admin-ui/` — admin shell + panels (strict TS, esbuild, no framework) → `wixy_server/static/admin/`.
- `editor/` — the overlay injected into the live-preview iframe → `wixy_server/static/editor/`.
- `e2e/` — Playwright end-to-end flows against a local full stack.
- `projects/*.json` — the per-site project registry. `spec/` — the decided build spec.
  `decisions/` — the architecture decision log. `docs/` — design docs + the AI operator manual.

## Documentation

- **[`docs/ai/architecture.md`](docs/ai/architecture.md)** — start here for the mental model,
  then the per-subsystem deep dives and [`docs/ai/invariants.md`](docs/ai/invariants.md).
- **[`docs/ai/contracts.md`](docs/ai/contracts.md)** — the HTTP route table + response shapes.
- **[`docs/ai/runbook.md`](docs/ai/runbook.md)** — deploy, rollback, creds, health.
- **[`spec/README.md`](spec/README.md)** — the full, authoritative build specification (00–09).
- **[`CLAUDE.md`](CLAUDE.md)** — orientation + the rules that bind this repo.

## Deployment

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
- **Health**: `curl http://127.0.0.1:9380/healthz`; `GET /api/version` reports the engine's
  git SHA + active slot + the currently published site version.
