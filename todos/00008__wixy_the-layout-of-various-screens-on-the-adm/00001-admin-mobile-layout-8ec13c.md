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
- **Media** — implemented (this branch): pure CSS in the ≤720px block (no markup hooks
  needed — every target already had a class). Picker dialog → explicit full-width sheet
  with `box-sizing: border-box` (root cause of a 320px clip: no global border-box reset,
  so the base rule's `max-width: 92vw` applied to the content box and padding pushed the
  dialog 32px past the edge); alt-step Back/Use-this-image → full-width 44px row (were
  21px); Upload joins the shared 44px rule; `.wx-media-meta` wraps. Verified with a
  baseline→fixed ad-hoc Playwright pass at 390/320px (zero overflow, 44px targets).
- **Remaining (operator picks order):** Chat, Settings/Theme,
  and the pre-existing mobile topbar/nav wrap at ≤720px (seen at 320px —
  untouched so far).

## Working agreements

- Operator directs screen order (answered via question #21: "History next").
- gh via PowerShell tool only (Bash swallows gh stdout).
- After merge: confirm deploy by polling `https://ca.cinnamons.uk/api/version`
  until `sha_full` == merge commit (Slots poll 30s + warmup gate ≈ 30-60s).
