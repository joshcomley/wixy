# Uxer adoption slice 1: admin-ui dark/light/system theme + mobile-responsive layout

Operator request (after viewing `/admin` live on a phone): "implement a dark theme
... implement UXER... gives us theming and mobile support." `Uxer/UXER-INTEGRATION.md`
(the framework's own integration guide, `joshcomley/Uxer`, cloned to
`D:\Servers\Cmd\Storage\clones\Uxer`) is unambiguous that adopting Uxer means far
more than a dark-mode toggle: nine mandatory subsystems (dual-theme, zoom, font
scaling, screenshot button, settings view + keyboard-shortcuts page, session
persistence, a theme toggle in the chrome, an app icon, and a full theme editor)
plus the MCP compliance-bridge integration itself. Scoped into 7 slices (see the
harness task list); this entry covers slice 1 only — the design-system foundation
and mobile reflow, i.e. exactly what the operator asked for in their own words,
which also happens to be items 1 (theming) and the "mobile" half of the mandatory
list's non-negotiable baseline.

## Why this was tractable in one slice

`admin-ui/src/style.css` already routed every color through ~8 CSS custom
properties (`--wx-brand-blue`, `--wx-ink`, `--wx-muted`, `--wx-surface`,
`--wx-canvas`, `--wx-border`, `--wx-danger`, `--wx-shadow`) — no component rule
anywhere used a literal color for its primary palette. Adding a dark variant was
therefore mostly a `:root[data-theme="dark"]` override block, not a per-component
rewrite.

## Palette: computed, not eyeballed

Uxer's own mandate (point 2 of "Mandatory: Dual-Theme Support"): light mode must
not use pure white — a tinted neutral derived from the app's warmth. Wixy admin's
brand accent is blue (`#2563eb`, hue ~217°, a cool hue) → per Uxer's own mapping
("cool apps get ice blue/slate, hue 210-230°"), the light surface became `#f3f5f9`
(was `#ffffff`) and canvas `#eaedf3` (was `#f7f8fa`, already close).

Every text/background pair was checked with a real WCAG contrast-ratio
calculation (relative luminance formula, not a guess) before being finalized:

| Pair | Ratio | Grade |
|---|---|---|
| light ink/surface | 14.25 | AAA |
| light muted/surface | 4.56 | AA |
| light danger/surface | 5.93 (after darkening `#dc2626`→`#b91c1c`) | AA |
| dark ink/surface | 13.59 | AAA |
| dark muted/surface | 5.88 | AA |
| dark danger/surface | 6.08 | AA |
| white-on-brand-fill (light `#2563eb`) | 5.17 | AA |
| white-on-brand-fill (dark `#3f6fcf`) | 4.79 | AA |
| dark brand-as-text (`#6fa0f5`) on surface | 6.43 | AA (near AAA) |

The last two rows are why `--wx-brand-blue` split into two variables:
`--wx-brand-blue` (fill color, paired with white text on buttons — needs to stay
dark enough for white-on-top to clear 4.5:1) and `--wx-brand-blue-text` (the same
hue used as plain text/links directly on the canvas — needs to be lighter in dark
mode to clear 4.5:1 itself, since `#3f6fcf` as *text* on `#1a1d26` only reaches
~3.5:1). Light mode uses the same value for both (`#2563eb` clears both roles).
Same reasoning produced `--wx-brand-blue-tint`/`--wx-danger-tint` (pale
selected/error chip backgrounds — two more `var()`-ified literals that were
hardcoded per-mode, `#eaf0fe`/`#eff6ff`/`#fef2f2`) and `--wx-solid-dark`/
`--wx-solid-dark-text` (an intentionally-always-dark chip surface for toasts,
badges, and code blocks — `--wx-ink` was doing double duty as both "the page's
primary text color" AND "an always-dark fill for a white-text badge," which
breaks the instant `--wx-ink` becomes light-colored in dark mode).

`color-scheme: light` / `dark` set on `:root` per variant so native form controls
(`<select>`, `<input type="color">`, scrollbars) also render in the matching
variant — free, one line, no per-control override needed.

## Mode persistence + no-FOUC bootstrap

`admin-ui/src/theme.ts`: `ThemeMode = "light" | "dark" | "system"`, persisted to
`localStorage["wx-theme-mode"]`, live `matchMedia("(prefers-color-scheme: dark)")`
tracking while `"system"` is selected. `admin_shell.html` gained a synchronous
inline `<script>` (reads the same key, applies `data-theme` before
`admin.css`/`admin.js` load) so there's no flash of the wrong theme on first
paint — the CSS's own `@media (prefers-color-scheme: dark)` fallback only matters
if that inline script somehow didn't run. Toggle button in the topbar (☀️/🌙/💻,
cycles light→dark→system) per Uxer's "small icon button in the title bar" pattern.

## Mobile reflow (720px breakpoint)

Nav collapses from a 168px vertical sidebar to a horizontal scrollable strip
under the topbar; topbar wraps instead of clipping; theme panel's side-by-side
controls+preview stacks vertically; tables get `overflow-x: auto` rather than
breaking the page layout; touch targets bumped to 44px (Uxer's own `targets`
convention) on nav items and row-action buttons; media grid's `auto-fill`
grid was already responsive, untouched.

## Verification

Real browser verification (Playwright, headless — local test harness, not a web
lookup, so the fleet's headed-browser rule doesn't apply) against `e2e/
fixture_server.py`'s real wixy_server instance: light mode, dark mode (both
desktop and 390×844 mobile viewport), and the theme/media panels' mobile reflow
all screenshotted and visually confirmed correct, including the `color-scheme`
fix actually changing native `<select>`/`<input type="color">` rendering.

Hit a real, reproducible-looking `503 {"detail": "git rev-parse HEAD failed: "}`
from `/api/admin/state` partway through this session's verification. Investigated
rather than dismissed: replicated the exact `subprocess.run` call standalone
against the same checkout — succeeded every time (returncode 0, real SHA, no
stderr) — ruling out a corrupted checkout or a bug in `checkout.py`. Root cause:
this session had accumulated multiple overlapping `fixture_server.py` processes
racing on port 8799 (several `Stop-Process` cleanup rounds were needed before a
single clean instance stayed up) — and `fixture_server.py`'s own header comment
already documents an identical prior symptom (`theme-change.spec.ts` timeouts)
being root-caused via `fleet_diag.py` profiling to this shared hub VM's transient
disk-I/O contention from unrelated processes (decisions/00025, 00027, 00030) —
not a fixture or product bug. A single clean server instance, verified
immediately after starting, produced zero errors across the full check. Not
re-litigated further; this is a known, already-profiled characteristic of this
shared box's local fixture-testing path, not something this slice's (CSS/TS-only,
zero server-code) diff could cause.

## Remaining Uxer slices (not this PR)

Zoom/font-scale controls; Settings view + keyboard-shortcuts page + full session
persistence; screenshot button + app icon/favicon; the theme editor (live color
editing, export/import, contrast warnings); the actual MCP compliance-bridge
integration (`uxer-style.json`, bundle build+mount, conditional bridge script,
server routes). Tracked as harness tasks #16-#20.
