# Subsystem: admin-ui & editor

The two independent strict-TS/esbuild/no-framework bundles and the `postMessage` protocol
between them. Spec: [`spec/05-editor.md`](../../spec/05-editor.md). The wire types are in
[contracts.md](contracts.md) §5–6.

## Runtime topology

- **`admin-ui/`** (→ `wixy_server/static/admin/`) — the admin shell at `/admin`. Entry
  `admin-ui/src/index.ts` → `shell.ts:mountShell`. Renders the chrome, owns **all session
  state**, talks to `/api/admin/*`, and owns the **single** `OpQueue` for the session. Loaded
  by `wixy_server/static/admin_shell.html`.
- **`editor/`** (→ `wixy_server/static/editor/`) — the overlay injected *inside* the
  live-preview iframe. Entry `editor/src/index.ts` → `overlay.ts:initOverlay`. Injected by
  `wixy_server/preview.py` into every `/admin/preview/<page>.html` (the same rendered site
  HTML that ships to production, carrying `data-wx-*` attributes). Provides hover chrome,
  click→popover editing, and op emission.
- **Relationship:** the shell's edit view (`editView.ts:mountEditView`) hosts an
  `<iframe class="wx-preview-iframe">` pointed at the preview URL; the overlay runs inside it.
  Same origin on both sides (one FastAPI app), so `postMessage` targets `win.location.origin`,
  never `"*"`. The theme panel (`themePanel.ts`) reuses the same machinery with a second
  embedded preview iframe for live theme preview. The iframe element is sized to the
  device switcher's CSS width and `transform: scale()`d down when the wrap is narrower
  (squished tablet/desktop simulation, decisions/00076); the scale rides
  `setDevice.scale` so the overlay's composer can counter-scale. In edit view the shell
  hides the topbar + nav (`wx-shell-editing`) behind a slim one-line edit bar (back icon,
  device switcher left, Settings + a 10s chrome-reveal ▾ right) which the shell hands to
  `mountEditView` as `toolbarLeading`/`toolbarTrailing` and which pins into a
  `.wx-edit-bar-host` row in the shell's NON-scrolling chrome (`toolbarHost` dep,
  decisions/00082) — never the scrolling `.wx-main`, so it can't scroll out of reach.
  A browse-mode toggle (an inline SVG mouse icon — not the 🖱️ emoji, which has no
  glyph in this box's font stack, verified in real Chromium/Edge/Chrome alike;
  `.wx-browse-mode-toggle`) sits right after the device group —
  unlike back/Settings/chrome-reveal it's built INSIDE `mountEditView` itself, not handed
  in via `toolbarLeading`/`toolbarTrailing`, since it drives the overlay directly
  (`setBrowseMode` postMessage) the same way the device buttons drive `setDevice`
  (decisions/00091). While on, the overlay suspends hover chrome/popovers/the item
  toolbar/the `data-wx-if` eye toggle and every click just navigates (or is inert) like
  the real site — letting an operator click through several pages to find the one they
  want, then flip it back off and keep editing on whatever page they landed on, in the
  SAME session (no reload, no lost draft state). State is a plain closure variable in
  `mountEditView`, matching its lifetime exactly: it survives every in-session page
  change the overlay itself drives (`reuseEditView` in shell.ts keeps the SAME `EditView`
  alive across those), and resets to off the moment you leave edit mode entirely and a
  fresh `mountEditView` call happens next time. A real iframe navigation destroys the
  overlay's own JS state, so `init`'s optional `browseMode` field (default off) tells
  each freshly-booted overlay which mode to start in, without a follow-up round trip
  that could race a click on the just-loaded page.
  The one piece of chrome edit view does NOT hide is the `.wx-statusbar` at the very
  top of the shell: the draft chip (left, opens the review drawer) and the Publish button
  (right), visible on every route (decisions/00083) — the chip no longer relocates into
  the slim edit bar, and the topbar carries neither control. The chip is a plain **label**,
  not a pill (its box was redundant inside the bar; Publish opens the same drawer, so it's a
  convenience trigger). The bar takes `.wx-statusbar-pending` — tinted background + a
  brand-blue rule — **only when there is something to publish** (draft ops or outside site
  updates) or while a publish runs; with nothing pending it stays plain and its label goes
  muted, so the prominence keeps its meaning (decisions/00094). In that quiet state the
  Publish button also HIDES (`hidden`) and the bar collapses to a narrow strip
  (`.wx-statusbar:not(.wx-statusbar-pending)` drops the vertical padding that framed the
  button) — with the chip already saying "No unpublished changes", the button is dead
  chrome (operator, 2026-08-02, decisions/00108). A RUNNING publish forces the button
  visible even if a state snapshot already reads clean, since it's the progress surface. The quiet styling is keyed
  off that bar class, NOT the chip's `disabled` attribute — the chip is enabled when idle and
  disabled mid-publish, which is the opposite of what the appearance needs. While a publish runs the
  status bar doubles as the progress surface (decisions/00089, Inv 25): the Publish
  button spins (`wx-button-busy` + `wx-spinner`) and the chip narrates the stage in
  layman wording, driven by a shell-owned watch that polls `/api/admin/state` every 2s
  while `publishJob.isRunning` — armed by the drawer's `onPublishStarted` or by any
  state load finding a running job (reload-mid-publish, another tab/device) — and
  announces the terminal job with exactly one version-guarded toast ("Published —
  version N is live." / "Publish failed — your draft changes are safe.").
- **Edit chrome on mobile (decisions/00084):** the edit view opens on the USER'S OWN form
  factor — `initialDeviceFor(width, coarsePointer)` in `editView.ts` (phone → mobile even
  when a phone reports ≥480 CSS px; tablet → tablet; a narrow desktop window previews as
  its closest small form factor). Every fixed bottom sheet in the overlay (composer,
  hours/price sheets) pins to the VISUAL viewport (`editor/src/visualPin.ts`) so the
  on-screen keyboard and pinch-zoom can't scroll it off; the overlay also appends
  `interactive-widget=resizes-content` to the preview document's viewport meta at startup
  (never to anything published), and the admin shell's own meta locks user scaling
  (`admin_shell.html`) so outer pinch can't pan chrome away. The ▾ chrome reveal repaints
  the topbar (`visibility: visible` — the hidden rule otherwise wins the tie and the bar
  opens as an empty gap) and, on ≤720px, relocates the nav between the (hidden) topbar and
  the slim edit bar (`matchMedia` in `shell.ts`) so the menu reveals ABOVE the bar.
- **Mobile chrome (decisions/00107):** at ≤720px the topbar is GONE (`display: none`) —
  the "Wixy · name" banner cost a full phone row, and its `overflow: hidden` (needed for
  the desktop slide) clipped the ⋯ popover to invisibility ("I tap the burger menu,
  nothing appears", operator 2026-08-02). In its place a `.wx-navrow` chrome row holds the
  scrolling tab strip with the ⋯ trigger pinned at its right OUTSIDE the scroll, and
  anchors the secondary-controls popover (`position: relative`, no overflow clip — the
  row must NEVER gain one, or the popover vanishes again). `placeChrome` in `shell.ts`
  moves navEl + trigger + popover between the row (narrow) and the topbar (wide); edit
  view hides the row with the tabs and the ▾ reveal shows it, trigger included. Desktop
  is untouched.
- **Root no-scroll contract (decisions/00085, Inv 24):** the shell's root document can never
  scroll at all — `html, body` carry `overflow: hidden; overflow: clip; overscroll-behavior:
  none` (mirrored pre-paint in `admin_shell.html`), and the chrome sizes to the DYNAMIC
  viewport (`.wx-shell` / `.wx-drawer` `100dvh` with the `100vh` fallback, toasts offset by
  `100vh - 100dvh`). `100vh` had sized the shell to the LARGE mobile viewport, so a phone's
  URL bar made the whole page scroll the bars off — 00084's composer pin was correct but rode
  the scrolling iframe. Only `.wx-main` and the preview document scroll.

## The edit protocol

Every message is `{ wx: 1, type, … }` (`wx: 1` = protocol-version discriminator). Both
directions are origin-checked and runtime-validated after crossing the boundary
(`parse*Message` return the narrowed message or `null`). **`admin-ui/src/protocol.ts` and
`editor/src/protocol.ts` are byte-identical** and must be hand-synced (Inv 20, decisions/
00015). Message sets are in [contracts.md](contracts.md) §6.

**One text edit, end to end:**
1. **Handshake:** overlay boots → `ready`. Shell (`createEditViewCore.handleMessage`) →
   `api.getContent(page)` → `init{page, bindings, draftRev}`. Only the *shape* of bindings
   crosses; content values are read from the live DOM (`contentModel.ts`).
2. **Edit:** click a bound element → the kind-specific popover (`popovers.ts`). On commit
   (`overlay.ts:commitEdit`):
   - **Direct (page/global key):** apply to DOM optimistically, compute `{file, path}` via
     `opTargeting.directOpTarget` (`@key` → `{file:"_global", path:key.slice(1)}`), emit
     `op{file, path, value}`.
   - **Item-scope key (`.`-prefixed):** apply to DOM, walk to the outermost `[data-wx-list]`
     (`findOutermostList`), reconstruct that list's **whole array** from the DOM
     (`readListValue`), emit **one op targeting the outermost list key** with the entire array
     (there is no valid overlay path inside an array). `readItemValue` (`contentModel.ts`)
     dispatches per `field.kind`: an `"attr"` field reads through `readAttrValue`, which
     queries `[data-wx-attr]` (the element the target attribute is actually set on, not the
     list-item root — `builder/bindings.py:_apply_attrs` sets it on the SAME element carrying
     `data-wx-attr="attrName:key[,attr2:key2]"`, parsed by `parseAttrSpec`) and returns that
     element's own `getAttribute(attrName)`. Every scalar text read also passes through
     `normalizeEmptyText` (collapses a lone `\s`-only string — which already matches a real
     NBSP — or the literal `&nbsp;` entity text to `""`), so the "blank new item" placeholder
     `overlay.ts`'s add-item flow writes (`innerHTML = "&nbsp;"`, needed so a truly empty
     text element stays clickable) can never itself be read back as real content on a LATER
     structural op. Both gaps were root causes A and B of the 2026-07-28 gallery
     publish-corruption incident (decisions/00095) — before this, an attr-kind item field was
     silently OMITTED from the reconstructed array (not set to `""`, just absent — exactly
     "missing required property"), and a freshly-added item's untouched placeholder became the
     literal 6-character string `"&nbsp;"` once it round-tripped through the server's nh3
     sanitize pass.
   - **Structural list edits** (toolbar ↑↓✚⧉✖): `listOps.applyListStructuralOp` transforms
     the array; emit the whole new array as one op (`add` clones item[0] with strings blanked).
3. **Up:** `messaging.sendToShell` → `parent.postMessage(msg, origin)`.
4. **Shell:** origin-check → `core.handleMessage` → `case "op"` → `opQueue.enqueue(op)`.
5. **Queue → server:** `OpQueue` coalesces 300ms → `PATCH /api/admin/draft {expectedRev, ops}`.
6. **Echo down:** on 200 the queue's `onAccepted` → `editView.applyOps` → `applyOps{ops}` to
   the overlay, which treats it as a no-op confirmation (already applied optimistically —
   decisions/00017).

**Two special reuses of `applyOps`:** (a) media replace — overlay `mediaRequest{key}` → shell
opens `mediaDialog`, answers with `applyOps[{file, path:key, value:{src,alt}}]` (or an empty
`ops` batch = cancel); (b) theme live preview — `themePanel` sends `themeVars`/`themeFonts` to
its embedded iframe. `navigate{page}` lets the overlay self-navigate internal links; the shell
updates the hash without re-loading.

## Op queue semantics (`admin-ui/src/opQueue.ts`)

One `OpQueue` per session (owned by `shell.ts`); panels take only the `OpQueueLike =
{readonly rev, enqueue}` slice. DOM/framework-free.
- **Coalescing:** `enqueue` → `DEFAULT_COALESCE_MS = 300` timer; multiple ops in the window
  flush as one PATCH.
- **Ordering:** strict FIFO; ops enqueued during an in-flight request are picked up next
  iteration in order.
- **Optimistic concurrency via `rev`:** `sendPatch(currentRev, batch)` → `{kind:"ok", rev}` |
  `{kind:"conflict"}` | `{kind:"rejected", message}`. **ok** → advance `currentRev`,
  `onAccepted(batch, rev)`. **409** → re-fetch `/api/admin/state` draft.rev, **re-queue the
  batch at the front**, retry immediately (no extra delay). **422** (`kind:"rejected"` — the
  server's draft-write gate, decisions/00095, found the batch structurally invalid) → the
  batch is **dropped, never re-queued** (unlike a conflict, retrying the exact same invalid
  op can only loop forever) and `onRejected(batch, message)` fires; `shell.ts` shows a calm,
  generic toast ("That change couldn't be saved — refreshing the page preview.") and calls
  `activeEditView?.reload()` if the current route is the edit view — a real reload, since the
  live preview DOM may still be showing the rejected edit (applied optimistically, never
  actually saved) and a reload is the same reconvergence mechanism any other hard refresh
  uses. **network/5xx** → re-queue at front, `onError`, break (kept for next flush; shell
  shows "Couldn't save… retrying").
- **`flushNow()`** flushes immediately (before navigating away). A 409 is expected and handled
  here — `api.ts` never blind-retries a 4xx.

## admin-ui panels (`admin-ui/src/`)

`shell.ts` (chrome + state + the OpQueue + a 60s revalidation loop that reloads on an
`/api/version` commit change unless mid-edit; same-route panel re-renders from that loop
never close an open drawer — only genuine route changes do, decisions/00081); `router.ts` (path routes, decisions/00087: pages/edit/theme/
media/chat/history/settings/section); `pagesPanel.ts` + `pageSettingsDrawer.ts` (`meta.*` editing);
`publishDrawer.ts` (review diff + `POST /api/admin/publish` + SSE progress; disables Publish
with a "Nothing to publish" hint when the preview's `opCount` is 0 AND no upstream commits are
pending — decisions/00071; layman wording throughout: the chip reads "N unpublished changes ·
M site updates", the upstream section is "updates made outside the editor" with a plain-English
explainer — decisions/00081; **five mutually-exclusive body states** (decisions/00095), each a
full `body.innerHTML = ""` swap, never a partial patch: **blocked** (`renderBlocked` — the
publish preview's `validate.ok === false`; "Publishing is paused" + calm body text, "Fix it for
me" → `POST draft/repair` → re-fetches the preview on full success or swaps to a
still-blocked message + an emphasized "Send a report" on partial, and "Send a report" →
`POST report` — no raw validator text ever rendered, no Publish button at all while blocked)
· **reviewable** (`renderReviewable` — the pre-existing diff+confirm UI, unchanged except the
old inline error box is gone since a blocked draft never reaches this state) · **running**
(`renderRunning`, entered synchronously on confirm click, before any await — spinner +
"Publishing your site…" + a stage caption fed by the SSE stream, same `PUBLISH_STAGE_LABELS`
wording the status bar uses) · **success** (`renderSuccess(version)` — a checkmark, "Your site
is live.", "Version N") · **failure** (`renderFailure` — "Publishing didn't work this time." +
"Nothing changed on your live site, and your edits are safe." + "Try again"/"Send a report",
no raw error detail). `currentRev` is a mutable local that advances past `deps.expectedRev`
after a successful in-drawer repair, so a follow-up repair or the eventual publish always
targets the latest known rev. The `onPublishStarted`/`onPublishSettled` shell bridge
(Inv 25) fires at the exact same points as before this rewrite — confirm still calls
`onPublishStarted` synchronously and `onPublishSettled` in a `.finally()` regardless of
outcome or whether the drawer was torn down first); `historyPanel.ts`
(ledger + typed-confirm restore + a per-row **Changes** expander showing the version's old→new
key diff from `GET /api/admin/publishes/{n}/diff`, each row with a **Reinstate** button that
PATCHes the shown old value back into the current draft — hidden for added-in-that-version keys
and for pages that no longer exist); `diffView.ts` (the shared old→new diff renderer both the
review drawer and the history Changes view use — one component, one `.wx-diff-*` CSS block;
whole-array `list` entries render as per-item human lines — "Wednesday: value: Closed → By
phone enquiry", "Added: …", "Removed: …", capped at 10 + "…and N more" — never a raw JSON
dump, decisions/00081); `mediaPanel.ts` + `mediaDialog.ts` (library + picker);
`chatPanel.ts` + `markdown.ts` (see [ai-chat.md](ai-chat.md)); `themePanel.ts` + `themeVars.ts`
+ `googleFonts.ts` + `googleFontsCatalog.ts` (site-theme editing with live preview);
`thumbnailService.ts` (mobile-view page captures for the Pages panel — hidden 390px
iframe + html2canvas, serial debounced queue, decisions/00078);
`api.ts` (typed fetch: 10s timeout, 3 attempts, retries network+5xx only). The Uxer-adoption
layer — `theme.ts`/`themeEditor.ts` (admin **chrome** dark/light/system, *not* the site
theme), `zoom.ts`, `fontScale.ts`, `settingsPanel.ts`, `shortcuts.ts`, `contrast.ts`,
`screenshot.ts` — is separate from the published-site theme (easy to conflate; decisions/
00045–00050).

**`sectionPanel.ts` + `sectionPanelModel.ts`** (decisions/00098) — the registry-configured
admin section editor (`state.adminSections`, Inv 1: no site literals in this module or
anywhere else in the engine — `ca.json`'s `adminSections` array is the only place "Before &
After"/`gallery.sliders`/`gallery.tiles` are spelled out). `shell.ts` renders one nav button
per `state.adminSections[]` entry dynamically (inserted right after Edit via
`editNavItem.after(...)`, re-synced whenever the section list changes on a state reload —
unlike `NAV_ROUTES`, which is static) and mounts `mountSectionPanel(section, {api, opQueue,
win?})` for route `{kind:"section", id}`; an unknown `id` (a stale deep link, or a section
removed from the registry) falls back to the pages panel. The panel owns its own fetch
(`api.getContent(section.page)`, mirroring `mediaPanel.ts`'s "owns its own lifecycle"
`mountXPanel` shape rather than `pagesPanel.ts`'s `renderXPanel(data, callbacks)` one — a
collection's ARRAY VALUES live in page content, not `StateResponse`, only its config does)
and treats each `AdminCollection`'s array as one indivisible unit: every add/edit/reorder/
delete writes the WHOLE array as one `opQueue.enqueue({file, path, value})` op (the standard
collection rule this codebase already applies elsewhere), never a partial patch. Per item:
an `image`-kind field opens the shared `mediaDialog.ts` picker (writes `{src, alt}` —
`contentSrc`, never a served `url`, per decisions/00095's fix). Displaying that stored
value back as a thumbnail/preview `<img>` — outside the live-preview iframe, which alone
gets a real `<base href="/">` — must run it through `mediaDialog.contentSrcToDisplayUrl`
first (decisions/00102: both the card thumbnail and the add-flow preview shipped without
this and rendered as broken images in production for every existing item). A `text`-kind field is a
plain input, committed on blur/Enter, entity-decoded for display
(`sectionPanelModel.decodeCommonEntities`) since the value is stored PLAIN and the builder's
BeautifulSoup render pass re-escapes it at serialization time (the same convention
`contentModel.ts`'s `.textContent`-based reads already rely on); a `choice`-kind field is a
`<select>` from `field.options`, committed on change. Reordering has BOTH a pointer-based
drag (a drop-indicator line, commit-on-release) AND ↑/↓ buttons emitting the identical
whole-array op — a deliberate addition on top of decisions/00017's earlier "buttons only"
simplification for the INLINE overlay's own item toolbar, kept here as the fallback/
accessibility path while this dedicated screen adds real drag for "her pride" polish
(spec 3c). The guided **add** flow is a linear wizard — one step per `image`-kind field (in
field order), then a final form step for the rest — generalizing the brief's literal
"step 1 Before, step 2 After, step 3 form" to however many image fields a collection
actually declares (one for `gallery.tiles`, two for `gallery.sliders`); Save stays disabled
until `sectionPanelModel.isNewItemComplete` (every image field picked, and the field
literally named `title`, if present, non-blank) — a new item is always born schema-valid,
never a half-filled placeholder landing in the array. `sectionPanelModel.ts` is the pure,
DOM-free half (dotted-path content reads, array reorder/delete/update, the add-flow
completeness gate, entity decoding) — unit-tested directly; `sectionPanel.test.ts` covers
the thin DOM binding on top (kept deliberately DOM-light per spec 3c — the pointer-drag
interaction itself is real-browser e2e territory, not jsdom's).

## editor modules (`editor/src/`)

`overlay.ts` (coordinator: hover chrome, popover routing, op emission, list toolbar, `data-wx
-if` eye toggle, `mediaRequest`, shell handshake, browse-mode gating (decisions/00091) — a
`browseMode` flag mirrored from `init`/`setBrowseMode` that short-circuits hover chrome,
click-to-edit, and the eye toggle in favor of plain navigation); `messaging.ts` (origin-checked postMessage);
`opTargeting.ts` (`{file, path}` targeting; encodes "no dotted path indexes an array");
`contentModel.ts` (reads current values back out of the live DOM — the overlay never receives
content values, only shapes; text reads are chrome-stripped and demoted to markdown source,
Inv 23 + decisions/00075); `listOps.ts` (pure array transforms); `dom.ts` (binding
discovery, precedence list→href→img→bg→text); `popovers.ts` (link + image editors only —
text no longer has a popover; also the two anchoring helpers, and they must not be mixed
(decisions/00086): `positionNear` = VIEWPORT anchoring for EDITOR surfaces — link/image
popovers, like the composer, stay reachable; `positionInDocument` = DOCUMENT anchoring
for CONTENT labels — the hover chip and list item toolbar ride the page on scroll,
listener-free, or they detach from the element the moment the preview scrolls); `composer.ts` (THE text editor: bottom-anchored sheet,
auto-growing textarea, B/I/link row, SVG maximize, live markdown preview, decisions/00075;
auto-grow sizes only AFTER attach — caller must `refit()` post-`appendChild`, decisions/00079;
pinned to the visual viewport — decisions/00084; draft recovery — every keystroke
persists to localStorage under the caller's per-binding `draftKey`, and reopening with a
stored draft ≠ seed shows the Restore/Discard banner, so a reload mid-edit loses
nothing — decisions/00088); `visualPin.ts` (the visual-viewport
pin shared by the composer and the control sheets, the cover-mode pin for the
full-screen Q&A editor (decisions/00090), plus the `interactive-widget` meta
append); `markdownText.ts` (inline-markdown render + demote — hand-synced twin of
`builder/markdown_inline.py`, locked by the shared fixture, Inv 20);
`controls.ts` (structured control sheets — opening-hours whole-array editor,
price-list row editor, and the FULL-SCREEN Q&A whole-list editor
(decisions/00090), opened instead of the composer when the clicked element
carries `data-wx-control` in the template, decisions/00077);
`navigation.ts` (internal-link interception — `resolveInternalPageSlug`/`handlePlainAnchorClick`
in overlay.ts also drive browse-mode navigation unchanged; browse mode only widens WHICH
clicks reach that path, from "unbound anchors only" to "every anchor", decisions/00091).

## Build

Both packages: `npm ci` → `npm run typecheck` (tsc --noEmit, strict) → `npm test` (vitest) →
`npm run build` (esbuild, two builds — JS iife + CSS — minified, sourcemapped). Output goes to
`wixy_server/static/{admin,editor}/` and is **committed**; CI fails on drift (Inv 2). Note the
theme-preview TS (`themeVars.ts`/`googleFonts.ts`) are hand-ported from `builder/theme.py` and
must match the server byte-for-byte (Inv 20). `editView.ts` splits a pure `createEditViewCore`
(unit-testable router) from the DOM `mountEditView` because jsdom can't test real iframes.
