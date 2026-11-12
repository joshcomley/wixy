# Implementation brief: fix the publish corruption + friendly publish UX (self-heal & report), unmissable AI-chat task visibility, and a dedicated Before & After editor

You are the implementing agent for a fully-investigated plan. This brief was written by a planning agent (cmd session id `5b2083a2-fdf6-4abf-b1b6-bf43ae0975ba`) that diagnosed everything below against the live system and the code — you do NOT need to re-derive the diagnosis, but you should spot-verify the load-bearing facts as you touch each area.

## Your reporting contract (mandatory)

Message the planning agent by POSTing to `http://127.0.0.1:9321/sessions/5b2083a2-fdf6-4abf-b1b6-bf43ae0975ba/send` with JSON body `{"text": "<message>"}` (this is the same call the `peer` skill wraps, if you have it) at exactly two moments:

1. **If you get stuck or this brief doesn't hold up** once implementation starts (a cited fact is wrong, a design collides with something real, a gate you can't pass) — ask via that POST rather than guessing or improvising around the gap. Keep working on anything not blocked while you wait.
2. **When ALL the work is done** — a mandatory completion report after your final verification step: what shipped (PR numbers/commits), how you verified it (including live verification), and any deviations from this brief.

## Where you are

- Repo: **wixy** — the CMS engine serving `ca.cinnamons.uk` (Cottage Aesthetics). You are in worktree `D:\Servers\Cmd\Storage\clones\wixy__worktrees\00013__wixy_double-things-need-working-on-arm-armed` (workspace `b94ef6fa-670e-4fd2-9451-b29e53acba8a`).
- **First action:** `git fetch origin && git merge origin/main --no-edit` (handover rule — the branch may be stale).
- Read `CLAUDE.md` at the repo root, then `docs/ai/architecture.md`. Per-area deep-dives are cited throughout; read each before touching that area: `docs/ai/contracts.md`, `docs/ai/editor-and-admin-ui.md`, `docs/ai/publish-pipeline.md`, `docs/ai/serving-and-overlay.md`, `docs/ai/media.md`, `docs/ai/ai-chat.md`, `docs/ai/invariants.md`, `docs/ai/testing.md`, `docs/ai/runbook.md`.
- Production: fleet service `Wixy`, Slots blue/green at `D:\Servers\Wixy\` (NEVER edit anything there except the runtime `Storage\.env` config step named below — the site-repo checkout under `Storage\projects\ca\repo\` is machine-managed runtime data, also hands-off). Deploy = merge this repo's `main`; Slots redeploys automatically. Runtime state: `D:\Servers\Wixy\Storage\projects\ca\` (overlay, builds, ledger, chats). Server binds loopback `:9380`; public ingress is cloudflared + CF Access.
- The site owner is **non-technical** — every string she can see must be plain, calm English. Josh (the operator/developer) reads logs and reports.
- The project has a `verify` skill ("Drive the deployed Wixy + Cottage Aesthetics instance end to end") — read/use it for the live-instance access recipe (CF Access service token headers from `C:\D\Biosphere\Storage\cf_access_token.json`, keys `client_id`/`client_secret`, sent as `CF-Access-Client-Id`/`CF-Access-Client-Secret` against `https://ca.cinnamons.uk`).
- Use the `persistent-todos` skill to track the workstreams below in `todos/` so the plan survives any handover.

## Binding repo rules (from CLAUDE.md / invariants — the ones you will hit)

- New Python fully typed, `mypy --strict` green (`mypy` covers `builder/` + `wixy_server/`). `ruff check .` + `ruff format .` clean.
- New TS strict; **no framework**; `admin-ui/` and `editor/` build with esbuild into `wixy_server/static/{admin,editor}/` and the bundles are **committed** — after touching `admin-ui/src` or `editor/src`, run `npm run build` in that package and commit the output; CI fails on drift (Inv 2).
- `admin-ui/src/protocol.ts` ≡ `editor/src/protocol.ts` byte-identical (Inv 20). **This plan requires NO protocol change** — if you find yourself changing it, message the planner first.
- Tests: bare `pytest` (the `-n 4` cap in pyproject addopts is load-bearing — never `-n auto`); `npm test` (vitest) in both TS packages; Playwright e2e in `e2e/`. Bug fixes are red/green: failing test first, then the fix, committed together.
- Update the matching `docs/ai/*` file **in the same PR** as any public-surface change (routes/envelopes → `contracts.md` is the canonical route table; also touch the per-subsystem file). Call `op call aim-doc.doc_rules` before committing public-surface changes and apply its update-mapping.
- Record `decisions/NNNNN-slug/{title.md,decision.md}` entries for the non-obvious calls (numbering: scan existing `decisions/` for max, currently ~00094; entries this plan expects are listed per-PR below).
- Inv 1: no `cottage`/`ca` literals in `builder/`/`wixy_server/` code paths — everything site-specific goes in `projects/ca.json` or the site repo. The Before & After editor below is deliberately designed as a **generic, registry-configured section editor** for this reason.
- The spec (`spec/00–09`) is decided. Where this plan extends editor behaviour beyond spec/05's letter (e.g. attr read-back, write-time validation), that is "reality contradicts a cited fact → prefer reality + record a decisions entry", not a redesign. Do not rewrite spec files.
- All AI inference through cmd (Inv 13) — nothing in this plan calls any model API directly.
- This work is NOT one of the security-gated independence milestones — normal auto-merge on green CI applies (branch → PR → merge each PR before starting the next).

---

# THE INCIDENT (diagnosed; verify as you go)

On 2026-07-28 the site owner tried to **add a new before/after photo pair** on the gallery page using the editor overlay's list item toolbar. Publish has been broken since, showing her a wall of raw validator output (she was shown things like `pages/gallery.html: attribute binding '.cat' (for 'data-cat') does not resolve to a string` and `content/gallery.json: gallery.sliders[0]: missing required property 'cat'`).

Live draft overlay right now — `D:\Servers\Wixy\Storage\projects\ca\draft\overlay.json`, **rev 127**, two ops, both `by: cottageaestheticshartlebury@gmail.com`:

1. `gallery:gallery.sliders` — whole-array op, 3 items. ALL THREE are missing required `cat`. Item[0] is fully gutted: `title`/`sub` are the literal string `"&nbsp;"`, `before`/`after` are `{"src":"","alt":""}`. Items [1] and [2] match the checked-in base content exactly except for the missing `cat`.
2. `gallery:meta.ogImage` — `{"src": "/images/ba-lips-1-after.jpg", "alt": "Ba Lips 1 After"}`. The file `images/ba-lips-1-after.jpg` EXISTS in the repo; the leading slash is the problem.

Base content `content/gallery.json` in the site-repo checkout is intact (3 sliders with `cat: lips/lips/cheeks`). Live pointer is v19 @ `897b5fa`. Three upstream commits are pending publish (`snapshot: WIP…`, `feat: add FAQ to main navigation menu`, `Merge pull request #20`).

Mechanism (all in code, exact locations):

- **A. attr bindings are invisible to DOM read-back.** The gallery template (`pages/gallery.html` in the SITE repo) binds category as `data-wx-attr="data-cat:.cat"` on each `data-wx-list-item` (both `gallery.sliders` and `gallery.tiles`). `editor/src/contentModel.ts` `readItemValue` builds its element selector from a ternary chain that has no `attr` branch (attr-kind fields fall through to the `data-wx` selector, which never matches an element carrying only `data-wx-attr`), and `readScalarValue`'s `case "attr"` returns `null` anyway. So every whole-array reconstruction (`readListValue`) silently DROPS attr-bound fields. Every item-scoped edit or toolbar action on those lists emits a `cat`-less array.
- **B. Add-item placeholders become stored content.** `editor/src/overlay.ts` `blankTextLikeFields` (~line 699) writes `innerHTML = "&nbsp;"` into every `[data-wx]` of the cloned item and empties `src`/`alt`/`href` (deliberate, for click-targets). Any SUBSEQUENT structural op re-reads the whole list from the DOM (`runListStructuralOp` → `readListValue`), so `"&nbsp;"` and empty img objects became stored values (innerHTML serializes U+00A0 as the entity; `demoteHtmlToMarkdown` passes it through).
- **C. The media picker returns the served URL, not the content form.** `admin-ui/src/mediaDialog.ts` `renderAltStep` → `onPick({ src: item.url, … })`; for repo images `_list_media` (`wixy_server/routes_admin_api.py`) sets `url: /images/<name>`. Content form must be `images/<name>` (relative). Both pick flows are affected: the editor overlay flow (`editView.ts` `onMediaRequest` → `applyOps`) and `pageSettingsDrawer.ts`'s ogImage field (the op that broke). Staged-upload picks (`/admin/draft-media/<name>`) are CORRECT and rewritten at publish (`publisher.py:_rewrite_draft_media_refs`) — do not change that shape.
- **D. Why it exploded only at publish:** `builder/validate.py:_validate_images` does `(project_root / src).exists()` — an absolute-looking `/images/...` rhs makes pathlib discard `project_root`, so it reports "does not exist" even though the file exists (same quirk `routes_admin_api.py:_staged_image_keys` already documents for `/admin/draft-media/`). The schema errors come from `builder/schemas/gallery-slider.schema.json` (`required: [cat, title, sub, before, after]`, `additionalProperties: false`) via `COLLECTION_RULES` in `builder/collections.py`. Nothing validates draft PATCHes at write time (`routes_admin_api.py:_apply_draft_patch` only runs `sanitize_set_ops`), so the draft sat broken for two days and surfaced as `publishDrawer.ts`'s raw `renderValidate` list + the raw `errorBox` `<pre>` on failure.

---

# WORKSTREAM 0 — repair the live draft and unblock her publish TODAY (operational; do this FIRST, before any code)

Use the deployed admin API on `https://ca.cinnamons.uk` with the CF Access service-token headers (recipe in the `verify` skill). All under `/api/admin/*`:

1. `GET /api/admin/state` → note `draft.rev` (expected 127) and confirm via `GET /api/admin/publish/preview` that the two poisoned ops above are still what's there (validate errors match). **If the overlay has changed since this diagnosis** (different rev/ops), STOP and re-diagnose with the same method before acting; only discard the sliders op if it still shows the corruption fingerprint (items missing `cat`).
2. `PATCH /api/admin/draft` body:
   ```json
   {"expectedRev": <rev>, "ops": [
     {"file": "gallery", "path": "gallery.sliders", "discard": true},
     {"file": "gallery", "path": "meta.ogImage", "value": {"src": "images/ba-lips-1-after.jpg", "alt": "Lip enhancement result — after"}}
   ]}
   ```
   Rationale: discarding the sliders op restores the intact base array (her only "edit" there was the corruption); the ogImage op preserves her real intent (share image = lips-1 after) with the src corrected.
3. `GET /api/admin/publish/preview` → assert `validate.ok == true` and the only content change is the ogImage.
4. Inspect the three pending upstream commits in the site-repo checkout (`git -C D:\Servers\Wixy\Storage\projects\ca\repo show --stat <sha>` — read-only) to confirm they're the FAQ work and benign; spot-check the draft preview renders (gallery + FAQ nav) via the verify skill's browser recipe.
5. `POST /api/admin/publish` `{"message": "Fix Before & After photos and share image; FAQ goes live", "expectedRev": <new rev>}` → expect `{version: 20, …}`.
6. Verify live: `https://ca.cinnamons.uk/gallery.html` contains 3 `ba-slider` figures each with a `data-cat` attribute and real image srcs; nav contains FAQ; page for FAQ renders.

Report step-0 completion inside your eventual final report (version number + what you verified).

---

# WORKSTREAM 1 (PR 1) — publish can never break like this again + the publish experience is calm

## 1a. Editor read-back fixes (root cause A + B) — `editor/src/`

- `contentModel.ts`:
  - Teach the read path attr bindings. Mirror `builder/bindings.py:parse_attr_spec` (spec format `"attrName:key[,attr2:key2]"`, comma-separated, whitespace-tolerant) in a small exported TS helper (this is a THIRD hand-synced pair candidate — instead of full duplication lock it with a tiny unit test asserting the same parse results as the Python tests' cases). In `readItemValue`, for `field.kind === "attr"`: find the element within the item whose `data-wx-attr` spec contains a pair whose key equals `field.key` (query `[data-wx-attr]` candidates via `queryOwn`-style self-then-descendant search, parse each), and read `el.getAttribute(attrName) ?? ""`. Check how `builder/bindings_map.py` represents attr fields (`BindingField` has an optional `attr` — if the map already carries the attribute name, prefer `field.attr` over re-parsing; verify with a mini-site fixture that has an attr binding on a list item — you will likely need to ADD one to `builder/tests/fixtures/mini-site/` plus its bindings-map expectations, which also gives the Python side coverage).
  - Normalize placeholder-empty text reads: after `demoteHtmlToMarkdown`, if the result is empty ignoring whitespace, U+00A0 characters, and literal `&nbsp;` entities → return `""`. One helper (`normalizeEmptyText`) applied in `readScalarValue`'s `"text"` case. `blankTextLikeFields`'s DOM placeholder stays (its click-target rationale is documented and correct) — the READ side now cancels it.
- Unit tests (vitest, `editor/tests/` pattern): a fake list item DOM with `data-wx-attr="data-cat:.cat"` round-trips `cat`; an item with `&nbsp;` innerHTML reads `""`; a multi-pair attr spec (`"a:.x,b:.y"`) reads both; regression: reconstructed slider-shaped items satisfy the required-key set.

## 1b. Media picker writes the content form (root cause C) — server + `admin-ui/`

- `wixy_server/routes_admin_api.py` `_media_item`/`_list_media`/`_save_upload`: add a `contentSrc` field to every media item: repo images → `images/<name>` (also when `stagedReplace` — the reference form is by name), draft uploads → `/admin/draft-media/<name>`. `url` stays as-is (display/thumbnail).
- `admin-ui/src/api.ts` `MediaItem`: add `contentSrc: string`.
- `admin-ui/src/mediaDialog.ts` `renderAltStep`: `onPick({ src: item.contentSrc, alt: … })`. That single change fixes both pick flows (editView mediaRequest and pageSettingsDrawer ogImage).
- Sanity-check preview rendering still shows a just-picked repo image (relative `images/<name>` inside `/admin/preview/<page>.html` resolves the same way server-rendered content srcs already do — confirm in e2e/live, don't assume).
- Tests: server test for `contentSrc` shapes; vitest for the pick value.

## 1c. Server-side write gate — a draft can never persist schema-invalid or off-form ops

New module `wixy_server/draft_validate.py`, called from `_apply_draft_patch` after `sanitize_set_ops`, before `apply_patch`:

1. **Normalize** each `SetOp.value` recursively (reuse the `{src, alt}`-shape detection convention from `publisher._rewrite_draft_media_refs`): a `src` string matching `^/images/(.+)$` whose file exists at `<repo>/images/<name>` → rewrite to `images/<name>`. Also normalize whole-string-nbsp text leaves (`"&nbsp;"` / `"\u00a0"` / whitespace-only mixtures of those) → `""` — whole-value only, never inside longer strings.
2. **Validate structure** of collection ops: for each SetOp whose `(file, path)` matches a `COLLECTION_RULES` entry (import from `builder.collections`; also cover the two special shapes if targeted directly: `treatments:sections` items' `cards`, `_global:footer.*` lists), check each item with a STRUCTURAL subset of the schema — `type`, `required`, `properties` recursion, `additionalProperties` — deliberately NOT `pattern`/length (see 1f: pattern is publish-time only, so the inline toolbar's blank-item add keeps working as a draft state). Implement the structural check in `draft_validate.py` walking the same `builder/schemas/*.json` dicts (load via `builder.validate._load_schema` or duplicate the tiny loader).
3. On violation → raise a new `DraftValidationError(summary, details)`; route maps it to **422** `{"detail": "<one-line plain summary>"}` and `logger.warning`s the full op + errors (this is the "it goes in the logs" part). The overlay is untouched.
- Also extend `publisher.py:_rewrite_draft_media_refs` to map `/images/<name>` → `images/<name>` (belt for any historical bad refs at materialize).
- `routes_admin_api.py:start_publish` `_preflight`: after the rev check, run the same validate the preview runs (`validate_site` on merged + the `_staged_image_keys` filter — factor the preview's validate block into a shared helper so preview and preflight can't drift) and on failure raise **422** `{"detail": "The site's content has a problem that needs fixing before it can publish."}`. This kills the raw-`PublishError`-at-`merging` path for validation failures.
- **Client handling of the 422** — `admin-ui/src/api.ts` `patchDraft` returns a third outcome `{kind: "rejected", message}` on 422 (currently ok|conflict; network/5xx retry logic untouched); `opQueue.ts`: on `rejected`, DROP the batch (do NOT re-queue — an infinite retry loop is the failure mode otherwise), advance nothing, call a new `onRejected(batch, message)` callback, continue with the next queued batch. `shell.ts` wires `onRejected` → toast "That change couldn't be saved — refreshing the page preview." + if the active route is an edit view, reload the preview iframe (re-`loadPage` current page) so the DOM reconverges with the real draft.
- Tests: pytest for normalize (leading-slash rewrite only-when-exists, nbsp collapse), structural validation accept/reject per schema, 422 mapping, preflight-validate 422; vitest for opQueue rejected-drop + shell toast wiring.

## 1d. Self-heal — `POST /api/admin/draft/repair`

New module `wixy_server/draft_repair.py` + route in `routes_admin_api.py`:

- Request `{"expectedRev": int}`; 409 on rev mismatch (Inv 9 semantics) and 409 if a publish is running (mirror `post_restore`'s guard). Runs under `tree_lock()` for the read, like its siblings.
- Algorithm, over a copy of the overlay's ops against base = checkout content (`build_site_source` without overlay):
  1. Normalize every SetOp value (same helpers as 1c — src form when file exists, nbsp collapse).
  2. For each collection-rule SetOp: per item index, if the item fails FULL schema (`builder.jsonschema_lite.validate_against_schema`): try filling missing required fields from the base array's same-index item; still failing → replace the whole item with the base item at that index; no base item at that index → drop the item. If the repaired array deep-equals the base value → drop the op entirely (no-op ops are noise).
  3. Non-collection SetOps whose image refs still point at nonexistent files after normalization → discard that op (reverts the key to base).
  4. Build the new overlay at `rev+1` (respect `expected_rev`; write with `save_overlay`), then run the shared validate helper on the merged result.
- Response `{"rev": int, "actions": [<plain-English strings>], "validate": {"ok": bool, "errors": [...]}}`. Actions are owner-readable, e.g. "Restored the Before & After photos to their last published version", "Fixed the link to the shared image", "Removed an unfinished photo entry". Derive them from which rule fired, template-generic (no `gallery` literals in the strings' construction — label by the human page name from the op's file key).
- Errors that survive repair (e.g. template/binding errors from an upstream commit — not overlay-fixable) stay in `validate.errors`; the UI then routes to Report.
- Tests: a fixture overlay reproducing the REAL incident (missing cat ×3 + gutted item + leading-slash ogImage) heals to a clean draft with exactly the expected actions; a repair with an upstream-caused error reports `ok: false`; rev conflict 409.

## 1e. Report — `POST /api/admin/report`

New module `wixy_server/reports.py` + route:

- Request `{"context": str, "note": str | null}` (context free-form slug like `publish-validate` / `publish-failed`).
- Gathers a diagnostic bundle: timestamp, context, note, current validate result, the raw overlay JSON, `publish_job` snapshot (stage/log/error) if any, live pointer, last 5 ledger entries, upstream `aheadOfPublished`, engine version (same source `routes_version.py` uses), and a non-secret settings summary. Writes it to `Storage/projects/<slug>/reports/<UTC yyyymmddTHHMMSSZ>.json` (add `reports_dir` to `wixy_server/storage.py:ProjectPaths`, `mkdir(parents=True, exist_ok=True)` on write).
- Email (optional, engine-generic): `wixy_server/settings.py` gains optional `WIXY_REPORT_SMTP_HOST`, `WIXY_REPORT_SMTP_PORT` (default 587), `WIXY_REPORT_SMTP_USER`, `WIXY_REPORT_SMTP_PASSWORD`, `WIXY_REPORT_EMAIL_TO`, `WIXY_REPORT_EMAIL_FROM` (follow the existing optional-env patterns in that module). If host+to configured: send via stdlib `smtplib` STARTTLS in the worker thread, subject `[wixy/<slug>] Report from the site editor — <context>`, body = short summary + the bundle JSON pretty-printed; a send failure is caught and logged, never a 5xx.
- Response `{"saved": true, "emailed": bool}`.
- Also: `get_publish_preview` logs a `logger.warning` line per validate error whenever it computes a not-ok result (so a blocked owner shows up in logs even if she never presses Report).
- **Deployment config step (operational, not code):** read the fleet Gmail creds from `%AIM_ROOT%\Biosphere\Storage\gmail_smtp_credentials.json` (`{user, app_password, host, port, alert_to}`) and append the six `WIXY_REPORT_*` values to `D:\Servers\Wixy\Storage\.env` (to = `alert_to`, from = `user`) BEFORE merging PR 1, so the Slots swap that deploys the PR picks them up. Editing `Storage\.env` is runtime config and allowed; touch nothing else under `D:\Servers\Wixy\`.
- Tests: bundle written + shape; email path with a monkeypatched SMTP client; unconfigured → `emailed: false` still 200.

## 1f. Publish-time guard for blank image srcs (schemas)

- `builder/schemas/gallery-slider.schema.json`: `before.src`/`after.src` gain `"pattern": "\\S"`; `builder/schemas/gallery-tile.schema.json`: `img.src` likewise (jsonschema_lite already supports `pattern` — confirmed). This makes an abandoned blank photo entry a publish-blocking (friendly-screen) problem instead of a silently-broken live page; the 1c write gate deliberately ignores `pattern` so drafting stays fluid, and 1d's repair drops still-blank items.
- Update the collection-schema tests accordingly.

## 1g. The calm publish experience — `admin-ui/src/publishDrawer.ts` (+ small css)

Replace the two "horrible screen" surfaces. Keep everything else (upstream section wording, diff groups, Inv 25's shell-owned progress — do not touch `shell.ts`'s watch beyond the `onRejected` wiring from 1c).

- **Blocked state** (preview `validate.ok === false`): `renderValidate` no longer renders the raw error list. Instead a `wx-publish-blocked` panel: heading "Publishing is paused", body "Some recent changes have a technical problem, so publishing is paused. You can fix this automatically, or send a report to your developer. Your live site is unaffected.", two buttons:
  - **"Fix it for me"** → `api.repairDraft(expectedRev)` (new api.ts method → `POST /api/admin/draft/repair`); busy-spin via the shared `spinnerButton.ts`; on `validate.ok` → re-fetch the preview and re-render the drawer (now publishable) + transient toast "Fixed — ready to publish." listing `actions` (join with "; ", it's 1–3 short lines); on `ok: false` → swap the panel body to "We couldn't fix everything automatically — please send a report." with the Report button emphasized.
  - **"Send a report"** → `api.sendReport("publish-validate")` → toast "Report sent to your developer." (or "Report saved for your developer." when `emailed: false`).
  - The Publish confirm button is hidden while blocked (today it's clickable and would 502).
- **Running/terminal states**: when confirm is clicked, swap the whole drawer body to a single clean centered state (`wx-publish-running`): a large spinner, "Publishing your site…", and a one-line layman stage caption. Move `PUBLISH_STAGE_LABELS` out of `shell.ts` into a new shared `admin-ui/src/publishStages.ts` imported by both (avoids drawer↔shell import cycles). On success: a large ✓, "Your site is live." + "Version N". On failure: calm state — "Publishing didn't work this time. Nothing changed on your live site, and your edits are safe." + buttons [Try again] (returns to the reviewable drawer state, refetching the preview) and [Send a report] (`context: "publish-failed"`). **Delete the raw `errorBox` `<pre>` entirely** — server detail lives in logs + report bundle.
- Keep `deps.onPublishStarted`/`onPublishSettled` semantics exactly (Inv 25's bridge).
- Tests: extend `publishDrawer.test.ts` — blocked state renders no raw error text, Fix flow happy + partial, Report button both toasts, failure state shows no raw message, success state, stage captions; keep the existing onPublishStarted/settled assertions green.

## 1h. Docs + decisions for PR 1

- `contracts.md`: new routes (`POST draft/repair`, `POST report`), `media` items' `contentSrc`, publish 422 validation preflight, PATCH 422 rejected contract; error-mapping table row for `DraftValidationError`.
- `editor-and-admin-ui.md`: attr read-back + nbsp normalization + rejected-PATCH reconvergence + the new drawer states; `media.md`: `contentSrc`; `publish-pipeline.md`: preflight validate + `/images/` normalization at materialize; `invariants.md`: add an invariant — "the draft overlay is structurally valid by construction: PATCH normalizes image-src forms and rejects collection ops that fail the structural schema subset; full-schema (incl. pattern) enforcement remains publish-time" with the deliberate inline-add-blank exception; `architecture.md` module map rows for the new modules.
- decisions entries: (1) the incident + root causes A–D + the layered fix (editor read-back, contentSrc, write gate, preflight); (2) self-heal + report design (deterministic repair, no AI in the loop, email optional).

---

# WORKSTREAM 2 (PR 2) — the AI chat makes "working on it" impossible to miss, with a live task list

Current behaviour (read `docs/ai/ai-chat.md` first): `routes_chat.py:_stream_events` SSE-relays cmd transcripts (`message`/`status`/`error` events); `ChatStatus.activity` is a **last-activity ISO timestamp** (`chatPanel.ts:activityState` treats <10s-fresh as "working"); the panel's only signal is a small `statusStrip` reading "Assistant is working…"/"Idle". The conversation prompt preamble is `wixy_server/templates/chat_preamble.md` composed/stripped by `wixy_server/preamble.py` (compose/strip are exact inverses; **the template must contain no line that is exactly `---`** — `test_preamble.py` pins this; mind that when you extend it).

## 2a. Task-list protocol (preamble + server parse + SSE event)

- **Preamble** (`templates/chat_preamble.md`): add a section instructing the assistant:
  - Immediately on receiving any request that involves doing work (not a pure question): FIRST reply with one short plain sentence acknowledging what it's about to do, THEN include a fenced task block, and start working.
  - The block format (exact): a fenced code block with info string `wixy-tasks` containing ONLY JSON `{"tasks": [{"label": "<owner-language step>", "status": "pending" | "doing" | "done"}]}` — 2–7 tasks, stable labels, whole block re-emitted (all tasks, updated statuses) each time progress changes, and a final emission with every task `done` alongside its closing summary.
  - Keep it forceful ("ALWAYS", "every time") — compliance is the weak link; the UI degrades gracefully when a block never appears.
- **Server**: new `wixy_server/chat_tasks.py`: `extract_tasks(text) -> tuple[str, list[TaskItem] | None]` — find fenced ` ```wixy-tasks ` blocks (regex, tolerant of surrounding whitespace), parse+validate (labels non-empty strings, status in the three values; malformed → treat as absent but strip the block anyway), return text with the block(s) removed (collapse the leftover blank lines) and the LAST block's tasks.
- `routes_chat.py:_stream_events`: for assistant `text` messages, run `extract_tasks` on the owner-visible text (compose with `_owner_visible` — order: owner-visible strip first, then task extraction). Emit the cleaned text in the `message` event (owner never sees raw JSON), and when tasks were present emit an additional SSE event `{"type": "tasks", "tasks": [{"label": …, "status": …}, …], "messageIndex": <index>}` right after that message event. Replay-on-reconnect naturally re-emits historical task events in order; the client keeps the last one.
- `fake_cmd.py`-driven pytest: scripted transcript with two task blocks (progressing statuses) → asserts stripped bubbles + two `tasks` events in order + malformed-block stripping; preamble round-trip test still green.

## 2b. Unmissable working state + task card — `admin-ui/src/chatPanel.ts` (+ css)

- Replace the `statusStrip` with a prominent **state banner** directly under the conversation header (`wx-chat-work-banner`, `aria-live="polite"`, full-width, impossible to miss on mobile):
  - **Working** (any of: `activityState(...) === "working"`; OR a local `awaitingReply` flag set on successful `send()` and cleared on the next non-user message; OR latest tasks exist with any status ≠ `done`): spinner + bold "Working on your tasks…" (or "Thinking…" when no task list yet). Subtle pulse animation.
  - **All done** (latest tasks all `done`, not working): green ✓ "All tasks completed — review the changes in Edit, then press Publish." (auto-hides after the owner sends another message).
  - Hidden otherwise.
- **Task card** (`wx-chat-tasks`): rendered from the latest `tasks` event, pinned (sticky) between banner and thread so it stays visible while messages scroll: header "Tasks · N of M done", one row per task — `done` → green ✓, `doing` → spinner, `pending` → hollow circle — plus label. Update in place on each event.
- Handle the new stream event in `handleStreamEvent` (`event.type === "tasks"`); extend `ConversationStreamEvent` union + parsing in `api.ts`.
- The keep-alive re-render timer that ages "working" out stays (rename accordingly).
- Vitest: scripted stream events drive banner states (working → completed), task card rendering/counts, awaitingReply covers the send→first-status gap.

## 2c. The conversation LIST also shows work-in-progress

She often leaves the conversation screen; the list (and its 2s poll) should show it.

- Server: `routes_chat.py:list_conversations` (and `/state`'s `chats` snapshot via `chats.py:conversation_summary` — keep one shape) enriches each ready conversation with `"working": bool` — `get_status` per conversation, `activity` timestamp fresh within 10s → true; guard with a small TTL cache (~5s, on `app.state`) so the 2s poll doesn't hammer cmd; any `CmdChatError` → `false`. Concurrency via `asyncio.gather`.
- `chatPanel.ts` list rows: when `working`, the status dot pulses (`wx-chat-dot-working`) and the title gains a muted "— working…" note.
- contracts.md: summary shape + the new `tasks` SSE event documented in §4; `ai-chat.md` updated (protocol, extraction, working cache). decisions entry: the wixy-tasks fenced-block protocol choice (transcript-embedded, provider-agnostic, no cmd-side changes) + the list working-cache.
- Live check after deploy: open a real conversation, ask for a small real change ("change X wording"), watch banner/tasks appear; confirm the list row pulses from another tab.

---

# WORKSTREAM 3 (PR 3) — a beautiful, dedicated Before & After editor

She considers the Before & After page the most important part of the site and currently has NO safe way to add pairs (that's what triggered the incident). Build a dedicated management screen: photo pairs picked from the media library, drag-to-reorder, category/title/sub editing — simple enough for a non-technical phone user.

**Design: a generic, registry-configured "section editor"** (Inv 1 — no site literals in engine code). The engine renders whatever sections the project registry declares; `ca.json` declares one for the gallery page.

## 3a. Registry config — `builder/config.py` + `projects/ca.json`

- `ProjectConfig` gains `admin_sections: tuple[AdminSection, ...]` with frozen dataclasses:
  - `AdminSection {id, nav_label, title, description, page, collections: tuple[AdminCollection, ...]}`
  - `AdminCollection {path, label, item_noun, schema, fields: tuple[AdminField, ...]}`
  - `AdminField {key, kind: "image" | "text" | "choice", label, options: tuple[AdminFieldOption, ...] (choice only; {value, label})}`
  - Parse leniently in `load_project_config` following its existing defensive style (missing/malformed section → skip with a `logger.warning`; empty tuple default).
- `projects/ca.json` addition:
  ```json
  "adminSections": [{
    "id": "before-after", "navLabel": "Before & After", "title": "Before & After",
    "description": "The photos on your Before & After page. Drag to reorder — changes go live when you press Publish.",
    "page": "gallery",
    "collections": [
      {"path": "gallery.sliders", "label": "Drag-to-compare photos", "itemNoun": "photo pair", "schema": "gallery-slider",
       "fields": [
         {"key": "before", "kind": "image", "label": "Before photo"},
         {"key": "after", "kind": "image", "label": "After photo"},
         {"key": "title", "kind": "text", "label": "Treatment name"},
         {"key": "sub", "kind": "text", "label": "Treatment type"},
         {"key": "cat", "kind": "choice", "label": "Category", "options": [
           {"value": "lips", "label": "Lips"}, {"value": "cheeks", "label": "Cheeks"}, {"value": "chin", "label": "Chin & Jaw"}]}
       ]},
      {"path": "gallery.tiles", "label": "Tap-to-zoom photos", "itemNoun": "photo", "schema": "gallery-tile",
       "fields": [
         {"key": "img", "kind": "image", "label": "Photo"},
         {"key": "title", "kind": "text", "label": "Caption"},
         {"key": "cat", "kind": "choice", "label": "Category", "options": [
           {"value": "lips", "label": "Lips"}, {"value": "cheeks", "label": "Cheeks"}, {"value": "chin", "label": "Chin & Jaw"}]}
       ]}
    ]
  }]
  ```
  (Verify `gallery-tile.schema.json`'s exact required fields first and match; the category values mirror the template's filter buttons `data-cat` values — lips/cheeks/chin.)
- `/api/admin/state` gains `"adminSections": [...]` (camelCase serialization of the above) in `_build_state_locked`. contracts.md updated.

## 3b. Route + nav — `admin-ui/src/router.ts`, `shell.ts`

- `Route` union gains `{kind: "section"; id: string}`; path `/admin/section/<id>` (segments `["section", id]`); `sameRoute` compares ids; legacy-hash parsing gets it for free via `routeFromSegments`.
- `shell.ts`: nav buttons for sections render from `state.adminSections` (dynamic — NAV_ROUTES is static today; render section buttons into `navEl` after "Pages"/before "Theme" once state loads, and refresh if the section list changes on a state reload). Route-mount branch `route.kind === "section"`: look up the section by id in the latest state (unknown id → fall back to pages panel) and mount the new panel; pass the shared `OpQueueLike` slice + `api` + a re-fetch hook, mirroring how `mountMediaPanel`/pages panel get their deps.

## 3c. The panel — new `admin-ui/src/sectionPanel.ts` (+ css in `admin-ui/src/style.css`)

`mountSectionPanel(section, deps: {api, opQueue, win?})`:

- Load `api.getContent(section.page)` → for each configured collection, read the array at its dotted path (missing → empty). Keep the arrays as panel state — the panel is the array's source of truth while mounted; every mutation writes the WHOLE array as one op: `opQueue.enqueue({file: section.page, path: collection.path, value})` (the standard collection rule; rev/409 handling is the queue's existing job). After acceptance the draft chip/status bar updates exactly like any edit.
- Per collection, render a card list:
  - **Slider-pair card**: before/after thumbnails side by side with small "Before"/"After" corner tags (obviously distinguishable on a phone), each with a "Change" button → `openMediaDialog` (reuse from `mediaDialog.ts`) → writes `{src: value.src, alt: value.alt}` into that item field (this is post-PR-1, so picks carry `contentSrc`). Text fields as inline inputs (commit on blur/Enter — entity-decode for display (`&amp;` → `&`) and verify what the builder does with a plain `&` on render before deciding whether to re-encode on save; match the composer's behaviour so both paths store the same form). Choice fields as a `<select>` from options. A delete button with `confirm()` ("Remove this photo pair? You can undo by discarding your draft changes."), and a drag handle (⠿).
  - **Reorder**: pointer-based drag-and-drop (pointerdown on the handle, move with a drop indicator, commit on release → reordered array → one op). Also keep ↑/↓ buttons on each card (accessibility + fallback; they emit the same whole-array op). No external libs.
  - **Add flow** — the marquee interaction, so it can never create a half-item: a large primary "Add a photo pair" (label from `itemNoun`) button opens a guided modal: step 1 pick the Before photo (media dialog with upload), step 2 pick the After photo, step 3 title/sub/category form (category defaults to the first option). Save is disabled until every image field and required text (title) is filled — a new item is born schema-valid INCLUDING non-blank srcs. Append to the end of the array (she can drag it up).
- Visual bar: match the existing `wx-` design language (drawer/panel classes, buttons, spacing) and make it feel considered — generous touch targets, clean card grid (2-up on desktop, 1-up mobile), thumbnails `object-fit: cover` with fixed aspect. This page is her pride — polish it. After deploy, do a real device-width pass (390px) via headed Playwright and iterate the CSS live before finalizing (the global "iterate hard CSS on the live page" rule).
- Empty state per collection: friendly "No photos yet — add your first pair."
- Note in the panel footer: "Changes here are drafts until you press Publish." 
- Vitest: panel state logic — load/render counts, add-flow gating (save disabled until complete), reorder emits the reordered whole array, delete/edit emit whole arrays, choice select writes value; keep DOM-light (the pure array-manipulation helpers can be a small exported module for testability, e.g. `sectionPanelModel.ts`).

## 3d. Interplay notes

- The INLINE gallery editing path (hover toolbar on the page itself) remains available and is now safe (PR 1 fixed read-back + the write gate backstops). Both tools produce the same whole-array ops.
- Do NOT block the inline toolbar's add-blank flow; the publish-time `pattern` guard + self-heal + this panel's guided add cover the abandonment case.
- e2e (`e2e/tests/`): a full owner journey — open `/admin/section/before-after`, add a pair (upload two images through the dialog), retitle, reorder via buttons, publish, then assert the built output: `content/gallery.json` gains the item WITH `cat` and `images/...` srcs, and the rendered gallery page contains the new figure. Plus a publish-blocked journey: PATCH an intentionally-broken sliders array via the API (it must be REJECTED by the 1c gate — assert 422), then simulate a legacy-corrupt draft by writing the overlay through a test hook or fixture server to exercise drawer-blocked → Fix-it-for-me → publishable.
- Docs: `editor-and-admin-ui.md` (section panel + config), `contracts.md` (state.adminSections), `architecture.md` map. decisions entry: registry-driven section editor (why config not code, Inv 1; why whole-array ops; why the guided add gates completeness).

---

# CROSS-CUTTING VERIFICATION & SHIPPING

Per PR (three PRs, sequential — ship PR 1, then start PR 2, etc.):

1. `ruff check . && ruff format . && mypy` green; bare `pytest` green (full suite ~expected minutes; capture to a log file once, don't re-run for slices).
2. `npm run typecheck && npm test && npm run build` in `admin-ui/` AND `editor/` (build output committed — CI diffs it).
3. `e2e/`: `npx playwright test` against the local full stack (see `e2e/fixture_server.py` + `docs/ai/testing.md`).
4. `op call aim-doc.doc_rules` → apply mappings; docs + decisions in the same PR.
5. PR → CI green → merge (auto-merge policy; NOT security-gated). After each merge, confirm Slots deployed: `GET https://ca.cinnamons.uk/api/version` sha equals the merged main sha (watch for a few minutes; the deploy poller fast-forwards the slot). If the service needs a bounce, use Devfleet `POST http://127.0.0.1:9999/restart/Wixy` — never Start-Service/SCM.
6. Live verification after PR 1: repeat a small end-to-end publish as the verify skill drives it; confirm the drawer's new states by temporarily PATCHing a schema-invalid array via the API — expect the 422 rejection (gate working), and verify the blocked-state UI by exercising the repair endpoint against a crafted legacy-style bad overlay ONLY if one can be injected without the gate (if not, cover via e2e and skip live). After PR 2: real conversation task-list smoke. After PR 3: real phone-width pass of the section editor + an actual add-pair + publish with a real (small) image, then remove the test pair + publish again (leave her content as you found it, minus the fixes).
7. Env prep (before PR 1 merge): the `WIXY_REPORT_*` values into `D:\Servers\Wixy\Storage\.env` as specified in 1e.

Priorities if anything must give: W0 (unblock her) > W1 > W2 > W3 — but the expectation is ALL FOUR, end-to-end, with the completion report sent only after live verification of the last PR.

Final completion report (mandatory, via the POST in "Your reporting contract"): what shipped per PR (numbers, merge SHAs, live version numbers), the live-verification evidence, any deviations from this brief and why, and anything you deliberately left for follow-up.
