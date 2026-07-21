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
  The one piece of chrome edit view does NOT hide is the slim `.wx-statusbar` at the very
  top of the shell: the draft chip (left, opens the review drawer) and the Publish button
  (right), visible on every route (decisions/00083) — the chip no longer relocates into
  the slim edit bar, and the topbar carries neither control. While a publish runs the
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
  opens as an empty gap) and, on ≤720px, relocates the nav between the topbar and the
  slim edit bar (`matchMedia` in `shell.ts`) so the menu reveals ABOVE the bar.
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
     (there is no valid overlay path inside an array).
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
  `{kind:"conflict"}`. **ok** → advance `currentRev`, `onAccepted(batch, rev)`. **409** →
  re-fetch `/api/admin/state` draft.rev, **re-queue the batch at the front**, retry
  immediately (no extra delay). **network/5xx** → re-queue at front, `onError`, break (kept
  for next flush; shell shows "Couldn't save… retrying").
- **`flushNow()`** flushes immediately (before navigating away). A 409 is expected and handled
  here — `api.ts` never blind-retries a 4xx.

## admin-ui panels (`admin-ui/src/`)

`shell.ts` (chrome + state + the OpQueue + a 60s revalidation loop that reloads on an
`/api/version` commit change unless mid-edit; same-route panel re-renders from that loop
never close an open drawer — only genuine route changes do, decisions/00081); `router.ts` (hash routes: pages/edit/theme/
media/chat/history/settings); `pagesPanel.ts` + `pageSettingsDrawer.ts` (`meta.*` editing);
`publishDrawer.ts` (review diff + `POST /api/admin/publish` + SSE progress; disables Publish
with a "Nothing to publish" hint when the preview's `opCount` is 0 AND no upstream commits are
pending — decisions/00071; layman wording throughout: the chip reads "N unpublished changes ·
M site updates", the upstream section is "updates made outside the editor" with a plain-English
explainer — decisions/00081); `historyPanel.ts`
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

## editor modules (`editor/src/`)

`overlay.ts` (coordinator: hover chrome, popover routing, op emission, list toolbar, `data-wx
-if` eye toggle, `mediaRequest`, shell handshake); `messaging.ts` (origin-checked postMessage);
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
pin shared by the composer and the control sheets, plus the `interactive-widget` meta
append); `markdownText.ts` (inline-markdown render + demote — hand-synced twin of
`builder/markdown_inline.py`, locked by the shared fixture, Inv 20);
`controls.ts` (structured control sheets — opening-hours whole-array editor and
price-list row editor, opened instead of the composer when the clicked element
carries `data-wx-control` in the template, decisions/00077);
`navigation.ts` (internal-link interception).

## Build

Both packages: `npm ci` → `npm run typecheck` (tsc --noEmit, strict) → `npm test` (vitest) →
`npm run build` (esbuild, two builds — JS iife + CSS — minified, sourcemapped). Output goes to
`wixy_server/static/{admin,editor}/` and is **committed**; CI fails on drift (Inv 2). Note the
theme-preview TS (`themeVars.ts`/`googleFonts.ts`) are hand-ported from `builder/theme.py` and
must match the server byte-for-byte (Inv 20). `editView.ts` splits a pure `createEditViewCore`
(unit-testable router) from the DOM `mountEditView` because jsdom can't test real iframes.
