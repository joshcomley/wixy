# 00001 — Make the admin site usable on mobile, screen by screen (8ec13c)

**Mission:** the operator's standing complaint — "The layout of various screens on the
admin site are not very mobile friendly." Rework each admin screen for narrow
viewports (≤720px), one screen per PR, in the order the operator picks.

## Established pattern (apply to every table screen)

Per-cell classes + `data-label` attributes in the panel's TS (inert on desktop —
no markup duplication), then a CSS-only restack inside the existing
`@media (max-width: 720px)` block in `admin-ui/src/style.css`: row → compact
block (identity line / secondary line / one wrapping meta line of
"Label: value · …" pairs / full-width 44px action buttons). Inline confirm forms
stack prompt+input full-width (`flex: 1 1 100%`) with buttons sharing a row
(`flex: 1 1 auto`). Dates use `toLocaleString(undefined, {dateStyle:"medium",
timeStyle:"short"})` so they fit the meta line. Desktop rendering must stay
unchanged; verify zero horizontal overflow (`scrollWidth === innerWidth`) at
390px AND 320px with real-browser screenshots (ad-hoc Playwright script in
gitignored `e2e/test-results/`), then rebuild the committed bundles
(`npm run build` in `admin-ui/`) and commit them alongside.

## Screen status

- **Pages** — SHIPPED (PR #81, merged 2026-07-20, confirmed live).
- **Static-asset cache fingerprinting** — SHIPPED (PR #82, decisions/00069,
  Inv 22). Root cause of "nothing appears to have changed" after deploys:
  unfingerprinted bundle URLs + heuristic browser caching. Bundles now carry
  `?v=<sha256[:10]>` with immutable year-long cache; `/admin` is `no-cache`.
- **History** — SHIPPED (PR #83, merged 2026-07-20): same restack + restore-confirm form
  stacking; 2 new vitest hooks tests; visual-verified at 1280/390/320px; e2e 9/9, pytest 791.
- **Media** — SHIPPED (PR #84, merged 2026-07-20): pure CSS in the ≤720px block (no markup hooks
  needed — every target already had a class). Picker dialog → explicit full-width sheet
  with `box-sizing: border-box` (root cause of a 320px clip: no global border-box reset,
  so the base rule's `max-width: 92vw` applied to the content box and padding pushed the
  dialog 32px past the edge); alt-step Back/Use-this-image → full-width 44px row (were
  21px); Upload joins the shared 44px rule; `.wx-media-meta` wraps.
- **Chat** — SHIPPED (PR #85, merged 2026-07-20): list restacks (dot pinned to the first
  line via absolute positioning; title link 44px via `padding: 13px 0` — min-height would
  re-center wrapped titles away from the dot); conversation header one line (ellipsis
  title); all chat buttons joined the shared 44px rule; the horizontal-scroll table
  fallback was DELETED (chat was its last member).
- **Transcript os.replace hardening** — SHIPPED (PR #86): bounded retry (5 attempts,
  linear 50ms backoff) on PermissionError around write_transcript's os.replace — root
  cause of two pytest flakes on hub (Windows Defender/indexer briefly locking the fresh
  tmp file, WinError 5, tearing down the TestClient lifespan). Windows-only; CI Linux
  unaffected, but the flake was real on this box.
- **Settings/Theme** — SHIPPED (PR #87, merged 2026-07-20): theme color row re-grids at ≤720px
  (presets were squeezed out of the 1fr cell — now a full-width second line, with pinned
  grid-row/grid-column so DOM order can't drop Reset onto a third line); color well,
  hex, font picker/family, shadow input 44px; swatches 18→44px; theme Reset/Reset-all +
  settings Reset-all joined the shared 44px rule. Steppers + the device switcher stay
  compact (documented prior decision: topbar-chrome tier).
- **Remaining:** the pre-existing mobile topbar/nav wrap at ≤720px (seen at 320px —
  untouched so far). Raised with the operator as the final candidate (question #23).
- **Topbar compact (operator decision #23: "Compact the top bar")** — SHIPPED (PR #88,
  merged 2026-07-20): the five secondary control groups (zoom, font scale, screenshot,
  theme, settings) wrapped in `.wx-topbar-secondary` (`display: contents` on desktop —
  the bar renders byte-identical; hidden popover at ≤720px) behind a ⋯ trigger. Popover
  labels come from aria-labels via CSS `content: attr(aria-label)` (group captions
  ::before, icon+label rows ::after); all buttons 44px border-box. Deterministic two-row
  bar at ≤720 via flex `order` + an `::after` invisible break (row 1: title+⋯, row 2:
  chip/Publish/Site) — adaptive wrapping stranded a lone button. Trigger toggles with
  aria-expanded; outside-click listener attached only while open; Escape closes.
  shell.test.ts +2 (27/27).

**MISSION COMPLETE (2026-07-20):** all admin screens + the top bar are mobile-friendly
and verified live (PRs #81–#88).

**Round 2 (operator feedback same evening: "header is still huge, Media looks
identical"):** topbar → ONE row at ≤720 (Site link moved into the ⋯ popover as its first
labeled row; chip/Publish paddings compacted; title `flex: 1 1 60px` — flex-wrap decides
breaks on HYPOTHETICAL main sizes, so a small basis is what actually keeps the row to
one line; empty spacer hidden); helper hints (`.wx-pages-hint`, shared by Pages+Media)
hidden at ≤720, panel h2s tightened; media cards compacted (~175px → ~127px tall:
denser grid `minmax(100px)` gap 8, padding 6, meta 0.625rem) and the per-card full-width
Delete button became a 44px 🗑 overlay chip on the thumbnail corner (CSS-only icon swap,
DOM text unchanged), with permanently-disabled deletes HIDDEN at ≤720 (presence of the
chip = deletable). PR #90.

## Working agreements

- Operator directs screen order (answered via question #21: "History next").
- gh via PowerShell tool only (Bash swallows gh stdout).
- After merge: confirm deploy by polling `https://ca.cinnamons.uk/api/version`
  until `sha_full` == merge commit (Slots poll 30s + warmup gate ≈ 30-60s).
