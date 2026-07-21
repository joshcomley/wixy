# Edit chrome immovable on mobile: visual-viewport pin, form-factor device default, reveal placement

**Date:** 2026-07-21 · **Status:** decided · **Round:** operator mobile feedback (four reports in one)

## Symptoms (operator, on their phone, dark mode)

1. "The edit area at the bottom of the edit screen can scroll off, and then you can't get it
   back again. The top and bottom of the edit area should be rock solid, immovable."
2. "The default display should be what the user is on, auto detected. At the moment it
   defaults to desktop always."
3. "The full screen icon is teeny tiny."
4. "When I press the down arrow to reveal the hidden menu for ten seconds, the menu shows
   below, not above where it should. The gap for it appears above, but it is empty."

## Root causes (each measured, not theorised)

1. **Composer scroll-off** — the composer (and the structured-control sheets, same
   `.wx-composer` fixed positioning) anchors `bottom: 0` to the LAYOUT viewport. Two
   mobile-only mechanisms detach that from what the user sees: the on-screen keyboard
   (shrinks only the visual viewport by default, covering fixed-bottom chrome) and
   pinch-zoom (pans the visual viewport across the layout one — fixed chrome "scrolls
   off" with no obvious way back). Pinch-zooming the OUTER admin shell pans the slim
   edit bar and the whole iframe (with the composer inside it) the same way.
2. **Device default** — the `innerWidth < 480 → mobile` check (decisions/00076) reads any
   phone reporting ≥480 CSS px (real configurations: display-size settings, unusual DPRs)
   as desktop — "always". Measured live: 390px → Mobile ✓, 487px → Desktop ✗. No tablet
   answer existed at all.
3. **Maximize icon** — the ⤢/⤡ codepoints render as tiny, faint glyphs in Android's
   system font (no emoji presentation).
4. **Reveal** — two independent bugs compounding: (a) `.wx-shell-editing .wx-topbar`
   sets `visibility: hidden` and NOTHING reset it on reveal (equal specificity, no later
   rule) — the bar slid open as an EMPTY GAP (layout but no paint); (b) the nav lives
   inside `.wx-body`, which is BELOW the pinned slim edit bar (`.wx-edit-bar-host`) in
   the shell's flex column — so the revealed menu rendered in the wrong place.

## What was decided

1. **Visual-viewport pinning** (`editor/src/visualPin.ts`): every fixed bottom sheet
   (composer, hours/price sheets) tracks `window.visualViewport` resize+scroll and
   re-anchors `bottom`/`left`/width. The composer pins INTERNALLY (its destroy releases);
   the sheets pin at their overlay call sites (released on close). The pin composes with
   the composer's counter-scale: pinned width = visual width × scale, in px.
   PLUS `interactive-widget=resizes-content`, set at overlay startup on the PREVIEW
   document's viewport meta only (`ensureResizesContentMeta` — idempotent, no-ops when
   the site template has no meta, so preview fidelity is never altered): the keyboard
   then resizes the layout viewport itself and the pin's offsets read 0. iOS Safari
   ignores the meta key and is covered by the pin alone.
   PLUS the admin shell's own viewport meta locks user scaling
   (`maximum-scale=1, user-scalable=no, interactive-widget=resizes-content` in
   `admin_shell.html`): an app shell, not content; outer pinch can no longer pan any
   chrome away. Legibility is served by the in-app zoom + font-scale controls.
2. **`initialDeviceFor(width, coarsePointer)`** (`admin-ui/src/editView.ts`): <600 →
   mobile (any pointer); coarse && <768 → mobile (phone landscape); coarse && ≤1366 →
   tablet; fine-pointer <1024 → tablet (narrow desktop window previews as its closest
   small form factor); else desktop. Measured post-fix on the live site: 390→Mobile,
   487→Mobile, 820→Tablet, 1280→Desktop.
3. **Maximize/restore are inline SVGs** (Feather maximize-2/minimize-2 paths,
   `currentColor` stroke, 18px in CSS) — crisp on every platform.
4. **Reveal**: `.wx-shell-chrome-revealed .wx-topbar` now sets `visibility: visible`
   (the later rule wins the specificity tie; instant flip so content shows DURING the
   slide, clipped by the bar's overflow) — closing still hides at the slide's end via
   the editing rule's delayed flip. AND the nav relocates between the topbar and
   `.wx-edit-bar-host` on ≤720px (`matchMedia("(max-width: 720px)")`, re-placed live on
   breakpoint crossings) — desktop's in-body sidebar is untouched.

## Watch for

- The composer's counter-scale only reaches the overlay when a `setDevice` message lands
  AFTER the overlay loads; the mount-time one is posted before the iframe exists and is
  lost. On a device whose INITIAL simulation is squished (e.g. tablet default on a
  700px-wide screen) the composer text starts iframe-scaled until the first device
  switch/resize. Cosmetic, noted here so it isn't rediscovered as a mystery.
- `admin_shell.html`'s zoom lock also disables double-tap zoom in the shell — intended;
  the preview's OWN page zoom inside the iframe is unaffected on iOS Safari (which
  ignores `user-scalable=no` anyway) but Android Chrome honors it everywhere.
- The mini-site fixture gained the standard `width=device-width` viewport meta (real
  sites ship one — ca does), which is what exercises the overlay's meta append in e2e.
