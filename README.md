# wixy

Self-hosted CMS engine + live visual editor + embedded AI chat + one-click publisher,
serving `ca.cinnamons.uk` (Cottage Aesthetics). See `CLAUDE.md` for dev commands and
layout, and `spec/README.md` for the full build specification.

## Deployment

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
