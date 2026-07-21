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
  hides BOTH title bars (`wx-shell-editing`) behind a slim one-line edit bar (back icon,
  device switcher left, Settings + a 10s chrome-reveal ▾ right); the shell hands those
  buttons to `mountEditView` as `toolbarLeading`/`toolbarTrailing`.

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
`/api/version` commit change unless mid-edit); `router.ts` (hash routes: pages/edit/theme/
media/chat/history/settings); `pagesPanel.ts` + `pageSettingsDrawer.ts` (`meta.*` editing);
`publishDrawer.ts` (review diff + `POST /api/admin/publish` + SSE progress; disables Publish
with a "Nothing to publish" hint when the preview's `opCount` is 0 AND no upstream commits are
pending — decisions/00071); `historyPanel.ts`
(ledger + typed-confirm restore + a per-row **Changes** expander showing the version's old→new
key diff from `GET /api/admin/publishes/{n}/diff`, each row with a **Reinstate** button that
PATCHes the shown old value back into the current draft — hidden for added-in-that-version keys
and for pages that no longer exist); `diffView.ts` (the shared old→new diff renderer both the
review drawer and the history Changes view use — one component, one `.wx-diff-*` CSS block); `mediaPanel.ts` + `mediaDialog.ts` (library + picker);
`chatPanel.ts` + `markdown.ts` (see [ai-chat.md](ai-chat.md)); `themePanel.ts` + `themeVars.ts`
+ `googleFonts.ts` + `googleFontsCatalog.ts` (site-theme editing with live preview);
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
text no longer has a popover); `composer.ts` (THE text editor: bottom-anchored sheet,
auto-growing textarea, B/I/link row, maximize, live markdown preview, decisions/00075);
`markdownText.ts` (inline-markdown render + demote — hand-synced twin of
`builder/markdown_inline.py`, locked by the shared fixture, Inv 20);
`navigation.ts` (internal-link interception).

## Build

Both packages: `npm ci` → `npm run typecheck` (tsc --noEmit, strict) → `npm test` (vitest) →
`npm run build` (esbuild, two builds — JS iife + CSS — minified, sourcemapped). Output goes to
`wixy_server/static/{admin,editor}/` and is **committed**; CI fails on drift (Inv 2). Note the
theme-preview TS (`themeVars.ts`/`googleFonts.ts`) are hand-ported from `builder/theme.py` and
must match the server byte-for-byte (Inv 20). `editView.ts` splits a pure `createEditViewCore`
(unit-testable router) from the DOM `mountEditView` because jsdom can't test real iframes.
