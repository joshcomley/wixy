# wixy — engine repo

Self-hosted CMS engine for `ca.cinnamons.uk` (Cottage Aesthetics), deployed and serving
production. The full build spec lives in `spec/` (read `spec/README.md` first) — it is
authoritative and decided; this file is quick orientation, not a substitute. The
INDEPENDENCE phase (make her whole web presence run on her own accounts, dual-control
with Josh's dev lane) is specified in `spec/independence/` (read `spec/independence/
README.md` first) — same authority, layered on top of the base spec where it's silent.

## What's here

- `builder/` — pure Python library: parse templates, resolve `data-wx-*` bindings,
  build/validate/serve. No server imports. Importable standalone (the site repo's CI
  installs just this).
- `wixy_server/` — FastAPI app: public serving, `/admin` + `/api/admin/*`, draft overlay,
  publish pipeline, cmd-powered AI chat proxy. Imports `builder`.
- `admin-ui/` — admin shell + panels (strict TS, esbuild, no framework) → bundles into
  `wixy_server/static/admin/` (committed; CI checks for drift).
- `editor/` — the overlay injected into the live preview iframe (strict TS, esbuild) →
  bundles into `wixy_server/static/editor/`.
- `e2e/` — Playwright end-to-end flows against a local full stack (spec/08 §2).
- `projects/*.json` — per-site project registry (repo URL, domain, media limits);
  overridable per-deployment via `WIXY_SITE_REPO`/`WIXY_DOMAIN`/`WIXY_INDEXABLE` env
  vars (`wixy_server/registry.py`, spec/independence/01 §2.2).
- `deploy/standalone/` — the portable Docker deployment target (spec/independence/03);
  the fleet's own blue/green Slots deploy at the repo root is untouched by this.
- `guide/` — the independence-phase HTML guide for the site owner (spec/independence/07).
- `spec/` — the full, decided build specification (00–09).
- `spec/independence/` — the independence-phase specification (00–09 + README);
  layered on top of the base spec, same "decided, implement faithfully" authority.
- `docs/` — brief + design blueprint for the driving customer, Cottage Aesthetics.
- `decisions/` — architecture decision log (`NNNNN-slug/{title,decision}.md`).
- `todos/` — persistent per-workspace task lists (survive handovers).

## Dev commands

Python (interpreter: `pythoncore-3.14`; run `pip install -e ".[dev]"` once):

```
ruff check .              # lint
ruff format .             # format
mypy                      # strict type-check (builder/ + wixy_server/)
pytest                    # full suite, -n 4 fixed (never -n auto)
python -m builder --help  # builder CLI (validate/serve/build)
python -m wixy_server     # run the server
```

TypeScript (in `admin-ui/` and `editor/` independently):

```
npm ci
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest
npm run build       # esbuild → wixy_server/static/<name>/
```

E2E (`e2e/`, Playwright, headless, against a local full stack):

```
npm ci
npx playwright install --with-deps chromium
npx playwright test
```

## Rules that bind this repo

- The spec (`spec/00`–`09`) is decided — implement it faithfully, don't redesign or
  downscope. Where reality contradicts a cited fact, prefer reality and record a
  `decisions/` entry.
- New Python fully typed, `mypy --strict` green on `builder/` + `wixy_server/`. New TS
  strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), no
  framework, self-hosted assets only (no CDN).
- Never call the Anthropic/Claude API directly, anywhere in this engine — all AI
  inference goes through cmd (`spec/06-ai-chat.md`).
- Frontend bundles are committed; CI fails on drift (`git diff --exit-code` after a
  rebuild) — always run `npm run build` after touching `admin-ui/src` or `editor/src`
  and commit the output alongside the source change.
- Tests parallelize via pytest-xdist with the fixed `-n 4` cap in `pyproject.toml`'s
  `addopts` — never pass `-n auto`.
- Never author code in `D:\Servers\Wixy\` (that's the deployment target, a Slots
  blue/green checkout) — this repo is the source; see the global
  `D:\Servers\CLAUDE.md` worktree-guard rule. Branch here, PR, merge to `main`; Slots
  deploys it.
- Independence-phase milestones 2, 3, 4, 6 and 7 (spec/independence/09-work-plan.md)
  are SECURITY-GATED: open the PR, peer-message the spec author session with the PR
  number + that milestone's review checklist, and merge only after an explicit
  approval reply — never auto-merge those on green CI alone. Milestone 9 additionally
  needs a full Fable acceptance review before the phase is called done.
- `WIXY_EDITION=standalone` is the one operator-decided exception to the
  no-direct-Anthropic-API rule above (spec/independence/05 §2, milestone 6) — scoped
  to that backend only; the fleet edition (`WIXY_EDITION=fleet`, the default) keeps
  the cmd backend and the rule as stated.
