# Answers

One `## Q-NNN` section per question the operator actually asked, newest first, never
deleted. Answer FIRST, in plain English, before any detail. Status: 🟢 ANSWERED /
🟡 PARTIAL / 🔴 OPEN / ⚫ OBSOLETE.

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
