# Testing

Answer/setup regressions cover capture-induced suspended/interrupted contexts,
one setup-only resume, rejection/still-suspended failure, stop during pending
resume, and a permission-dialog timer pause before the initial connected pulse.
Connected stalls still terminate normally. Diagnostic tests check visible local
and peer failures, a32-entry cap and exclusion of exception content/IDs. The real
browser scenario exercises denied microphone permission and phone-width copy
details and dismissing the notice. Socket-first connected stalls must send failure,
drop the expired message and expose copyable details. Incoming and idle-connection
failure traces are separate, and idle failures do not overlay the thread.
Transcribe recovery tests cover no automatic POST, temporary flag
recovery, silent renewal without flicker, failed history/wipe during attachment,
abort deadlines, detach cancellation and old-owner denial. These are
controlled tests, not proof of the reported physical iPhone pair.

The loopback E2E server's `FixtureSocketIdentity` carries a supplied fake HTTP
identity into WebSocket upgrades through an HttpOnly test cookie. Chromium omits
Playwright's context extraHTTPHeaders on those upgrades; without the fixture hop,
the call socket correctly rejects an email-bound token and locks those tests.
Production never imports this middleware. The call browser scenario checks the
phone icon right of ⋯, no header select, an in-viewport recipient picker and a
separate confirmation before invitation/audio, then the existing duplex/cleanup
gates. Setup keeps the Caller and Receiver active (mouse moves) until both are muted: a ringing
call does not pause the 10 s idle lock, so an untouched device on a loaded machine locks and
leaves the picker (decisions/00196); the muted-idle phase then stops that activity. CI's image proof falls back from a failed ECR pull to the same official
Python tag on Docker Hub before building; it never ignores build/boot failures.

Live-call focused loop: `pytest wixy_server/tests/test_livechat_calls.py -n 0` (signed
JWT dual-gate tests, immutable pair/state/credit/lease tests, real Uvicorn fragmented
oversize proof); in `admin-ui`, `npm test -- tests/server/call.test.ts
tests/server/callAudio.test.ts tests/server/callWorklet.test.ts tests/server/panel.test.ts`;
in `e2e`, `npx playwright test tests/server-calls.spec.ts --workers=1` after rebuilding
admin assets. Synthetic duplex is distinct from the physical-device listening and
actual-tunnel gate in [the review](../../spec/server-chat/voice-call-architecture-review.md#acceptance-and-real-audio-validation).

Repair discriminators additionally live in `test_livechat_call_repairs.py` and
`admin-ui/tests/server/callRepairs.test.ts`: actual native-work accounting under
cancel/timeout, pre-start cancel and separate quotas; overflow transitions; crossing
invites; immutable capture tags; rendered acknowledgements and preserved expiry.
The real browser scenario includes a third unlocked same-login browser: it must see
no incoming prompt, receive zero audio frames and never acquire a microphone. Device
selection must not silently move to that observer while the chosen peer is busy.

Round-2 regressions cover terminal-before-outgoing (including a dequeued outgoing),
both-member admission/dequeue authorization and lifetime boundaries without a tick,
constructor-failure decline, recorder-busy affordances and disconnected reconnection.
Panel tests cover cache restore ordering plus lock/expiry/disposal negatives. The
persisted-page Chromium scenario uses actual panel/chatView/thread and asserts draft
preservation and presence-only restoration; injected events do not certify physical
BFCache eligibility or mobile background behavior. On Windows set `WIXY_E2E_PYTHON`
to the installed Python interpreter, since bare `python3` may be the Store alias.
The pending-permission cache regression combines the real panel and real call
controller, permutes both pagehide listener orders and hidden-event presence, and
asserts lock before visible return, one audio stop and socket close. Companion
controls retain genuine picker/permission exemptions, cover permission ending before
persisted pagehide and verify shield decisions against the original hide timestamp.

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

Each Playwright worker boots its **own** isolated fixture server (`e2e/fixtures.ts`, a
worker-scoped fixture: free port, private temp git origin and storage, ~5–9 s cold start) and
supplies `baseURL`, so the suite runs on several workers instead of one shared server. Specs import
`test`/`expect` from `../fixtures`, never straight from `@playwright/test` (types still come from
there). Whole spec files go to whichever worker is free; tests within a file stay serial.
`WIXY_E2E_WORKERS` sets the cap (default 3/4 of the cores, at most 4: 3 on a 4-vCPU CI runner,
never "auto"; `1` reproduces the old fully serial run for debugging) and `WIXY_E2E_PYTHON` names the interpreter for `fixture_server.py` (default
`python3`; on Windows use the real interpreter, bare `python` is the Store stub). Do not add a
shared `webServer` or a fixed port back: that is what forced `workers: 1`.

**Every test starts from a pristine Server chat** (decisions/00195). A worker's one fixture server
holds one Server chat that its tests share in sequence, and which tests share a worker varies run to
run, so a test used to inherit earlier tests' messages, game rounds (Adventure Time's unfinished
rounds are OFFERED as a tab and their cards carry a Play button), device grants, call state and
fake-cmd settings. `e2e/fixtures.ts` therefore has a test-scoped **auto** fixture, `serverChatReset`,
that POSTs the fixture server's own `/test/server/reset` (in `e2e/fixture_server.py` only, never in the
product app) before each test: the product's `wipe_for_scrub` plus the storage sweep the real wipe
route runs (every message and what hangs off it, Adventure rounds and the never-again list,
transcripts, attachment files), then what a wipe deliberately keeps (device grants, push
subscriptions, `adv_settings`), then the in-memory state (call broker sessions and per-identity
admission budgets, the rate limiters, the fake cmd's transcription settings and PIN lockout, the
delete-response delay). The database file is never replaced under its live connections. Specs
therefore never need to clean up after themselves and must not rely on what an earlier test left.
`WIXY_E2E_WORKERS=1` is the worst case for leftovers: run it when touching shared state.

Two taps on one page inside 400 ms lock the chat when the second is a gesture-boundary control (the
quote on a reply, a lightbox button): a test that sends and then taps the quote must wait
`MULTI_TAP_INTERVAL_MS + 100` first (decisions/00198).

A failing e2e job uploads `e2e/test-results/` (failure screenshots plus `error-context.md`) as the
`e2e-test-results` artifact for 7 days. Playwright `trace` stays off: retain-on-failure cost +31 % wall
clock on the full suite and once hung `context.close()`.

**Clocks:** `page.clock.install()` does NOT pause time (measured on Playwright 1.61.1: page time keeps
flowing at real speed); a spec that counts idle time with `runFor` must call `freezeClock(page)` from
`e2e/tests/helpers.ts` after the page has loaded, or a busy machine adds its own delay to the count.
`waitForNextDraftPatchAccepted(page, { path })` waits for the PATCH that edits a given content path;
without `path` it is satisfied by any accepted PATCH, including one the test's own click did not cause.

**Image bakes and uploads:** never leave one inside Playwright's default 5 s `expect` timeout (the
Alignment test's "Save aligned photo" did, and a loaded CI runner broke it: the dialog was still open at
5.0 s; click to dialog-closed measured 0.07 s unthrottled, 1.2-2.6 s with the page's CPU throttled 6-20x
via CDP `Emulation.setCPUThrottlingRate`, 4-8 s at 25x and 9-14 s at 30x, where the old 5 s wait failed). Arm `waitForMediaUpload(page)` from `e2e/tests/helpers.ts` before the click or
`setInputFiles` that causes the upload (it resolves on the `POST /api/admin/media` answering 200, skips a
5xx the admin client retries, and rejects with the status on any other), then wait for the on-screen
effect with `{ timeout: MEDIA_PIPELINE_TIMEOUT_MS }` (60 s: the admin client's own 3 x 10 s upload attempts
plus backoff is 31.5 s, doubled for the bake). A test doing that raises its own budget with
`test.setTimeout(MEDIA_PIPELINE_TIMEOUT_MS * 3)`. `section-panel.spec.ts`'s `uploadThroughMediaDialog`
is the media-dialog flavour.

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
| `test_livechat_grants.py`, `test_routes_livechat_grants.py` | device grants (Inv 48): hash-only storage, the cap, the 30-day window, migration v9, the janitor, both gates on enrolment, one uniform 401, the rate limit, cmd never contacted, the request guard on all four routes, real-JWT identity binding, lone-surrogate labels (audit F5). `TestBoundTokenRevocation`: revoking a grant 401s its bound token at the next request, "sign out other devices" spares exactly the caller's own bound grant and nothing for an unbound caller (audit F4) |
| `test_livechat_reply_to.py`, `test_routes_livechat_reply_to.py`, `test_livechat_reply_to_driftguard.py` | reply to a message (Inv 51): migration v10 + the partial `idx_messages_reply_to` index, `create_message`'s target-exists/missing/idempotent resolution, `list_messages`/`get_messages`'s one-level quote resolution, the `finish_attachment` quote-freshness cascade, and erasure (delete, wipe, and a bare `DELETE FROM messages` from a simulated older-process connection); the `POST /messages` wire contract including `replyToSeq` validation; and the driftguard asserting the server's `reply_to_json` and `admin-ui/src/server/replyTo.ts`'s `replyToFromMessage` agree, both against the shared fixture `spec/server-chat/fixtures/reply-to-cases.json` |
| `TestStreamEvents` in `test_routes_livechat.py`, `TestMediaRoute` in `test_routes_livechat_media.py`, `TestUnlockToken`/`TestMediaSignature`/`TestMediaSigner` in `test_livechat_tokens.py` | §9 (audit F4) bound-token propagation: a `"g"`-bearing token round-trips and rejects a malformed grant id; an open SSE stream re-checks grant liveness on its own loop tick and sends `locked` within it; a bound media URL folds the grant id into its HMAC and is refused once the grant is revoked while an unbound URL for the same attachment is untouched |
| `test_livechat_adventure.py` | Adventure Time store (Inv 56): schema v20 incl. migration from a real v19 database, the state machine and EVERY transition's idempotency (same move replayed = unchanged, different move = `bad_state`), `too_early` with 1 s tolerance, exclusion maths (rejected + banked + the advised switch), `exhausted`, the single-destination skip, abandonment, `wyrSeq`/`wyrRefKind` for adventure anchors, the holiday-pack compare-and-sets, cascade from a connection that never imported the store, wipe (rounds + never-again list; `adv_settings` kept), raw-byte erasure, concurrent writers |
| `test_routes_livechat_adventure.py` | Adventure Time over HTTP: auth on every route, the exact view JSON, every spin/landing validation bound, the whole game through the routes with a `FakeResearcher`, replays and 409s, the never-again list and bank screen, the advised-places settings routes, the edition with no researcher, the game chat, erasure through the routes (sentinel bytes gone from `server.db` + WAL) |
| `test_livechat_adventure_live.py` | `POST /adventure/live`: bounds, its OWN 30/s limiter on the authenticated identity, the `adventure_live` SSE event (id-less, ordered with drawing frames), nothing stored; the generalised `DrawingBroker` keeps `drawing_live` byte-identical |
| `test_livechat_adventure_pack.py` | the holiday pack: defensive parse + sanitise (URLs, limits, unknown keys), the prompt (names only the destination, voice, FCDO source), `cmdchat.py`'s chat-spawn run calls against `fake_cmd.py` (exact body, nested `run`, no repeat of a lost spawn), and the job (success, bad JSON, error/timeout, give-up, early retry, restart resume, blue/green overlap, `CapacityLimiter(2)`, spawn spacing) |
| `test_livechat_safe_fetch.py` | (also: `Retry-After` with non-ASCII digits or out-of-range dates, a malformed redirect `Location`, lone-surrogate URLs, `refuse_host_suffixes`) the SSRF-safe GET (`livechat/safe_fetch.py`, Inv 56) against `fake_web.py`'s local server: the address policy for ~60 refused and ~15 allowed addresses (IPv4 private / loopback / link-local / CGNAT / multicast / reserved, IPv6 incl. mapped, compatible, NAT64, 6to4, Teredo), URL parsing refusals (schemes, ports, userinfo, backslash, IP literals in decimal / hex / octal / full-width spellings, single-label hosts), a name resolving to a private address or to mixed records (no connection made), one resolution per connection and a rebinding resolver, redirects (relative, cap of 3, loop, to a private host / scheme / port / IP literal, https -> http), byte / time / content-type / `Content-Encoding` bounds, `Retry-After` once, one request per host and four hosts at once, no cookies / proxies from the environment, and TLS (certificate checked against the HOSTNAME, SNI sent, untrusted / wrong-name certificate refused) with a throwaway CA |
| `test_livechat_adventure_pictures.py` | the finder (`adventure_pictures.py`) over `fake_open_web.py` (a fake Wikipedia REST summary + Commons API + venue pages in the real measured shapes): the slot plan, Commons file-name parsing from the real `thumb.wikimedia.org` URL, `prepare_picture` (formats, EXIF / ICC stripped, orientation, alpha, bounds, animation, bombs, the 16 MP limit read from the format's own header BEFORE `Image.open`, shrink-first re-encode, one decode at a time), source order, "never an original", the Commons-search hero and sights fallback, credits, de-duplication and the 22-picture cap (hero 6 + dishes 6 + other items 10), a page image tag or redirect aimed at a private address (never dialled), 429 strikes, the budget, `still_wanted` |
| `test_livechat_adventure_dishes.py` | local food to try (spec 4.3b): the pure food-term / accent-folding / title-token rules, the `dishes` section (keys, first, no link, prompt, valid without), the plan (dishes first, own caps), the dish sources over the fake web (lead image only when the article reads as food, the Commons search order and its two checks, a moth-named dish rejected by both, no article-images fallback, JPEG and 480 px, a duplicate photo, the 6 + 6 + 10 budget, decodes one at a time) |
| `test_livechat_adventure_pictures_job.py` | the picture job and wire: the v20 column amendment on an old v20 database, `images` state transitions, the compare-and-set attach (one transaction, refuses a rejected / deleted / finished round), Gallery exclusion, rev moving as each picture becomes ready, the job (success, nothing found, finder error, rejected / deleted mid-hunt, no room, two processes, startup redo, shutdown leaves it pending), and through the app: view shape with signed URLs, delete / wipe erasure of pictures and credits (raw bytes), restart, and the whole chain with the real `WebPictureFinder` + `SafeFetcher` over the fake web |
| `test_adventure_bank.py` | the destination bank against the world MAP: `tooling/adventure/validate_bank.py` (schema, id/slug rules, ranks, advice marks, every point inside its unit's geometry or within 25 km) run over the committed bank and a fixture bank |
| `test_adventure_bank_loader.py` | the SERVER's strict loader `adventure_bank.load_bank` over the committed file and a small fixture bank (`tests/fixtures/adventure_bank.json`), exclusion (rejected, banked, the advised switch), the 40 km top-five spacing. `wixy_server/tests/adventure_testkit.py` holds the shared helpers and the programmable `FakeResearcher`; `fake_cmd.py` gained the chat-spawn run endpoints (`chat_spawn_*` state, `FakeSpawnPlan`) |
| `test_cookout_bank.py` | the Cookout ingredient bank (Inv 57): `tooling/cookout/validate_bank.py` over the committed `cookout_ingredients.json` (size 2,500-4,000, 15 categories, schema/slug rules, unique normalised names and aliases, no category over 25 %, per-role depth, the operator's examples, the staples contract, no staple name in `stopWords`) and 500 simulated maximum-skip rounds asserting on EVERY emitted pair different categories, different families, an `everyday` side, no repeated id or picked family; the strict loader rejecting each class of bad input (mutations start from the committed bank); the draw's fixtures (mixed rarity in a family, a least-shown category with no everyday entry, cross-category family collisions, one eligible category left -> `exhausted`); the contraband scanner |
| `test_livechat_cookout.py` | the Cookout store (Inv 57): schema v21 incl. migration from a GENUINE v20 database (`fixtures/livechat_v20.db`, written by the pre-Cookout store, every v20 row surviving), create / explicit Join / strict alternation / two skips (third is `skip_exhausted`), Open vs Blind redaction asserted on the parsed JSON of every response incl. mutations (`current.*` null for the other player, partner `picks` null, partner history absent, reveal on `finished`, skipped pairs still hidden, no reveal on `abandoned`), `slot_of` email rules, `moveId`/`clientId` idempotency, manual retry transactions, two-store-connection `BEGIN IMMEDIATE` races (pick/pick, skip/pick, join/join, new/new, bank/bank, retry/retry, the turn-10 pick giving one transition, one event, one job start), abandonment, cascade and wipe |
| `test_routes_livechat_cookout.py` | the Cookout routes over HTTP: a 401 `locked` gate on every route (also with an invalid body and with a revoked grant), the exact view JSON, validation bounds, `Cache-Control: no-store`, the error mapping (404 / 409 / 422 / 503), `GET /cookout/bank` declared before `/{seq}`, `wyrSeq` accepted for a Cookout anchor with `wyrRefKind = "cookout"` |
| `test_livechat_cookout_ai.py` | the AI jobs (`cookout_ai.py`): `parse_concepts` / `parse_recipe` structure, coverage (>= 7 each, one >= 8, union = 10, exact `omitted` complement, <= 4 staples, distinct technique pairs), both lexical contraband passes (an unpicked bank food, a fifth staple, an omitted item in prose, longest-span-first fixtures such as `peanut butter` vs `butter`), the food-only prompt (no name, email or chat text), the repair runs (up to `MAX_REPAIRS`), resume after a restart, compare-and-set completion, standalone `unavailable`; the canned Cookout answers live in `fake_cmd.py` |
| `test_livechat_cookout_images.py` | the pictures (`cookout_images.py`, `wyr_images.generate_many`): the 1-3 chain graph keeps the WYR node ids and settings and `generate_pair` still raises `ImageGenerationError`, the `wyr_` prefix cleanup, `images_generation` fencing across two store instances (late success and late failure both `False`), partial success kept + `/pictures/retry` for the missing slots, Gallery exclusion, `images_started_at` / `images_tries` self-healing, the attempt directory removed on success / partial failure / delete / wipe / cancel, `clear_cookout_scratch` keeping work under 900 s and reclaiming it after |
| `test_livechat_cookout_twists.py` | the twelve Cookout twists in the store and routes (Inv 57, livechat.md §24.1): fixed start-sheet options and the server-side spin, the chef-only refusal without a runner, starters and the turn flow with them, lucky dip / chaos / veto (token_used, exhausted, stale pair, a pick of a swept option -> `bad_state`), the gate and stars' reveal-and-lock, the wildcard cloche, the dinner vote and the archived-vote secrecy rule, the rescue swap archive (generation row, dropped unfinished recipes, banked kept, forbidden ids), the generation fence on Bank / votes / retries and the cross-generation Bank replay ledger, We cooked it! (rating per slot, the exact-attachment photo link, view-once and foreign-round rejection, unlink on message delete), `_wipe`, and Blind redaction asserted on the parsed JSON of every response |
| `test_cookout_twists_catalogue.py` | the static style and challenge catalogues: ids, frozen wording, and that no directive, recipe directive or picture phrase contains a bank food (the contraband scan returns nothing) |
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
  voice note that is playing), `server-transcription.spec.ts` (opt-in transcription at
  desktop and a 402px phone: nothing sent while cmd is not private, a playing note survives its
  transcript, a failure and Retry, two devices agreeing, phone layout),
  `server-permanent-unlock.spec.ts` ("Keep this device unlocked" end to end and the two lock
  checkboxes; it installs a stand-in for Chromium's `IdleDetector` with an init script because a
  headless run cannot answer its permission prompt), and `server-drawing.spec.ts` (the pen,
  two identities: a stroke seen live before the drawer lifts and then stored in the same place,
  scrolling with its message, Select-mode delete for both, the anchor's deletion taking it,
  rapid dots never locking while Escape does, and 390/360 px phones with touch where every
  control is hit-tested and two fingers scroll without drawing; the toolbar's layout contract —
  two lines in every mode, the Draw | Select switch never moving — is checked in the device's own
  font AND in a forced wide one (`useWideFont`: Verdana, else DejaVu Sans), because the first
  layout passed every local run in Segoe UI and failed only on CI's Ubuntu font (decisions/00176
  #13); the fixture runs one chat per
  worker, so it scopes every assertion to its own anchor via
  `svg.wx-srv-drawing[data-anchor-seq="N"]` and acts at a human pace between separate
  controls, or R3's boundary rule locks). The transcription fixture drives the
  fake cmd through `/test/server/transcribe-config` (private on/off, text, status, `hold` to park
  requests, `reset` — which also gives every test a fresh rate limiter),
  `/test/server/transcribe-stats`, `/test/server/seed-voice` (a ready note with real ffmpeg
  audio) and `/test/server/delete-message` (the spec removes every note it seeds: the fixture
  runs ONE chat for the whole suite and `server-media.spec.ts` asserts exactly one
  `.wx-srv-voice`).

Server-chat unit coverage also lives in `admin-ui/tests/server/{gestures,lockModel,panel,http,unlock,reactions,setReaction}.test.ts`.
The pen's (livechat.md §19) is `admin-ui/tests/server/{drawings,drawingGeometry,drawGesture,drawingLive,drawingModel,drawingSync,drawingsApi,drawingLayer,threadDrawing}.test.ts`
— `drawings.test.ts` is the TS half of the palette drift guard (it parses
`wixy_server/livechat/drawings.py`), and `drawingLayer.test.ts` stubs every measured box
because jsdom lays nothing out.
Adventure Time's client (livechat.md §23.1) is covered by
`admin-ui/tests/adventure/{api,model,live,scene,packView,card,bank,pane}.test.ts` (over `adventureFixtures.ts`: a three-country
world and one view per state of the round; jsdom with the renderer stubbed — the pane tests drive it with real `PointerEvent`s
carrying explicit timestamps and a manual clock, and read the `GlobeFrame`s it draws) and `admin-ui/tests/serverAdventureThread.test.ts`
(the ⋯ menu, starting a round, the offer, the one-game replacement with Would you rather, the game chat's `wyrSeq` and tags, the Holiday
bank with older history paged in, lock and wipe); `serverGameTabs.test.ts` pins the one-game-at-a-time rule. A mock that REJECTS (say a
`serverFetch` that throws the lock error) must attach a `.catch(() => {})` to the promise it returns, or vitest reports the promise the
Cookout's client (livechat.md §24) is covered by `admin-ui/tests/cookout/{api,model,cookoutGame,cookoutCard,recipeBook}.test.ts` (defensive parsers, the monotonic-`rev` guard and poll backoff, the start sheet, Join, the skip button's three states, the Blind "secret turn" card with no ingredient string anywhere in the DOM, the ten-pick reveal, three dish cards, Bank this -> Writing recipe... -> Banked with the full recipe, the card and the Recipe book) and `serverGameTabs.test.ts` (`GameKey` includes `"cookout"`); `e2e/tests/server-cookout-twists.spec.ts` plays every twist end to end with two browsers, Blind leak checks included; `e2e/tests/server-cookout.spec.ts` plays it with two people (the e2e fixture server's fake cmd returns canned concepts and recipes).
mock keeps as an unhandled error. `e2e/tests/server-adventure.spec.ts` plays the whole game with two people and REAL mouse drags on the
Classic map (a flat map keeps frames fast, so a flick's timing holds on a software-GL runner): a slow part a watcher sees as a live
finger, then a quick flick; both Stops (what is lit when Stop is pressed is what both screens settle on), the fake cmd's canned pack, the
destination's mini chat and pop-up, the bank and its screen, reject + "never again", Adventure and Would you rather replacing each
other, the Options switch, the "Local food to try" grid (the canned pack's `dishes` section, inserted by `e2e/fixture_server.py`, with
four dishes pictured from the fake Wikipedia and Bifana left text-only: the tile geometry, a dish opening in the viewer, the card's dish
photo; it needs the server's dishes pipeline, spec §4.3b), and 360 px and desktop layouts. It reads the pane's `data-*` facts (a canvas has no DOM to assert on) and
keeps both pages awake with a Shift key press (a mouse move would disturb a drag). Set `WIXY_E2E_SHOTS=<dir>` to run the main flow on
the real Satellite map, flicking with timestamped in-page pointer events, and save 390 px screenshots.
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
  It also answers the Cookout runs (`wixy-cookout-concepts` / `wixy-cookout-recipe`) from canned JSON built out of the
  prompt's own basket (`canned_cookout_concepts` / `canned_cookout_recipe`).
- `e2e/fixture_server.py` points Cookout's AI runner at the second, never-stopped fake cmd (`create_app(cookout_cmd_client=...)`),
  as it does the Adventure researcher. Cookout rounds need nothing extra between tests: the per-test `serverChatReset`
  (`/test/server/reset`, decisions/00195) runs the product's wipe, which deletes `cookout_rounds` / `cookout_turns` /
  `cookout_generations` / `cookout_recipes` with their anchor messages.
- `wixy_server/tests/fixtures/livechat_v20.db` — a genuine schema-v20 `server.db` written by the pre-Cookout store with real
  rows in every v20 table; `test_livechat_cookout.py` copies it to prove v20 -> v21 keeps every row byte for byte.
- The Cookout bank validator (`tooling/cookout/validate_bank.py`) is imported by `test_cookout_bank.py`; mutation tests start
  from the committed bank because a small fixture could not satisfy its bank-wide size and role-coverage rules.

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
