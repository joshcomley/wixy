# Answers

One `## Q-NNN` section per question the operator actually asked, newest first, never
deleted. Answer FIRST, in plain English, before any detail. Status: 🟢 ANSWERED /
🟡 PARTIAL / 🔴 OPEN / ⚫ OBSOLETE.

## Q-004 — "…it scrolls to the end of the chat with you. That might be happening, I'm not sure but check that it does and it doesn't overflow."

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

- STATUS: 🟢 ANSWERED (shipped in PR #143, decisions/00110)
=======
## Q-003 — "When Purdy is using Wixie, it doesn't tell her if the version she's looking at is out of date…"

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
(594 UI unit tests, 1005 server tests, full browser suite). Shipped as decisions/00109.

- STATUS: 🟢 ANSWERED (decisions/00109)

## Q-002 — "Currently, when there are no unpublished changes, it still has a publish button…"

> *"Currently, when there are no unpublished changes, it still has a publish button.
> So that can just hide when there are no changes to publish, because that strip at
> the top says "no unpublished changes," so you don't need it.*
>
> *In fact, when there are no unpublished changes, let's just make it a very narrow
> strip that says "no unpublished changes." It doesn't need to have the same height
> as it does right now."* (2026-08-02)

**Answer: done, and confirmed working on the live website. When there is nothing to
publish, the bar at the top of the admin is now a thin one-line strip that just says
"No unpublished changes" — no Publish button. The moment you change something, the
bar grows back to its full height and the Publish button reappears.**

More detail:

- The thin strip is 29 pixels tall, down from 53 — about half the height.
- The button is hidden, not greyed out — a permanently greyed button would look
  broken.
- If a publish is actually running, the button stays on screen no matter what,
  because that is where the progress is shown.
- One hidden bug was found and fixed along the way: the "how many changes" counter
  used to miss certain kinds of change (swapping or deleting a picture, adding or
  removing a page). With the button hidden, that miscounting would have made those
  changes impossible to publish, so the counter now counts every kind of change.

Measured/verified 2026-08-02 (evening), on the live site (ca.cinnamons.uk/admin) in
a real browser after the release went out: with nothing pending, the bar measured
29 pixels with no Publish button; I made one throwaway edit and the bar grew to 53
pixels with the Publish button back; I discarded that edit and it returned to the
thin strip. The live site was left exactly as found — nothing published, nothing
left over. Checked at normal computer-screen width; phones keep the thin strip too,
covered by the test suite. All tests pass: 1002 Python, 589 admin unit, 41
end-to-end.

- STATUS: 🟢 ANSWERED (shipped in PR #140, decisions/00108; verified live 2026-08-02)

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
