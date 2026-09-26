# Invariants

Numbered, load-bearing rules the engine depends on. **Known exceptions are listed next to
the invariant** — there are no silent carve-outs. Cross-referenced from
[CLAUDE.md](../../CLAUDE.md) and the deep-dives. When you add or change one of these, update
this file and the code together.

### Inv 1 — Engine is generic over projects; no site-specific literals
No `cottage`/`ca`-specific string literals in `builder/` or `wixy_server/` code paths.
Everything site-specific lives in the site repo + `projects/ca.json`. All *state and paths* are
per-slug (no code hardcodes a slug), so a future multi-project deploy is not precluded.
*Enforced by:* `test_uses_cmd_project_from_registry_not_hardcoded` and the registry design.
*Known exception / scope (important):* **v1 serving is single-project by construction.**
`app.py:create_app` raises `RuntimeError` unless exactly one project is registered, and the
public routes (no slug in the path), the admin UI, `app.state.publish_job`, `tree_lock`, the
upstream watcher, and the single `WIXY_CF_ACCESS_AUD` are all single-project. "Nothing may
assume one project" holds for the **builder/state** layer — the **serving** layer *does* assume
exactly one (per-slug state is future-proofing, not active multi-tenancy). Tests and fixtures
may name `ca`/the mini-site.

### Inv 2 — Frontend bundles are committed; CI fails on drift
`wixy_server/static/{admin,editor}/*` are built by esbuild and **committed**. After touching
`admin-ui/src` or `editor/src` you must `npm run build` and commit the regenerated output;
CI runs `git diff --exit-code -- wixy_server/static` and fails on any difference.
*Exception / subtlety:* `.gitattributes` forces `* text=auto eol=lf` specifically so a
Windows-built sourcemap's `sourcesContent` doesn't differ from CI's Ubuntu build (decisions/
00016). Never revert that.

### Inv 3 — `data-wx-*` is strict: a missing key fails the build
Every binding key must exist in the JSON; the builder raises `BuildError` (build) or records
a `binding-error` (validate) on a missing key — no silent fallback to template text.
*Exception:* unbound literal text is allowed for pure structure/decoration (e.g. `❦`,
`★★★★★`) — and even those should be bound if trivially possible (`spec/02` §2).

### Inv 4 — Build output is deterministic
`build(templates, content, theme)` is a pure function; `hash_output_tree` must be stable.
`content.write_json_canonical` = 2-space indent, `sort_keys=True`, `ensure_ascii=False`,
trailing `\n`; all outputs written UTF-8 `newline="\n"`; `build_nav` sorts by
`(navOrder, slug)`; sitemap sorts slugs; `generate_fonts_url` sorts+dedupes weights.
*Exception:* the generated Google-Fonts URL need not byte-match the hand-written one — parity
gates *rendering*, and tests must not assert the URL string (`spec/02` §4).

### Inv 5 — The builder tolerates a partially-migrated site
`SiteSource.theme` may be `None`; any page's content may be `{}`. With no theme, no
`theme.css` is emitted and `apply_head` leaves the page's existing fonts `<link>` untouched
(never overwrites it with a font-less URL). `SiteSource.content_dir` lets `validate`
distinguish "not migrated yet" (file absent → skip) from "migrated but malformed" (present
but missing `meta` → error). *Do not reintroduce a hard content/theme requirement*
(decisions/00004).

### Inv 6 — Draft overlay is last-writer-wins per key; no CRDT
Single-operator tool. `merge_overlay` applies overlay ops over `origin/main` per key; an AI
upstream edit to a key you haven't touched flows into your draft, a key you *have* touched
keeps your draft value until published or discarded. Do **not** build multi-user conflict
resolution.
*Exception / rule:* collections overlay as the **whole array** (no path indexes into an
array); scalar/meta/theme keys overlay per dotted leaf.

### Inv 7 — Live is an immutable per-SHA build; the swap is one atomic pointer write
`builds/<sha>/` is immutable and content-addressed. Going live = `save_live_pointer`
(tmp+`os.replace`) only. Publish steps 1–4 never touch the serving pointer; a crash, bad
merge, or half-publish cannot mutate the live site.
*Known caveat (not a violation):* publish **step 5** is a sequence of four individually-atomic
writes (live → ledger → overlay → prune), not one transaction — a kill mid-sequence can leave
`live.json` advanced while the ledger/overlay lag (recoverable, but not atomic as a set).

### Inv 8 — The Storage checkout is fast-forward-only
`ensure_checkout` does `git fetch` + `git merge --ff-only`; a non-ff local state raises
`CheckoutError` and is **never force-updated**. The initial clone is a full clone (no
`--depth`/`--single-branch`) because restore needs arbitrary historical trees.
*Exception:* restore uses a detached scratch `git worktree add` at an arbitrary sha — a
separate working tree sharing only the object DB, safe alongside a fetch/merge.

### Inv 9 — Optimistic concurrency: every overlay mutation checks & bumps `rev`
`apply_patch`, `add_page`, `delete_page`, and `discard_all` all validate `expected_rev` and
return an overlay at `rev+1`. This makes a racing stale PATCH always 409.
*Exception:* none — even an idempotent-in-effect `delete_page` and a `discard_all` still bump
`rev` (so an in-flight stale PATCH after a discard still 409s).

### Inv 10 — `data-wx-if` differs between publish and preview
**publish** extracts falsy branches (they vanish and their subtree is not walked); **preview**
keeps them, marks `data-wx-hidden="1"`, and *still walks/validates* their bindings.
`validate` deliberately runs in preview mode so a currently-hidden branch's bindings are
still checked.
*Exception:* none — this asymmetry is intentional and load-bearing for the editor.

### Inv 11 — `version` is monotonic and never reused
`next_version = max(version)+1` across the whole ledger; a restore consumes a **new** version
even though it revisits an old sha. Every ledger entry (publish or restore) consumes one.

### Inv 12 — CF Access JWT gates admin routes; Server chat adds an in-app gate
Bind `127.0.0.1` only (the tunnel is the sole ingress). `/admin*` + `/api/admin*` require a
verified CF Access JWT (`aud` = the app AUD, `iss` = the team domain, signature vs cached
JWKS). `/internal/*` + `/healthz` return a bare 404 when a `Cf-Ray`/`Cf-Connecting-Ip`
header is present (they answer loopback probes only). The embedded AI chat has **no publish
tool** — it cannot publish.
*Exception:* `WIXY_DEV_NO_AUTH=1` bypasses auth for local dev/tests **only** — the app
refuses to start if it's set while `WIXY_ENV=prod`. `/api/version` is public by design.
The Server chat's `/api/admin/server/*` routes also require its short-lived in-app unlock
token (except PIN unlock and signed media URLs); this is an additional gate layered on CF
Access, never a replacement. The PIN is verified by cmd and Wixy stores no PIN value.

### Inv 13 — All AI inference goes through cmd; never the Anthropic API
No direct Anthropic/Claude API calls anywhere in the engine. `wixy_server/cmdchat.py` is the
single chokepoint to cmd (localhost `9320`/`9321`, unauthenticated, no keys). Every wixy
conversation is a real cmd chat.
*Exception (roadmap only):* the not-yet-built independence phase's *standalone* edition
(`spec/independence/05`) adds an optional `anthropic` backend using the owner's own key — an
operator-decided exemption that applies only to that separate edition, never to this engine.

### Inv 14 — The code requires Python ≥ 3.14 (PEP 758 syntax)
`bootstrap.py:52` (`except CheckoutError, BuildError:`) and `cmdchat.py:186`
(`except json.JSONDecodeError, TypeError, UnicodeDecodeError:`) use **unparenthesized
multi-exception `except`**, legal only on Python ≥ 3.14 (PEP 758). This is **not** Python-2
syntax and **not** a bug — it catches all listed types. `pyproject.toml` pins
`requires-python = ">=3.14"` and the deploy uses the pythoncore-3.14 interpreter.
*Verified:* `py_compile` of both files is clean on 3.14. It **would** be a `SyntaxError` on
≤3.13 — do not "fix" it, and do not run this repo on an older interpreter.

### Inv 15 — Tests parallelize at a fixed `-n 4`, never `-n auto`
`pyproject.toml` `addopts = "-n 4 -m 'not live_cmd'"`. The cap is deliberate — the suite runs
on the hub VM next to production cmd, and `-n auto` caused a real outage (2026-07-07). Never
pass `-n auto`, never lower the cap to "fix" a rare full-suite flake, never add per-test
skips/retries (decisions/00025, 00027). See [testing.md](testing.md).

### Inv 16 — Media: SVG rejected, EXIF stripped, content-hash dedupe, no transient data loss
`media.py:process_upload` rejects SVG (XSS) and non-image MIME, rejects >15 MB, strips EXIF
(client-photo privacy), auto-orients, downscales to the project's `maxLongSidePx`, and names
the file by the sha256 of the **final re-encoded bytes** (re-upload dedupes). At publish, a
staged file is copied into `images/` **before** `builder validate`, and the staged original
is deleted only **after** validate passes — so an aborted publish (`git reset --hard`) never
loses data (decisions/00024).

### Inv 17 — Builds are pruned to the last 20 ledger versions; restore can rebuild
`_prune_builds` keeps the build dirs referenced by the last `_MAX_KEPT_VERSIONS = 20` ledger
entries (by count) plus always the live one. A pruned version is reconstructable via
`restore.ensure_build` from its sha (annotated tag `wixy-publish-v<N>` is pushed for every
publish — even a pure-upstream one with no new commit — so history survives Storage loss).

### Inv 18 — Two-tier locking; `tree_lock` never held across build/verify
Intra-process = the re-entrant `treelock.py:tree_lock()` over the Storage working tree, held
one mutation-step at a time and for the duration of a tree read — **never across the
multi-second build/verify** (which read a committed, quiescent tree). Cross-process = the
`locks/publish.lock` file, owned by `run_publish` for the whole pipeline; the watcher checks
it first and yields. A hard process-kill orphans the lock, which **self-heals after
`_LOCK_STALE_AFTER_S = 600s`** so the watcher resumes (decisions/00030).

### Inv 19 — Never author in the deployment target
Never edit `D:\Servers\Wixy\` — it's a Slots blue/green deployment target. Branch in this
repo → PR → merge `main`; Slots deploys. A machine-check hook (`worktree-guard`) hard-denies
Edit/Write into a primary checkout under the Servers tree.
*Exception:* the site-repo checkout at `Storage\projects\ca\repo\` is machine-managed runtime
data written only by the publisher + fetch loop — it is *not* an authoring clone and the
"never author in D:\Servers" rule doesn't make it one (agents get cmd worktrees instead).

### Inv 20 — Hand-synced client/server ports must not drift
Two pairs are deliberately duplicated and must be kept identical by hand:
(a) `admin-ui/src/protocol.ts` ≡ `editor/src/protocol.ts` (the postMessage protocol, byte-
identical, decisions/00015); (b) `admin-ui/src/themeVars.ts` / `googleFonts.ts` are TS ports
of `builder/theme.py:generate_theme_css` / `generate_fonts_url` and must produce byte-
identical output to the server (so the theme panel previews without a round-trip;
`googleFonts.test.ts` mirrors the Python tests). A third pair joined in decisions/00075:
(c) `builder/markdown_inline.py` ≡ `editor/src/markdownText.ts` (inline-markdown render
for text bindings) — locked by ONE shared fixture, `builder/tests/fixtures/
markdown-inline.json`, which both pytest and vitest load. A fourth pair joined in
decisions/00117: (d) `builder/bindings.py`'s `ATTR_ITEM_HIDDEN` (`"data-wx-item-hidden"`) ≡
`editor/src/contentModel.ts`'s `ATTR_ITEM_HIDDEN` — the preview-mode marker attribute a hidden
collection item carries, taught to the editor's whole-array DOM read-back (Inv 28).

### Inv 21 — Deploy scripts avoid two Windows footguns
`launcher.py` runs the slot's venv as a **blocking `subprocess.run`**, never `os.execv` (on
Windows `execv` spawns a separate process and orphans the server from Devfleet's Job Object —
decisions/00037). `deploy.py:_pip_install_venv` builds `<slot>/.venv.new` fresh and
**atomically swaps it in** (`_atomic_swap_dir`), never `shutil.rmtree` in place (an in-place
delete fails because the build-step runs *using* that venv's interpreter — decisions/00039).
`deploy.py` hooks are `fn(ctx)`-arity (decisions/00040).

### Inv 22 — Every `/admin/static/*` URL referenced from served HTML is content-fingerprinted
Any `src`/`href` into `/admin/static/` must carry `?v=<sha256(file)[:10]>`
(`staticcache.fingerprinted_url`), and the document carrying those URLs must itself be
non-heuristically-cacheable (`GET /admin` is `Cache-Control: no-cache`; preview HTML is
`no-store`). Otherwise a redeployed bundle is invisible behind the browser's heuristic cache
for days — the bug decisions/00069 fixed. The shell is rewritten by construction
(`app.py:_fingerprint_shell_assets`); anything new that references `/admin/static/*` from a
served document must go through `fingerprinted_url` too. *Enforced by:*
`test_staticcache.py` (incl. the no-bare-references guard). *Known exceptions:* (1) the
`?uxer=`-gated Uxer compliance-bridge `import()` (AI-tooling-only surface, gitignored
local build) — see decisions/00069's "what to watch for"; (2) **outstanding gap, found
2026-08-10 while fixing the sibling Inv 34**: `FingerprintedStaticFiles.get_response`
grants `immutable` on `?v=` PRESENCE alone, never verifying the value against the served
file's actual current hash — the same class of bug decisions/00130's audit round 2 (F1)
fixed on the public-site sibling of this pattern. Not yet fixed here; see decisions/00130's
addendum for the exact follow-up shape.

### Inv 23 — Overlay chrome is stripped before any DOM value crosses into a draft op or editor seed
The overlay injects chrome INTO content elements (today: the `data-wx-if` eye
toggle, `OVERLAY_CHROME_SELECTOR` in `editor/src/dom.ts`). Any value read from the
live DOM — whole-array list reconstruction, popover/composer seeds, link labels —
must go through the chrome-free readers (`chromeFreeInnerHtml` /
`chromeFreeTextContent` in `editor/src/contentModel.ts`), never raw
`innerHTML`/`textContent`, or the chrome's markup and label land in committed
content (the 2026-07-21 incident: 👁️-and-button pollution staged in the prod
draft, decisions/00073). Corollary: any code path that overwrites an if-bound
element's `innerHTML` must re-attach its eye toggle (`ensureIfToggle`).

### Inv 24 — The admin shell's root document never scrolls; chrome sizes to the dynamic viewport
The admin is an app shell: ONLY the middle content (`.wx-main`, the preview iframe's
own document) may scroll. `admin-ui/src/style.css` (and the mirrored pre-paint inline
rule in `admin_shell.html`) sets `html, body { overflow: hidden; overflow: clip;
overscroll-behavior: none; }` — no touch/wheel/keyboard pan, URL-bar pan, scroll
chaining out of the preview iframe, pull-to-refresh, or (with `clip`) even a
programmatic `scrollTop` can move the chrome. Fixed chrome sizes to the DYNAMIC
viewport (`.wx-shell`, `.wx-drawer`: `height: 100vh; height: 100dvh`; the loading
screen's mins; toasts at `bottom: calc(20px + 100vh - 100dvh)`), because `100vh` is
the LARGE mobile viewport — with the URL bar shown it left the shell taller than the
visible area and the whole page scrolled the bars off (the operator's second
edit-chrome report, decisions/00085). *Enforced by:* `e2e/tests/mobile-edit-chrome.
spec.ts`'s "shell root no-scroll" describe (forced-overflow shell attacked with a
real wheel gesture AND programmatic scrolls; served-bundle dvh assertions;
middle-still-scrolls guard). *Watch for:* anything new fixed-bottom reuses the
`calc(… + 100vh - 100dvh)` offset pattern; panels scroll inside `.wx-main`, never
the root; the preview document is intentionally NOT overflow-constrained (it is the
middle that must scroll). *Corollary (decisions/00110):* inside `.wx-main`, a
full-height interactive panel (the chat conversation view) is itself a flex column
(`height: 100%`) with exactly ONE scroll region — the chat thread (`flex: 1;
min-height: 0; overflow-y: auto`) — while its composer is pinned by layout
(`flex: none` + `env(safe-area-inset-bottom)`), never by `position: sticky` and never
reachable only by scrolling `.wx-main`. The pre-00110 stacked layout (a
`max-height: 60vh` thread inside a scrolling `.wx-main`) was the "double-scroll" the
operator reported; e2e (`chat-ux.spec.ts`'s layout-invariants leg) asserts the thread
scrolls, `.wx-main` does not, and the composer is fully on-screen.

### Inv 25 — Publish run/completion feedback is shell-owned, never drawer-owned
The publish drawer may be closed mid-publish, a publish may start in another tab or
from the AI assistant, and the page may be reloaded mid-job — so the admin SHELL
(not the drawer) owns "a publish is running / it just went live". While
`state.publishJob.isRunning` — or the `publishInFlight` bridge (set synchronously by
the drawer's `onPublishStarted`, cleared by `onPublishSettled`, covering the
confirm→POST race where the first poll could beat the job registering, incl. the
409 path where NO job ever starts) — a shell watch (`ensurePublishWatch`/
`publishWatchTick` in `shell.ts`) polls `/api/admin/state` every 2s, and
`renderTopBar` turns the status bar into the progress surface: the Publish button
swaps to `wx-button-busy` + `wx-spinner` ("Publishing…", full opacity) and the chip
narrates the stage in layman wording (`PUBLISH_STAGE_LABELS`). The terminal job
fires exactly ONE toast — "Published — version N is live." (6s, info) or "Publish
failed — your draft changes are safe." (8s, error) — guarded twice:
`announcedPublishVersion` dedupes the drawer's success path against the watch, and
`publishWatchSawRunning` means a STALE terminal job from a previous publish (the
server keeps the last job) is never announced. The drawer keeps its inline SSE
stage detail and spins its own confirm button (`setButtonBusy` from `spinnerButton.
ts`, shared), but completion feedback must never depend on the drawer staying open.
*Enforced by:* `admin-ui/tests/shell.test.ts`'s "publish progress feedback"
describe (busy affordance + stage narration, drawer-closed completion, exactly-once
dedupe, stale-job guard, conflict bridge-drop, failure toast) and `publishDrawer.
test.ts`'s onPublishStarted/busy-confirm tests. *Watch for:* any new publish
trigger must set the bridge + fire `onPublishStarted` (or be discoverable via
`publishJob.isRunning`); the drawer's confirm hides on success (a stale
`expectedRev` makes a second click meaningless); toast lifetime params are the 3rd
arg of `showTransientToast`.

### Inv 26 — The draft overlay is structurally valid by construction
Every `SetOp` a `PATCH /api/admin/draft` batch carries is normalized then structurally
checked (`wixy_server/draft_validate.py`: `normalize_set_ops` → `check_structural`, against
`builder/schemas/*.json` for every `COLLECTION_RULES` key plus the two nested special shapes)
BEFORE `apply_patch` runs. A violation raises `DraftValidationError` → **422**, the whole
batch rejected and the overlay left untouched — never a partial or structurally-broken write
(the 2026-07-28 gallery incident: three collection items each missing a required field,
decisions/00095). The check is deliberately STRUCTURAL only
(type/required/properties/`additionalProperties`, `jsonschema_lite`'s `skip_pattern=True`) —
a freshly-added, not-yet-filled-in list item (blank strings, no image picked yet) is a valid
mid-edit draft state, not a violation. Pattern-level rules (e.g. a non-blank image `src`) are
enforced separately and only at publish/repair time (`validate_merged_for_publish`, the full
schema check) — see [contracts.md](contracts.md) §8.
*Exception:* overlay data written BEFORE this gate existed, or a future gap in its
`COLLECTION_RULES`/nested-shape coverage, isn't retroactively validated — this invariant
covers writes going forward only. `POST /api/admin/draft/repair` (decisions/00095, 00096) is
the deterministic recovery path for already-corrupted data, not a live-caught violation of
this invariant. *Note:* `visible` (Inv 28) is a schema-legal optional boolean on every
collection item's schema (`builder/schemas/gallery-slider.schema.json`/`gallery-tile.schema.json`)
— an item carrying `visible: false`/`true` passes this gate like any other well-typed field; a
non-boolean value is what the gate correctly rejects.

### Inv 27 — A published staged upload is never left as a dead draft ref
A publish CONSUMES the staged uploads it references: `publisher._materialize_locked` copies
`draft/media/<name>` into the repo as `images/<name>`, rewrites the srcs, and deletes the
staged copy — so `/admin/draft-media/<name>` dies at that moment, and any client still holding
the pre-publish content is holding dead refs (decisions/00115). Two independent defences, both
required, neither sufficient alone: (a) the mounted section panel re-reads its collection on
publish and on repair (`SectionPanel.refresh()`, wired in `shell.ts`), so it never re-sends a
pre-publish array; (b) `normalize_set_ops` re-points an already-published upload on the way in
(`rewrite_published_draft_media_src`) — **only** when the staged copy is gone AND
`images/<name>` genuinely exists, so a still-staged upload is untouched and a name that
resolves nowhere stays put as the real `missing-image` error it is.
*Exception:* a src that resolves NOWHERE is deliberately left alone by (b) — surfacing as a
publish-preview `missing-image` and repaired at the item level by `POST draft/repair` (which
falls the item back to its last published version), never silently rewritten to a file that
doesn't exist.

### Inv 28 — Collection items: `visible: false` hides; absent/`true` shows (sibling of Inv 10)
An optional boolean `visible` on any collection list item (`builder/bindings.py:_expand_list`):
absent or `true` = shown (byte-identical to pre-existing behavior — the convention is opt-in
and additive); only an explicit `false` hides it. Mirrors Inv 10's publish/preview asymmetry
exactly: **publish** drops the item entirely (never cloned, walked, or appended — it never
reaches the built HTML); **preview** keeps it, marks the clone `data-wx-item-hidden="1"`
(`ATTR_ITEM_HIDDEN`), and still walks/validates its bindings, so a currently-hidden item's
broken binding is still caught by `validate` even though it no longer fails a `build`.
Deliberately NOT built on top of `data-wx-if`: `_expand_list` appends a list-item clone AFTER
`_walk` returns, so a publish-mode `el.extract()` on the still-detached clone would be undone
by the append, and `_evaluate_if` hard-fails on a missing key — both verified dead ends
(decisions/00117). **Canonical storage form: the key exists ONLY when `false`** — both write
paths (the admin-ui toggle, `sectionPanel.ts`'s `renderToggleField`/`removeItemField`, and the
editor overlay's whole-array read-back, `contentModel.ts:readListValue`) omit the key rather
than writing `true`, keeping the two convergent.
*Enforced by:* `builder/tests/test_bindings.py::TestListItemVisible`,
`wixy_server/tests/test_preview.py`/`test_draft_validate.py`, `admin-ui/tests/sectionPanel.test.ts`/
`sectionPanelModel.test.ts`, `editor/tests/contentModel.test.ts`/`listOps.test.ts`/
`overlay.test.ts`, and `e2e/tests/section-panel.spec.ts`/`collection-edit.spec.ts`.
*Exception:* none — this asymmetry is intentional, mirroring Inv 10's own "no carve-out" note.

### Inv 29 — Every URL-bearing binding value must resolve to an allowed URL scheme
`builder/bindings.py:_apply_href` (for `data-wx-href`) and `_apply_attrs` (for a
`data-wx-attr` pair whose TARGET attribute is `href`/`src`/`action`/`formaction`/`xlink:href`
— decisions/00129 generalized this from href-only) reject (build) / record (validate) any
value whose scheme isn't `http`/`https`/`mailto`/`tel`, or that isn't schemeless (a relative
path, `#fragment`, or empty string) — `builder/sanitize.py:is_safe_href`, reusing
`sanitize_rich_lite`'s own `nh3`-backed `_URL_SCHEMES` allowlist so scheme parsing (leading
whitespace, embedded control characters, mixed case — all real bypass classes) matches what
`nh3` already does for rich-text `href` values, not a weaker hand-rolled check. Applies to
EVERY such binding (contact page tel/mailto, nav items, social links,
`gallery.sliders.sourceUrl`, the Contact map's `data-wx-attr="src:@mapSrc"` iframe embed) — a
generic render-layer guard keyed on the TARGET ATTRIBUTE NAME, not a per-field or
per-binding-kind special case (decisions/00121/00123/00129). A `data-wx-attr` pair targeting
any OTHER attribute (`data-cat`, `data-booking-url`, …) is free text and never scheme-checked
— only attribute names a browser itself navigates/fetches/submits to are covered.
*Enforced by:* `builder/tests/test_bindings.py::TestHrefBinding`/`TestAttrBinding`,
`builder/tests/test_sanitize.py::TestIsSafeHref`.
*Exception:* none — an admin-side display guard (e.g. `renderUrlField`'s `/^https?:\/\//i`,
decisions/00120) is a UX convenience only and must never be treated as the safety boundary;
this invariant is enforced at render time regardless of what any admin control shows.

### Inv 30 — A `choice` field's `optionsFrom` source, once staged, re-renders every dependent field
When an `AdminField` declares `optionsFrom: "<collection path>"` (decisions/00124), its
selectable options are resolved LIVE from that other collection's current staged items
(`resolveChoiceOptions`, `sectionPanel.ts`), not a static list — so any edit that changes the
SOURCE collection (rename a label, add/remove an item) must re-render every field that
depends on it, in the SAME staged edit, or the dependent dropdown silently shows stale
options until an unrelated re-render happens to occur. `stageLocal` and `undoLast` both
re-render `dependentCollectionsOf(collection)` (scans `section.collections` for any OTHER
collection whose fields declare `optionsFrom === collection.path`) in addition to the
collection they were called for; `discardUnsaved` already re-renders every collection
unconditionally and needed no change. A brand-new item's `blankItem()` has the same class of
trap in miniature: defaulting a choice field from `field.options[0]` is always empty for an
`optionsFrom` field, so `blankItem` takes an optional `resolveOptions` callback (default
`field => field.options`, unchanged for every pre-existing caller) and `sectionPanel.ts`
passes `resolveChoiceOptions` through it — without this a newly-added item silently defaults
its category to blank instead of the first real one.
*Enforced by:* `admin-ui/tests/sectionPanel.test.ts`'s `"mountSectionPanel — dynamic choice
options via optionsFrom (decisions/00124)"` block (the unsaved-label-edit test is red without
the `dependentCollectionsOf` wiring, green with it) and `sectionPanelModel.test.ts`'s
`describe("blankItem")` `resolveOptions` cases.
*Exception:* none — every write path that stages a collection (`stageLocal`, `undoLast`,
`discardUnsaved`) must keep every `optionsFrom`-dependent field in sync; a future write path
that stages a collection without going through one of these three would violate this
invariant silently (no test would catch a brand-new, not-yet-existing call site) and must be
audited against this invariant when added.

### Inv 31 — A collection's tab visibility never gates whether it re-renders
When a section groups its collections under a tab strip (`AdminCollection.tab`, decisions/
00125), every collection's inner body is built and kept in `collectionBodies` — and re-rendered
by `stageLocal`/`undoLast`/`dependentCollectionsOf`/a successful Save — regardless of whether
its tab is currently the visible one. Tabs are a purely additive DOM visibility layer
(`renderBody`, `sectionPanel.ts`) toggling `hidden` on each tab's panel wrapper; they must
never lazily mount, unmount, or skip re-rendering a hidden panel's content, or Inv 30's
"dependent dropdown updates immediately" guarantee would silently stop holding the moment its
source collection lives on a DIFFERENT tab than its dependent — the single most likely real
shape of a multi-tab section (a "Categories" tab feeding a "Photos" tab's dropdowns).
*Enforced by:* `admin-ui/tests/sectionPanel.test.ts`'s `"mountSectionPanel — tabs (decisions/
00125)"` block, specifically the cross-tab Inv-30 test (a category renamed while its tab is
hidden already shows decoded in the OTHER tab's dropdown once switched to, proving the update
happened at stage-time, not lazily on tab-switch).
*Exception:* none — a section with ≤1 distinct tab group renders with no tab strip at all
(unchanged from before this capability existed), so this invariant is vacuous for every
section that hasn't opted into tabs.

### Inv 32 — `wixy-live` mirrors the live pointer; server-only writer; advisory
The site repo's `refs/heads/wixy-live` branch always reflects the CURRENT live pointer's sha
— `checkout.push_live_mirror(repo, sha)` force-pushes it at the end of every successful
publish (`publisher.py`'s swap stage) and every restore (`restore.py`, after the live-pointer
flip). This is the ref the GitHub Pages deploy workflow (site repo) watches, so the public
custom domain always serves exactly what the owner last published or restored to — **never**
the site repo's `main` HEAD, which agents merge content to routinely without the owner's
involvement (decisions/00126). Force is required: a restore moves the ref BACKWARDS to an
older sha already on the remote.
*Exception:* `push_live_mirror` is deliberately advisory-only — it retries once, swallows
every exception a git subprocess can raise, and returns `False` on failure rather than
raising. A failed mirror push never fails or blocks a publish/restore (publish logs a
`WARNING` job-log line; restore logs via `logger.warning`); the ref simply lags until the
next successful publish/restore heals it. *Known gap (not a violation):* GitHub resolves a
push-triggered workflow run from the pushed commit's own tree, so a restore to a sha
predating `pages.yml`'s existence on `main` moves `wixy-live` correctly but triggers no Pages
run — see [runbook.md](runbook.md)'s GitHub Pages section for the manual-dispatch recovery.

### Inv 33 — Public page URLs are extensionless; both shapes resolve forever; zero redirects
`page_url` (`builder/nav.py`) emits `"/"` for `index`, else `"/<slug>"` (decisions/00128
supersedes the original spec/02 §3 `/<slug>.html` convention) — everything computed from it
(nav hrefs, canonical/og:url, sitemap `<loc>`) follows. Resolution is strictly WIDER than
emission: `builder.serving.resolve_site_path`, shared by `wixy_server/routes_public.py` and
`builder/cli.py:cmd_serve`, accepts the literal `.html`-suffixed path too — on purpose,
forever, because GitHub Pages (the public domain's actual host) cannot redirect, so the
server deliberately mirrors Pages rather than diverging from it. Never add a redirect from
`/<slug>.html` to `/<slug>` (or the reverse) anywhere in this stack — that would desync the
server from what Pages itself does for the exact same URL.
*Exception:* none for the shapes themselves — but the trailing-slash case is a deliberate,
load-bearing NON-resolution: `/<slug>/` always 404s (verified live against Pages — no
directory-index fallback there either), so `resolve_site_path`'s `.html`-append retry
explicitly skips any request path ending in `/`. Do not "fix" this into a 200 or a redirect;
that would be the resolver disagreeing with what Pages actually serves for that path.

### Inv 34 — Every public-site `href="site.css"`/`src="site.js"`/`href="theme.css"` is content-fingerprinted
Sibling of Inv 22, same failure mode, different code path: `builder/build.py` calls
`assetcache.fingerprint_asset_references` once all three assets' final bytes are known,
rewriting every page's bare reference to `...?v=<sha256(file)[:10]>` in place. Otherwise a
CDN edge or browser that cached one before a publish keeps serving those exact pre-publish
bytes for up to 24h afterwards — a real production incident (decisions/00130): a merged,
published fix looked "unchanged" because Cloudflare's edge, not the server, was still
serving stale bytes. `wixy_server/routes_public.py:_cache_control_for` serves `public,
max-age=31536000, immutable` only when the request's `?v=` is VERIFIED to equal
`content_fingerprint(resolved)` — presence alone is not sufficient (decisions/00130's audit
round 2, F1: a naive presence-only check lets a stale fingerprint replayed during a
publish's propagation window pin the current bytes under the old URL immutably, poisoning
it against a future publish that reverts to the old content). A bare or mismatched request
for the same asset keeps the unchanged `public, max-age=86400` default. *Enforced by:*
`builder/tests/test_assetcache.py`, `test_build.py::TestAssetFingerprinting`,
`test_routes_public.py`'s fingerprinted-vs-mismatched-vs-bare cache-control tests. *Known
exceptions:* (1) images are not fingerprinted (decisions/00130's "what to watch for" —
upload filenames are effectively-unique by convention today, a materially different risk
shape); (2) `wixy_server/staticcache.py`'s `FingerprintedStaticFiles` (Inv 22, the admin-side
sibling this invariant mirrors) still grants immutable caching on `?v=` PRESENCE alone,
the same class of gap F1 fixed here — not yet fixed there as of this writing; flagged, not
fixed, pending its own follow-up (see decisions/00130's addendum).

### Inv 35 — A non-indexable build allows crawling; it never disallows it
`builder/sitemap.py:generate_robots_txt(indexable=False)` emits `User-agent: *\nAllow: /\n`
— never `Disallow: /` or any other crawl block. A blocked page's per-page `<meta
name="robots" content="noindex">` (`templates.apply_head`) is unobservable to a crawler that
was never allowed to fetch the page in the first place (Google's own documented behavior); a
`Disallow`'d-but-linked URL can still surface in results with no snippet, the opposite of
what "non-indexable" is supposed to achieve. The two signals divide the work cleanly:
`robots.txt` stays permissive (crawl control only, never privacy), the per-page `noindex`
meta is what actually excludes the page from the index, and `sitemap.xml` is omitted
entirely (no `Sitemap:` directive either) so there's nothing pointing a crawler at content
this build isn't ready to be indexed for (decisions/00135). Do not "fix" this back into a
crawl block to make a staging host feel more private — `robots.txt` was never a privacy
mechanism; a genuinely confidential staging surface needs authentication, not this file.
*Enforced by:* `builder/tests/test_sitemap.py::TestGenerateRobotsTxt`,
`test_build.py::test_robots_allows_crawling_when_not_indexable`,
`test_cli.py`'s indexable-override tests, `test_render.py::test_no_noindex_meta_when_indexable`.
*Exception:* none — this applies to every non-indexable build regardless of project or
deployment target (`ca.cinnamons.uk` staging today; any future project registered the same
way).

### Inv 36 — Static redirect aliases are validated by strict rejection, never normalization
`builder/staticredirects.py:validate_static_redirects` checks every source/target against
`re.fullmatch` — **never** `re.match` combined with `^...$` anchors, because Python's `$`
matches immediately before a trailing `\n`, so an anchored `match()` check lets a value like
`"/home\n"` silently pass as if it were the clean `"/home"` (confirmed empirically during
decisions/00136's review). A source or target failing the grammar is a fatal `BuildError` —
never coerced, trimmed, lowercased, or otherwise "cleaned up" into a passing form. This
applies to every check in this module: source shape, source-is-not-root, source/real-page
collision (checked against the actual emitted `<slug>.html` filename, not just the raw
content-model slug), source/reserved-name collision (`404`, plus the lowercase Windows
device-reserved stems `con`/`prn`/`aux`/`nul`/`com1-9`/`lpt1-9`, since the real deployment
targets are Linux CI + GitHub Pages but this repo's own dev/test environment is Windows),
target shape, target-is-not-literally-`"/index"` (the homepage's real page-content slug IS
`"index"`, but its canonical URL is `"/"` — accepting `/index` as a target would generate a
page whose canonical URL conflicts with the homepage's own, caught in decisions/00136's
review), and target-resolves-to-a-real-page (which also rejects redirect chains/loops, since
an alias source is already proven disjoint from every real page slug by the checks before
it — a target can only ever be a real page, never another alias). The JSON loader itself
also rejects a **duplicate key** in the source file outright (`object_pairs_hook`) rather
than silently keeping only the last value, which is what plain `json.loads` does by default
(confirmed empirically) — the same reject-don't-normalize discipline applied one layer
earlier, before validation even runs. Generated alias pages carry no query string or URL
fragment from the original request and contain no `<script>` — this is deliberate,
script-free, deterministic HTML for retired-path equivalence, not a general redirect proxy.
*Enforced by:* `builder/tests/test_staticredirects.py` (the full module), incl. explicit
trailing-newline/CRLF/whitespace-variant, duplicate-key, Windows-reserved-name, and
`/index`-target rejection tests.
*Exception:* none — a future relaxation of the grammar (e.g. multi-segment paths) must keep
the same reject-don't-normalize discipline and the same `fullmatch` requirement.

### Inv 37 — `X-Robots-Tag: noindex` on exactly published media + the version-JSON endpoints
`wixy_server/robots_header.py`'s middleware adds `X-Robots-Tag: noindex` to exactly two path
categories, and only when `indexable: false`: published media (`/images/*`) and the public
version JSON endpoints (`/api/version`, `/api/version/notes` — an exact-match allowlist, never
a prefix match on `/api/version*` or a blanket `/api/*`). This is the non-HTML sibling of the
per-page HTML `noindex` meta (Inv 35) — that meta tag can never be observed inside a non-HTML
response body, so media and JSON had no `noindex` signal at all once Inv 35 made staging
crawlable. Never applied to `/admin*`/`/api/admin*` (Inv 12's auth gate) or `/internal/*`/
`/healthz` (Inv 12's edge-header 404), regardless of `indexable`, and never applied at all when
`indexable: true`. Classification is by request path alone (`request.url.path`) — a 404 for a
path inside `/images/` still gets tagged, deliberately, since nothing at that URL should be
indexed either way. **Not exhaustive over the app's public non-HTML surface, deliberately:**
`/uxer-style.json`, `/.uxer-web-port` (both public, non-HTML dev-tooling endpoints) and every
other static asset (`site.css`/`site.js`/`theme.css`, anything outside `/images/`) carry no
`X-Robots-Tag` regardless of `indexable` — out of this invariant's scope, not a gap.
*Enforced by:* `wixy_server/tests/test_robots_header.py` — the path allowlist as an exhaustive
pure-function unit test, plus integration coverage on both `indexable` states.
*Exception:* none — a genuinely new public JSON route that should carry this header is a
deliberate, explicit addition to the allowlist (and decisions/00137), never an automatic
consequence of a route merely being public.

### Inv 38 — Homepage JSON-LD: generic mechanics, site-authored facts, never engine-parsed
`builder/structureddata.py` emits `WebSite` + an optional `LocalBusiness`-family node as one
`<script type="application/ld+json">` on the homepage (`slug == "index"`) only, and only when
`indexable: true` — a non-indexable build emits nothing here at all (Inv 35's own "staging
emits nothing" precedent, not a noindex-flagged version). `WebSite` needs only the registry
(`project.name`/`domain`); `LocalBusiness` needs the new, optional `_global.json.business`
block (spec/02-content-model.md §7) — absent or malformed means no `LocalBusiness` node, never
a fabricated one (Inv 5). `business.types` (the `@type` array) and `business.address`
(a structured `PostalAddress`) are **site-authored, never engine-parsed** from the free-text,
HTML-bearing `_global.json.address` display string — that display shape has already drifted
once in this project (decisions/00139), so no parser could be trusted to stay correct. A
build-time substring check degrades a drifted `business.address` field to the plain visible
string plus a non-blocking `validate` warning (`ValidationResult.warnings`, decisions/00139) —
`addressCountry` is excluded from that check since a UK-local address never displays "GB" on
the page. Opening hours reuse `_global.json.hours[]` directly via `re.fullmatch` against the
exact "HH:MM – HH:MM" shape (en dash) — any open day that doesn't match aborts the WHOLE
`openingHoursSpecification`, never just that one day (a partial emission would assert a false
closure for the day that failed to parse). The favicon itself is site-repo work (a root-level
image + hand-authored `<link rel="icon">` tags, the same convention `theme.css`'s own
`<link rel="stylesheet">` uses) — the only engine piece is a tiny, generic, explicit root-file
passthrough allowlist in `build_site` (`favicon.ico`, `favicon.svg`, `apple-touch-icon.png`).
*Enforced by:* `builder/tests/test_structureddata.py` (unit + a real-production-data scenario
using the actual deployed `cottage-aesthetics-preview` values), `builder/tests/test_build.py`
(full-build integration: homepage-only, indexable-gated, favicon passthrough),
`builder/tests/test_validate.py` (the drift warning).
*Exception:* none — a future non-UK project needing `addressCountry` verified against visible
text would need its own decision, not a quiet change to this check.

### Inv 39 — `data-wx-img` gets intrinsic `width`/`height`, never overriding an authored value
`builder/bindings.py:_apply_img` sniffs a bound `<img>`'s intrinsic pixel dimensions from the
real on-disk file via `builder.imagesize.probe_image_size`, the same stdlib, never-raising,
Pillow-free JPEG/PNG/GIF/WebP header sniffer `templates.py`'s `og:image:width`/`height` already
uses (decisions/00134) — both now share one `is_safe_relative_src` safety gate, moved into
`imagesize.py` so it isn't a driftable per-caller copy (decisions/00012's own precedent). The
sniff is **skipped, never a build failure**, whenever: `site_root` is `None` (no disk context —
`apply_bindings`'s new keyword defaults to this for any caller not passing one); the resolved
`src` is unsafe to join onto `site_root` (`is_safe_relative_src` rejects a `/`-prefixed path —
which covers every draft-staged src, since `docs/ai/media.md` fixes that shape as always
`/admin/draft-media/<name>` — a remote `http(s):`/other-scheme URL, a `..` traversal segment,
or a Windows drive/UNC path); or the sniff itself returns `None` (missing file, unrecognized
format, malformed header). **A `width`/`height` already present on that specific template
`<img>` tag is never overwritten** — an intentional per-slot dimension override (e.g. a
fixed-aspect-ratio gallery tile always fed a similarly-cropped image) always wins over the
sniff, checked before any disk access is attempted; this covers a template-hardcoded value
AND a `data-wx-attr`-authored one, since `_apply_scalar` deliberately runs `data-wx-attr`
*before* `data-wx-img` for exactly this reason (the reverse order would let `_apply_img`
sniff+set both width and height first, then `data-wx-attr` overwrite only width afterward,
pairing an authored width with a sniffed height — a real bug caught by this invariant's own
graded audit). Each `data-wx-list` clone of an `<img>` template is walked (and therefore
sniffed) independently — no caching/sharing of a probed result across clones, since different
array items bind different `src` values. This applies identically in `publish` and `preview`
mode (`validate_site` also passes `site_root` so a draft/staged page gets the same coverage a
real build would, though a draft src is always skipped by the same `/`-prefixed rejection
above). **A sniffed `height` is paired with a mandatory CSS guard**, since HTML `width`/
`height` are CSS presentational hints: `templates.py:apply_head` unconditionally injects
`<style data-wx-guard="img-dim">:where(img[width][height]){height:auto}</style>` into every
page's `<head>` (zero specificity, so a real site-authored height rule still wins outright) —
without it, a site whose CSS constrains only `width` on an image (no `height` rule at all)
would have the browser stretch that image to the sniffed height instead of preserving its
aspect ratio. This lives in `apply_head`, not appended to the `theme.css` build artifact,
specifically so it is atomic with the width/height attributes in BOTH `build_site` (publish)
and `wixy_server/routes_preview.py`'s live admin preview (which calls `render_page` directly,
independent of any `build_site`/Publish cycle) and independent of whether the project has a
theme at all (Inv 5's partial-migration tolerance).
*Enforced by:* `builder/tests/test_bindings.py` (`TestImgBindingIntrinsicDimensions`: real
JPEG/PNG/GIF/WebP on disk, missing file, `site_root=None`, authored-dimension preservation,
remote/draft-media/traversal-src skip, preview mode, per-list-clone independence, a
`data-wx-attr`-authored width leaving height unset), `builder/tests/test_imagesize.py`
(`TestIsSafeRelativeSrc`, the shared gate's own unit tests), `builder/tests/test_render.py`
(`TestImgDimensionLayoutGuard`: the guard is present unconditionally, not duplicated across
repeated `apply_head` calls, and reaches real `render_page` output).
*Exception:* none — a future project needing a different override rule (e.g. always
re-sniffing even over an authored value) would need its own decision, not a quiet change here.

### Inv 40 — Server-chat data stays in private per-project storage
Chat rows, uploads, originals, and renditions live only below
`Storage/projects/<slug>/server/`. They are excluded from the site repo, builds, publish,
`reports.py` bundles, backup snapshots, and public routes. Protected API routes require the
in-app token as well as CF Access; media is served only through signed URLs. The status decoy
contains real server data, never chat state.

### Inv 41 — Wixy holds zero PIN state
Only cmd's app-key-scoped loopback PIN service verifies the PIN and owns registration and
lockout. **Target rule:** Wixy never stores, logs, echoes, or commits a PIN. A missing or
unreachable verifier returns 503 and never opens the gate. The unlock token exists only in
browser memory; mutations send it in `X-Wixy-Server-Token`, while media uses an email- and
expiry-bound signed URL. A token in a query string is rejected.

`POST /unlock` reads the raw JSON body itself instead of binding a Pydantic model, and validates
the PIN in the route — 4–16 ASCII digits — before cmd is contacted, so a rejected keypress never
costs an attempt. Every malformed shape returns the same redacted `422 {"error":"invalid_pin"}`:
invalid, empty, truncated or non-UTF-8 JSON; a top-level array or other non-object; a missing or
misspelled key; a non-string or nested-object `pin`; and a `pin` outside 4–16 ASCII digits. No
response or log line carries the submitted value.

`POST /unlock` has no token to gate it, so it carries its own CSRF guard
(`unlock_request_refusal` in `livechat/tokens.py`, called first thing in the route): a
`Sec-Fetch-Site` header, when the browser sends one, must be `same-origin`; `Content-Type` must be
`application/json`; and the custom header `X-Wixy-Server-Unlock: 1` must be present. Each of the
three is read as a list and a duplicated line is refused, not resolved by whichever value comes
first. A refusal (403 `forbidden` or 415 `unsupported_media_type`) is decided before the body is
read and before cmd is contacted, so a hostile cross-site page can never spend the owner's PIN
attempts; a simple cross-site POST cannot set the custom header without a CORS preflight, which
wixy does not grant. Decision 00158 records why this guard exists.
*Enforced by:* `wixy_server/tests/test_routes_livechat.py::TestUnlockMapping` (the malformed-shape
and unparseable-body cases assert the exact 422 body, no PIN in the response or in captured
logs, and zero attempts charged at the fake cmd; too-short and too-long PINs likewise),
`TestUnlockRequestGuard` (the CSRF guard: every refusal shape, charging nothing) and
`TestSettingsHaveNoPinField`.

### Inv 42 — Server-chat lock is fail-closed
Every R6 lock cause locks the chat: idle timeout (10 seconds, or 60 seconds on a device where
the owner ticked "Extend auto-lock to 1 minute" — a per-device preference, chat-only, stored in
`localStorage` under `wx-srv-idle-extended`; the decoy and every other state still use the fixed
10 seconds), panic, multi-tap, Escape, hidden document, route-away, unauthorized response, or
token expiry. A lock detaches the chat subtree from the document, aborts the stream, pauses
media, and discards an unfinished recording. A hidden document is exempt only while the file
picker or microphone permission flow is suspended. The decoy displays only real server status;
badges, titles, favicons, and push text never expose chat activity.

The lock also wins the race with an attach still loading history. `chatView.ts` keeps an attach
epoch that every attach, detach, and dispose advances; the pending history load's continuation,
its failure handler (including a stale 401 lock), and every stream callback each check both the
epoch and the current session before acting. A lock or detach while history is loading can
therefore never open a stream afterwards, and a late `locked` event or 401 from a previous unlock
can never lock the next session.
*Amended (round 2, Inv 48):* a device that has "Keep this device unlocked" switched on and not
paused silences exactly two automatic locks from an open chat — idle and route-away — and answers
token expiry and a 401 with a silent re-mint before it locks. Everything deliberate (panic, a
multi-tap, Escape) still locks AND pauses the grant. A hidden document is governed by two
per-device checkboxes, "Lock when I change tab" and "Lock when I lock my screen" (both ticked
by default, stored as `"0"` under `wx-srv-lock-on-tab` / `wx-srv-lock-on-screen`; absent or
unreadable is ticked): both ticked locks at once, both unticked never locks, and when they
differ the chat is put behind the decoy at once (a shield holding the session in memory) and
restored on return ONLY when the cause is known and its own box is unticked — an ambiguous
cause always stays locked. Locking on either box, or by Escape/panic/multi-tap, pauses an
active grant. A hidden document in any state other than an open chat still locks as before.
A hide caused by the page being UNLOADED (a reload, a navigation, a closing tab — `pagehide`
with `persisted` false, which browsers follow with `visibilitychange → hidden`) is not a
background switch: it neither locks nor pauses, or every reload would undo "keep this device
unlocked". A page entering the back/forward cache (`persisted` true) can be restored open, so
that stays an ordinary background switch.
*Amended again (round 2, independent review + Architect ruling on §8, decisions/00161):* "the
cause is known" above means judged from WHEN a screen-lock event was DISPATCHED, not merely
whether one happened during the absence — an event is CAUSAL only inside
`[hideAt - 1000ms, hideAt + 2000ms]` (`screenLockEvidence` in `lockModel.ts`); one delivered only
once the frozen page resumes (a batched event) is not evidence of what caused THIS hide, even on
an otherwise-proven device, and the shield stays ambiguous. A SECOND background switch inside one
absence taints the shield (the evidence window is anchored to the first hide, so a later switch's
true cause becomes unreadable against it) and forces the eventual return to stay locked regardless
of what the evidence says; the same taint applies if a lock event arrives while a restore is only
waiting on a token renewal. The grant is paused the INSTANT a background switch begins the shield,
not when the shield later resolves to a lock — a page reloaded, closed, or discarded before the
500 ms window elapses is still found paused on the next mount. An idle period that ran out while
the page was away locks the returning chat INSTANTLY (cause `idleAway`), before any touch gets a
chance to be mistaken for activity that should have prevented it.
*Enforced by:* `admin-ui/tests/serverChatView.test.ts` (no stream after a panic, idle or hidden
lock while attach is pending; a late `locked` event or unauthorized attach failure from the
previous unlock is ignored), `admin-ui/tests/server/panel.test.ts`,
`admin-ui/tests/server/panelGrant.test.ts` and `lockModelGrant.test.ts` (the grant,
shield and checkbox behaviour), and `e2e/tests/server-lock.spec.ts` +
`server-permanent-unlock.spec.ts`.

### Inv 43 — Server-chat idle time is reset only by user input
Only the defined user-input events count as activity. `scroll` events, incoming messages, and
programmatic scrolling do not reset the idle timer; an incoming message cannot keep a locked-
eligible chat visible. Changing the "Extend auto-lock to 1 minute" setting does not restart the
clock either: the panel re-measures the idle deadline (last activity + 10 or 60 seconds)
without moving the last-activity time. From the sheet itself, the tap that toggles the box is
an ordinary pointer event and so is activity in its own right — the period counts from that
tap; a change that arrives any other way (another tab of the device) is measured from the
last real activity, and can lock at once if that deadline has already passed. Only the
unlocked chat's idle period is affected; the decoy's re-hide and the PIN pad's idle close
stay 10 seconds. With a device grant active there is no idle timer for the open chat at all; a
return from the background compares the wall clock with the last activity (a suspended phone
may not advance `performance.now()`), except while a suspension holds the timer paused (R7:
`recording`, `micPermission`, `filePicker`, `mediaPlaying`, and `viewOnce` — holding only for
timed views, released on close).

### Inv 44 — Server-chat media is sniffed, bounded, and private
Inspect magic bytes before any media subprocess. Every ffmpeg/ffprobe input uses the sniffed
explicit demuxer and `-protocol_whitelist file`. Photos are decoded through Pillow (including
HEIC/HEIF via `pillow-heif`) and every still image is normalized to 8-bit RGB or RGBA before
its metadata is stripped: palette modes (`P`/`PA`) keep their colours, alpha is preserved, an
embedded ICC profile is converted to sRGB (a failed conversion logs a warning and keeps the
pixels as they are, never failing the upload), and 16-bit greyscale is scaled through a
0–65535 → 0–255 lookup table rather than clipped. Metadata (EXIF, ICC, text chunks) is then
removed by rebuilding the image from those normalized pixels. Animated GIFs are the one
documented exception: they keep their original bytes as `full.gif`. The output format follows
transparency, not the source format (table in [livechat.md](livechat.md) §8). Voice/video are
normalized into private renditions and successful raw uploads are removed. Failed originals are
diagnostic-only and expire after seven days. Enforce quota and the free-space floor at upload
initialization; a declared `sizeBytes` below 1 is rejected. Missing ffmpeg, ffprobe or
`pillow-heif` makes media uploads, the media queue and the `mediaProcessing` status
unavailable without disabling text chat. View-once attachments are delivered once through
`GET /messages/{seq}/view-once/content` (gated by a one-time claim, Inv 52), never through
`GET /media` (which returns 404), and their `renditions` column is cleared to `'[]'` upon send.
*Enforced by:* `wixy_server/tests/test_livechat_processing.py` (pixel-level checks per source
mode, colour profile and output format, including the palette, 16-bit greyscale and Display-P3
cases), `test_livechat_uploads.py`, `test_livechat_media_queue.py`, and
`test_routes_livechat_media.py` (the availability gate, including a missing `pillow-heif`, and
the `sizeBytes` bound).

### Inv 45 — Server-chat service worker cannot intercept fetches
The worker has no `fetch` handler and policy permits registration only after explicit Android
push opt-in. Pushes are payloadless and the notification text is fixed and generic.

The opt-in is reachable: each time the settings sheet opens, `settingsSheet.ts` mounts the
`pushToggle.ts` control into its push slot, but only on an Android-capable browser (Android
user agent plus `PushManager`, `serviceWorker` and `Notification`) once the chat has a display
name. Desktop and other browsers never see it, the sheet unmounts it on close, and the worker is
registered only from the enable click.
*Enforced by:* `e2e/tests/server-push.spec.ts` (a desktop browser shows no control; an Android
browser sees it, enabling registers `/admin/server-sw.js` with scope `/admin/` and stores the
subscription, disabling deletes it and unregisters), `admin-ui/tests/serverSettingsSheet.test.ts`,
`admin-ui/tests/pushToggle.test.ts`, `admin-ui/tests/serverSw.test.ts`, and
`wixy_server/tests/test_livechat_push.py`.

### Inv 46 — Server chat delete and wipe are hard deletes, without chat-visible tombstones
Any unlocked user can delete any message for everyone. Delete removes the message, its
attachments, its reactions (by cascade, Inv 49), media/upload/failed files, and earlier message
events, then emits one `message_deleted`; repeating the delete is idempotent. Wipe removes all messages, attachments,
uploads, files, and events, then emits one `wiped`. Clients remove content on those events. A
client's delete and wipe requests wait up to 30 seconds; an unknown outcome is settled by
retrying the idempotent delete, or for a wipe — which is never re-sent — by comparing server
message sequence numbers in the history (see [livechat.md](livechat.md) §6). The
internal `deleted_storage` rows are filesystem-recovery tombstones only; they never appear in
history or the event stream. Each delete/wipe records those rows in the same SQLite transaction
that removes the attachment/upload rows, so startup can resume file deletion after a crash.
`GET /media` verifies that the attachment row still exists before serving a signed rendition,
even if Windows could not remove a file that was open. Failed unlinks remain pending and are
retried by the two-second startup-resumed worker; they are never silently treated as complete.
The worker queries only `cleanup_pending=1` rows through `idx_deleted_storage_pending`; completed
tombstones remain for ID-reuse protection but are not revisited.
Each cleanup pass clears pending state only if the tombstone generation is unchanged; a concurrent
late-write requeue bumps the generation and remains scheduled for another pass.
The compare-and-clear is required because file removal and the SQLite status update are separate
operations. The hourly janitor conditionally deletes still-orphaned attachment rows and still-
unpromoted upload rows before queueing their files; completed tombstones age out after seven days,
while pending tombstones remain.
Every store connection sets `PRAGMA secure_delete=ON`; both delete and wipe TRUNCATE the WAL.
Recovery removes media files before retrying the DB scrub. A 204 requires an empty WAL and
completed media cleanup. 202 returns one `erasurePending` flag covering both; the settings
sheet waits until it clears. Route and background WAL scrubs serialize through
`LiveChatStore.scrub_guard()` and re-read the current marker under the guard, avoiding redundant
scrub attempts against a marker another worker already cleared. A route's ten-second deadline
includes timed guard acquisition; a busy checkpoint waits at most 250 ms per attempt so writers
can run between retries. Delete and wipe publish their stream event immediately after commit,
before filesystem cleanup.
Sequence high-water marks and push subscriptions are preserved. Media files are unlinked, but
NTFS/SSD byte-level shredding is not claimed.
*Enforced by:* `wixy_server/tests/test_livechat_store.py` (migration, idempotence, secure delete,
and raw-byte scrubbing — the delete and wipe raw-byte assertions run while a second store
connection is held open, so a WAL that was not truncated would fail them),
`test_routes_livechat.py` (auth, confirmation, held-file cleanup and old signed-URL 404),
`test_livechat_media_queue.py` (delete/processing race), `admin-ui/tests/server/erasureRequests.test.ts`
and `admin-ui/tests/serverThread.test.ts` (the client's timeout, retry and reconciliation rules),
`e2e/tests/server-chat.spec.ts` (cross-client deletion, a 12-second-delayed delete, old-media
404, wipe replay, and mobile gesture behavior), — for a reply's quote specifically (Inv 51) —
`test_livechat_reply_to.py`'s `TestReplyErasure` (the same raw-byte proof extended to a target
with replies, plus a bare `DELETE FROM messages` from a simulated older-process connection), and —
for view-once delivery erasure specifically (Inv 52) — `test_livechat_view_once.py` (fail-closed
linklessness, post-download erasure via the ordinary delete path, broken stream retry safety, and
backstop cleanup).
*Known limits:* filesystem overwrite is not a reliable shred guarantee on NTFS/SSD. A 202
response means chat content is already deleted and broadcast while database-byte or media-file
cleanup continues durably in the background.

### Inv 47 — app-lifetime background work is contained
Every app-lifetime background loop is started through `ContainedTaskGroup.supervise`; every
request-triggered one-shot task uses `ContainedTaskGroup.spawn`. Exceptions are logged and
recorded without cancelling sibling work. Supervised loops restart with bounded exponential
backoff; three consecutive failures in the livechat media or erasure worker mark media processing
as degraded. The main and standalone worker apps use the same wrapper. Media-queue items and push
recipients are isolated within their inner task groups, so one item failure leaves siblings
running. A recovered loop's failure count reads as zero after five minutes without another
failure. The wrapper exposes no raw `start_soon` method.
*Enforced by:* `wixy_server/tests/test_background.py`, `test_routes_system.py`, worker-app tests,
and strict mypy.

### Inv 48 — A device grant only replaces typing the PIN, and only a verified PIN can create one
"Keep this device unlocked" (`spec/server-chat/03-permanent-unlock.md`) rests on a **device
grant**: a separate, revocable credential. `POST /device-grants` needs BOTH a valid unlock token
(you are inside the unlocked chat) AND a PIN that cmd verifies at that moment — an attempt is
charged exactly as for `/unlock`, through the same `_verify_pin` helper, so the 401/429/409/503/422
mapping cannot drift. The server stores only `sha256(secret)` in `device_grants` (an id, the hash,
the CF Access email that created it, a display label and three timestamps — never chat content,
never the secret); the 32-byte secret reaches the browser once, base64url-encoded, in a
`Cache-Control: no-store` response, and every comparison uses `hmac.compare_digest`.

A grant is bound to the CF identity that created it, is individually revocable, is refused after
30 days unused, and an identity holds at most five live ones (a sixth revokes the oldest). It
**only ever mints a normal unlock token**, through `POST /unlock-with-grant` — no PIN, and cmd is
never contacted; every chat route still requires that token in `X-Wixy-Server-Token`, and the
token itself still never leaves JS memory (Inv 41 unchanged). Every way `unlock-with-grant` can
fail — unknown id, wrong secret, revoked, idle over 30 days, another identity's grant, a malformed
field — is the same reason-free `401 {"error":"grant_invalid"}`; ten failures per identity per
minute answer 429. All four grant routes run the `unlock_request_refusal` guard first, so a
cross-site page can neither spend a PIN attempt nor probe a grant. The janitor revokes grants unused
for 30 days and deletes rows revoked for more than a week. A device label rejects a lone UTF-16
surrogate BEFORE cmd is asked to verify (and charge) the PIN (audit F5) — the same class of check
already applied to a sender name (§5.3) and a reaction, just missed here the first time.

**Revocation ends live sessions, not just future ones (spec §9, audit F4).** A token minted by
`unlock-with-grant`, or by `POST /device-grants` itself, is BOUND to that grant (payload key
`"g"`, 32 lowercase hex): `require_server_token` re-checks the grant is still live on every
request that carries one, `GET /stream`'s loop re-checks it on its existing ~2s tick, and a bound
token's media URLs carry `&g=` and fold the grant id into their HMAC too. **Revoking a grant ends,
within about 2 seconds, every session and media link minted from it. No route exchanges a
grant-bound token for an unbound one** — a route that did would let a thief holding the device
outlive its own revocation. `POST /unlock`'s PIN-minted tokens are never bound, so an ordinary PIN
session is untouched by any of this. "Sign out other devices" revokes every OTHER live grant of
the identity but spares the CALLER's own bound grant, so the button's promise is literally true
and the click that fired it doesn't sign itself out; turning "Keep this device unlocked" off on
the current device revokes that one grant and locks the chat at once, on purpose.

On the device the grant lives in two `localStorage` keys: `wx-srv-device-grant` (present means the
setting is on) and `wx-srv-grant-paused` (`"1"` after a deliberate or checkbox-caused lock; a PIN
unlock clears it). Unreadable, malformed or unwritable storage means OFF, and a pause that cannot
be written drops the grant, so a panic can never be undone by a reload. `grantActive` means the
in-memory session is bound to the stored grant, never merely that the key is present: after a PIN
unlock on a device holding an unpaused grant, the client exchanges for a bound session at once via
`unlock-with-grant`, and the ordinary automatic locks apply until that arrives (or forever, on a
network error) — without this, re-entering the PIN after a panic would run a never-auto-locking
chat on an unbound 12h token, the same hole by another door. **Known limits:** rotating the PIN at
cmd does not revoke grants (Sign out other devices does); a lost phone's push subscription still
receives the payload-less "new message" ping until it is removed — the ping shows no content, and
opening it still needs the PIN — see the runbook.
*Enforced by:* `wixy_server/tests/test_livechat_grants.py` (hash-only storage, the cap, the 30-day
window, identity binding, migration v9, the janitor, lone-surrogate labels), `test_routes_livechat_grants.py`
(both gates on enrolment, the uniform 401, the rate limit, cmd never contacted, the guard on all
four routes, real-JWT identity binding, bound-token revocation ending a session/stream/media link,
"sign out other devices" sparing the caller's own grant), `admin-ui/tests/server/{deviceGrant,
grantsApi,lockModelGrant,panelGrant,settingsSheetKeep}.test.ts`, and
`e2e/tests/server-permanent-unlock.spec.ts`.

### Inv 49 — Server-chat reactions are a small, public, cascading mark
A reaction is one row per (message, reactor, emoji). The reactor is the trimmed, **case-folded
sender name** (`reactor_key`, the same folding as push self-exclusion), never the device. The emoji
must be one of the six in `livechat/reactions.py`, each an exact code-point sequence compared as a
plain string with no normalisation (the heart is U+2764 U+FE0F). Setting a reaction is a **desired
state** (`PUT /messages/{seq}/reactions` with `reacted: bool`), never a toggle; a request that
changes nothing writes no event; a reaction for an unknown or deleted message is a 404, never a 500.
A change appends the existing `message_updated` event; a reaction never sends push. `by_email` is an
audit column and never leaves the store.
The `reactions` table cascades on `messages` delete (`ON DELETE CASCADE`) — deliberately, because an
older slot process can hard-delete a message during a blue/green overlap with foreign keys on — so
delete and wipe erase reactions with the message and Inv 46's raw-bytes guarantee covers the reactor
name and the emoji. In the browser, a change that touches only a message's reactions patches the
reactions row in place: it must never rebuild the bubble, because that disposes media that may be
playing. The stream is the one ordered source of truth; a PUT response is applied only when no newer
state arrived while it was in flight and the chat was not wiped meanwhile.
*Enforced by:* `test_livechat_store.py` (`TestReactions`, the reaction delete/wipe raw-bytes cases and
the older-process cascade case — mutation-checked against removing the cascade),
`test_routes_livechat.py::TestReactionRoutes`, `test_livechat_reactions.py` (allowlist + the TS/Python
drift guard), `admin-ui/tests/serverThread.test.ts` (in-place patch, a playing `<audio>` keeps its
identity and `currentTime`, stale/wipe/delete responses), and `e2e/tests/server-reactions.spec.ts`.
*Known limits:* renaming yourself orphans your old reactions (they read as someone else's), exactly
as old messages stop aligning right; there is no free-form emoji and no reaction history.
Decisions: [00164](../../decisions/00164-server-chat-reactions/decision.md),
[00165](../../decisions/00165-reactions-patch-in-place-stream-is-truth/decision.md).

### Inv 50 — A voice note is transcribed only on request, only through cmd's private mode, and the text is erased with its message
Transcription (spec/server-chat/05-voice-transcription.md, decisions/00166) is never automatic: the
only trigger is `POST /api/admin/server/attachments/{id}/transcribe`, which answers 404 for anything
that is not a sent voice note and 409 until it is ready. wixy talks to cmd's `/api/transcribe` **only
with `private=1` and `cleanup=0`, with no `session_id` and no `context`, and only while cmd's
`GET /api/transcribe/capabilities` has answered a literal `{"private": true}`** — from a 60 s cache
when the request is accepted, and asked of cmd afresh (`available(fresh=True)`, never the cache)
immediately before any audio leaves. Anything else (false, absent,
malformed, unreachable, the standalone edition) is "unavailable": no audio is sent, the route answers
503 `{"error":"not_configured"}` and the control is hidden. This exists because cmd's plain route
retains the audio and transcript where delete and wipe can never reach them (Inv 40/46).
The transcript lives only in `attachment_transcripts`, `ON DELETE CASCADE` from its attachment, so
Inv 46's delete and wipe (with `secure_delete` and the WAL scrub) erase it with the message; a result
that arrives after the message was deleted updates no row and is discarded. The text is never logged,
never in a push payload and never in an error message. The job runs on the contained group (Inv 47),
one at a time, single-flight per note, at most 6 new jobs a minute per identity; a `pending` row found
at startup becomes `failed`.
*Enforced by:* `wixy_server/tests/test_livechat_transcribe.py` (probe strictness and 60 s cache; the
exact request fields; response mapping; no text in any log line),
`test_routes_livechat_transcription.py` (nothing sent to a cmd that is not private, on every
unavailability path incl. a rollback inside the probe-cache window between accept and send; the async flow; single-flight, one at a
time and the rate limit; delete and wipe erase a transcript sentinel from the raw database and WAL
bytes; a result after deletion is discarded; startup recovery), `test_livechat_store.py`
(`TestTranscripts`: the state machine, racing begins, cascade), and
`admin-ui/tests/serverTranscript.test.ts` + `e2e/tests/server-transcription.spec.ts` (opt-in only, a
playing note survives its transcript, both devices agree, phone layout).
*Known limit:* the no-retain half is cmd's promise, tested in cmd's repo; wixy can only refuse to talk
to a cmd that does not make it. The feature is operator-visible only after one live end-to-end run
shows nothing new under cmd's `dictation-audio/` or `asr-shadow.jsonl`.

### Inv 51 — a reply stores only the quoted message's seq
A reply to a message (round 2 ruling item 10, spec/server-chat/04-round2-rulings.md) persists
nothing but `messages.reply_to_seq` — a nullable, self-referencing column with
`ON DELETE SET NULL`, indexed by `idx_messages_reply_to`. The quote (the target's sender, a text
snippet cut to 300 code points, and a media summary) is derived at READ time from the target's
LIVE row, in the same transaction as the page that returns it (`LiveChatStore.list_messages`/
`get_messages`, one level only — a target's own quote is never resolved). Copying the quoted
content into the reply row is forbidden: it would let a deleted message's words survive inside
every reply to it, breaking Inv 46. Deleting or wiping the target therefore erases its words
everywhere it was quoted, and it vanishes with the original — with no chat-visible tombstone (no
"Original message deleted" line); a reply to a since-deleted message simply becomes an ordinary
message. This holds for every deletion path, including a bare `DELETE FROM messages WHERE seq = ?`
issued by an older slot process unaware of this column, because the erasure lives in the schema's
foreign key, not in application code. `POST /messages`'s optional `replyToSeq` never raises a raw
`IntegrityError` into a 500: `create_message` checks the target's existence inside its own
`BEGIN IMMEDIATE` transaction and silently stores `NULL` (sending as a plain message) when it is
missing, exactly what would have happened had the delete landed a moment later. The index is
required, not tuning: `wipe()`'s bulk `DELETE FROM messages` must search this child column once
per deleted row for the `SET NULL` action, and unindexed that is O(n) per row (measured 2026-09-25:
17.6s vs 0.2s at 20,000 messages, one in three a reply). A reply's own `sender`/`device_id`/
`by_email` are ordinary message fields — nothing new is added for identity or audit.

On the client, a reply's quote is kept honest by THREE mechanisms, not one (audit F3/F9 — an
earlier version of this doc claimed `message_deleted` was the only/sole one, which is false and
was itself a near-miss: reading it that way is exactly what would make removing the other two
look like safe, redundant cleanup):
1. **Live, while connected and unlocked:** `message_deleted{seq}` (the server does not
   additionally fan out `message_updated` for replies on delete) — `thread.ts` removes the
   `.wx-srv-quote` element in place from every loaded bubble and pending echo that quotes `seq`,
   and cancels the composer's pending reply if it targets `seq`.
2. **Across a lock:** the live stream resumes from a FRESH cursor on reattach, so a
   `message_deleted` fired while locked is never delivered. This is covered instead because the
   server always resolves `replyTo` fresh from the live target row on every read (§(2)) — a
   refreshed message that comes back with `replyTo: null` is patched via `patchQuote`, on the
   same "safe patch, don't rebuild" branch as `patchReactions` (`sameExceptReactions` deliberately
   ignores `replyTo` for the rebuild-vs-patch decision, precisely so this stays a patch, not a
   full re-render).
3. **A pending, not-yet-sent reply's target, across a lock:** `attach()` re-checks a pending
   reply's target the same way it already reconciles retained history rows (a pending reply's
   target must have been loaded when Reply was clicked, so it is always in the retained set) and
   cancels the pending reply if the target didn't come back.
None of these three ever re-renders a whole bubble — the same voice/video cut-off trap Inv 46's
reactions-adjacent guard protects against — and cancelling a pending reply always clears the
composer bar's own text/quote content, not merely its `hidden` flag (audit F8: a hidden node still
containing the deleted target's words is not erasure).
Quote freshness the other direction — an attachment finishing processing — is a real
`message_updated`: `finish_attachment` also appends one for every message whose `reply_to_seq`
points at the message that owns the finished attachment, so a quote gains its thumbnail the moment
the target's video or photo becomes ready; the same `patchQuote` branch above patches it in place.
*Enforced by:* `wixy_server/tests/test_livechat_reply_to.py` (schema/migration, one-level
resolution, target-exists/missing/idempotent `create_message` behaviour, the
`finish_attachment` cascade, and the erasure raw-byte tests — delete, wipe, and a bare
`DELETE FROM messages` from a simulated older-process connection), `test_routes_livechat_reply_to.py`
(the `POST /messages` wire contract, including `replyToSeq` validation — an integer >= 1,
booleans rejected, and never a 500 even at SQLite's own integer ceiling), `test_livechat_reply_to_driftguard.py`
(Python) and `admin-ui/tests/server/replyTo.test.ts` (TypeScript) — both asserted against the same
shared fixture `spec/server-chat/fixtures/reply-to-cases.json` so the server's `reply_to_json` and
the client's `replyToFromMessage` can never silently drift apart — and
`admin-ui/tests/serverThread.test.ts`'s "reply to a message" suite (the composer bar, draft
carry-through on a failed send, the sent bubble's quote button and its scroll-to-original paging
including that a paging error never removes a quote genuine exhaustion would, and the in-place
quote removal on `message_deleted`, including that a playing `<audio>` element in the reply keeps
its identity and `currentTime`), plus its "reattach after a lock" and "in-flight data can never
resurrect a deleted target's words" suites (mechanisms 2 and 3 above, and the three narrower races
— a stale history page, a failed send restore, a failed delete restore — that could otherwise
reintroduce a deleted target's words).
Decisions: [00168](../../decisions/00168-reply-to-a-message-schema-and-erasure/decision.md).

### Inv 52 — A view-once attachment is never linkable
A view-once photo or video (spec/server-chat/06-view-once-media.md) is never linkable: in the same
write transaction that creates the message, the store copies the attachment's `renditions` list into
`view_once_renditions` and sets `renditions = '[]'`. Consequences:
1. `attachment_json` mints no URLs for a view-once attachment, and nor does any reply quote's `thumbUrl`.
   This fail-closed rule holds in every code path, including older slot processes during blue/green overlap.
2. `GET /media/{attId}/{rendition}` returns 404 for any attachment whose message is view-once.
3. The attachment must be `ready` before sending (`POST /messages/view-once`, 422 `not_ready`), so
   media processing never runs after send and cannot restore renditions.
4. Its bytes leave the server once, through a claim-bound route (`POST /messages/{seq}/view-once/open`
   then `GET /messages/{seq}/view-once/content`), and the message is then immediately erased through the
   ordinary hard-delete path (Inv 46: `delete_message_for_scrub` + `_finish_committed_erasure`).
5. A backstop janitor loop running at least every 30s erases any view-once message whose claim is older
   than 600s, covering incomplete downloads.
*Enforced by:* `wixy_server/tests/test_livechat_view_once.py` (schema migration v11, validation matrix,
atomic single-winner claim race, streaming download, post-delivery erasure, broken download retry safety,
backstop cleanup, and fail-closed linklessness), `admin-ui/tests/server/viewOnce.test.ts` (lifecycle triggers,
resource release, `viewOnce` idle suspension, and spotlight math/clamping/easing), and `admin-ui/tests/serverThread.test.ts`
(bubble cards, tap to view, non-closure on `message_deleted`, wipe, and detach).
