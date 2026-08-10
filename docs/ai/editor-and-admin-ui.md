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
  the slim edit bar, and the topbar carries neither control. At the bar's FAR LEFT sits
  the **version badge** (`versionBadge.ts`, decisions/00109) — the owner-facing, no-git-
  history variant of the fleet's `ver` pattern: a tiny muted `v N` (the engine's first-
  parent commit count from `/api/version`'s `commit.count`, pinned to the loaded page on
  the first check) while up to date; the fleet's canonical green glow (`v old → v new`,
  `.wx-version-update-available`) once a revalidation finds the server's sha has moved
  past the pinned one. Tapping it opens a THEMED confirmation ("Would you like to load
  the latest version now?") — never a changelog — and only its confirm reloads
  (`win.location.reload()` after `beforeReload` flushes the OpQueue; a flush that
  re-queued ops — the shell's `opSaveFailed` flag, set by the queue's `onError` — BLOCKS
  the reload with a calm note instead of silently losing them). The update dialog also
  carries a "What's new in this version:" bullet list (decisions/00112) — the
  `Release-note:` commit trailers of exactly the commits she'd advance past, fetched
  from `/api/version/notes?since=<her pinned sha>` (prefetched when the glow appears;
  a "Loading what's new…" line fills in place if she's faster). These lines are
  DOCTRINE, not polish: every commit message carries one plain-English trailer for her
  ("General bug fixes and improvements." when nothing is user-visible), CI's
  `release-note` job enforces it, and the server substitutes the generic line for any
  range that comes up empty. Nothing reloads the page
  on its own: the pre-00109 behaviour (auto-reload outside edit view, a toast inside it)
  is gone because she may be mid-edit. A rollback deploy quiets the badge again. The chip
  is a plain **label**, not a pill (its box was redundant inside the bar; Publish opens
  the same drawer, so it's a convenience trigger). The bar takes `.wx-statusbar-pending` — tinted background + a
  brand-blue rule — **only when there is something to publish** (draft ops or outside site
  updates) or while a publish runs; with nothing pending it stays plain and its label goes
  muted, so the prominence keeps its meaning (decisions/00094). In that quiet state the
  Publish button also HIDES (`hidden`) and the bar collapses to a narrow strip
  (`.wx-statusbar:not(.wx-statusbar-pending)` drops the vertical padding that framed the
  button) — with the chip already saying "Nothing to publish", the button is dead
  chrome (operator, 2026-08-02, decisions/00108). The button is hidden from CONSTRUCTION
  (the quiet default), not just hidden on first state load — painting it visible-then-
  hiding made the page jump mid-layout. A RUNNING publish forces the button
  visible even if a state snapshot already reads clean, since it's the progress surface.
  Two load-bearing consequences: the STATE endpoint's `draft.opCount` counts every
  publishable kind (same formula as the preview — decisions/00071/00080's staged page
  adds/deletes and staged media replacements/deletions produce no overlay ops), and any
  publishable mutation that isn't a draft PATCH must fire a shell state refresh — the
  media panel does this via the grid's `onChanged` dep (wired to
  `refreshStateInBackground`), or a staged replacement would leave the bar stale
  (button hidden) until the 60s revalidation. The quiet styling is keyed
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

One `OpQueue` per session (owned by `shell.ts`); most panels take only the `OpQueueLike =
{readonly rev, enqueue}` slice (`editView.ts`). `sectionPanel.ts` instead takes
`SectionOpQueueLike = {readonly rev, enqueueTracked, flushNow}` (decisions/00119) — the real
`OpQueue` class satisfies both without any change, since `enqueueTracked` is an ADDITIONAL
method alongside `enqueue`, not a replacement. DOM/framework-free.
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
- **`enqueueTracked(op): Promise<EnqueueOutcome>`** (decisions/00119) — like `enqueue`, but
  resolves `{accepted: true, rev}` or `{accepted: false}` once THIS op's batch is settled,
  bounded to the SAME flush attempt `flushNow()` triggers (never left waiting on a later
  automatic background retry — a network-error catch settles `{accepted: false}` immediately
  and detaches the resolver, so an eventual retry's own settle is a harmless no-op). Exists
  because `sectionPanel.ts`'s `saveNow()` originally inferred success from `rev` advancing
  across a plain `flushNow()` call — a false positive when a 409-refetch (which itself
  advances `rev` via `fetchCurrentRev`) is immediately followed by a network error on the
  retry: the batch is only re-queued, not landed, but `rev` moved anyway. `enqueueTracked`
  reports the batch's real fate directly instead.

## admin-ui panels (`admin-ui/src/`)

`shell.ts` (chrome + state + the OpQueue + a 60s revalidation loop that drives the
version badge's `check()` — a deploy turns the badge into its green glow; the reload
itself only ever comes from her confirm tap, decisions/00109; same-route panel
re-renders from that loop never close an open drawer — only genuine route changes do,
decisions/00081); `versionBadge.ts` (the status bar's deploy-awareness badge + its
themed reload-confirmation dialog — detailed in the status-bar paragraph above);
`router.ts` (path routes, decisions/00087: pages/edit/theme/
media/chat/history/settings/section); `pagesPanel.ts` + `pageSettingsDrawer.ts` (`meta.*` editing);
`publishDrawer.ts` (review diff + `POST /api/admin/publish` + SSE progress; disables Publish
with a "Nothing to publish" hint when the preview's `opCount` is 0 AND no upstream commits are
pending — decisions/00071; layman wording throughout: the chip reads "N changes ready to publish ·
M site updates" (decisions/00118 reworded this from "N unpublished changes" to match the section
panel's own "ready to publish" banner — both read the same `state.draft.opCount`), the upstream
section is "updates made outside the editor" with a plain-English
explainer — decisions/00081; **five mutually-exclusive body states** (decisions/00095), each a
full `body.innerHTML = ""` swap, never a partial patch: **blocked** (`renderBlocked` — the
publish preview's `validate.ok === false`; "Publishing is paused" + calm body text, "Fix it for
me" → `POST draft/repair` → re-fetches the preview on full success or, on a PARTIAL fix,
swaps to a still-blocked message and **auto-sends** the report (decisions/00114 — a dead end
the owner can't act on doesn't also wait on her pressing a button), and "Send a report" →
`POST report` — no raw validator text ever rendered, no Publish button at all while blocked)
· **reviewable** (`renderReviewable` — the pre-existing diff+confirm UI, unchanged except the
old inline error box is gone since a blocked draft never reaches this state) · **running**
(`renderRunning`, entered synchronously on confirm click, before any await — spinner +
"Publishing your site…" + a stage caption fed by the SSE stream, same `PUBLISH_STAGE_LABELS`
wording the status bar uses) · **success** (`renderSuccess(version)` — a checkmark, "Your site
is live.", "Version N") · **failure** (`renderFailure(reason)` — "Publishing didn't work this
time." + "Nothing changed on your live site, and your edits are safe." + "Try again", the
report **auto-sent** with `reason` as its note and a plain-English status line; the manual
"Send a report" button appears only if that automatic send failed — no raw error detail).

**Which of success/failure it lands on comes from the publish JOB, never from the POST's HTTP
status (decisions/00114).** A successful publish once rendered the failure state because the
POST was aborted at the blanket 10s timeout, blindly retried, and answered `409`. Now:
`publish`/`restore` use `LONG_RUNNING_POLICY` (one attempt, 10-min backstop) in `api.ts`, and
the drawer settles through one idempotent `settleSuccess`/`settleFailure` pair reached by
whichever arrives first — the SSE stream's terminal event (`done`/`failed`), the POST
resolving `ok`, or `reconcile()` polling `GET state`'s `publishJob` whenever the POST resolves
anything else (including a throw). A job still `isRunning` KEEPS the running state; failure
needs real evidence (job `failed`, no job, or the server unreachable). `priorJobId` (passed by
the shell) makes the previous publish's parked terminal job unreadable as this one's outcome —
the drawer-side twin of the watch's `publishWatchArmedJobId`.

`currentRev` is a mutable local that advances past `deps.expectedRev`
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

**`settingsPanel.ts`** (`/admin/settings[/<page>]`, Uxer's Settings-view mandate) — one tab
strip, one `SettingsPage` union (`general`/`appearance`/`shortcuts`/`contact`/`engine`/`ai`/
`system`, `router.ts`), one `pageRenderers` dispatch table; every tab is a plain function
`(deps, teardownFns) => HTMLElement`, no shared base class. Most tabs edit LOCAL browser
state only (`general`'s quick theme/zoom/font-size toggles, `appearance`'s full theme editor,
`shortcuts`' rebind list) or are read-only server status + action triggers (`engine`'s
update/rollback, `ai`'s budget, `system`'s backup/disk/publish summary — spec/independence
04-06, always-exists-but-degrades-gracefully on editions where they don't apply). **`contact`**
(decisions/00127) is the one tab that WRITES persisted site content: `content/_global.json`'s
`phone`/`email`/`address` — already a single shared source every page's template references
via `@phone`/`@email`/`@address` (`builder/render.py`'s `resolved_global_content`, never
hardcoded per-page), and the inline overlay editor already wrote edits back there correctly
(`opTargeting.directOpTarget`, `@key` -> `{file:"_global", path:key}`); this tab is a
dedicated, discoverable place to do the same edit, not a new mechanism. `GET /api/admin/global`
(a direct sibling of `GET /api/admin/theme` — same shape of problem, one non-page-slug content
bucket, `routes_admin_api.py`) reads the current merged value; each field auto-saves on
`change` via `opQueue.enqueue({file:"_global", path:key, value})`, the SAME per-field
auto-save/`discard:true`-reset pattern `themePanel.ts`'s color rows use — NOT the Before &
After section's staged-save model (decisions/00118), which three scalar fields don't need. The
address field is a `<textarea>`: the stored value embeds a literal `<br>` for its one line
break (decisions/00075's plain-render-ready-HTML convention), so `addressToTextareaValue`/
`textareaValueToAddress` (exported, pure, unit-tested directly) decode `<br>` -> `\n` for
display and join typed lines back with `<br>` on save — showing her a literal `"<br>"` in a
plain input would be a real, avoidable rough edge. **`phone`/`email` each have a DERIVED PAIR
key** (`phoneHref`/`emailHref`) every real `tel:`/`mailto:` link on the site binds via
`data-wx-href` — independently of the `data-wx="@phone"`/`"@email"` text binding, since
`data-wx`/`data-wx-href` apply independently on the same element. `ContactFieldConfig.hrefKey`/
`hrefKind` (+ the exported pure `deriveContactHref`) make `commit()` enqueue BOTH keys in the
same batch and Reset discard both then reload the tab from the server — display and href must
never move independently through this tab, a HIGH-severity gap a FINAL HANDOFF review caught
before the first merge (decisions/00127 has the full incident). `address` has no href pair;
`hrefKey` is simply absent from its `CONTACT_FIELDS` entry. `SettingsPanelDeps.opQueue:
OpQueueLike | null` is the one dependency `contact` needs that no sibling tab does (mirrors
`shell.ts`'s existing "theme" route null-guard — the brief window before the shell's own
initial state fetch resolves — localized to this one tab rather than gating the whole settings
route and regressing the other six's load speed).

**`sectionPanel.ts` + `sectionPanelModel.ts`** (decisions/00098) — the registry-configured
admin section editor (`state.adminSections`, Inv 1: no site literals in this module or
anywhere else in the engine — `ca.json`'s `adminSections` array is the only place "Before &
After"/`gallery.sliders`/`gallery.tiles` are spelled out). `shell.ts` renders one nav button
per `state.adminSections[]` entry dynamically (inserted right after Edit via
`editNavItem.after(...)`, re-synced whenever the section list changes on a state reload —
unlike `NAV_ROUTES`, which is static) and mounts `mountSectionPanel(section, {api, opQueue,
win?, openAligner?, onRequestPublish?, onDraftChanged?})` (`opQueue` here is the narrower
`SectionOpQueueLike`, above) for route `{kind:"section", id}`
(the last two deps are decisions/00118's staged-save wiring, below); an unknown `id` (a stale
deep link, or a section removed from the registry) falls back to the pages panel. The panel
owns its own fetch (`api.getContent(section.page)`, mirroring `mediaPanel.ts`'s "owns its own
lifecycle" `mountXPanel` shape rather than `pagesPanel.ts`'s `renderXPanel(data, callbacks)`
one — a collection's ARRAY VALUES live in page content, not `StateResponse`, only its config
does) and treats each `AdminCollection`'s array as one indivisible unit: every add/edit/
reorder/delete stages the WHOLE array locally (`stageLocal`, decisions/00118), and an explicit
Save writes it as one `opQueue.enqueue({file, path, value})` op per dirty collection (the
standard collection rule this codebase already applies elsewhere) — never a partial patch,
and never automatically on every edit the way the rest of the admin works (below).

**Staged save (decisions/00118)** — unlike every other admin surface (auto-save via the
shared `OpQueue`, 300ms coalesce), THIS panel holds edits locally against a `savedState`
snapshot (deep-equal via `sectionPanelModel.itemsEqual`/`jsonValueEqual`, not
reference-equal — editing a field back to its original value reads as clean again) until she
presses **Save**. Three visible stages: **unsaved** — a `wx-field-dirty` class on a changed
input/select, a `wx-section-unsaved-badge` on a changed card, and a sticky bottom
`.wx-section-save-bar` (Save / **Undo last**, a panel-wide bounded stack of pre-mutation
snapshots, purely local / **Discard unsaved**, reverts every collection to `savedState`,
confirmed); **ready to publish** — once Save succeeds (`saveNow()` awaits
`opQueue.enqueueTracked(op)` per dirty collection and checks every settled `EnqueueOutcome`
is `accepted`, decisions/00119 — not inferred from `rev` advancing, the original decisions/
00118 design's known gap, see "Op queue semantics" above), a `.wx-section-ready-banner` at
the TOP of the panel reads the same `state.draft.opCount` the shell's status-bar chip does
(reworded to match: "N changes ready to publish"), with **Publish** (auto-saves any new
dirty edits first, then calls `deps.onRequestPublish`, wired to `shell.ts`'s
`openPublishDrawer()` — the panel never re-implements publish itself, Inv 25) and **Discard
all changes** (confirmed, calls the previously-unwired `api.discardDraft()`, then re-`load()`s
a clean panel and calls `deps.onDraftChanged` so the shell's own chip clears too); **published**
— the existing drawer/pipeline, unchanged. Two guards against losing local work: `shell.ts`'s
`handleRoute` prompts (and reverts the address bar on decline) before leaving the section
route while `activeSectionPanel.hasUnsavedChanges()`; the panel's own `beforeunload` listener
(added on mount, removed on `teardown()`, capability-guarded like `shell.ts`'s own timer/
document checks) covers a real tab close/reload. See decisions/00118 for the full rationale,
including why this panel diverges from auto-save at all.

**Because the panel is that array's source of truth while mounted, anything that rewrites the
draft BEHIND it must tell it to re-read** (`SectionPanel.refresh()`, decisions/00115) — a
publish (which re-points every staged upload at `images/<name>` and deletes the staged file)
and a `POST draft/repair`. `shell.ts` holds the mounted panel in `activeSectionPanel` and
calls `refresh()` from `announcePublishSucceeded` (the one version-guarded terminal path both
the drawer callback and the shell's own watch funnel through) and from the publish drawer's
`onDraftRepaired`. Without it the panel keeps the PRE-publish array and its next edit writes
those now-dead `/admin/draft-media/` srcs straight back, blocking the following publish — the
2026-08-03 production incident. `refresh()` never destroys work in progress: it awaits
`opQueue.flushNow()` first (a Save batches everything staged into one PATCH, and the queue
itself still coalesces at 300ms, so an early re-read could otherwise land between enqueue and
flush), defers to `focusout` while a field inside the panel holds focus, and — decisions/
00118 — ALSO defers while the panel is dirty (any local edit not yet Saved), re-attempting
once she saves, undoes, or discards; in practice a `refresh()` almost never lands on a dirty
panel (Publish auto-saves first), but this covers the race where another tab/device/the AI
assistant triggers one while she's mid-edit here. Per item:
an `image`-kind field opens the shared `mediaDialog.ts` picker (writes `{src, alt}` —
`contentSrc`, never a served `url`, per decisions/00095's fix). Displaying that stored
value back as a thumbnail/preview `<img>` — outside the live-preview iframe, which alone
gets a real `<base href="/">` — must run it through `mediaDialog.contentSrcToDisplayUrl`
first (decisions/00102: both the card thumbnail and the add-flow preview shipped without
this and rendered as broken images in production for every existing item). A `text`-kind field is a
plain input, staged locally on blur/Enter (decisions/00118 — not written to the draft until
Save), entity-decoded for display
(`sectionPanelModel.decodeCommonEntities`) since the value is stored PLAIN and the builder's
BeautifulSoup render pass re-escapes it at serialization time (the same convention
`contentModel.ts`'s `.textContent`-based reads already rely on); a `url`-kind field
(decisions/00120) is the same plain input PLUS a small "Open ↗" link next to it once the
current value looks like a real `http(s)://` URL (`renderUrlField` — never a clickable
`href` for anything else, defensively, since the value round-trips through free text she
can type/paste anything into); a `choice`-kind field is a
`<select>` from `resolveChoiceOptions(field)` (see `optionsFrom` below), staged on change.
Reordering has BOTH a pointer-based
drag (a drop-indicator line, stage-on-release) AND ↑/↓ buttons emitting the identical
whole-array stage — a deliberate addition on top of decisions/00017's earlier "buttons only"
simplification for the INLINE overlay's own item toolbar, kept here as the fallback/
accessibility path while this dedicated screen adds real drag for "her pride" polish
(spec 3c). The guided **add** flow is a linear wizard — one step per `image`-kind field (in
field order), then a final form step for the rest — generalizing the brief's literal
"step 1 Before, step 2 After, step 3 form" to however many image fields a collection
actually declares (one for `gallery.tiles`, two for `gallery.sliders`); Save stays disabled
until `sectionPanelModel.isNewItemComplete` (every image field picked, and every field with
`required: true` non-blank — decisions/00124, replacing an earlier hardcoded "a field
literally named `title` is required" special case, an Inv 1 violation this fixed rather
than kept) — a new item is always born schema-valid,
never a half-filled placeholder landing in the array. `sectionPanelModel.ts` is the pure,
DOM-free half (dotted-path content reads, array reorder/delete/update, the add-flow
completeness gate, entity decoding) — unit-tested directly; `sectionPanel.test.ts` covers
the thin DOM binding on top (kept deliberately DOM-light per spec 3c — the pointer-drag
interaction itself is real-browser e2e territory, not jsdom's).

**Dynamic choice options via `optionsFrom`** (decisions/00124) — a `choice`-kind field's
selectable options normally come straight from its registry-literal `options` array, but
when the field declares `"optionsFrom": "<collection path>"` instead (or as well —
`optionsFrom` wins), `resolveChoiceOptions(field)` (`sectionPanel.ts`, used by both
`renderChoiceField` on the card and `renderChoiceInputRow` in the add wizard) reads that
OTHER collection's own current items straight out of `collectionState` — staged,
possibly-unsaved — and maps each item's `value`/`label` text fields to one
`{value,label}` option (empty `value`s filtered out). This is what lets a project turn a
fixed choice set into an ordinary admin-managed collection instead of a registry literal
only a developer can change: the Before & After gallery's `gallery.categories` is a plain
two-required-text-field collection (`value` internal key, `label` display name), and
`gallery.sliders.cat`/`gallery.tiles.cat` point at it via `optionsFrom` instead of a
static `options` array. Two consequences this required fixing generically rather than
per-collection: (1) a brand-new item's `blankItem()` used to default a choice field from
`field.options[0]`, which is always empty for an `optionsFrom` field — `blankItem` gained
an optional `resolveOptions` parameter (defaults to `field => field.options`, so every
other caller is unaffected) and `sectionPanel.ts`'s `openAddFlow` now passes
`resolveChoiceOptions` through it, so a new item's category defaults to the first real
category instead of silently blank; (2) editing the OTHER collection (renaming a category
label, adding one) must re-render every field that depends on it, since `stageLocal` only
re-renders the ONE collection it's called for — `dependentCollectionsOf(collection)`
(scans `section.collections` for any collection whose fields declare `optionsFrom ===
collection.path`) is now also re-rendered from both `stageLocal` and `undoLast`, so a
label edit updates the dependent dropdown immediately, in the same staged edit, with no
reload (`discardUnsaved` already looped over every collection unconditionally, so needed
no change).

**Grouping collections into tabs** (`AdminCollection.tab`, decisions/00125) — a section with
many collections (e.g. Before & After's category list plus two separate photo collections)
can group them under a switchable tab strip instead of stacking every collection's cards on
one long scroll. Purely additive: `groupCollectionsByTab` (`sectionPanelModel.ts`, unit-
tested directly) buckets `section.collections` by `tab ?? "General"`, preserving registry
order both within and across groups; `renderBody` (`sectionPanel.ts`, replacing `load()`'s
old inline render loop) renders every collection sequentially with NO tab UI at all whenever
that produces exactly one group — today's behavior, and every other section's, byte-for-byte
unchanged — and only builds a `role="tablist"` strip (full ARIA tabs keyboard pattern: Left/
Right/Home/End move focus AND switch the active panel, automatic-activation style) once there
are ≥2 distinct groups. The active tab (`activeTab`, a closure variable) survives a `load()`
re-render — a background refresh must not yank her back to the first tab mid-edit — and
switching tabs is PURELY a `hidden` toggle on each group's wrapper `.wx-section-tab-panel`:
`collectionBodies` still maps every collection's path to its own body element regardless of
which panel contains it, so `stageLocal`/`undoLast`/`dependentCollectionsOf`'s cross-
collection re-render (Inv 30) and a successful Save all work completely unchanged — including
updating a collection on a currently-HIDDEN tab, so switching to it afterward already shows
the live result rather than needing its own re-render trigger (Inv 31; the categories-feeding-
photos shape is the realistic case this guards, and the ONE new test in this area proves it
directly: rename a category while its tab is hidden, then switch tabs and check the OTHER
collection's dropdown already reflects it). The Before & After section uses this to split
"Categories" (`gallery.categories`) from "Photos" (`gallery.sliders` + `gallery.tiles`,
sharing one tab) — the save bar, undo stack, and discard-all/discard-unsaved controls stay
section-WIDE regardless of which tab is active (unchanged from before tabs existed), so an
edit made on one tab is still visible/saveable/discardable after switching away from it.

**The `visible` toggle ("Show on site", decisions/00117 + Inv 28; prominence + bulk actions
decisions/00119)** — a `"kind": "toggle"` `AdminField` renders as a full-width **card-header
switch bar** (`renderVisibilityBar`, prepended as the card's first child, ahead of the drag
handle — NOT in the fields loop with the text/choice fields anymore) rather than a plain
checkbox row: a real `<input type="checkbox">` behind a styled `.wx-switch` track+thumb (native
a11y — keyboard + screen reader support for free — 44px tappable area per the Uxer touch-target
convention), read as `item[field.key] !== false`, next to a plain-English line — "Shown on your
site" when on, "Hidden — not on your site yet. Turn on to add it." when off.
**`.wx-switch-track`/`.wx-switch-thumb` MUST carry `pointer-events: none`** — they have to
follow the checkbox in DOM order for the `:checked + .wx-switch-track` CSS selector below to
work, but a later sibling with no `pointer-events` override paints ON TOP of an earlier
`position: absolute` one and silently swallows every click. This shipped broken past a fully
green `npm test` (jsdom doesn't enforce real paint/stacking order) and was only caught by a
real-browser e2e `.check()` failing with "element intercepts pointer events" — a reminder that
this codebase's "DOM-light unit tests, real interaction in e2e" split (see the aligner
paragraph below) means a CSS stacking bug like this ONLY surfaces in e2e, never earlier. This wording
REPLACED an earlier small "Hidden" chip pill entirely (`.wx-section-hidden-chip`, now deleted)
— the chip only said *that* an item was hidden, never *why it looked greyed out* or *what to do
about it*, which was Purdi's literal complaint. Storage semantics are completely UNCHANGED from
decisions/00117: unchecking still `stageLocal`s `updateItemField(…, field.key, false)`,
re-checking still `removeItemField(…, field.key)` (`sectionPanelModel.ts`) — the key exists only
when `false`, never `true`, matching the builder's own convention exactly; only where and how
prominently the control renders moved, and it stages via `stageLocal` like every other edit
(decisions/00118 — never auto-saves). A card whose item currently has `visible: false` also
keeps the existing `wx-section-card-hidden` class (~0.55 opacity) as a secondary whole-card cue,
driven by the same `item["visible"] === false` check. The guided add-flow's form step
dispatches on `field.kind` with an explicit switch (a `toggle` field used to fall through a
text/choice ternary into an empty `<select>` — decisions/00117 fixed the trap before it
shipped; decisions/00120 hit the SAME class of trap adding `url` and fixed it the same way —
EVERY new kind needs an explicit branch here, never rely on the trailing `else`
un-audited). `url` reuses the plain text row in the wizard (identical UI need during
creation — only the main card view's `renderUrlField` adds the "Open" link, for reviewing an
already-saved value) — its own toggle row (`renderToggleInputRow`, a SEPARATE code path from
`renderVisibilityBar`, untouched by decisions/00119) still starts checked (a new item is born
shown) and writes a key only if she unchecks it before Save.

**Turn all on / Turn all off** (decisions/00119) — each collection header
(`renderCollectionSection`, next to "Add a X") gets two buttons, shown only when the collection
actually declares a `toggle`-kind field: **Turn all on** drops `field.key` from every item
(`sectionPanelModel.showAllItems`), **Turn all off** sets it `false` on every item
(`hideAllItems`) — both pure, generic over `SectionItem[]` + a field key, following the same
"never mutate, always return a new array" convention as `updateItemField`/`removeItemField`.
Both confirm via `win.confirm` ("Show/Hide all N `<itemNoun>`s on/from your site? You choose
when to publish.") and are a no-op on an empty collection (nothing to confirm). Either stages
the WHOLE collection through the SAME `stageLocal` chokepoint an individual toggle uses, so one
bulk action is one Undo step and lands in the same Save batch as anything else she's mid-editing.

**Inline before/after preview** (`beforeAfterSlider.ts`, decisions/00119) — a collection with
`>= 2` `image`-kind fields where the first two are BOTH filled on a given item gets a
lightweight, READ-ONLY drag-to-compare preview inserted immediately after the card's images
block (`renderCard`, `sectionPanel.ts`): two stacked `object-fit: cover` images in a `640:360`
frame (matching `gallery.sliders`'s registry `alignAspect`), the BEFORE image clipped from the
right via `clip-path: inset(0 (100-v)% 0 0)`, driven by a transparent full-frame
`<input type="range">` (native mouse+touch+keyboard drag for free) — `set(v)` updates the
clip-path plus a divider/handle's `left%`. Ported from the PUBLIC site's own gallery slider
(`cottage-aesthetics-preview`'s `pages/gallery.html`, `.bas-frame`/`.bas-before`/`.bas-range`),
restyled with this admin's OWN `--wx-` tokens (two separate design systems — never the site's
earthy palette here). `renderBeforeAfter({beforeUrl, afterUrl, beforeAlt?, afterAlt?, start?})`
is the whole pure-DOM component (no editing controls at all, ever) — reused UNCHANGED, just
filling a wider box, for the tap-to-enlarge modal a small expand button opens
(`.wx-before-after-modal-backdrop`/`.wx-before-after-modal`, mirroring `openAddFlow`'s own
backdrop + Escape-key + click-outside-to-close idiom already in this file, not
`mediaDialog.ts`'s differently-shaped one). Which two fields feed it comes generically from
`collection.fields.filter(f => f.kind === "image")` (Inv 1 — never a hardcoded `before`/`after`
key). NEVER fabricated from one photo: a tile (a single `image` field, `gallery.tiles`) or a
pair with either photo still missing just keeps its existing thumbnail(s) as-is — the fallback
is silence, not a broken half-slider. Completely separate from the aligner below, which it
never reuses, wraps, or replaces (the aligner EDITS a photo's crop/position; this only PREVIEWS
what's already there).

**The before/after aligner** (`alignerDialog.ts` + the pure `alignerModel.ts`,
decisions/00111) — a collection whose registry entry sets `alignAspect: "W:H"` AND
declares ≥2 `image` fields gets a **"Line up photos"** button on each fully-picked card
and in the add flow's form step. The full-screen canvas dialog lets the owner drag a
photo with a finger (pointer events, `touch-action: none`), pinch or slider-zoom, tilt
(±0.25° micro buttons, clamped ±10°), and nudge with a micro arrow pad (long-press
repeat), in a Blend (onion-skin) or Split (the live widget's wipe) view, with a Move
toggle picking which side the controls drive. On save each adjusted side is **baked on
an offscreen canvas at the frame's exact aspect (1920-wide), uploaded through the
ordinary `api.uploadMedia` pipeline, and swapped into the item's `{src, alt}`** (alt
preserved, original upload left in the library) — the site's template/schema/publish
path is untouched, and what she sees in the dialog is pixel-identical to what publishes
(identity transform = `object-fit: cover` at the same aspect). The one rule the model
enforces: the drawn image always covers the whole canvas (a gap would bake as a
border) — every gesture is coverage-clamped by bisection, with two deliberate
auto-compensations (`withPanCompensated`/`withRotationCompensated`) that pay for an
edge-breaking nudge or tilt with a tiny auto-zoom so no button ever feels dead. Unit
tests cover the geometry + wiring (jsdom has no canvas — painting is guarded and
`loadImage` is an injectable dep; the panel stubs the dialog via `SectionPanelDeps.
openAligner`); the real drag→bake→publish journey is e2e in
`section-panel.spec.ts`.

## editor modules (`editor/src/`)

`overlay.ts` (coordinator: hover chrome, popover routing, op emission, list toolbar, `data-wx
-if` eye toggle, `mediaRequest`, shell handshake, browse-mode gating (decisions/00091) — a
`browseMode` flag mirrored from `init`/`setBrowseMode` that short-circuits hover chrome,
click-to-edit, and the eye toggle in favor of plain navigation); `messaging.ts` (origin-checked postMessage);
`opTargeting.ts` (`{file, path}` targeting; encodes "no dotted path indexes an array");
`contentModel.ts` (reads current values back out of the live DOM — the overlay never receives
content values, only shapes; text reads are chrome-stripped and demoted to markdown source,
Inv 23 + decisions/00075; `readListValue` also writes `visible: false` back onto a
reconstructed item whose DOM root carries `data-wx-item-hidden="1"` — the preview-mode marker
for a hidden collection item, Inv 28/decisions/00117 — so a structural edit to ANY OTHER item
in the same list can never silently un-hide it, the same incident class as decisions/00095's
`.cat` attr-drop); `listOps.ts` (pure array transforms — its "add" op strips a cloned
item[0]'s `visible` key so a new item is always born shown, even from a hidden first item;
"duplicate" deliberately keeps it, since a duplicate of a hidden item should stay hidden too;
`overlay.ts`'s DOM-side "add" clone strips the same attribute from the live element, keeping
the DOM and the emitted array convergent — visually, a `[data-wx-item-hidden]` element in the
live preview iframe is dimmed (40% opacity) with a small "Hidden" badge, a CSS-only `::after`
pseudo-element in `editor/src/style.css` — deliberately NOT an injected DOM node, which would
have to join `OVERLAY_CHROME_SELECTOR` in `dom.ts` (Inv 23) to stay out of read-back values; a
pseudo-element sidesteps that requirement entirely, since it's never part of the DOM tree);
`dom.ts` (binding
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
`resolveInternalPageSlug` matches BOTH URL shapes a same-origin page link can carry
(decisions/00128): clean (`/<slug>`, `builder.nav.page_url`'s current convention) and legacy
(`/<slug>.html`, kept forever — no redirects anywhere) — either resolves to the same slug.

## Build

Both packages: `npm ci` → `npm run typecheck` (tsc --noEmit, strict) → `npm test` (vitest) →
`npm run build` (esbuild, two builds — JS iife + CSS — minified, sourcemapped). Output goes to
`wixy_server/static/{admin,editor}/` and is **committed**; CI fails on drift (Inv 2). Note the
theme-preview TS (`themeVars.ts`/`googleFonts.ts`) are hand-ported from `builder/theme.py` and
must match the server byte-for-byte (Inv 20). `editView.ts` splits a pure `createEditViewCore`
(unit-testable router) from the DOM `mountEditView` because jsdom can't test real iframes.
