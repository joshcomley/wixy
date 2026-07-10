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

## CI-only bundle-drift failure: a Windows-only CRLF leak into the sourcemap

PR #58's first push (`2903043`) failed CI's `frontend` job specifically on
"bundle drift check (committed bundles must match a fresh build)"
(`git diff --exit-code -- wixy_server/static`), even though every local
check (typecheck, vitest, `npm run build` re-run, ruff, mypy, pytest) had
been green immediately beforehand. Root-caused rather than dismissed as a
flake, per house discipline:

- The CI diff isolated to exactly one file, `admin.css.map` (not `admin.js.map`,
  not `admin.css`/`admin.js` themselves) — pointing at something specific to
  `style.css`'s sourcemap, not a general build nondeterminism.
- Measured actual bytes: the working-tree `style.css` had 1528 CRLF / 0 bare
  LF; `git show HEAD:admin-ui/src/style.css` (the committed blob) had 0 CRLF
  / 1528 bare LF. Every OTHER file touched this slice (zoom.ts, fontScale.ts,
  both test files, shell.ts, admin_shell.html) was LF-only in the working
  tree, matching the committed blob — so this was specific to `style.css`,
  not a general Windows/git issue on this box.
- `.gitattributes` (`* text=auto eol=lf`) already documents this exact
  failure class in its own comment: esbuild embeds `sourcesContent`
  verbatim into a sourcemap, so a CRLF-tainted local source produces a
  `*.map` differing byte-for-byte from CI's clean LF checkout, purely from
  line-ending noise — nothing to do with any real content change.
- Traced the actual introduction: this slice's `px_to_rem.py` one-off script
  (see the font-scale section above) opened `style.css` with Python's
  default Windows text-mode `open(path, "w")`, which translates `\n` →
  `\r\n` on write. It read an LF file and wrote a CRLF one, entirely outside
  git's own `eol=lf` normalization pipeline (which only fires on
  checkout/checkin, not on an arbitrary script's raw file write in between).
  Every subsequent local `npm run build` then baked CRLF-based
  `sourcesContent`/`mappings` into `admin.css.map`, which got committed —
  git's checkin-time LF normalization doesn't reach inside a JSON string's
  *escaped* `\r\n` sequences, so the drift was permanent until rebuilt from
  a genuinely-LF source.

Fix: `git checkout -- admin-ui/src/style.css` did **not** restore LF on
this box (`core.autocrlf=true` apparently still wins over the path's
`eol=lf` attribute for this checkout direction here — a machine/git-version
quirk, not investigated further since a working alternative existed).
Wrote the git blob's exact bytes to disk directly in binary mode instead
(bypassing Python's text-mode translation entirely), confirmed
byte-identical to `HEAD` via `git diff --exit-code`, then reran
`npm run build` and committed only the resulting `admin.css.map` change
(`848c18b`). **Lesson for future slices**: any one-off Python script that
rewrites a tracked text file on this box should open with
`newline=""` (or write in binary mode) to avoid silently reintroducing
CRLF — the built-in Edit/Write tools already do this correctly (verified:
every other file this slice touched came out LF-only), only the raw
`px_to_rem.py` script sidestepped it.

## CI-only: git push/fetch hangs via the Bash tool, and a stalled e2e job

Two unrelated infra flakes hit while shipping this slice's fix commit,
both root-caused rather than worked around blind:

1. `git push`/`git fetch`/`git ls-remote` invoked via the **Bash** tool
   hung (2min timeout on push, 30s timeouts on two follow-up fetches),
   even though the push had actually already succeeded server-side
   (confirmed via a `GIT_TRACE=1` run redirected to a file, which
   completed in ~1.5s real time and showed the true cause: after a
   successful transfer, git's own credential-helper flow shells out to
   `'C:\Program Files\GitHub CLI\gh.exe' auth git-credential store` to
   cache the credential — an *internal* `gh.exe` invocation, not one this
   session made directly. That nested call hangs under the Bash tool's
   MSYS pty the same way a direct `gh` call does (the fleet's
   already-documented "gh gives no output via Bash" issue), just one level
   removed — so it's not only explicit `gh` commands that need the
   PowerShell tool on this box, plain `git` network commands can trigger
   the identical hang indirectly. Routing them through PowerShell instead
   resolved it immediately (sub-second `fetch`/`ls-remote`).
2. PR #58's `e2e` CI job stalled for 9+ minutes on the "install playwright
   browsers" step — confirmed anomalous, not just slow, by diffing against
   PR #57's same step on the same workflow (23 seconds there, via
   `gh api repos/.../actions/jobs/<id>` step timestamps). Nothing in this
   slice's diff touches `e2e/`, `package.json`, or anything
   Playwright-related, so this was runner-side (a stalled download/apt
   mirror), not a regression to chase in-repo. Cancelled
   (`gh run cancel`) and re-ran just the failed job
   (`gh run rerun --failed`) rather than waiting indefinitely or debugging
   further — the standard, correct remedy for an isolated infra stall once
   it's been shown to be genuinely anomalous rather than assumed so.

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
