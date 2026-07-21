# 00014 — Mobile edit chrome: immovability, device auto-detect, icon, reveal menu

Operator reports (2026-07-21, phone, dark mode), all in one round:

1. Composer (bottom edit area) can scroll off and can't be recovered → top/bottom
   chrome must be rock solid, immovable.
2. Edit view always defaults to Desktop → should auto-detect the user's form factor.
3. The composer's full-screen (maximize) icon is teeny tiny.
4. The ▾ 10s reveal shows an empty gap above while the menu appears below (wrong place).

## Root causes

1. Composer/sheets anchor `bottom:0` to the LAYOUT viewport — mobile keyboard and
   pinch-zoom detach that from the visible region. Outer-shell pinch also pans the
   slim bar + iframe away.
2. `innerWidth < 480 → mobile` misclassifies ≥480px-CSS-width phones (measured live:
   487px → Desktop). No tablet branch at all.
3. ⤢/⤡ text glyphs render tiny in Android's system font.
4. Reveal: `.wx-shell-editing .wx-topbar`'s `visibility: hidden` was never reset on
   reveal (empty gap), and the nav lives inside `.wx-body` BELOW the pinned slim bar.

## Fix (decisions/00084)

- `editor/src/visualPin.ts`: pinToVisualViewport (vv resize+scroll → bottom/left/width)
  for composer (internal, released on destroy) + control sheets (at overlay call sites,
  released on close); `ensureResizesContentMeta` at overlay startup (preview doc only).
- `admin_shell.html` meta: `maximum-scale=1, user-scalable=no, interactive-widget=resizes-content`.
- `initialDeviceFor(width, coarse)` in editView.ts: mobile <600 / coarse <768 /
  coarse ≤1366 tablet / fine <1024 tablet / else desktop.
- Maximize/restore: inline SVGs (Feather ±2), 18px CSS.
- Reveal: `visibility: visible` on the revealed topbar (later rule wins tie) + navEl
  relocated between topbar and editBarHost on ≤720px (matchMedia, live re-place).
- mini-site fixture gained the standard viewport meta.

## Verify

RED→GREEN: editor vitest 191, admin-ui vitest 463, both tsc clean; ad-hoc Playwright
14/14 checks at 390/487/820/1280 + 390/320 dark (device default, reveal stack,
composer pin after scroll + pinch attempt, interactive-widget meta, SVG icon size).
E2E spec added: e2e/tests/mobile-edit-chrome.spec.ts. Gates: full pytest + e2e.

## Gotchas hit this round (environment, not code)

- Fixture server MUST be launched via run_in_background, never `&`: the orphan's git
  child processes die instantly → every /api/admin/* 503s with EMPTY stderr
  ("git rev-parse HEAD failed: ").
- The machine's `pip install -e` for wixy points at worktree 00005 — python launched
  without the repo cwd/sys.path gets STALE code + bundles. Always run from the repo root.
- Peer collision: decisions/00083 was taken by workspace-00010's status bar mid-round;
  this work renumbered to 00084.
