# Answers

One `## Q-NNN` section per question the operator actually asked, newest first, never
deleted. Answer FIRST, in plain English, before any detail. Status: 🟢 ANSWERED /
🟡 PARTIAL / 🔴 OPEN / ⚫ OBSOLETE.

## Q-002 — "So the one I just added, the lips are in different positions and I can't see how I can move the image so they match up like the others? Do I just ask the chat?"

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

- STATUS: 🟢 ANSWERED (shipped in this change, decisions/00108)

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
