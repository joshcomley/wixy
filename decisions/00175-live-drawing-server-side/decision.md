## Symptom

The operator asked for a pen tool in the Server chat: either person can draw freehand on
top of the thread, the drawing sticks to where it was drawn and scrolls with the chat, it
streams live stroke-by-stroke to the other person while being drawn, it persists until
deleted, and the pen's colour/thickness can be changed mid-drawing. This is a large feature
(a new kind of stored data, a live stream between two screens, and new erasure rules), so
the project doctrine required an Architect design ruling before any code — that ruling is
`spec/server-chat/07-live-drawing.md` (PR #282, six numbered forks, all folded into the
spec). This entry records the SERVER half's implementation; the client half is a separate
decision (00176) on a parallel branch, `cmd/workspace-00035-live-drawing-client`.

## Root cause

N/A — new feature, not a bug fix.

## What was decided

Built exactly to spec 07, in the shape the Architect ruled:

- **Anchoring (F1):** a drawing stores only its anchor message's `seq`
  (`anchor_message_seq`, `ON DELETE CASCADE`) plus geometry in *draw space* — integer CSS
  px, `x` from the thread column's left edge, `y` from the anchor bubble's top edge, and the
  drawer's own `column_width` (`CHECK BETWEEN 200 AND 4000`). The server never computes a
  position; it stores exactly what the client measured, and scaling/rendering is entirely
  client-side (spec §1).
- **A drawing is a session; each stroke its own row (F2):** `drawings` (one row per pen
  session, `client_id` UNIQUE as the create idempotency key) and `drawing_strokes` (primary
  key `(drawing_id, stroke_id)`, `stroke_id` the append idempotency key, `ord` the stroke's
  position, colour/width per stroke). Each stroke is stored the moment it ends (pointerup),
  never batched until the session ends — a closed tab loses at most the stroke under the
  finger.
- **Schema v13** (`_SCHEMA_V13_DRAWINGS`, `wixy_server/livechat/store.py`): the spec's own
  text still says v12 — amended in place (marked as an amendment, not silently corrected)
  because the Spotlight→Tease rename (decisions/00172) landed first on `main` and took v12
  first. `docs/ai/livechat.md` §18 and the CLAUDE.md schema table record the real number.
  Both foreign keys are index-covered (`idx_drawings_anchor`; `drawing_strokes`'s own PK
  leads with `drawing_id`) — reply-to's schema v10 already measured what an uncovered
  cascade FK costs (17.6s vs 0.2s at 20,000 rows) — and `ON DELETE CASCADE` on both means an
  OLDER blue/green-overlap process that has never heard of these tables still removes a
  drawing and its strokes when it hard-deletes the anchor message, exactly like reactions
  (decisions/00164).
- **No new persisted event type, no `events` rebuild (F3):** create/append/delete each
  appends exactly one EXISTING `message_updated` event for the anchor. The `Message` wire
  shape carries only a summary (`drawings:[{id,rev}]`, `DrawingSummary`) — never the
  strokes, so a 50-message history page never carries megabytes of points. A client fetches
  the body with `GET /messages/{seq}/drawings` when it sees a summary entry it lacks or a
  newer `rev`.
- **The live relay is a new, separate, deliberately lossy channel (F3):** `POST
  /drawings/live` relays in-progress points through a NEW in-memory `DrawingBroker`
  (`livechat/drawing_broker.py`), never the existing `LiveChatNotifier` (which carries no
  payload — a live batch IS the data). Each open `/stream` connection registers its own
  bounded `LiveDrawingQueue` (`deque(maxlen=64)`, oldest dropped past capacity) and drains
  it every loop tick, before the ordinary persisted-event poll. The SSE frame is `event:
  drawing_live` with **no `id:` line**, so it can never advance the replay cursor.
  Rate-limited (30 batches/sec per authenticated device, `SlidingWindowRateLimiter`, 429 past
  the cap; see the audit amendments below). Nothing about a live batch is ever written to `server.db`, a file, or a log
  line — this is the new invariant, Inv 53.
- **Cascade erasure (F4):** covered above by the schema's own FK; a wipe additionally issues
  explicit `DELETE FROM drawing_strokes; DELETE FROM drawings` in the same transaction as
  every other table, even though the cascade already covers it, so the wipe's intent is
  never implicit (spec §6).
- **New invariant, Inv 53** (`docs/ai/invariants.md`): a drawing is chat content — erased
  with its drawing, its anchor, or a wipe; a live stroke in progress is never persisted or
  logged, regardless of how the drawing session ends (F6).

## Bug found and fixed during parallel client testing

The client builder's real-browser e2e testing (session `fffc7eb8`, working the client half
in parallel) caught a genuine 500 on **every** call to `GET /messages/{seq}/drawings`:
`@router.get("/messages/{seq}/drawings")` was missing `response_model=None`, so FastAPI
tried to build a Pydantic `TypeAdapter` for the return annotation `JsonObject` and raised
`PydanticUserError: TypeAdapter for JsonObject "is not fully defined"` — every sibling route
returning a bare `JsonObject` already carries `response_model=None` for exactly this reason.
One-line fix; regression test added
(`test_routes_livechat_drawings.py::TestGetDrawingsRoute::
test_returns_every_drawing_with_its_strokes`, whose docstring names the finding).

## Conformance matrix

See the PR description for the full spec-requirement → code-location → test mapping. Two
things this entry flags explicitly rather than leaving implicit:

1. **`test_livechat_drawings.py::TestClientListMatchesServerList`** (the TS/Python palette
   drift guard, spec §3's "shared by TS and Python with a drift guard, as for the reaction
   emoji") is RED on this branch alone, by design: `admin-ui/src/server/drawings.ts` lives
   on the parallel client branch (`cmd/workspace-00035-live-drawing-client`) and does not
   exist here yet. It turns green once both branches share `main`. The exact literal shape
   both sides agreed on (over `/peer`, matching `reactions.ts`'s own regex-parseable
   pattern) is in that test's own docstring.
2. **`POST /drawings/{id}/strokes`'s point-bounds validation uses the global
   `MAX_COLUMN_WIDTH` (4000), not the specific drawing's own stored `column_width`** — the
   spec's wire shape for this route (§4) carries no `columnWidth` field at all, so this is
   the conservative bound that covers every possible drawing regardless of its own width. A
   point that passes this gate but falls outside the drawing's OWN column width is a
   rendering-only imprecision (the stored `column_width` is what actually places the stroke
   visually), never a correctness or security issue — flagged for the audit, not treated as
   a defect to fix unilaterally, since tightening it would mean adding a field the spec
   doesn't ask for.

## Audit amendments (Opus 5.5 audit of PR #286, first round)

The audit found three defects in the live relay, each red/green proven in
`test_routes_livechat_drawings.py` by reintroducing the defect and watching the new tests fail.

- **F1 (medium): the rate limit was keyed by the client-chosen `drawingClientId`.** A token
  holder picks every body field, so inventing a new id per request reset the budget, and the
  limiter's table grew by one key per request. Spec 07 §4 says "per device": the key is now the
  authenticated identity (`_live_relay_budget_key`: the grant id when the token is bound to a
  device grant, so re-unlocking with the grant cannot reset it, else a SHA-256 of the token, so
  the table never holds a usable credential; a fresh PIN-unlocked token costs a PIN entry). Two
  people drawing together are two tokens and never throttle each other. `SlidingWindowRateLimiter`
  also drops idle keys once per window (behaviour-preserving: a key with no event in the window
  is indistinguishable from a new one), so the table is bounded by the keys active within one
  window. The old test `test_rate_limit_is_keyed_per_drawing_client_id` encoded the flaw and was
  replaced.
- **F2 (medium): a lost wake-up in the stream loop.** `LiveDrawingQueue.push` and
  `LiveChatNotifier.publish` each swap in a fresh event and set the old one, and
  `notifier.current_event`'s own docstring says to capture it BEFORE the guarded check; the loop
  read both events only at the wait, after the awaited grant check and `events_after`. A frame
  pushed in that gap (a live POST runs on the event loop, so it lands exactly there) left the loop
  waiting the full 2 s: a stroke's last batch or its cancel reached the other person up to 2 s late.
  The same window existed for a message committed by this process. Both events are now captured at
  the top of each iteration. Cost: at most one extra spin when a push lands between the capture
  and the drain.
- **F3 (low): unbounded fields on `POST /drawings/live`.** `drawingClientId`, `strokeId`,
  `anchorSeq` and `batch` were unchecked yet copied into up to 64 queued frames per open stream.
  They are now bounded like the create/append routes (ids 8-64 characters, `anchorSeq` 1..2^53-1,
  `batch` 0..10,000,000, else 422 before anything is relayed).

## What to watch for

- **Two live-drawing branches must never both hold `cmd/workspace-00029-live-drawing`
  checked out.** This branch was originally being worked from a different workspace
  (00031) that also carried an unrelated in-flight disk-space incident and a Tease
  preview/speed-slider task; the driver (session `6c42566b`) reassigned sole ownership of
  this branch to this workspace (00034) mid-flight over `/peer` — see the PR's linked
  conversation. Before resuming work on this branch from a different workspace, confirm via
  `git worktree list` that no OTHER worktree already has it checked out.
- Decision numbers 00175 (this entry, server) and 00176 (client) were reserved by
  peer-message rather than by re-scanning at merge time, because both PRs were being
  written concurrently. Per the numbering doctrine (see CLAUDE.md HANDOVER section, and
  douglas decisions/00018's `id6` rationale for the sibling `todos/` scheme), the number is
  a sort hint, not an identity — a genuine collision at merge time is not a blocker, just
  worth a quick renumber for readability.
