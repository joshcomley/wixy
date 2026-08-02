# Answers

One `## Q-NNN` section per question the operator actually asked, newest first, never
deleted. Answer FIRST, in plain English, before any detail. Status: 🟢 ANSWERED /
🟡 PARTIAL / 🔴 OPEN / ⚫ OBSOLETE.

## Q-006 — "…we want to add in the update a brief, very user-friendly release change list of what's new in this version…"

> *"So now what we want to do is we want to add in the update a brief, very
> user-friendly release change list of what's new in this version. So it's not the
> full Git comment history, and that means that anything going forward, any changes
> to Wixie, needs a very user-friendly description of what it is. And if it's just
> bug fixes and things, then it just says that. General bug fixes, something like
> that. So that means updating the doctrine for Wixie so that any git commits also
> have with it in the description the user-friendly release info sentence. And that
> is what gets shown when there's a new version."* (2026-08-02)

**Answer: done. When the version number glows green and Purdy taps it, the popup now
shows a short "What's new in this version" list in plain English — one line per
change, written for her, never the git history. Every Wixy change from now on must
carry that plain-English sentence inside its commit message (a new binding rule for
everyone who works on Wixy, and the computer double-checks it on every change — a
missing sentence fails the build). If a change is nothing she can see, the sentence
is simply "General bug fixes and improvements."**

How it works in plain English: every time a change is made to Wixy, the person (or
computer) making it writes one ordinary sentence about it — like "The update popup
tells you what changed in plain English." Those sentences travel with the change.
When her page notices a new version has arrived, it asks for exactly the sentences
belonging to the versions she missed, and lists them as a few bullets in the popup,
above the "Load latest version" button. If somehow there are no sentences to show
(for example a change made before this rule existed), the popup falls back to
"General bug fixes and improvements." so it never shows her a blank or programmer
gibberish.

Measured/verified 2026-08-02: the sentence-collecting is covered by new server tests
(collecting, de-duplicating, ordering, every fallback), the popup list by new unit
tests and the full browser test (which also proves no git shas ever appear), and the
whole suite is green. Verified live on ca.cinnamons.uk: this very change carried the
sentence "The update popup tells you what changed in plain English." — the first
real entry she'll see.

- STATUS: 🟢 ANSWERED (shipped in PR #146, decisions/00112; verified live 2026-08-02)

## Q-005 — "So the one I just added, the lips are in different positions and I can't see how I can move the image so they match up like the others? Do I just ask the chat?"

> *"So the one I just added, the lips are in different positions and I can't see how I
> can move the image so they match up like the others? Do I just ask the chat? I'm sorry,
> I'm going to drive you mad asking stupid questions"* (Purdi, 2026-08-02, after adding a
> new before & after photo pair)

**Answer: you don't need to ask the chat — and it wasn't a stupid question. There was
genuinely no way to move the photos; the button just didn't exist. Now it does: on the
Before & After screen, every photo pair has a "Line up photos" button (it's also offered
at the end of adding a new pair). Tap it, then drag the photo with one finger until the
features sit on top of each other, pinch or use the Zoom slider to resize, use
Straighten for any tilt, and finish with the little arrow buttons for tiny nudges. Press
"Save aligned photo", then Publish as normal.**

What it looks like while you work: the photo you're moving floats see-through on top of
the other one (the "Blend" view), so you can see the lips line up exactly. The "Split"
view shows the familiar drag-to-compare wipe instead, so you can check the finished
result before saving. The "Move" buttons at the top choose which of the two photos
you're adjusting — usually the After one.

Two things that are safe to know:

- **Your original photos are never changed.** Saving makes a brand-new photo in your
  media library and swaps it into the pair. If you ever want to start completely over,
  just pick the original photo again and line it up fresh.
- **You can't crop anything off by accident.** The tool never lets an edge of blank
  background sneak in — if you move or tilt too far, it gently zooms the photo a touch
  to keep the frame full.

Measured/verified 2026-08-02: the whole journey was exercised for real in a real browser
(add a pair → Line up photos → drag + a micro nudge → Save → Publish → the live page
serving the new aligned photo), alongside 38 new unit tests for the moving/zooming maths
and the buttons. Nothing about how you add, reorder, or publish pairs changed.

- STATUS: 🟢 ANSWERED (shipped in PR #145, decisions/00111)

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
(599 UI unit tests, 1006 server tests, 42 browser tests). Then **verified live** on
ca.cinnamons.uk/admin after the release went out: the strip reads "v161 · No
unpublished changes" with the badge at the far left, and tapping it pops "Wixy is up
to date — You're using the latest version (v161)." The glow itself only appears when
an update lands while she's looking — covered by the browser test; she'll see it for
real the next time Wixy updates while her page is open.

- STATUS: 🟢 ANSWERED (shipped in PR #142, decisions/00109; verified live 2026-08-02)

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
