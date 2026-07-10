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
all correct, `color-scheme` native-control fix confirmed). Slices 3-7 remain -
continue in the same branch-per-slice, PR, wait-green, merge discipline as the rest
of this project.

## Links
PR (slice 1): (fill in when opened)
