# wixy — engine repo

Self-hosted CMS engine for `ca.cinnamons.uk` (Cottage Aesthetics). The full spec lives in
`spec/` (read `spec/README.md` first) — it is authoritative and decided. This file is quick
orientation; the **operator manual is [`docs/ai/`](docs/ai/architecture.md)** (start there
for the mental model, then the per-subsystem deep-dives and [invariants](docs/ai/invariants.md)).

**Status:** the v1 build is complete and deployed — all 13 milestones + the Uxer admin-UI
adoption shipped (50 `decisions/` entries; live at `ca.cinnamons.uk`). The
[`spec/independence/`](spec/independence/README.md) phase (owner-controlled infra, MIT fork,
pluggable AI, HTML setup guide) is **specced but not yet implemented** — roadmap, not current
behaviour.

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

Python (interpreter: `pythoncore-3.14`; run `pip install -e ".[server,dev]"` once — the
`server` extra brings FastAPI/uvicorn/etc., needed by `python -m wixy_server`, the
`wixy_server/tests` suite, and `mypy` over `wixy_server/`):

```
ruff check .              # lint
ruff format .             # format
mypy                      # strict type-check (builder/ + wixy_server/)
pytest                    # full suite, -n 4 fixed (never -n auto)
python -m builder --help  # builder CLI: validate / build / serve / parity
python -m wixy_server     # run the server (loopback, WIXY_PORT default 8000; prod 9380)
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

## Documentation map (`docs/ai/`)

The AI operator manual — read the one you need; each uses exact identifiers and links rather
than duplicates. `spec/` is the decided intent; `docs/ai/` is the code reality + how to work.

| File | When to read it |
|---|---|
| [architecture.md](docs/ai/architecture.md) | **Start here** — mental model, data flow, the two-lane state machine, module map |
| [contracts.md](docs/ai/contracts.md) | The HTTP route table + literal response envelopes, error map, SSE + postMessage shapes, fixtures |
| [invariants.md](docs/ai/invariants.md) | The numbered load-bearing rules (+ known exceptions) — check before changing behaviour |
| [glossary.md](docs/ai/glossary.md) | Domain terms + every status machine (publish/chat/checkout) |
| [testing.md](docs/ai/testing.md) | Test matrix, fixtures, how to run (bare `pytest` — the `-n 4` cap is load-bearing) |
| [runbook.md](docs/ai/runbook.md) | Deploy (= merge `main`), rollback, bounce, creds, CI, health |
| [builder.md](docs/ai/builder.md) · [serving-and-overlay.md](docs/ai/serving-and-overlay.md) · [publish-pipeline.md](docs/ai/publish-pipeline.md) · [media.md](docs/ai/media.md) · [editor-and-admin-ui.md](docs/ai/editor-and-admin-ui.md) · [ai-chat.md](docs/ai/ai-chat.md) | Per-subsystem deep dives |

When you change a public surface (routes, schema, env vars, an invariant), update the matching
`docs/ai/` file **in the same PR** — this is the doc-maintenance contract below.

<!-- aim:doc-maintenance:start -->
## AI Operator: Documentation Maintenance

This project has documentation maintained by [aim-doc-mcp](https://github.com/joshcomley/Aim.Mcp.Common/tree/main/code/aim-doc-mcp).

**Before committing code changes** that touch the public surface (routes, schema, config, major modules), call `mcp__aim-doc-mcp__doc_rules` to get the canonical rules for this stack and apply the relevant update-mapping. The rules evolve in the MCP server, not here — that's why this block does not duplicate them.

**Periodically, or after large refactors,** ask the user to run `doc` to trigger a full audit sweep (fresh-agent comprehension test + gap-close loop).

**To disable** documentation maintenance for this project, run `doc_disable`. To re-enable, run `doc` again.
<!-- aim:doc-maintenance:end -->
