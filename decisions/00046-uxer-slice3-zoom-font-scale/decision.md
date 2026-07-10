## Symptom / context

Uxer slice 3 (harness task #16): UXER-INTEGRATION.md §2/§3 mandate independent
zoom and font-scale controls in the app's chrome — `+`/`−` buttons, keyboard
shortcuts (`Ctrl+Plus`/`Ctrl+Minus`/`Ctrl+0` for zoom, `Ctrl+Shift+Plus`/
`Ctrl+Shift+Minus` for font-scale), a live percentage display, both
persisted. See decisions/00045 for slice 1's theme work this builds on.

## Font-scale required a full px→rem conversion, not just new controls

UXER-INTEGRATION.md's web-platform table gives two options for font-scale:
"scale the root CSS custom property that drives typography" or "font-size on
`<html>` if using rem-based typography throughout." admin-ui/src/style.css
had ~70 `font-size`/`font:` shorthand declarations, all in fixed `px`
(confirmed by grep: only the values {10,11,12,13,14,15,16,18} appeared, no
outliers). A `px` value never responds to a change in `<html>`'s font-size —
so implementing font-scale as anything less than converting every one of
those declarations to `rem` would have made the feature a no-op for real
content, working only for the new controls' own labels. Wrote a one-off
Python regex script (two patterns: `font-size:\s*(\d+)px` and
`font:\s*(?:\d+\s+)?(\d+)px`, both anchored to the literal property prefix so
box-model `px` values like `padding`/`gap`/`border-radius` were never
touched) and ran it once: 70 replacements, verified via `git diff --stat`
(70 insertions/70 deletions, no other lines touched) before proceeding.
`fontScale.ts` then sets `document.documentElement.style.fontSize =
"<pct>%"` — a *percentage*, not a fixed px, so it composes with whatever the
browser's own root font-size already is (which may itself reflect an OS/
browser accessibility text-size preference) rather than flattening it to an
assumed 16px baseline.

Chose `rem` over the alternative (`calc(14px * var(--wx-font-scale))`
wrapped around every declaration) because both require touching the same
~70 lines, but `rem` values are simpler to read/write for any future
component and don't need a `calc()` wrapper remembered at every call site.

Zoom uses the other web-platform option from the same table: CSS `zoom` on
`<html>` (simpler than `transform: scale()` + manual layout/scroll
compensation, and explicitly endorsed for this exact case).

## Keyboard shortcuts: `.code` + modifiers, not `.key`

`Ctrl+Plus` and `Ctrl+Shift+Plus` share a physical key (the `=`/`+` key on
most layouts) — typing `+` itself usually already requires Shift, so a
`.key === "+"` match can't distinguish "user pressed Ctrl+Plus" from "user
pressed Ctrl+Shift+Plus" on many keyboards; `.shiftKey` and `.key` would
disagree in a way that makes them unreliable together. `zoom.ts`/
`fontScale.ts` instead match on `KeyboardEvent.code` (the physical key,
`"Equal"`/`"Minus"`/`"Digit0"`, unaffected by Shift) combined with
`e.shiftKey` as the actual discriminator between the two features'
shortcuts (`Ctrl+Equal` = zoom in, `Ctrl+Shift+Equal` = font-scale up). Also
matches the numpad codes (`NumpadAdd`/`NumpadSubtract`/`Numpad0`). Both
handlers require `!e.altKey` too, since AltGr composition reports both
`ctrlKey` and `altKey` true on some international layouts and would
otherwise misfire.

## Real bug found only by real-browser verification: stale label on keyboard-driven change

Unit tests (zoom.test.ts/fontScale.test.ts, written first) asserted only on
`controller.getLevel()` and the applied CSS (`style.zoom`/`style.fontSize`)
— both correct in isolation. Headless-Playwright verification against the
local fixture server (same method as decisions/00045) found the topbar's
visible percentage label went stale after a keyboard shortcut: clicking
`+`/`−` updated the label (shell.ts's click handlers called `renderZoom()`
manually right after invoking the controller), but `Ctrl+Plus`/`Minus`/`0`
— handled entirely inside `zoom.ts`'s own internal `keydown` listener —
changed the real state (`localStorage`, `<html>` style) correctly but never
told shell.ts to re-render the label. Confirmed root cause (not a Playwright
artifact) with a targeted diagnostic: an `EventTarget`-registration probe
showed the listener was attached correctly and receiving the real event;
tracing a debug log through `matchShortcut` confirmed it matched and called
`setLevel` correctly; the gap was purely "no notification path out."

Fixed properly rather than patching around it: both `initZoom` and
`initFontScale` now take an optional `onChange(level)` callback, invoked
from inside `setLevel` (so it fires for every state change regardless of
origin — click, keyboard, or a future caller). `shell.ts` wires
`onChange: renderZoom` / `onChange: renderFontScale` at construction and
the click handlers now just call the controller method — the redundant
manual `renderZoom()` call after each click was removed since `onChange`
now covers it too. Added dedicated regression tests
("onChange also fires for a keyboard-shortcut-driven change") to both test
files so this exact gap can't silently regress — the existing
state-only assertions would not have caught it.

Small process note for future slices: a debug `console.log` with 6 object
properties in one call had `action` silently dropped from Playwright's
`msg.text()` output — Chrome DevTools Protocol's console object-preview
truncates wide object previews. Don't spend time debugging a "missing"
property from a wide console.log object dump; reduce to a short string
concatenation (or fewer keys) to get a trustworthy read.

## Other small judgment calls (logged per house style, not asking back)

- Bounds: zoom 50–200% step 10 (default 100), font-scale 80–150% step 10
  (default 100). Not spec-mandated exact numbers — reasonable ranges,
  consistent step size, easy mental math for the percentage display.
- Zoom's `Ctrl+0` resets to 100% per spec; font-scale has no reset shortcut
  in spec (only `Ctrl+Shift+Plus`/`Minus`) so none was bound — the
  controller still exposes a programmatic `reset()` for slice 4/6 (Settings
  view, theme editor) to call from a UI button.
- New topbar buttons stayed at their natural small size (~26px) on the
  mobile breakpoint rather than being bumped to the 44px touch-target
  convention slice 1 applied to nav items and row-action buttons — matches
  the existing `.wx-theme-toggle` precedent (already 30px, unchanged on
  mobile in slice 1), treating topbar micro-controls as a distinct compact-
  chrome tier from primary interactive rows.
