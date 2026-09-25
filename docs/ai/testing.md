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
| `test_bindings.py` / `test_bindings_map.py` | `data-wx-*` resolution (publish vs preview, list expansion, `if`, the `visible: false` item convention — `TestListItemVisible`, Inv 28) plus `data-wx-img`'s intrinsic `width`/`height` sniff (`TestImgBindingIntrinsicDimensions`: real JPEG/PNG/GIF/WebP on disk, missing file, `site_root=None`, authored-dimension preservation (template-hardcoded and `data-wx-attr`-authored), remote/draft-media/traversal src skip, preview mode, per-list-clone independence — decisions/00140) / the static binding-map extractor |
| `test_render.py` / `test_build.py` | per-page render (incl. the social-preview tags: `og:site_name`, `twitter:card`, `og:image:alt/width/height` + their omission/skip cases, decisions/00134; the indexable-vs-not `noindex` meta presence/absence, decisions/00135; the img-dimension layout guard's inline `<style>` injection — `TestImgDimensionLayoutGuard`, decisions/00140) / full build + determinism (`hash_output_tree`) + self-check |
| `test_sitemap.py` | `generate_robots_txt`/`generate_sitemap_xml` — the non-indexable build's crawl-allow (never `Disallow`), no-`Sitemap:`-directive robots.txt, and the indexable build's `Allow` + `Sitemap:` directive (decisions/00135); sitemap slug sort order |
| `test_staticredirects.py` | `load_static_redirects`/`validate_static_redirects`/`generate_redirect_pages` unit tests (malformed source/target shapes incl. the `fullmatch`-vs-`match`+`$` trailing-newline case, root-target-accepted/root-source-rejected, collision with a real page's emitted filename, collision with the reserved `404` name, chain/loop rejection, deterministic sorted output, no `<script>`/query-preservation mechanism) plus `build_site` integration tests (backwards-compatible with no flag, alias exclusion from `sitemap.xml`, resolution through the shared `resolve_site_path` Pages-equivalent resolver, byte-identical determinism across two builds) — decisions/00136 |
| `test_structureddata.py` | `build_structured_data`/`inject_structured_data` (Inv 38) — indexable gate, `@type` bare-string-vs-array, contact fields, `sameAs`, the address drift-check (match/degrade/`addressCountry`-excluded/no-visible-text-to-compare/none-of-the-geographic-fields-recognized), strict all-or-nothing hours parsing (incl. near-miss format rejection), the `</script>` breakout-XSS regression (`test_script_tag_breakout_payload_cannot_escape_the_script`), and `TestRealProductionShape` — the actual deployed `cottage-aesthetics-preview` `_global.json` values as a scenario, not just synthetic data — decisions/00139 |
| `test_imagesize.py` | `imagesize.probe_image_size`'s stdlib JPEG/PNG/GIF/WebP(VP8/VP8L/VP8X) header sniffer — hand-crafted bytes per format/marker, plus failure cases (missing/truncated/non-image/zero-dim/directory, never raises); `is_safe_relative_src`'s safe-vs-unsafe path shapes (shared by the `og:image` and `data-wx-img` dimension sniffs) |
| `test_validate.py` | every validate code path; missing-key/image/schema/theme errors |
| `test_content.py` / `test_theme.py` / `test_nav.py` | dotted paths + canonical JSON; theme dict round-trip + CSS/fonts URL; nav derivation |
| `test_sanitize.py` / `test_jsonschema_lite.py` | rich-lite allowlist; the JSON-Schema subset (incl. bool≠number guard) |
| `test_config.py` | `ProjectConfig`/`adminSections` parsing — lenient skip-on-malformed, `AdminFieldKind` (incl. `toggle`), `alignAspect` parsing |
| `test_cli.py` | the four subcommands, exit codes, `--json` |
| `test_partial_migration_state.py` | the partially-migrated tolerance (Inv 5) |
| `tests/parity/test_parity.py` | rendered parity vs the **CA-site** `baseline/` (captured from the real Cottage Aesthetics build, **not** the mini-site; regenerated only via `capture-baseline.yml`). Screenshot advisory unless `--strict`; text/link/style exact. Uses module-scoped fixtures. `TestCaptureForcesLazyImagesToLoad` covers `capture.py`'s `_force_eager_images` (decisions/00141) — a `loading="lazy"` image below the fold must still measure/screenshot as if fully loaded, the same "deterministic settled state" precedent `_force_reveal` already established for scroll-gated content. |

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
| `test_robots_header.py` | `X-Robots-Tag: noindex` middleware (Inv 37) — the path allowlist as a pure-function unit test, plus integration coverage on both indexable states |
| `test_livechat_pinclient.py`, `test_livechat_tokens.py`, `test_livechat_store.py`, `test_livechat_uploads.py`, `test_livechat_processing.py`, `test_livechat_media_queue.py`, `test_livechat_janitor.py`, `test_livechat_push.py` | PIN client and tokens; SQLite migrations and erasure; upload validation and chunking; media processing, queue, janitor, and push |
| `test_routes_livechat.py`, `test_routes_livechat_media.py` | protected chat/upload routes, delete/wipe recovery, and signed media; `TestReactionRoutes` covers `PUT …/reactions` (auth, idempotence, no-op-writes-no-event, allowlist/sender/boolean 422s, 404 for unknown/deleted/oversized `seq`, raw-bytes erasure, stream frames) |
| `test_livechat_reactions.py` | the reaction allowlist as exact code points, `reactor_key` folding, and the **drift guard** that parses `admin-ui/src/server/reactions.ts` and fails if it differs from `REACTION_EMOJIS` (Inv 49) |
| `test_livechat_transcribe.py`, `test_routes_livechat_transcription.py` (+ `TestTranscripts` in `test_livechat_store.py`) | opt-in voice-note transcription (Inv 50): the cmd private-mode client, probe and cache, the exact request fields, the async route and job, single-flight / one-at-a-time / rate limit, raw-byte erasure of a transcript sentinel on delete and wipe, startup recovery. They run against `fake_cmd.py`'s private-mode double (`transcribe_private_supported`, `transcribe_retained`, `transcribe_gate`); `wixy_server/tests/conftest.py` gives every un-injected `CmdTranscriber` an inert transport so no test can reach a real cmd |
| `test_background.py`, `test_routes_system.py`, `test_settings.py` | contained loop/one-shot failures, media health status, and Server-chat environment settings |

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
  fixture's `showcase.items` (whose item count several other specs assert exactly). Server chat
  coverage is `server-chat.spec.ts` (conversation, delete/wipe, and cross-client behavior),
  `server-media.spec.ts` (chunked photo/video/voice upload and rendering),
  `server-lock.spec.ts` (disguise, lock causes, and gestures), `server-tap-precision.spec.ts`
  (R3 v1.7, mobile 390×844 with `hasTouch`: a scroll-shaped touch sequence never locks, a
  genuine same-spot double-tap on a bubble still does — decisions/00163),
  `server-reactions.spec.ts` (two people reacting live, delete taking reactions with it, a
  390 px and a 360 px phone leg, and the real-browser proof that a reaction never interrupts a
  voice note that is playing), and `server-transcription.spec.ts` (opt-in transcription at
  desktop and a 402px phone: nothing sent while cmd is not private, a playing note survives its
  transcript, a failure and Retry, two devices agreeing, phone layout). The fixture drives the
  fake cmd through `/test/server/transcribe-config` (private on/off, text, status, `hold` to park
  requests, `reset` — which also gives every test a fresh rate limiter),
  `/test/server/transcribe-stats`, `/test/server/seed-voice` (a ready note with real ffmpeg
  audio) and `/test/server/delete-message` (the spec removes every note it seeds: the fixture
  runs ONE chat for the whole suite and `server-media.spec.ts` asserts exactly one
  `.wx-srv-voice`).

Server-chat unit coverage also lives in `admin-ui/tests/server/{gestures,lockModel,panel,http,unlock,reactions,setReaction}.test.ts`.
`serverThread.test.ts` holds the reaction rendering and the in-place-patch tests (a playing
`<audio>` keeps its identity and `currentTime`; a stale response never overwrites a newer frame).
jsdom's selector engine mishandles astral-plane emoji inside an attribute selector, so those tests
find emoji buttons through `dataset`; real-browser specs may use the selector.
The lock browser spec uses Playwright `page.clock` to control the 400 ms multi-tap window,
idle timeout, and suspensions. `server-tap-precision.spec.ts` instead dispatches real
`PointerEvent`s in the actual browser to exercise `MULTI_TAP_RADIUS_PX`/tap-zone matching end
to end, since jsdom never lays anything out and can't stand in for "did the finger move". Media
e2e uses fake microphone devices; voice readiness is polled from the rendered DOM rather than
controlled by `page.clock`.
CI installs the real `ffmpeg` binary in both the Python and e2e jobs: media-processing tests
exercise actual voice/video conversion, and the e2e fixture needs it for uploaded media.
Pillow is a core dependency; `pillow-heif` is installed by the server extra.

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

Four Server-chat delivery lessons set the acceptance bar:

- For erasure or background-worker changes, require **five consecutive clean full-suite
  runs**, run alone. Never overlap pytest and e2e; Windows concurrent-file-access races fail
  different tests on different loaded runs, so one green run does not establish stability.
- Do not dismiss a Server-chat e2e failure as host load based on a small number of retries.
  Require **10/10 passes on an unloaded node** before classifying a hub-only failure as
  host-load-only. Any failure in that unloaded control run means a real bug needs investigation.
- A test that seeds an attachment or upload directly into the store of a live app (`create_app`
  under `TestClient`) must stamp it with the real clock. The app's janitor sweeps at startup and
  hourly, and it deletes unreferenced attachments and unpromoted uploads older than 24 hours, so
  a 1970-dated row is reaped whenever the sweep lands mid-test (decisions/00157).
  `test_routes_livechat.py`'s autouse guard refuses such a seed; a new module that drives a live
  app and seeds directly needs the same guard.
- Never put an absolute upper bound on elapsed time in a test of a route that touches SQLite or
  threads. The delete route's own work is about 10 ms, yet a `< 0.5` s assertion failed once at
  1.77 s in a full-suite run: it measured the machine, not the route. To test a deadline, hold
  the contended resource far longer than any stall and assert what the code did (it answered
  while the resource was still held; the timeout it passed was capped by its deadline). A scrub a
  test expects to succeed gets `_SCRUB_SUCCESS_DEADLINE_S` (30 s), because success returns at
  once and only a stall can spend the number (decisions/00159).
