# 00085 — Admin shell root can never scroll: overflow clip at the root, dynamic-viewport (dvh) chrome sizing

## Symptom

Operator, 2026-07-21 — the SECOND report on the same screen, one day after 00084 shipped:
"absolutely nothing has changed in terms of the stickiness of those two areas. They keep
scrolling off the screen, so they're invisible, or partially invisible. The ONLY content that
should scroll is the website rendered in the middle." On their Android phone (~365-390 CSS
px), both the top strip (status bar) and the bottom editor (the composer, correctly pinned
inside the preview iframe) still scrolled away.

## Root cause

Two layers, and 00084 fixed only the inner one:

1. **`.wx-shell { height: 100vh }`** — `vh` is the LARGE viewport on mobile browsers (URL bar
   hidden). With the URL bar shown, the shell was taller than the actually-visible area, and
   the root document gained exactly that scroll range. Every touch-scroll of the preview that
   chained out (and every URL-bar hide/show) scrolled the WHOLE shell: the status bar slid off
   the top, and the iframe — carrying 00084's correctly-pinned composer — was cut at the
   bottom. The visual-viewport pin was working; it pins the composer *inside the iframe*, and
   when the outer shell scrolls, the iframe moves with it.
2. **The no-scroll contract was implicit.** Nothing made the root document unscrollable — the
   chrome stayed put only because content happened to fit (desktop, Playwright's static
   viewport). Any overflow — a URL bar, a rounding pixel, a future chrome row — silently
   became a scrollable page. Desktop Chromium cannot emulate the Android dynamic toolbar, so
   00084's verification (static viewport, resize-driven vv events) never saw it.

Cache was ruled out first ("absolutely nothing has changed" smells like a stale bundle): every
admin asset is `no-store` AND content-fingerprinted (Inv 22) — the phone was running the new
code, and the new code genuinely didn't constrain the shell.

RED proof (desktop Chromium, deterministic): force the shell 120px taller than the viewport
(= the URL-bar condition) — a wheel gesture over the chrome scrolled the root document and
moved the pinned bars by exactly 120px (`e2e/tests/mobile-edit-chrome.spec.ts`, "shell root
no-scroll" describe).

## What was decided

The app-shell invariant — **only the middle content scrolls** — now holds by CONSTRUCTION, two
guarantees each covering the other's gap:

- **`html, body { overflow: hidden; overflow: clip; overscroll-behavior: none; }`** on the
  admin shell (`admin-ui/src/style.css`, mirrored in `admin_shell.html`'s pre-paint inline
  rule). `hidden` removes the scrolling mechanism (touch/wheel/keyboard pans, URL-bar pans,
  scroll chaining out of the preview iframe, pull-to-refresh mid-edit); `clip` (Chrome 90+,
  Firefox 81+, Safari 16+) goes further — the element isn't a scroll container at all, so even
  a programmatic `scrollTop` assignment can't shift the chrome. Engines without `clip` fall
  back to `hidden` and stay gesture-safe.
- **Chrome sizes to the DYNAMIC viewport**, so the shell never overflows in the first place:
  `.wx-shell { height: 100vh; height: 100dvh; }` (tracks the URL bar, and the keyboard via
  `interactive-widget=resizes-content`); the same pair on `.wx-drawer` (replacing
  `top:0; bottom:0`, which had anchored its bottom edge to the layout viewport UNDER the URL
  bar); `100dvh` mins on the pre-paint loading screen.
- **Toasts ride above the URL-bar strip:** `.wx-toast-region { bottom: 20px; bottom:
  calc(20px + 100vh - 100dvh); }` — `100vh - 100dvh` is exactly the hidden strip (0 on desktop
  and under the keyboard with resizes-content; the calc is dropped on engines without dvh and
  the plain `20px` stands).

The preview document inside the iframe is deliberately NOT touched — it must scroll (the
operator's "only the middle"), and its overscroll chaining now dies at the root.

## Why

The operator's bar is "rock solid, immovable". A contract that holds only while content
happens to fit is not a contract. With `clip` + `dvh`, the chrome cannot move under ANY input
(gesture, chaining, programmatic, URL bar, keyboard) in ANY current browser, and the fallback
chain (`clip`→`hidden`, `dvh`→`vh`) degrades gracefully instead of breaking.

## What to watch for

- `overflow: clip` on the root propagates per spec: the viewport gets `hidden`, the element
  itself stops being a scroll container. If a future panel "needs" the root to scroll — it
  mustn't; put the scroll in `.wx-main` — it will silently not scroll.
- Desktop is unchanged: `dvh == vh` without dynamic chrome and the toast offset computes to 0.
- iOS Safari <16 has no `clip` (gets `hidden` — gesture-safe); <15.4 has no `dvh` (gets `vh` —
  the pre-fix toast/drawer behavior, not a regression).
- Anything new fixed-BOTTOM must reuse the `calc(… + 100vh - 100dvh)` offset pattern, not a
  bare `bottom: Npx`.
- The e2e contract ("shell root no-scroll" describe) attacks with BOTH a real wheel gesture
  and programmatic `scrollTop` — keep both halves when extending it; `hidden` alone passes the
  gesture half and fails the programmatic half.
