# 05 — Admin UI & the live visual editor

The admin lives at `https://ca.cinnamons.uk/admin/` (Cloudflare-Access-gated, see 07).
It is a **static-shell, API-hydrated** app: the shell paints in <100 ms, all data arrives
via `/api/admin/*` fetches into skeletons (fleet instant-render rule). TypeScript strict
(`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), **no framework** —
small typed DOM helpers, esbuild-bundled into `wixy_server/static/admin/` at build time.
All assets self-hosted (no CDN).

## 1. Shell layout

```
┌──────────────────────────────────────────────────────────────┐
│ Wixy · Cottage Aesthetics        [draft: 4 changes] [Publish]│  top bar
├─────────┬────────────────────────────────────────────────────┤
│ Pages   │                                                    │
│ Edit    │                                                    │
│ Theme   │              main panel                            │
│ Media   │   (preview iframe / panel content)                 │
│ Chat    │                                                    │
│ History │                                                    │
└─────────┴────────────────────────────────────────────────────┘
```

Top bar is always present: project name, draft-status chip (n changed keys + upstream
commits not yet published, click → review drawer), **Publish** button, and a "Site ▸" link
opening the live site. Navigation is client-side routing on proper paths — `/admin/pages`,
`/admin/edit/<page>`, `/admin/theme`, `/admin/media`, `/admin/chat`, `/admin/chat/<conv>`,
`/admin/history` (decisions/00087: every panel path serves the same shell; legacy `#/…`
links canonicalize and keep working).

## 2. Edit mode (the heart of the product)

`/admin/edit/<page>` shows a device-width toolbar (Desktop 1280 / Tablet 820 / Mobile 390) and an
**iframe** loading `/admin/preview/<page>.html` — the draft render (04 §4) with
`editor.js` + `editor.css` injected by the preview renderer. Browsing inside the iframe
stays in edit mode: the overlay rewrites internal link clicks to the preview equivalent and
notifies the shell (URL hash + page dropdown follow along). External links are inert in
edit mode (toast: "external link").

**Browse mode** (decisions/00091): a mouse-icon toggle next to the device buttons lets an
operator suspend click-to-edit entirely and just browse — every click either navigates
(internal links, including bound ones that would otherwise open their popover) or is inert,
exactly like the published site. Hover chrome, popovers, the list item toolbar, and the
`data-wx-if` eye toggle are all suspended while it's on. The point is clicking through
several pages to find the one you actually want without edit popovers getting in the way,
then flipping it back off and continuing to edit — on whichever page you landed on — in the
SAME session: no reload, no lost draft state. The toggle's state lives in the shell (the
edit view already survives every in-session page change, `shell.ts`'s `reuseEditView` —
decisions/00018) and is handed to each freshly-booted overlay via `init` — a real iframe
navigation destroys the overlay's own JS state, so this can't be a follow-up round trip
without risking a race against the very first click on the page that just loaded.

### Overlay ↔ shell protocol

`postMessage` on a fixed channel (`{wx: 1, type, …}`), both directions, origin-checked:

- shell → overlay: `init {page, bindings, draftRev, browseMode?}`, `applyOps {ops}` (echo
  after server accept), `setDevice`, `themeVars {css vars map}` (live theme preview),
  `select {key}`, `setBrowseMode {enabled}` (the browse-mode toggle, decisions/00091).
- overlay → shell: `ready`, `op {file, path, value}` (an edit the user made),
  `navigate {page}`, `selected {key, kind, rect}`, `mediaRequest {key}` (image binding
  clicked — the shell opens the media dialog and answers with `applyOps`).

The **shell owns state**: it PATCHes `/api/admin/draft` (optimistic, queued, coalesced at
300 ms; 409 → refetch overlay + replay queue) and echoes accepted ops back down. The
overlay does pure DOM work; a hard iframe reload always reconverges (server render is the
same merge).

### Selection & editing chrome (inside the iframe)

- Hover on any bound element (`[data-wx], [data-wx-img], [data-wx-bg], [data-wx-href],
  [data-wx-list]`): outline (2px, brand blue, 4px radius) + a floating chip naming the kind
  ("Text", "Image", "Link", "List"). Bound elements get `cursor: pointer` in edit mode.
- **Click a text binding** → the **composer**: a bottom-anchored sheet (cmd-chat style,
  decisions/00075 — supersedes the former inline plain/rich-lite popovers):
  - functions row (**B / I / link** inserting markdown markers around the selection,
    maximize to ~80vh for long text, ✓ save, ✕ cancel);
  - auto-growing textarea capped at ~5 lines / ~20% viewport;
  - Enter = newline, Ctrl+Enter or ✓ commits, Esc cancels (restores the pre-edit DOM);
  - live: keystrokes render the markdown (02 §5 amendment) into the element immediately;
    commit stores the markdown SOURCE as the `op` value.
  - **structured controls** (decisions/00077): a text binding whose element carries
    `data-wx-control="opening-hours"` or `data-wx-control="price"` in the template
    opens a dedicated sheet instead — the hours sheet edits the whole list as
    day/closed/times rows (one whole-array op); the price sheet edits the text as
    label/amount rows. Both keep a free-text mode ("edit as plain text" / per-row
    custom text), so authoring stays as unconstrained as before.
    `data-wx-control="qa"` (decisions/00090) opens a FULL-SCREEN editor instead:
    the whole Q&A list as question/answer cards with add/remove row (one
    whole-array op), covering the preview viewport rather than bottom-anchored.
- **Click an image binding** (`data-wx-img`/`data-wx-bg`) → "Replace image" button + alt
  input; Replace opens the shell's media dialog (§4). A dashed drop target also accepts a
  direct file drop onto the element.
- **Click a link binding** → popover with label (if the same element is also `data-wx`) +
  href field with page-picker (internal pages listed) / raw URL / tel: / mailto:.
- **Click an attribute binding** (`data-wx-attr`, e.g. the booking URL on `<body>` —
  reachable via a "Site links" row in the page-settings drawer since `<body>` isn't
  hover-targetable) → plain input per bound attribute key.
- **Lists**: hovering an item shows an item toolbar (↑ ↓ ✚ duplicate, ✖ delete, ⠿ drag
  handle); ✚ appends a blank-ish item cloned from the first item's shape (02 §6); delete
  confirms. The whole-array op is emitted after each structural change.
- **`data-wx-if`** elements render with 40% opacity + an eye toggle in edit mode when
  falsy (hidden on the real site), so hidden sections stay reachable.
- Editing chrome never mutates layout metrics (outlines are outline/box-shadow, popovers
  are position:fixed in a top-layer container) — what you see is what publishes.

### Page settings & pages panel

`#/pages`: table of pages (from `/api/admin/state`) — nav label, title, in-nav toggle,
nav order, last-modified; actions: Edit, Duplicate (POST `/api/admin/pages/duplicate`
{from, slug, navLabel} — copies template + content under the new slug), Delete (typed-
confirmation; takes effect at publish as a `git rm`). Per-page settings drawer edits
`meta.*` (title, description, ogImage via media dialog, nav fields).
Structural/layout work beyond this is explicitly the **AI chat lane's** job — the pages
panel says so in an empty-state hint.

## 3. Theme panel

`#/theme`: token groups exactly mirroring `theme.json` (02 §4):

- **Colors**: swatch grid; each opens a color input (native `<input type=color>` + hex
  field + the site's current palette as presets). Every change live-applies to the edit
  iframe via `themeVars` AND stores the op (`theme:colors.x`).
- **Fonts**: three slots (Headings / Body / Script) with a curated dropdown (~24 Google
  families with in-dropdown preview rendered via the fonts link) + custom-family input +
  weights multi-select. Live-applies by swapping the preview iframe's fonts `<link>`.
- **Effects**: shadow token as a raw string field (advanced).
- A "Reset to published" per-token and per-panel action (discards those draft keys).

## 4. Media panel & dialog

`#/media`: grid of repo `images/*` + staged draft uploads (badge "draft"), with dimensions,
file size, and **references** (which binding keys use it — from the reference scan
endpoint). Upload button + drag-drop (multi-file). Unreferenced-media delete per 02 §9.
The same component renders as a modal **dialog** when invoked from the editor (mediaRequest)
— pick or upload, returns the image object `{src, alt}` with alt prompted (pre-filled from
filename; empty alt allowed only after an explicit "decorative" checkbox — accessibility
default-on).

## 5. Publish & history

- **Publish button** → review drawer: the draft diff grouped by page (old → new text
  snippets, image thumbs before/after, theme token chips), upstream commits since the
  published SHA (subject lines — this is where AI-lane merges surface), the `builder
  validate` result, and a message field (pre-filled `"Content update via Wixy editor"`).
  Confirm → POST `/api/admin/publish`; progress states stream (04 §5): `pulling → merging →
  committing → building → verifying → swapping → done` with the new version number, or a
  failure state with the full error log inline (draft intact, site untouched).
- `#/history`: the publish ledger (04 §6) newest-first: version #, when, message, author
  (editor/AI/mixed), SHA, changed-file summary. Actions per row: **View** (opens that
  build read-only at `/admin/versions/<n>/…` — served from the archived build dir),
  **Restore** (typed confirmation; POST `/api/admin/restore` — see 04 §6 semantics:
  instant live swap + draft reset to that version, recorded as a new version).
- Publishes are serialized server-side; the UI disables Publish while one runs (state from
  `/api/admin/state`).

## 6. Chat panel

`#/chat` — the cmd-powered assistant, spec'd in [06-ai-chat.md](06-ai-chat.md). UI shape:
conversation list (title, status dot: working/idle/done, last message time) + "New
conversation"; `#/chat/<conv>` is a standard chat view (markdown rendering incl. fenced
code, tool-activity collapsed as "⚙ n actions" rows, timestamps), a composer with
Shift+Enter newline, and a status strip showing the agent's live state (typing/working
indicator driven by the poll). A pinned banner explains the contract: *"Changes the
assistant ships land in your draft preview — review them in Edit, then press Publish."*
When the assistant's latest activity merged commits upstream, the panel surfaces a
"Preview updated — review changes" chip linking to `/admin/edit/<likely page>`.

## 7. Error & offline behavior

Every fetch has a 10 s timeout + retry-with-backoff (3×); a persistent red toast appears
when `/api/admin/state` fails (server down) with auto-retry. PATCH conflicts (409) resolve
silently by refetch+replay; a genuinely lost edit is impossible (ops are queued until
acked). The editor never blocks on the network for keystrokes (fully optimistic).

## 8. Not in v1 (explicitly)

Multi-user presence/locking (single operator + owner), undo/redo stack beyond per-key
"reset to published" (git history covers it), arbitrary element re-arranging by drag
(AI lane's job), in-editor CSS editing beyond theme tokens, A/B or scheduling, i18n.
Do not build speculative hooks for these.
