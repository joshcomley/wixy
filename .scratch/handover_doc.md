## Mission

Purdi (site owner, Cottage Aesthetics) said of a before/after pair she'd just added
(2026-08-02): *"So the one I just added, the lips are in different positions and I can't
see how I can move the image so they match up like the others? Do I just ask the chat?"*
The operator asked for an alignment facility in the Before & After editor she can use
herself: finger-drag + pinch/slider + micro-movement buttons for the final adjustments.

**MISSION IS COMPLETE — shipped, merged (PR #145), deployed to production, and
live-verified on her real photos.** This handover exists so any follow-up (Purdi
feedback, small UX tweaks, or questions) lands in a session with full context.

## Current state

- **Shipped in PR #145** (merged 2026-08-02T19:53:56Z, merge commit `e306b57`) to
  `joshcomley/wixy` main. Branch `cmd/workspace-00018` deleted on origin; the local
  worktree branch `cmd/workspace-00018` still exists with everything committed.
- **Deployed**: Slots fast-forwarded production; `https://ca.cinnamons.uk/api/version`
  reports `sha_full: e306b57…`, slot blue, site version 27, edition fleet.
- **Live-verified read-only on production** (Playwright + CF-Access helper, zero writes
  to her content): all 4 of her real pairs show **"Line up photos"**; the aligner opened
  on her actual lips pair, both photos painted on the canvas (1280×720 backing store),
  Save correctly disabled pre-adjustment, then **Cancelled**. Screenshot:
  `.scratch/live-aligner-verify.png` (preview `live-aligner-verify-preview.png`).
- **ANSWERS.md Q-005** answers her question in plain English (her words verbatim).
- **decisions/00111-before-after-aligner/** records the design.
- All suites green at ship time: 1,004 Python, 665 admin-ui unit (36 files), strict
  typecheck, ruff/format/mypy, CI green (python/frontend/e2e/guide-linkcheck/
  image-boot-proof), e2e `section-panel.spec.ts` 3/3 incl. the real align journey.

## Decisions made

- **Bake, don't store CSS offsets** (the core call): the aligner re-renders the adjusted
  photo on an offscreen canvas at the frame's exact aspect (1920×1080) and uploads it
  through the ordinary `api.uploadMedia` pipeline; the item's `{src, alt}` is swapped
  (alt preserved, original kept in the library). Rejected storing `{x,y,zoom}` in
  content JSON + `object-position`/transform rendering — that needed a schema change
  (`gallery-slider.schema.json` is `additionalProperties:false`), a builder binding, a
  site-template restructure (transform on the clip-pathed before-img moves the clip
  edge), site CSS/JS changes, and parity churn — a cross-repo change for the same
  visible result. Accepted trade-offs: mild JPEG generational loss on repeated re-bakes
  (q92→q85), a baked crop can't be zoomed back out past what was kept (original remains
  in the library as the recovery path).
- **Frame aspect is registry config, not a site literal** (Inv 1):
  `projects/ca.json`'s `gallery.sliders` collection declares `"alignAspect": "640:360"`
  (the live frame's CSS `aspect-ratio:640/360`). Parsed leniently in
  `builder/config.py:_parse_align_aspect` → `AdminCollection.align_aspect`, mirrored by
  `/api/admin/state` as `alignAspect: {w,h}|null`. Aligner offered only when
  `alignAspect != null` AND ≥2 `image` fields AND both photos picked.
- **The one invariant**: the drawn image always covers the whole canvas (a gap would
  bake as a border). Identity transform = the site's own `object-fit:cover` render.
  Every gesture is coverage-clamped by bisection (`alignerModel.clampedToCoverage`).
- **Two auto-compensations** so no button feels dead at zoom 1:
  `withPanCompensated` (an edge-breaking nudge is paid with a tiny auto-zoom — else ←/→
  do literally nothing on a width-limited photo) and `withRotationCompensated` (same for
  tilt; refused only when even MAX_ZOOM can't hold it).
- **Entry points**: pair-card button + the add-flow form step (the moment she hit the
  wall). Deliberately NOT the inline overlay editor (would need a new `alignRequest`
  protocol message) and NOT tiles (single-image free-crop is a different feature).
- **`WIXY_E2E_PORT` env override** (default 8799) for the e2e fixture port — two agent
  sessions on one box collided mid-suite on the fixed port (found live verifying this).
  `WIXY_E2E_PYTHON` already required on Windows (`python3` = Microsoft Store stub).

## Files changed (all in the wixy engine repo; branch cmd/workspace-00018)

- NEW `admin-ui/src/alignerModel.ts` — pure geometry: cover-fit placement,
  `coversCanvas`, `clampedToCoverage`, `minCoveringZoom`, `withPanCompensated`,
  `withRotationCompensated`, `exportSize`, micro-step constants.
- NEW `admin-ui/src/alignerDialog.ts` — the full-screen dialog (drag/pinch/zoom
  slider/tilt/micro pad with long-press repeat, Blend/Split views, Move toggle,
  keyboard arrows, busy + plain-English error paths, jsdom-safe null-ctx guard,
  injectable `loadImage`, ResizeObserver disconnected in teardown).
- NEW `admin-ui/tests/alignerModel.test.ts` + `alignerDialog.test.ts` (38 tests).
- `admin-ui/src/sectionPanel.ts` — `SectionPanelDeps.openAligner` test seam,
  `alignImageFields`/`openAlignerForSides`/`openAlignerForItem`/`renderAlignButton`,
  card button + add-flow form-step button.
- `admin-ui/src/api.ts` — `AdminCollection.alignAspect: {w,h}|null` (required key).
- `admin-ui/src/style.css` — `.wx-align-*` block incl. `.wx-align-dialog [hidden]
  {display:none !important}` (author display:flex beat the UA `[hidden]` rule — real
  e2e catch) + `.wx-section-align-button`.
- `admin-ui/tests/sectionPanel.test.ts` — fixtures gain `alignAspect`; 7 aligner
  wiring tests (button presence rules, request shape, commit path, add-flow path).
- `builder/config.py` — `AdminCollection.align_aspect` + `_parse_align_aspect`.
- `builder/tests/test_config.py` — `TestAlignAspectParsing`.
- `wixy_server/routes_admin_api.py` — `_admin_sections_snapshot` emits `alignAspect`.
- `wixy_server/tests/test_routes_admin_api.py` — snapshot test round-trips it.
- `projects/ca.json` — `"alignAspect": "640:360"` on `gallery.sliders`.
- `e2e/fixture_server.py` + `e2e/playwright.config.ts` — `WIXY_E2E_PORT`.
- `e2e/tests/section-panel.spec.ts` — third journey: drag on canvas → nudge → save →
  publish → live html serves `*-aligned.jpg` (position-robust: suite shares one
  fixture server; never assert absolute card counts).
- `wixy_server/static/admin/admin.{js,css}(.map)` — rebuilt committed bundles (Inv 2).
- `docs/ai/contracts.md` (adminSections shape), `docs/ai/editor-and-admin-ui.md`
  (aligner paragraph), `decisions/00111-before-after-aligner/`, `ANSWERS.md` (Q-005),
  `todos/TODO-00018.md` + sidecar (DONE).

## Open items

None blocking. Possible future enhancements (only if asked): inline-overlay entry point
(`alignRequest` protocol message); free-crop for tiles; rotate-by-pinch-twist;
per-breakpoint aspect if a site's frame ever stops being one fixed ratio (keep
`alignAspect` in sync with the site template CSS).

## Task list

All complete: #1 aligner model + tests; #2 aligner dialog (touch drag + pinch + micro);
#3 section panel + registry wiring; #4 aligner CSS; #5 e2e + docs + decisions + ANSWERS;
#6 full verification + ship (lint/typecheck/unit/e2e/build/PR/merge/deploy/live-verify).

## Blockers

None. (During the session: GitHub Actions `pull_request` events stopped delivering for
this branch for ~15 min — close+reopen of the PR cleared the backlog; main moved 3×
under the branch in a busy merge night (PRs #140/#142/#143/#144), causing repeated
ANSWERS.md Q-number + decisions-number + bundle conflicts — resolved by renumbering
mine to **decisions/00111** and **ANSWERS Q-005**, rebuilding the bundle from merged
sources each time, and re-running gates.)

## Environment

- Repo: `joshcomley/wixy` worktree at
  `D:\Servers\Cmd\Storage\clones\wixy__worktrees\00018__wixy_purdi-just-said-of-the-before-and-after`
  (branch `cmd/workspace-00018`, fully committed). Production: `ca.cinnamons.uk`,
  engine deployed by Slots from main (`D:\Servers\Wixy\`).
- Python interpreter for ALL python: `%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe`
  (never bare `python`/`python3` — Microsoft Store stub). Bare `pytest` (the `-n 4` cap
  is in addopts; never `-n auto`, never `-p no:xdist`).
- admin-ui/e2e: `npm ci` once per package; `npm run typecheck` / `npx vitest run` /
  `npm run build` (bundle is committed; CI fails on drift — ALWAYS rebuild after
  touching `admin-ui/src`). e2e: `WIXY_E2E_PORT=88xx WIXY_E2E_PYTHON=<pythoncore>
  npx playwright test section-panel.spec.ts` (pick a non-8799 port on this shared box).
- gh CLI: use the PowerShell tool with full path `"C:\Program Files\GitHub CLI\gh.exe"`
  (Bash pty swallows its stdout). Live-site driving: `%USERPROFILE%\.claude\scripts\
  playwright_cf_access.cmd --url … --actions file.json` (CF-Access service token from
  `D:\Biosphere\Storage\cf_access_token.json`, keys `client_id`/`client_secret`).
- The site repo (content/templates) lives at `D:\Servers\Wixy\Storage\projects\ca\repo`
  (deployment checkout — never edit there); gallery frame CSS is
  `pages/gallery.html` `.bas-frame{aspect-ratio:640/360}`.

## How to continue

Nothing is in flight. If the operator/Purdi reports a problem or asks for a tweak:
FIRST `git fetch origin && git merge origin/main --no-edit` into a fresh branch (main
moves fast — 5 merges landed during this one session), read `decisions/00111-
before-after-aligner/decision.md` + `ANSWERS.md` Q-005, then work in
`admin-ui/src/alignerModel.ts` (geometry) / `alignerDialog.ts` (UI) with the same
test-then-build-then-verify loop used here (unit → `npm run build` → e2e on a
`WIXY_E2E_PORT` → CI → merge). Never touch her live content during verification —
open, inspect, Cancel.

## Anything else the next agent must know

- The e2e fixture serves the COMMITTED static bundle — a stale bundle was the one real
  red herring ("Line up photos" button missing) during verification. Rebuild before any
  e2e run that touches admin-ui source.
- `test_staticcache.py::test_shell_bundles_are_fingerprinted` can false-fail if an
  `npm run build` races a running pytest — re-run it settled before believing it.
- The aligner's Save can complete within one Playwright tick on localhost — assert the
  dialog CLOSES, never post-click button text (a "Saving…" assertion raced and lost).
- Merge-night lesson: ANSWERS.md Q-numbers and decisions/NNNNN numbers are
  first-come-first-served across parallel sessions — always re-check `origin/main`'s
  numbers at merge time and renumber yours rather than collide.
- CI event-delivery gap: if `gh run list --branch <b>` stays empty for minutes after
  push/PR, close+reopen the PR (verified fix).
- Purdi's actual misaligned pair was deliberately NOT fixed by us — the feature is the
  answer; she does it herself (or the operator walks her through it).
