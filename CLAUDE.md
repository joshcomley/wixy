# wixy — engine repo

Self-hosted CMS engine for `ca.cinnamons.uk` (Cottage Aesthetics). The full spec lives in
`spec/` (read `spec/README.md` first) — it is authoritative and decided; this file is
quick orientation, not a substitute.

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
- `projects/*.json` — per-site project registry (repo URL, domain, media limits).
- `spec/` — the full, decided build specification (00–09).
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
python -m builder --help  # CLI, once milestone 2 lands
python -m wixy_server     # run the server, once milestone 6 lands
```

TypeScript (in `admin-ui/` and `editor/` independently):

```
npm ci
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest
npm run build       # esbuild → wixy_server/static/<name>/
```

E2E (`e2e/`, Playwright, headless, against a local full stack once milestone 7 lands):

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
