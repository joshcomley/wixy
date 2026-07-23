# Browse-mode toggle

## Symptom / request

Operator request (2026-07-23, verbatim): "On the Editor, I need a toggle
button with a mouse icon, with that's toggled on, tapping just browses the
site. I should be able to navigate around and edit other pages, then untoggle
it, and continue editing a different page, all in one edit session."

Edit mode already lets you click through *unbound* content links (spec/05 §2's
original "browsing inside the iframe stays in edit mode"), but any BOUND
element intercepts the click for editing instead — critically, the header/
footer nav links are `data-wx-href`/`data-wx` bindings (the CTA pattern,
`builder/tests/fixtures/mini-site/partials/header.html`'s `<a data-wx-href=
".href" data-wx=".label">`), so clicking a nav link in edit mode has never
navigated — it opens the link-edit popover. There was no way to just click
around the site the way a visitor would while staying inside the draft
preview, short of the Pages panel's page-by-page Edit action.

## What was decided

**A session-scoped `browseMode` flag, toggled by a mouse-icon button
(`.wx-browse-mode-toggle`, an inline SVG — see "What to watch for" on why not
the 🖱️ emoji) in the edit bar, that suspends editing interception
overlay-side.** While on:

- `overlay.ts`'s `handleClick` skips binding detection entirely and routes
  straight to the existing `handlePlainAnchorClick` — the same internal/
  external resolution unbound links already used, now applied to EVERY anchor
  regardless of whether it also carries `data-wx-href`. A bound link
  navigates instead of opening its popover; a bound non-link is simply inert,
  same as clicking plain content on the real site.
- Hover chrome (outline + chip), the list item toolbar, and the `data-wx-if`
  eye toggle are all suppressed too — `handlePointerOver` short-circuits, and
  the eye toggle is both CSS-hidden (`.wx-browse-mode [data-wx-if][data-wx-
  hidden] .wx-if-eye-toggle { display: none }`) AND JS-gated in
  `handleIfToggleClick` (belt-and-braces: unlike hover chrome/popovers/the
  item toolbar, which are created on demand and so are fully disabled by
  gating their creation, the eye toggle is a real DOM node sitting inert in
  every hidden section at rest — a CSS regression alone would silently
  re-enable it).
- Turning browse mode ON mid-session force-clears whatever editing chrome is
  already open (`closePopover`/`clearHoverChrome`/`clearItemToolbar`) — the
  toggle button lives in the shell, OUTSIDE the iframe, so clicking it fires
  no mouseout/blur inside the preview document to do this for free.

**State lives in `admin-ui/src/editView.ts`'s `mountEditView`, not the
overlay.** A plain closure `let browseMode = false`, exactly the lifetime the
feature needs: this `EditView` instance already survives every in-session
page change — both overlay-driven (`shell.ts`'s `reuseEditView`, following a
`navigate` message) and shell-driven (Pages panel → Edit, while already in
the edit route) — so the toggle and its state ride along for free. Leaving
edit mode entirely tears the whole closure down; the next `mountEditView`
call starts fresh at off, with no separate reset needed.

**The protocol gets one field and one message**, both added the same way
`setDevice.scale` was (optional/absent-means-default, so existing `init`
senders — every current test's `initFor` helper — still parse without
changes):

- `InitMessage.browseMode?: boolean` — a REAL iframe navigation destroys the
  overlay's whole JS state, so a freshly-booted overlay needs to learn the
  CURRENT mode on the very first message it can receive, not a follow-up
  round trip that could race the very first click on the page that just
  loaded. `editView.ts`'s `EditViewCoreDeps.browseMode` is a getter
  (`() => boolean`), read fresh inside `requestInit` on every `ready`, not a
  value snapshotted when the core was constructed.
- `SetBrowseModeMessage {enabled}` — flips an ALREADY-loaded overlay live, no
  reload, for the toggle click itself.

**The button is built inside `mountEditView`, not passed in from `shell.ts`**
via `toolbarLeading`/`toolbarTrailing` like the back/Settings/chrome-reveal
buttons are. It drives the overlay directly (posts `setBrowseMode`) the same
way the device buttons drive `setDevice` — keeping that wiring inside
`editView.ts` avoids a forward-reference from a shell-built button back into
an `EditView` value that doesn't exist yet when the button is constructed,
and matches the file's existing "iframe/overlay wiring lives here, shell
chrome is handed in" boundary. It sits directly after the device group in the
toolbar row (both are "how the iframe below behaves" controls, distinct from
back/Settings/reveal's shell-level chrome).

## Why not the alternatives

- **Rely on the CSS `[data-wx-hidden]` opacity/eye-toggle visuals matching the
  real site exactly (fully hiding falsy `data-wx-if` sections) while
  browsing**: out of scope — the ask was about TAP/click behavior, not visual
  fidelity, and browse mode is still explicitly inside the DRAFT preview, not
  a switch to the literal published site; draft-only affordances like hidden-
  section dimming staying visible is consistent with that.
- **Session/localStorage-persisted browse-mode state (survive a full admin
  shell reload, not just an iframe navigation)**: the request was specifically
  about surviving iframe navigation within one edit session ("all in one edit
  session"), not surviving leaving/reloading the admin app entirely — a
  reload is a fresh session by every other convention here (the OpQueue, the
  composer's per-binding draft recovery aside, isn't otherwise resumed
  mid-flight either). A plain in-memory closure is the minimal mechanism that
  satisfies the actual ask.
- **A required (non-optional) `browseMode` on `InitMessage`**: would have
  forced updating every existing `initFor`-based test's expected `init`
  payload across the suite for a field most of them don't care about.
  Optional/absent-means-off mirrors `setDevice.scale`'s own precedent exactly.
- **Gate only via CSS for the eye toggle, matching the "created on demand"
  chrome's JS-only gating**: rejected — the eye toggle is the one piece of
  browse-mode-suspended chrome that sits in the DOM at rest rather than being
  created on interaction, so CSS-only gating is a single point of failure a
  future stylesheet edit could silently reopen with no unit test catching it;
  the other three suppressions (hover chrome, item toolbar, popovers) don't
  have this gap because gating their *creation* is airtight by construction.

## What to watch for

- **The 🖱️ emoji (U+1F5B1 MOUSE) has no glyph in this box's font stack —
  verified in real Chromium, Edge, AND Chrome, not just a Playwright-bundled-
  browser artifact.** It rendered as an unrecognizable shape while ⚙️/🌐 right
  next to it in the same test page rendered fine. Same class of bug the
  composer's maximize toggle already hit and fixed (decisions/00084: "the
  full screen icon is teeny tiny" on Android) — the general lesson repeats:
  don't trust an arbitrary emoji codepoint to have a real glyph on every
  platform; either verify it in a real browser first, or default to an
  inline SVG (Feather icon set, matching `composer.ts`'s `MAXIMIZE_ICON`/
  `RESTORE_ICON` pattern — `stroke="currentColor"`, sized via a `<button>
  svg { width; height }` CSS rule) for anything that must render reliably.
  `editView.ts`'s `MOUSE_ICON` is that fix here.
- **A same-specificity, later-in-source `background` declaration
  (`.wx-browse-mode-toggle-active` alone, vs. the earlier `.wx-browse-mode-
  toggle`) did NOT win the cascade in real-browser verification** — confirmed
  with `CSS.getMatchedStylesForNode` over CDP, and with `sheet.insertRule`
  appending the override straight onto the LIVE stylesheet object's true
  last index (ruling out any build/bundling/minifier reordering). `!important`
  reliably won; an isolated two-class COMPOUND selector (`.base.active`,
  genuinely higher specificity, no order-dependence) also reliably won. Root
  mechanism unconfirmed (plausibly an interaction between esbuild's minifier
  merging this rule with `.wx-device-toolbar button.wx-device-active`'s
  identical declaration body into one comma rule, and how this specific
  Chromium/Blink build resolves specificity across that merged selector list
  for the alternative that ISN'T the highest-specificity one in the group —
  unverified, not chased further). The fix applied
  (`.wx-browse-mode-toggle.wx-browse-mode-toggle-active`, decided above) is
  the generally-correct pattern regardless of the exact cause: a
  toggle/active modifier class should always be a compound selector with its
  base, not a same-specificity sibling relying on source order surviving a
  bundler. **If a future "active"/"selected" state class in this codebase
  silently fails to override its base style, check this first** before
  assuming a typo — verify via `getComputedStyle`, not just a screenshot at
  a glance (the emoji bug above nearly masked this one: a tiny/wrong glyph
  and a wrong background both look like "the button looks off" until you
  isolate which is which).
- `editor/src/protocol.ts` and `admin-ui/src/protocol.ts` must stay
  byte-identical (Inv 20) — both were updated together here; if either drifts
  on a future change, diff them before shipping.
- `mountEditView` is NOT unit-tested directly anywhere in this repo (jsdom's
  iframe/cross-document `postMessage` isn't reliable enough, per the file's
  own header comment; `shell.test.ts`/`themePanel.test.ts` always inject a
  fake `mountEditView`) — the toggle button's real DOM behavior is covered
  only by `e2e/tests/browse-mode.spec.ts` (real Chromium) and by unit tests
  of the pure logic it depends on (`createEditViewCore`'s `browseMode`
  threading, and the overlay's click-routing/chrome-suppression). A future
  change to `mountEditView`'s button-building code has no jsdom safety net —
  run the E2E suite.
- The theme panel's embedded preview iframe (`themePanel.ts`, reusing
  `mountEditView` wholesale per decisions/00021) gets the browse-mode toggle
  too, for free — not specifically requested, but consistent with that
  preview already supporting full click-to-edit and internal navigation.
