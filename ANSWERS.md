# Answers

One `## Q-NNN` section per question the operator actually asked, newest first, never
deleted. Answer FIRST, in plain English, before any detail. Status: 🟢 ANSWERED /
🟡 PARTIAL / 🔴 OPEN / ⚫ OBSOLETE.

## Q-002 — "…it scrolls to the end of the chat with you. That might be happening, I'm not sure but check that it does and it doesn't overflow."

> *"So we need a revamp of the chat experience in Wixy so that it's a full-screen
> experience just where the chat input area at the bottom is stickied and that it
> scrolls to the end of the chat with you. That might be happening, I'm not sure but
> check that it does and it doesn't overflow."* (2026-08-02, with a phone screenshot of
> the admin Chat tab)

**Answer: it WAS scrolling to the end — but in the worst way: it snapped you to the
bottom on every background refresh (about once a second), even while you were scrolled
up reading older messages. And the input box genuinely overflowed: it was a fixed
two-line box, so longer messages scrolled inside a tiny window. Both are fixed now.**

What was happening, in plain English:

- The chat page had TWO nested scrollbars — the page itself and the message list inside
  it — which is why you had to "double-scroll" to reach the input box, and why the box
  ended up hidden under the phone's bottom bar. The page no longer scrolls at all:
  only the message list scrolls, and the input box is pinned to the bottom of the
  screen, always visible, always above the phone's bar.
- The old code jumped you to the newest message every time it checked for updates.
  Now it follows you to the end only when you're already at the end; if you've
  scrolled up to read, a little "↓ New messages" button appears instead, and tapping
  it takes you back to the latest.
- The input box now grows as you type (up to a sensible cap, then scrolls inside
  itself) — no more overflowing text.
- You can attach a photo when STARTING a chat, not just inside one, and attached
  photos show as tappable thumbnails in the conversation (tap to see full size)
  instead of the ugly raw file path text from your screenshot.

Measured/verified 2026-08-02: the whole chat flow was exercised in a real browser
(1,036 Python tests, 605 UI unit tests, 41 end-to-end browser tests — including new
permanent tests for the pinned input box, the single scroll region, the jump-to-latest
button, photo attach-on-start, thumbnails, and the full-size viewer), then verified
live on ca.cinnamons.uk after deploy.

- STATUS: 🟢 ANSWERED (shipped in PR #__TBD__, decisions/00108)

## Q-001 — "I tap the burger menu, nothing appears. If that burger menu genuinely doesn't have anything in it…"

> *"The bit that says Wixy Cottage Aesthetics, and then it has the burger menu. I tap
> the burger menu, nothing appears. It's taking up a lot of space. If that burger menu
> genuinely doesn't have anything in it, let's just get rid of that whole banner
> permanently. We don't need it. And if it does have something in it, move the burger
> menu to the tabs area to the right."* (2026-08-02, phone screenshot of /admin)

**Answer: the menu DID have things in it — six controls (Site link, Zoom, Font size,
Screenshot, Theme, Settings) — it just could never show them on a phone. So, following
your own rule: the banner is gone, and the ⋯ menu now lives at the right end of the
tabs row, where tapping it actually opens the menu.**

Why nothing appeared: the banner bar had an invisible-clipping rule on it (there for an
unrelated slide animation on desktop), and the menu opened *below* the bar — straight
into the clipped area. It was opening every time you tapped; you just couldn't see it.

What changed, on phones only (desktop is untouched):

- The "Wixy · Cottage Aesthetics" banner row is removed — you get that vertical space
  back.
- The tabs row (Pages, Edit, Before & After, Theme, Media, …) now carries the ⋯ button
  pinned at its right end. It stays put even when you swipe the tabs sideways.
- Tapping ⋯ opens the menu under the tabs row: Site link, Zoom, Font size, Take a
  screenshot, Theme, Settings — all reachable, all visible.

Measured/verified 2026-08-02: reproduced the dead menu in a real 390px-wide browser
(the menu rendered but was clipped to nothing), then after the fix confirmed the menu
opens fully on-screen with all six controls; the phone test suite (41 end-to-end tests,
584 unit tests) passes, with a new permanent test that fails if the menu ever stops
opening on a phone again.

- STATUS: 🟢 ANSWERED (shipped in PR #139, decisions/00107)
