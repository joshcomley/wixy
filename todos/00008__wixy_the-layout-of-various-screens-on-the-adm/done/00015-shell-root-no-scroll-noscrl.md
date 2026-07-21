# 00015 — Admin shell root no-scroll + dvh chrome sizing

**Reported:** 2026-07-21 (operator, SECOND report on edit-chrome stickiness, one day after
00084 shipped): "absolutely nothing has changed in terms of the stickiness of those two areas.
They keep scrolling off the screen, so they're invisible, or partially invisible. The ONLY
content that should scroll is the website rendered in the middle."

**Root cause:** `.wx-shell { height: 100vh }` — `vh` = the LARGE mobile viewport (URL bar
hidden). With the bar shown the shell was taller than the visible area and the whole root
document scrolled: status bar off the top, iframe (carrying 00084's correctly-pinned composer)
cut at the bottom. Cache ruled out (assets are `no-store` + fingerprinted, Inv 22).

**Fix (decisions/00085):**
- `html, body { overflow: hidden; overflow: clip; overscroll-behavior: none; }` in
  `admin-ui/src/style.css` + mirrored pre-paint in `admin_shell.html` — no gesture, chaining,
  pull-to-refresh, or (with `clip`) even programmatic `scrollTop` moves the chrome.
- `.wx-shell` and `.wx-drawer` size to `100dvh` (vh fallback); loading-screen mins `100dvh`.
- `.wx-toast-region` bottom offset `calc(20px + 100vh - 100dvh)` rides above the URL-bar strip.
- e2e "shell root no-scroll" describe in `mobile-edit-chrome.spec.ts`: forced-overflow shell,
  real wheel gesture + programmatic attacks, served-bundle dvh assertions, middle-still-scrolls.
- RED proven both ways on unfixed code (wheel gesture scrolled root; programmatic scroll moved
  chrome 120px); GREEN 12/12 spec; ad-hoc 22/22 checks at 390+320 dark; screenshots eyeballed.

**Gates:** admin-ui vitest 463, editor vitest 191, tsc strict ×2, mypy strict, ruff, pytest
855 (1 documented flake, passed rerun), e2e 26/26 — all green. CI green on the PR.

**PR:** #116 (merged 2026-07-21; live on prod `2254f6a`, slot green — bundle + shell markers
verified in the deployed slot) · **Decision:** decisions/00085 · **Invariant:** Inv 24
