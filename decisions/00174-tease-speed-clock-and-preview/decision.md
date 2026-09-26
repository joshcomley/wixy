## Symptom

The operator asked (2026-09-26) for two things on the view-once Tease: a way to see the effect
while composing (so it is not a surprise), and a speed control, which had never existed for either
side (the cut-out always took exactly 16 s per loop). He chose "a speed slider, viewer-side,
alongside the existing size slider" over a sender-chosen or stored speed.

## What was decided

1. **Speed is viewer-side only.** A second slider (0.5x to 3x, step 0.25, default 1x) under the
   size slider. Nothing is sent, stored or migrated; there is no schema or wire change, so no
   Architect ruling was needed (the same category as the size slider it sits beside).
2. **Speed is an accumulated animation clock, not a divisor.** The path used to be
   `theta = 2*pi*(elapsedMs % 16000)/16000` with `elapsedMs = now - paintedAt`. Multiplying
   `elapsedMs` by the speed would teleport the cut-out the instant the slider moves (measured in
   the tests: about 594 px on a 1024x768 canvas for 1x to 3x after 2 s). Instead the viewer keeps
   `teasePhaseMs`, advanced every frame by `frameGap * speed` (`advanceTeasePhase`), and feeds THAT
   to `computeTeaseCoords` as `elapsedMs`. Changing the speed only changes the rate from then on,
   so it is seamless, and at 1x the clock equals wall time since first paint, identical to the old
   behaviour. Drag-resume timings (1.5 s hold, 600 ms ease) stay real time on purpose.
3. **The preview is the real renderer.** The maths and painting moved out of `viewOnceViewer.ts`
   into `teasePaint.ts` (`computeTeaseCoords`, `advanceTeasePhase`, `teaseGeometry`, `paintPhoto`,
   `paintTeaseMask`); the viewer re-exports the old names so importers and tests are unchanged.
   `teasePreview.ts` mounts a canvas in the sender's View-once sheet when Tease is ticked and draws
   with those same functions at the default size and speed. It reuses the staged file's existing
   preview URL, and stops on untick, sheet close, or when its element is removed from the page (a
   lock tears the chat down; a detached canvas would otherwise animate forever).
4. **Reduced motion:** no automatic movement, so the speed slider is not shown at all rather than
   shown doing nothing; the preview paints once, centred.
5. **Layout:** the two sliders are labelled rows ("Size", "Speed") stacked in a 340 px-max column so
   both fit a 360 px phone (side by side they need ~450 px). The new speed slider deliberately does
   NOT carry the `wx-srv-view-once-slider` class: the size slider's e2e locator is strict-mode
   and must keep matching exactly one element. The sender's sheet gained `max-height: 100%;
   overflow-y: auto` so the added preview cannot push the header and close button off a short phone.

## Why

Wall time x speed is the obvious implementation and it is wrong in a way no static test notices:
it only misbehaves at the moment the slider moves. The clock design makes the invariant structural
(the accumulated time is never rewritten). The tests assert exact expected positions before, at
and after a speed change, and were shown to FAIL against the naive version.

## What to watch for

- Anything that reads `elapsedMs` for the auto path must be given the animation clock, never raw
  wall time, or the speed control will jump again.
- New CSS for anything toggled through `hidden` needs an explicit `[hidden] { display: none }` rule
  and an entry in `HIDDEN_TOGGLED_CLASSES` (`admin-ui/tests/serverChatCss.test.ts`); the preview
  root is registered.
- Windows editing tools can leave CRLF in working files, which makes the committed bundle's source
  maps differ from CI's Linux build (seen on the rename, PR #284); convert to LF before building.
