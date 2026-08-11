# Testing

The test matrix, fixtures, and how to run everything. Spec:
[`spec/08-testing-acceptance.md`](../../spec/08-testing-acceptance.md). CI is
`.github/workflows/ci.yml` (see [runbook.md](runbook.md) §CI).

## How to run

Python (once: `pip install -e ".[server,dev]"` + `playwright install --with-deps chromium`;
interpreter pythoncore-3.14):
```
ruff check .            # lint
ruff format --check .   # format check (drop --check to fix)
mypy                    # strict, builder/ + wixy_server/
pytest                  # full suite — bare, so the -n 4 addopts cap applies
```
**Run bare `pytest`.** `pyproject.toml` sets `addopts = "-n 4 -m 'not live_cmd'"`; the fixed
`-n 4` is a hard fleet rule — **never pass `-n auto`** (Inv 15; the suite runs on the hub VM
next to production cmd, and `-n auto` caused a real outage 2026-07-07). `-n0` for serial
debugging only. Run an expensive suite once and grep the captured log rather than re-running.

TypeScript (in `admin-ui/` and `editor/` independently):
```
npm ci && npm run typecheck && npm test && npm run build
```
`npm test` = vitest (jsdom). Always `npm run build` and commit the regenerated
`wixy_server/static/{admin,editor}/*` after touching `src` (Inv 2 — CI fails on drift).

E2E (`e2e/`, Playwright, headless, against a local full stack):
```
npm ci && npx playwright install --with-deps chromium && npx playwright test
```

The one `@pytest.mark.live_cmd` test (a real cmd round-trip) is excluded by default; run it
during deploy verification: `pytest -o addopts="" -m live_cmd wixy_server/tests/`.

## Test matrix

### `builder/tests/` (pytest, hermetic — unit tests use the mini-site fixture; parity uses the CA-site baseline)

| File | Covers |
|---|---|
| `test_bindings.py` / `test_bindings_map.py` | `data-wx-*` resolution (publish vs preview, list expansion, `if`, the `visible: false` item convention — `TestListItemVisible`, Inv 28) / the static binding-map extractor |
| `test_render.py` / `test_build.py` | per-page render (incl. the social-preview tags: `og:site_name`, `twitter:card`, `og:image:alt/width/height` + their omission/skip cases, decisions/00134) / full build + determinism (`hash_output_tree`) + self-check |
| `test_imagesize.py` | `imagesize.probe_image_size`'s stdlib JPEG/PNG/GIF/WebP(VP8/VP8L/VP8X) header sniffer — hand-crafted bytes per format/marker, plus failure cases (missing/truncated/non-image/zero-dim/directory, never raises) |
| `test_validate.py` | every validate code path; missing-key/image/schema/theme errors |
| `test_content.py` / `test_theme.py` / `test_nav.py` | dotted paths + canonical JSON; theme dict round-trip + CSS/fonts URL; nav derivation |
| `test_sanitize.py` / `test_jsonschema_lite.py` | rich-lite allowlist; the JSON-Schema subset (incl. bool≠number guard) |
| `test_config.py` | `ProjectConfig`/`adminSections` parsing — lenient skip-on-malformed, `AdminFieldKind` (incl. `toggle`), `alignAspect` parsing |
| `test_cli.py` | the four subcommands, exit codes, `--json` |
| `test_partial_migration_state.py` | the partially-migrated tolerance (Inv 5) |
| `tests/parity/test_parity.py` | rendered parity vs the **CA-site** `baseline/` (captured from the real Cottage Aesthetics build, **not** the mini-site; regenerated only via `capture-baseline.yml`). Screenshot advisory unless `--strict`; text/link/style exact. Uses module-scoped fixtures. |

### `wixy_server/tests/` (pytest, hermetic — temp Storage + temp bare-origin repos + fake cmd)

| File | Covers |
|---|---|
| `test_app.py` / `test_smoke.py` | app assembly, router wiring, lifespan |
| `test_settings.py` / `test_storage.py` / `test_registry.py` | `.env`+env parsing; `ProjectPaths`; registry loading |
| `test_auth.py` / `test_auth_gate_integration.py` | JWT verify (JWKS, aud/iss/expiry); the admin-path gate + dev bypass |
| `test_checkout.py` / `test_watcher.py` | clone/fetch/ff-only + `CheckoutError`; the 60s loop + lock-yield + 600s self-heal |
| `test_overlay.py` / `test_merged_content.py` | overlay algebra + rev/409; `merge_overlay` layering (incl. unknown-slug skip) |
| `test_live_pointer.py` / `test_ledger.py` | atomic pointer read/write; append-only ledger + version monotonicity |
| `test_publisher.py` / `test_kill_during_publish.py` | the full pipeline; a **real OS-process kill** mid-publish + recovery (decisions/00030) |
| `test_restore.py` | restore diff → overlay, page-set reconciliation, worktree cleanup |
| `test_media.py` | upload pipeline (EXIF strip, dedupe, SVG/size reject), reference scan, delete guards |
| `test_preview.py` | draft preview render + editor injection, incl. the hidden-item `data-wx-item-hidden` marker (Inv 28) |
| `test_draft_validate.py` | the draft-write gate — `normalize_set_ops` (leading-slash/nbsp/published-draft-media rewrites) + `check_structural` (incl. `visible: false`/`true` accepted, non-boolean rejected) |
| `test_cmdchat.py` / `test_chats.py` | the cmd client (vs `fake_cmd`); conversation store |
| `test_routes_*.py` | HTTP surface per router (admin_api / chat / public / internal / version) |

### Frontend (vitest) & E2E (Playwright)

- `admin-ui/tests/*.test.ts` and `editor/tests/*.test.ts` — one per source module (opQueue,
  protocol, editView, contentModel, listOps, opTargeting, themeVars, googleFonts, contrast,
  shortcuts, …). `themeVars.test.ts` and `googleFonts.test.ts` mirror the Python theme tests — the TS ports
  (`themeVars.ts`↔`generate_theme_css`, `googleFonts.ts`↔`generate_fonts_url`) must match the
  server byte-for-byte (Inv 20).
- `e2e/tests/*.spec.ts` — full-stack flows against a real wixy app wired to a fake cmd
  (`e2e/fixture_server.py`): `text-edit`, `image-replace`, `theme-change`, `collection-edit`,
  `concurrent-editing`, `restore`, `ai-lane`, `chat-ux`, `section-panel` (decisions/00098's
  registry-configured Before & After editor, incl. the `visible` toggle — publish/un-publish
  round trip and the write gate accepting `visible: false`, decisions/00117). The gallery
  fixture (`fixture_server.py`'s `_GALLERY_JSON`) seeds one HIDDEN slider pair ("Hidden Pair")
  so both files have a real hidden item to exercise without touching the shared mini-site
  fixture's `showcase.items` (whose item count several other specs assert exactly).

## Named fixtures

- `builder/tests/fixtures/mini-site/` — a complete tiny site (pages/partials/content/theme/
  images) + `fixtures/project.json`; `builder/tests/conftest.py` builds a `SiteSource` from it
  (function-scoped). `test_parity.py` uses module-scoped fixtures (pytest forbids a
  module→function-scoped dependency, and re-launching a browser per test is wasteful).
- `builder/tests/parity/baseline/` — per-page `desktop.png`/`mobile.png` + `probe.json`;
  regenerated only via the manual `capture-baseline.yml` workflow (which must serve a builder
  **build output**, not a raw checkout — decisions/00043).
- `wixy_server/tests/fake_cmd.py` — `create_fake_cmd_app` (ASGITransport HTTP double) +
  `FakeCmdServer` (real ephemeral-port uvicorn for the websocket).

## Discipline (see [invariants.md](invariants.md) 15)

A failing test is yours to fix regardless of author — `git fetch && git merge origin/main`
before declaring a verdict, fix the root cause, never skip/xfail/delete to go green, red main
blocks merges. A rare full-suite-only flake is a box-level resource-contention characteristic
(decisions/00025, 00027) — investigate, but never lower `-n 4` or add per-test retries.
