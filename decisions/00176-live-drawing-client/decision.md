## Symptom (the request)

The operator asked (2026-09-26) for a pen in the Server chat: a pen button; draw on the chat
where you draw it; it scrolls with the chat; it draws LIVE on the other person's screen; select
a drawing and delete it; pen colour and thickness; the other person can draw too. The Architect
ruled the design in `spec/server-chat/07-live-drawing.md` (merged PR #282). The server half
(schema, routes, relay, erasure) is decisions/00175. This entry records the client decisions
the spec left to the Builder, and the places the code deliberately departs from the spec's
wording. The operator manual is `docs/ai/livechat.md` §19.

## What was decided

1. **The Pen button is in the chat HEADER** (spec §5; decisions/00169: a third composer control
   pushed the text box under its 120 px floor on a 360 px phone). It is a 44×44 px button around a
   36 px visible face (`.wx-srv-pen-face`) with `margin: -4px`, so the header row keeps its 36 px
   layout. *Rejected:* an `::after` hit area. It inflated `scrollWidth` and failed the real-click
   "label fits" check. The button carries `data-srv-gesture-boundary` and `aria-pressed`.
2. **Layout:** a new `div.wx-srv-thread-content` (`position: relative`) wraps
   `.wx-srv-message-list`. The drawing layer is its sibling inside that wrapper, never inside the
   list, because `renderThreadList` removes children of the list that it does not know about. There is one
   `<svg>` per drawing with a draw-space `viewBox`. Its box is the anchor's top plus the bounds ×
   the scale. x is clipped to the thread's visible width (no sideways scrollbar), and y is never
   clipped (a drawing below the last bubble grows the scroll area). Positions are re-read from the
   live DOM on every `renderThreadList`, by a ResizeObserver on the column and the thread, and once
   per frame during a stroke. They are never copied.
3. **The Draw surface** is an absolutely positioned div over the thread, inside
   `.wx-srv-thread-wrap`: `z-index: 1`, below the jump pill's 2. It has `touch-action: none`,
   pointer capture and `data-srv-gesture-exempt`, so multi-tap is excluded in Draw mode, per spec
   §5. The wheel is forwarded to the thread, and ctrl+wheel (a pinch) is swallowed. The right
   inset leaves a desktop scrollbar uncovered.
4. **The gesture machine** (`drawGesture.ts`, pure): a second TOUCH finger at most 150 ms after
   the first, and before the first has moved 12 px, cancels the stroke and starts a two-finger
   pan (`scrollTop +=` the centroid's dy). Any other extra pointer is ignored until all lift.
5. **Anchoring and sessions:** the first stroke anchors to the nearest confirmed bubble top at or
   above its start (the topmost bubble if the start is above them all). Later strokes of the
   same pen session join that drawing. A stroke starts a new drawing instead if it begins more
   than `DRAWING_Y_SPLIT_PX` (16 000 draw px) from the anchor, so no point can cross the
   server's ±20 000 bound, or if the drawing already has 200 strokes. The session ends on pen off,
   any lock, the page hiding (the pen stays on), or a wipe.
6. **The live channel** (`drawingLive.ts`): at most one live POST in flight, at least 50 ms
   apart, at most 200 points each. Each batch starts with the previous batch's last point, so a
   lost batch shows as a gap and never as an invented line. A 429 pauses for `retryAfterS`. A 2 s
   keepalive repeats the last point while the finger is still. A cancel frame is sent only if
   something was sent. `shutdown()` on lock posts any owed cancel IMMEDIATELY, with the token
   still in hand. **Bug found by a helper's test and fixed at the root:** `schedule()` kept a
   stale 2 s keepalive timer, so after "draw, pause, lift, draw again" the new stroke's preview
   waited up to 2 s. It now re-arms to the earliest thing owed (`timerAt`). Red/green proven.
7. **Storing** (`drawingSync.ts`): each drawing has a FIFO queue. The first stroke is
   `POST /drawings` and the rest are `POST /drawings/{id}/strokes`. An unknown outcome is retried
   with the SAME `clientId`/`strokeId` after 1, 2, 4 and 8 s, then every 15 s. Verdicts:
   - 404 drops the drawing.
   - 409 on create means the anchor is full, and a notice says so.
   - 409 on append splits the remaining strokes into a new drawing.
   - 422 drops that stroke.
   A lock pauses the queue (timers cleared, nothing new sent), and the next unlock resumes it
   with the fresh token.
8. **Deleting** (found in the handover review, 2026-09-26, and fixed red/green):
   - The old code resolved a delete as done at once whenever the drawing had no id yet. It
     dropped the queue even when its create had been SENT and its answer was unknown. It also
     did so when a create was in flight and then answered "retry". That create may exist on
     the server, so the "deleted" drawing could stay for the other person, and come back here
     through the next summary.
   - Now a delete of an id-less drawing whose create was sent carries that create on, alone, with
     the same `clientId`, on the ordinary backoff and through locks, until it gets a verdict.
     "ok" teaches the drawing its id. The id is tombstoned (and a copy a fetch already showed is
     taken down), and the drawing is deleted by that id. A refusal means nothing was made.
   - The promise settles only then. A wipe, or the anchor message going, settles it "ok",
     because the cascade took the drawing.
   - A failed or lock-interrupted delete now brings the drawing back WHOLE: the layer re-queues
     its `pending` strokes, which the delete had held back and which would otherwise have been
     shown here and never stored.
9. **Reconciliation** (`drawingModel.ts`):
   - A summary only TRIGGERS a fetch, after a 60 ms debounce, and the need is checked again when
     the timer fires. At most 1 fetch is in flight per message and 4 overall.
   - The GET is the only authority. **The epoch rule:** a drawing is removed for being absent
     only if it was known before the GET was sent. This covers the race where a fetch is
     answered just before this client's own create commits.
   - Stale answers are dropped. Own drawings are adopted by `strokeId` (never shown twice).
     Tombstones are ids only.
   - For own drawings, revisions up to the number of strokes SENT are accounted for, so the
     drawer never re-fetches its own strokes (verified in e2e: the drawer makes no GET).
10. **Select mode taps are Pointer Events, never `click`.** A tap uses the same rule as R3's
    recognizer (moved at most `TAP_SLOP_PX` 10 px, held at most `TAP_MAX_MS` 300 ms), in capture
    listeners on the thread. A tap that hits swallows the follow-on click for 700 ms. Measured in
    Chromium phone emulation: a touch tap produced `pointerup` and NO click. Hit testing is
    geometric, within 12 viewer px of the stroke's visible edge. "Next drawing" is the keyboard
    route. "Delete drawing" asks "Delete this drawing for everyone?" (Delete/Cancel). The drawing
    is removed at once and restored on failure with "Couldn't delete the drawing. Try again."
11. **Departure from spec wording, deliberate:** the spec says drawings are `pointer-events: none`
    "except in Select mode". They stay inert even in Select mode and are hit-tested geometrically,
    so a selection can never block scrolling, a message tap, the ⋯ menu or a lock gesture. The
    observable behaviour the spec asks for (a tap within 12 px selects the drawing) is unchanged.
12. **Keep the thread in place** (`keepThreadInPlace`, re-entrant): any change in the toolbar's
    height (pen on/off, a mode switch, a notice, the confirmation) does
    `thread.scrollTop += delta`.
    - Measured without it: the newest messages slid under the composer when the pen came on, and
      a view stuck to the bottom later jumped about 90 px.
    - `onRemoteContent` (stick-to-bottom) fires only for the OTHER screen's drawings, never for
      this screen's own confirmations.
    - `chatThreadScroll.ts` (shared with the AI chat) gained `hold()`, which the pen uses for the
      length of one stroke.
13. **Toolbar sizes** (measured in real Chromium): desktop is one line, 54 px. At 390 and 360 px
    it is exactly two lines, 100 px, in every mode. At 380 px and below the thickness buttons are
    40 px wide (still 44 px tall), because 44 px ones need 363 px where 336 px exist. The hint and
    the question sit beside their buttons and wrap, so a mode switch never changes the height.
14. **The R3 boundary-close hazard: KEEP AS SPEC** (driver ruling). A tap on a drawing followed
    by "Delete drawing" within 400 ms locks the chat, because the button is a boundary and the
    select tap is an ordinary tap. The same pattern exists for a bubble tap followed by ⚙. The e2e
    uses `humanPause` between separate controls.
15. **Drift guard both ways:** `drawings.ts` keeps `DRAWING_COLORS`/`DRAWING_WIDTHS` as one-line
    `export const NAME = [...] as const;` declarations. The server's `test_livechat_drawings.py`
    parses them, and `tests/server/drawings.test.ts` parses `wixy_server/livechat/drawings.py`
    (proved to bite). The server builder confirmed a byte-for-byte match.

## Why

- Every choice above either follows the spec's decided behaviour or fixes a defect measured in
  a real browser: the header space, the click-less touch tap, the toolbar pushing messages under
  the composer, and the stale keepalive.
- The storing and reconciliation rules exist because the stream and this client's own POST
  answers travel on different connections and arrive in either order. A summary therefore can
  never be allowed to delete anything by itself. Only a fetch that knows what the client knew
  when it was sent can remove a drawing.

## What to watch for

- `thread.ts` must keep calling `drawingLayer.detach()` FIRST in its own `detach()`: the live
  cancel needs the token.
- Never put anything inside `.wx-srv-message-list` that `renderThreadList` does not own. The
  layer lives beside it in `.wx-srv-thread-content`.
- Anything that changes the toolbar's height must go through `keepThreadInPlace`.
- A new write outcome must be classified as a verdict or "retry" in `api/drawings.ts`. A 2xx the
  client cannot read is "retry", never "ok": the idempotent retry will read it.
- Honest limits (listed in livechat.md §19):
  - text re-wraps on other widths;
  - live frames reach only same-process streams in a blue/green overlap;
  - a reconnect mid-stroke misses that preview;
  - the thickness buttons are 40 px wide at 360 px;
  - the boundary-close hazard;
  - a lost create answer can re-create a drawing the other person just deleted
    (tombstone-free, as for messages).
