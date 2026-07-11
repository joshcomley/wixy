# 00014 [h8k3nx] Uxer integration — admin-ui dark theme + mobile + full framework adoption

## What
Operator request, post-build (after M13 closed): "implement a dark theme... implement
UXER... gives us theming and mobile support." `Uxer/UXER-INTEGRATION.md`
(`joshcomley/Uxer`, cloned at `D:\Servers\Cmd\Storage\clones\Uxer`) mandates 9
subsystems for any adopting app, not just a dark toggle — scoped into 7 slices
(harness tasks #14-#20):

1. Design system + dark/light/system theme + mobile-responsive layout (this covers
   what the operator asked for in their own words)
2. (folded into 1 — same files)
3. Zoom + font-scale controls
4. Settings view + keyboard shortcuts page + session persistence
5. Screenshot button + app icon/favicon
6. Theme editor (live color editing, contrast warnings, export/import)
7. MCP compliance-bridge integration (uxer-style.json, bundle, bridge script, routes)

## Why
The operator viewed `/admin` live on their phone (post-M13) and found it cramped,
pure-white-only, no dark mode. Uxer is the fleet's own UI-automation + UX-compliance
framework; "implement Uxer" means adopting its full mandatory standard, not just the
narrower "dark theme" framing — per this whole chain's own discipline (implement
faithfully, don't downscope), doing so properly rather than cherry-picking.

## Context / current state
Not part of the original 13-milestone spec/00-09 — genuinely new, operator-initiated
scope after the build's own M13 close. admin-ui's CSS already routed every color
through ~8 custom properties, which made slice 1 (theme) tractable without a
per-component rewrite. See decisions/00045 for the full palette/contrast reasoning
and mobile-breakpoint decisions.

## Relevant files
- `D:\Servers\Cmd\Storage\clones\Uxer\UXER-INTEGRATION.md` (the framework's own
  integration guide — read the "Web Application Integration" section, not the
  Avalonia-desktop sections, for anything server/browser-side)
- `admin-ui/src/style.css`, `admin-ui/src/theme.ts`, `admin-ui/src/shell.ts`,
  `wixy_server/static/admin_shell.html`

## How to continue + acceptance
Slice 1 (design system + dark/light/system + mobile) done, verified via Playwright
screenshots against `e2e/fixture_server.py`'s real local server (light/dark/mobile
all correct, `color-scheme` native-control fix confirmed) — PR #57 merged.
Slice 3 (zoom + font-scale) done: required converting all ~70 `font-size`/`font:`
declarations in style.css from px to rem so font-scale genuinely affects the whole
admin UI, not just the new controls' own labels; real-browser verification caught a
genuine bug (keyboard-driven changes updated state but not the visible topbar label)
fixed via an `onChange` callback on both controllers — see decisions/00046 for full
reasoning, incl. an unrelated CI-only CRLF sourcemap drift + gh/git-via-Bash hangs
both root-caused and fixed there too — PR #58 merged.
Slice 4 (Settings view + keyboard shortcuts + session persistence) done: centralized
keyboard-shortcut matching into a new `shortcuts.ts` registry (rebindable/disableable,
replacing slice 3's per-module hardcoded matching), upgraded theme/zoom/fontScale
controllers from a single `onChange` to real multi-subscriber `subscribe()` (fixing a
second latent instance of slice 3's staleness bug, this time in theme.ts's
OS-preference listener), added `sessionState.ts` for last-active-route persistence,
and a new `settingsPanel.ts` (General + Keyboard Shortcuts tabs) reachable via a new
topbar gear icon. 27-check real-browser verification incl. the full rebind flow with
genuine keypresses — see decisions/00047 for full reasoning.
Slice 5 (screenshot button + app icon) done: chose getDisplayMedia (true pixel
capture, correctly includes the live-preview iframe) over a foreignObject/DOM-
serialization approach (would render the iframe blank) after empirically confirming
it's fully automatable headlessly (`--use-fake-ui-for-media-stream`) rather than
assuming a permission prompt would block real-browser verification; generated a
"W"-monogram favicon/icon set with PIL (no icon existed before) since none was
supplied. Verification's decisive check: the captured PNG has 6244 distinct colors
on an edit view with its iframe visible, proving genuine pixel capture rather than a
blank frame. Also rediscovered that `admin_shell.html` is cached in memory at
server startup (unlike the JS/CSS static assets), so the long-running fixture
server from slices 3-4 needed a restart to pick up the new favicon links — see
decisions/00048 for full reasoning.
Slices 6-7 remain - continue in the same branch-per-slice, PR, wait-green, merge
discipline as the rest of this project.

## Links
PR (slice 1): #57 (merged)
PR (slice 3): #58 (merged)
PR (slice 4): #59 (merged)
PR (slice 5): (fill in when opened)
