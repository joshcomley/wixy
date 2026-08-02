# Answers

One `## Q-NNN` section per question the operator actually asked, newest first, never
deleted. Answer FIRST, in plain English, before any detail. Status: 🟢 ANSWERED /
🟡 PARTIAL / 🔴 OPEN / ⚫ OBSOLETE.

## Q-002 — "When Purdy is using Wixie, it doesn't tell her if the version she's looking at is out of date…"

> *"When Purdy is using Wixie, it doesn't tell her if the version she's looking at is
> out of date. So we need a very simple version of OPVir that just pops up in the same
> little strip at the top… a very small, subtle V XXX in the top left… when there is a
> newer version for her to load it should become the nice glowing green thing that we
> get on all the other projects. But when she taps it, it doesn't bring up the git
> history, it just brings up a confirmation to say would she like to reload the page to
> load the latest version."* (2026-08-02)

**Answer: done. There's now a tiny version number at the far left of the top strip,
next to "unpublished changes". Normally it just sits quietly (e.g. "v159"). When Wixy
itself has been updated since she opened the page, it turns into the glowing green
"v158 → v159" she knows from the other projects. Tapping it pops up a themed "A new
version of Wixy is ready — would you like to load the latest version now?" with "Load
latest version" / "Not now" — no git history anywhere. Nothing ever reloads her page
on its own any more, and if her latest edit hasn't finished saving when she confirms,
the popup says so and stays put instead of losing it.**

How it works in plain English: every minute (and whenever she switches back to the
tab) the page quietly asks the server "which version are you now?" If the answer
matches what she already has, nothing happens. If it's newer, only the little badge
changes — the page she's working on is never touched until she taps and confirms. Her
work is safe either way: edits save to the server as she makes them, and half-typed
text survives a reload too.

The old behaviour it replaces: before, the page would either suddenly reload itself
(if she wasn't mid-edit) or show a four-second toast saying "Wixy was updated" that
vanished and never came back. Both are gone — the glowing badge stays until she taps it.

Measured/verified 2026-08-02: unit tests for the badge's every state (quiet, glow,
confirm, cancel, save-blocked), a full end-to-end test in a real browser that watches
a deploy land and walks the tap → confirm → reload flow, and the whole suite green
(594 UI unit tests, 1005 server tests, full browser suite). Shipped as decisions/00108.

- STATUS: 🟢 ANSWERED (decisions/00108)

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
