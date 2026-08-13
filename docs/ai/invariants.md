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

### Inv 12 — CF Access JWT is the only auth; loopback-only; internal surface hidden
Bind `127.0.0.1` only (the tunnel is the sole ingress). `/admin*` + `/api/admin*` require a
verified CF Access JWT (`aud` = the app AUD, `iss` = the team domain, signature vs cached
JWKS). `/internal/*` + `/healthz` return a bare 404 when a `Cf-Ray`/`Cf-Connecting-Ip`
header is present (they answer loopback probes only). The embedded AI chat has **no publish
tool** — it cannot publish.
*Exception:* `WIXY_DEV_NO_AUTH=1` bypasses auth for local dev/tests **only** — the app
refuses to start if it's set while `WIXY_ENV=prod`. `/api/version` is public by design.

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

