# Server chat — live drawing (the pen tool)

Architect ruling, 2026-09-26, on the Delivery Manager's six questions. Binding for workspace 29
round 2. The Builder may add detail but must not contradict it.

**Operator request (via the Delivery Manager):** a pen tool in the Server chat.
- Either person can draw freehand on top of the thread.
- A drawing stays where it was drawn and scrolls with the chat.
- It streams live, stroke by stroke, while being drawn.
- It persists until it is deleted, and it can be selected and deleted.
- The pen's colour and thickness can be changed.

## 1. Anchoring and different screen sizes (question 1): APPROVED as proposed, made precise

- **Anchor:** the message bubble whose top edge is the nearest one at or above the drawing's
  FIRST stroke's starting point. If the start is above the first loaded bubble, the anchor is
  that first bubble (the offset is then negative).
  - The drawing stores only the anchor's `seq`. Its position is read from the live DOM at
    render time, never copied (the Inv 51 pattern).
- **Coordinates:** every point is stored in *draw space*, in integer CSS px:
  - `x` is measured from the thread column's left edge. It is NOT measured from the bubble,
    because bubbles sit left or right depending on the sender.
  - `y` is measured from the anchor bubble's top edge.
  - The drawing also stores `column_width`, the drawer's thread-column width in CSS px.
- **Scaling:** one uniform factor `s = viewer column width / column_width` applies to x, y
  AND the stroke width, so a circle stays a circle.
  - Render each drawing as one `<svg>` whose `viewBox` is in draw space and whose CSS width
    is the viewer's column width. The browser then does the scaling exactly.
  - Absolutely position the svg at the anchor's current top.
  - `pointer-events: none` (except in Select mode, §5), `aria-hidden="true"`.
  - Path data is built only from validated numbers, never from a string the server echoes.
  - Re-position on layout changes with a ResizeObserver on the thread content: new messages,
    images loading, rotation.
  - The scrollable thread must grow to include any drawing that extends below the last
    bubble.
- **Honest limit (put it in `docs/ai/livechat.md`):** text re-wraps differently at different
  widths. A drawing stays attached to the right message, but on a much narrower or wider
  screen a circle drawn around particular words may not sit exactly on those words.
  Rejected alternative: stretching y between neighbouring messages. It tracks the content but
  distorts shapes, and both people mostly use phones of similar widths, where `s` ≈ 1.

## 2. What "a drawing" is (question 2): APPROVED as a session, with per-stroke storage

- **A drawing** = every stroke made from turning the pen on until it is turned off, or the
  session ends because the chat locks, hides or is routed away. It is selected and deleted
  as one unit.
- **Each stroke is stored the moment it ends** (pointer up), never only at the end of the
  session. A closed tab therefore loses at most the stroke under the finger.
- **Colour and thickness belong to each stroke,** because the operator can change the pen
  between strokes of one drawing.

## 3. Schema (question 6: the number is assigned at merge, v12 today)

```sql
CREATE TABLE IF NOT EXISTS drawings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,                 -- idempotent create
  anchor_message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
  sender TEXT NOT NULL, device_id TEXT NOT NULL, by_email TEXT,   -- by_email: audit only, never on the wire
  column_width REAL NOT NULL CHECK(column_width BETWEEN 200 AND 4000),
  rev INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS idx_drawings_anchor ON drawings(anchor_message_seq);
CREATE TABLE IF NOT EXISTS drawing_strokes(
  drawing_id INTEGER NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
  stroke_id TEXT NOT NULL,                        -- client-generated, idempotent append
  ord INTEGER NOT NULL,
  color TEXT NOT NULL, width INTEGER NOT NULL,
  points TEXT NOT NULL,                           -- JSON [[x,y],...] integers, draw space
  created_at REAL NOT NULL,
  PRIMARY KEY(drawing_id, stroke_id));
```

- **Both foreign keys must be index-covered.** A cascade searches the child column for every
  deleted parent row. Measured for replies: a 20,000-row wipe took 17.6 s without an index
  and 0.2 s with one (04-round2-rulings, item 10). `idx_drawings_anchor` and the
  `drawing_strokes` primary key (which leads with `drawing_id`) cover them.
- **Validation (422 `invalid`):**
  - `color` must be one of a fixed palette of 8 hex values, shared by TS and Python with a
    drift guard, as for the reaction emoji;
  - `width` must be in {2, 4, 8, 14};
  - `points`: 2–1000 pairs of integers, with `x` in [−50, column_width + 50] and `y` in
    [−20000, 20000], after the client's simplification (Ramer–Douglas–Peucker, 0.75 px).
    A single tap is a two-point dot;
  - at most 200 strokes per drawing and 20 drawings per anchor message, else 409 `full`.

## 4. Routes and live transport (question 3)

**Persisted state rides the EXISTING event machinery. No new persisted event type, and no
rebuild of the `events` table.**
- A drawing is part of its anchor message's state, as reactions are. Every change appends one
  `message_updated` row for the anchor: a create, an appended stroke, a delete.
- **The Message JSON carries only a summary,** `drawings: [{id, rev}]`, never the strokes. A
  history page of 50 messages must not carry megabytes of points.
- The client fetches bodies with `GET /messages/{seq}/drawings` (all drawings for that
  anchor, with strokes). It does so when a message it renders has a summary entry it lacks,
  or has a newer `rev`.
- The events table therefore stays the sole source of truth for everything persisted.
  Replay, coalescing, reconnect and blue/green behaviour are unchanged.

**Routes (token required):**
- `POST /drawings` — body `{clientId, anchorSeq, columnWidth, sender, deviceId, stroke:
  {strokeId, color, width, points}}` → 201 `{id, rev}`.
  - A repeated `clientId` → 200 with the same drawing.
  - An unknown or deleted `anchorSeq` → 404 (map the FK error; never 500).
- `POST /drawings/{id}/strokes` — body `{strokeId, color, width, points}` → 200 `{rev}`.
  - A repeated `strokeId` is a no-op 200.
  - A deleted drawing → 404.
- `DELETE /drawings/{id}` → 204, idempotent. **Either person may delete any drawing,** as with
  "Delete for everyone" for messages (Inv 46).
- `GET /messages/{seq}/drawings` → `{drawings: [{id, rev, sender, columnWidth, strokes:
  [{strokeId, color, width, points}]}]}`.

**Live strokes (while a stroke is being drawn) are a separate, deliberately lossy channel:**
- The drawer's client batches in-progress points every ~50 ms into `POST /drawings/live`,
  with body `{drawingClientId, anchorSeq, columnWidth, strokeId, batch, color, width,
  points}`. `batch` increases per stroke, so receivers ignore anything out of order.
  - At most 200 points per batch and 30 batches a second per device, else 429.
  - A final `{..., "cancel": true}` withdraws a stroke (see §5, two-finger scroll).
- **The server relays each batch through a NEW in-memory broker, not the notifier.** The
  notifier carries no data; it only says "re-read the database".
  - Each open `/stream` registers a bounded queue of 64 items. Overflow drops the oldest,
    because live preview is lossy by design.
  - The stream loop waits on the notifier OR its queue, and emits `event: drawing_live` with
    **no `id:` line**, so it never advances anyone's replay cursor.
  - It is sent to every stream, including the drawer's other devices. A client ignores live
    frames for a drawing it is drawing itself.
- **Live points are never written to the database, a file or a log line.** They are chat
  content (a drawing can be handwriting), so Inv 40 and Inv 46 apply. The broker holds
  nothing after it hands a batch to the queues.
- **Receivers:**
  - render live strokes in a separate layer, keyed by `strokeId`;
  - replace one with the stored stroke when the anchor's `message_updated` arrives and the
    drawing is re-fetched;
  - drop a live stroke that has not been updated for 5 s (the drawer vanished).
- **A reconnect mid-stroke simply misses that stroke's live preview.** The stored stroke
  arrives with the next `message_updated`.
- **Honest limit:** during a blue/green overlap, a live frame reaches only streams on the same
  process, because the broker is in-process. Stored strokes still reach everyone within 2 s
  through the existing database re-check. This is acceptable; a deploy overlap lasts minutes.
- **Revocation and locks:** the relay uses the same streams, so the grant check (03 §9), token
  expiry and `locked` apply unchanged. `POST /drawings/live` requires the token like every
  other route.
- No push notification for drawings (like reactions).

## 5. The pen tool, gestures and scrolling (question 5)

- **Pen button** in the chat HEADER, OFF by default. Not the composer bar: a third control
  there already pushed the text box under its 120 px floor on a 360 px phone
  (decisions/00169). It carries `data-srv-gesture-boundary`, because turning it on opens a
  new mode and toolbar under the finger. While ON, a small toolbar shows:
  - the 8 colour swatches;
  - the 4 thicknesses;
  - a **Draw | Select** switch;
  - "Done", which turns the pen off.
  On a 360 px phone it wraps onto two lines rather than overflowing (real-click visibility
  test at 360/390 px, as for 06 §3.1).
- **Draw mode (touch):** one finger draws and **two fingers scroll the thread.**
  - The drawing surface uses `touch-action: none` with pointer capture, as the spotlight
    drag does.
  - When a second finger lands within 150 ms of the first, and before the first has moved
    12 px, the first finger's stroke is cancelled (a live `cancel`, nothing stored) and
    the gesture becomes a two-finger pan, scrolling the thread by the centroid's movement.
  - Rejected: "turn the pen off to scroll". Toggling the tool every time you need to see
    further up or down is clumsy on exactly the device this will mostly be used on, and the
    two-pointer pan is a bounded piece of Pointer Events code.
  - Pinch-zoom is disabled while drawing.
- **Draw mode (mouse):** the wheel scrolls as usual; a drag draws.
- **Select mode:** a tap within 12 px (viewer space) of any stroke selects that stroke's whole
  drawing, showing a dashed outline and a **"Delete drawing"** button. The button asks
  "Delete this drawing for everyone?" with Delete / Cancel, like message deletion.
  - Those taps are ordinary UI taps.
  - "Delete drawing" carries `data-srv-gesture-boundary` (it opens a confirmation), as
    "Delete for everyone" does.
- **Outside pen mode drawings are completely inert** (`pointer-events: none`). They never
  interfere with reading, tapping a message, the ⋯ menu or any gesture.
- **The double-tap lock (R3):**
  - In **Draw mode**, the drawing surface is EXCLUDED from the multi-tap detector, as the
    typing box is. Rapid dots are content (dotting an i, a smiley's eyes), and a stray lock
    there would be exactly the false positive R3 v1.7 fixed.
  - The ✕ panic button stays visible and working, and **Escape still locks at once.**
  - In **Select mode** taps count as normal.
- **Idle lock (R7, Inv 43): no new suspension.**
  - The drawer's `pointermove`s are already activity, so drawing keeps the chat open.
  - WATCHING the other person draw is not activity: incoming frames are not input (Inv 43,
    unchanged). A viewer who does not touch the screen is idle-locked as usual.
- **A drawing session ends** when:
  - the pen is turned off;
  - there is any lock;
  - the page is hidden;
  - the user routes away;
  - there is a wipe.
  An in-progress stroke is then cancelled (live `cancel`); completed strokes are already
  stored.

## 6. Erasure (question 4): APPROVED

- **Deleting the anchor message cascades** to its drawings and their strokes. There is no
  re-anchoring and no orphans. The existing `message_deleted` removes the bubble; the client
  also removes any drawing layer anchored to that seq, in place.
- **Deleting a drawing** removes its row and, by cascade, its strokes. The anchor's
  `message_updated` summary no longer lists it, and every client removes that svg in place
  (never a whole-bubble re-render, which is the voice/video cut-off trap from reactions).
- **Wipe:** the existing `DELETE FROM messages` cascades. Add explicit `DELETE FROM
  drawing_strokes; DELETE FROM drawings` in the same transaction as the other tables anyway,
  so the wipe's intent is explicit.
- `secure_delete` and the WAL scrub then cover the bytes.
- **There are no drawing files** (rendering is client-side SVG), so nothing goes into
  `deleted_storage`. If a rendered file is ever added, it must be queued there the same way
  attachments are.
- **Raw-bytes tests (required):** store a stroke whose points form a distinctive sentinel
  run (for example `[[1234,5678],[2345,6789],[3456,7890]]`). Then assert that its serialized
  form is absent from `server.db` and its WAL after each of:
  - deleting the drawing;
  - deleting the anchor message;
  - a wipe.
  Also assert that no log line from the test run contains a live batch's points.

## 7. Tests (required)

**pytest:**
- validation and caps;
- idempotent create and append;
- anchor-FK 404 and deleted-drawing 404;
- `message_updated` appended per change, carrying summaries only;
- `GET /messages/{seq}/drawings` content;
- the erasure tests in §6;
- the live relay: frames reach other streams without an `id:` line, a slow consumer's queue
  drops the oldest, nothing is persisted (the table row count and the events count are
  unchanged by live posts), and it needs the token.

**vitest:**
- draw-space ↔ viewer-space mapping, and uniform scaling;
- anchor selection (above, and the top edge);
- RDP simplification bounds;
- the second-finger cancel rule, and the two-finger pan;
- Select-mode hit testing;
- in-place svg patch and removal;
- dropping a live stroke after 5 s;
- ignoring out-of-order `batch` numbers;
- the Draw surface excluded from multi-tap, while Escape still locks.

**e2e** (two identities, desktop plus 360/390 px):
- A draws a stroke and B sees it appear live before A lifts, then as stored;
- the drawing scrolls with its message;
- B deletes it in Select mode and it vanishes for both;
- deleting the anchor message removes it;
- a two-finger pan scrolls without drawing (touch emulation);
- the toolbar is visible and hit-testable at phone widths.

## 8. Process (question 6)
- **This file** is `spec/server-chat/07-live-drawing.md`. Add a new `docs/ai/livechat.md`
  section after the view-once one. Also update `docs/ai/contracts.md` (routes plus the
  `drawing_live` SSE frame), `docs/ai/invariants.md` and the CLAUDE.md store-schema row, in
  the same PR.
- **New invariant** (the next free number at merge, 53 today): "A drawing is chat content:
  its strokes live only in `server.db`, are erased with the drawing, its anchor message or a
  wipe, and a live stroke in progress is never persisted or logged."
- **An opus audit is required before merge,** with this file as the acceptance criteria. It
  adds a schema migration, touches the Inv 46 erasure paths, adds a new live transport path
  (an in-memory broker and a new SSE frame type), and adds new routes.
- Every commit: `Release-note: General bug fixes and improvements.` (R14a).
