# Unmissable AI-chat task visibility

## The ask

The chat panel's only "is the assistant doing anything" signal was a small
strip reading "Assistant is working…"/"Idle", driven purely by cmd's raw
`activity` timestamp — no sense of WHAT it was doing, how far along, or
whether it was stuck. The site owner is non-technical and often leaves the
conversation screen entirely while the assistant works; she had no way to
tell, from the pages/media/theme panels or the chat list, that anything was
happening at all. The ask: a live task list while the assistant works, a
banner that's actually hard to miss, and a working indicator on the
conversation list itself.

## What was decided

**A transcript-embedded protocol, not a cmd-side change.** cmd is a fleet-
wide platform this engine doesn't control the internals of (Inv 13: all AI
inference goes through it, wixy never talks to a model directly) — asking it
for a new structured-status API was out of scope. Instead, the preamble
(`templates/chat_preamble.md`) instructs the model to embed a fenced
` ```wixy-tasks ` block containing `{"tasks":[{"label","status"}]}` in its
own reply text, re-emitting the whole block (stable labels, updated
statuses) every time progress changes. This works identically regardless of
which backend eventually serves a conversation (spec/independence/05's
pluggable-backend future) — the protocol lives entirely in the prompt/
transcript, never in a wixy↔cmd API call.

**Extraction is server-side, mirroring the preamble's own compose/strip
split (decisions/00093).** `wixy_server/chat_tasks.py:extract_tasks` strips
every `wixy-tasks` block out of an assistant message's text and returns the
last valid block's tasks — run in `_stream_events` AFTER `_owner_visible`
(strip what must never be seen at all, THEN extract structured protocol from
what remains) and BEFORE the `sent_messages` diff, for the identical reason
the preamble strip runs there: the diff cache must hold exactly what was
actually sent, or an unchanged block on a later poll looks like a content
change forever (decisions/00093's own "diffing raw while emitting stripped
would re-send the message every tick," now the second instance of that
lesson in this file).

**The `tasks` SSE event is diffed independently of the `message` event, not
piggybacked on it.** A model re-emitting the SAME block with only a status
change (`"doing"` → `"done"`) can leave the CLEANED surrounding prose
byte-identical to what was already sent — the message-event dedup sees no
change and correctly stays silent. If the tasks event were gated on that
same dedup, a real, owner-visible progress update would be silently
swallowed. `last_tasks_sent` is tracked as its own piece of stream state,
compared independently every tick.

**A malformed block is still stripped, even though it produces no tasks.**
`extract_tasks` treats "found a `wixy-tasks` fence but the JSON inside is
garbage" the same as "found a well-formed one" for the purpose of REMOVING
it from the owner-visible text — raw protocol noise (even broken protocol
noise) must never reach the chat bubble. It just doesn't update the task
list in that case. This makes the UI degrade gracefully exactly as the
preamble instruction anticipates ("the UI degrades gracefully when a block
never appears") rather than leaking a stray fence into a reply.

**Three independent "is it working" signals on the client, not one.**
`chatPanel.ts`'s `isWorking()` ORs together: `activityState` (cmd's own
timestamp, unchanged from before), a local `awaitingReply` flag set the
instant `send()` succeeds and cleared on the next non-user message, and "the
latest tasks array has anything not yet done." Each covers a gap the others
miss on their own: activity alone misses the moment right after Send (cmd's
own activity timestamp hasn't ticked yet); tasks alone misses a conversation
that never emits a block at all (compliance is explicitly the protocol's
"weak link," per the preamble's own wording); awaitingReply alone would
never clear if a task block never arrives and the reply is a single terse
message. Together they cover the real gaps without needing a fourth signal.

**Sending a new message explicitly clears the stale task list.** Once every
task is `done`, the banner shows "All tasks completed…" — but if the owner
sends ANOTHER message, that old, fully-done list would otherwise linger
uselessly onscreen while a brand-new round of work starts. `send()`'s
success path clears `latestTasks` and sets `awaitingReply`, so the banner
falls back to the generic "Thinking…" wording until a fresh block (or plain
reply) arrives — never a stale "all done" sitting under active new work.

**The list-wide `working` flag is TTL-cached, not polled live per row.** The
conversation list already polls `GET .../conversations` every 2s
(`chatPanel.ts`); naively calling `client.status()` for every ready
conversation on every poll would multiply cmd calls by conversation count
for no real benefit (activity doesn't change meaningfully faster than a few
seconds). `chat_working.WorkingCache` — one instance on `app.state` for the
app's lifetime — caches `conv_id -> (working, cached_at)` for `_CACHE_TTL_S
= 5.0`, refreshing only stale/missing entries, fetched concurrently
(`anyio.create_task_group`, the codebase's established fan-out primitive —
chosen over a literal `asyncio.gather` to stay consistent with this
FastAPI+anyio codebase's own convention, not because of any functional
difference). `cache_ttl_s` is a constructor field, not a hardcoded module
constant, mirroring `routes_chat.StreamTiming`'s "bundle the real timing
constant so tests can shrink it" convention — a test that wants to observe
a change immediately after mutating fake activity sets it to `0` rather
than waiting out (or racing) 5 real seconds.

**`conversation_summary` gained `working` as a keyword parameter with a
`False` default, computed by the CALLER, not looked up internally.**
Computing "working" needs an async cmd call; `conversation_summary` is (and
stays) a plain synchronous dict-builder with no I/O of its own — exactly the
"kept in one place so the two call sites can never drift apart" property
its own docstring already promises for the OTHER fields. Both call sites
(`routes_chat.list_conversations`, `routes_admin_api.get_state`) now
independently: load conversations, filter to `effective_status(...) ==
"ready"`, call `WorkingCache.working_for`, thread the resulting map through.
`effective_status` itself was extracted from routes_chat.py's own duplicate
logic into `chats.py` as a shared function once a SECOND call site needed
the identical "absent-from-runtime-means-ready" rule — the exact duplicated-
contract failure mode decisions/00092 already hit once for the preamble
separator, caught here before it could recur a second time.

## A CSS footgun this PR's own e2e coverage caught (real bug, real lesson)

`.wx-chat-work-banner`'s first draft set `display: flex` unconditionally, toggled
hidden/shown purely via `workBanner.hidden = true/false` (the DOM `hidden`
property/attribute). This is broken: `[hidden]`'s UA-stylesheet rule and a bare
class selector are EQUAL CSS specificity, and author stylesheets win ties over the
UA stylesheet — so the class rule's unconditional `display: flex` silently
overrides the browser's default `[hidden] { display: none }`. The attribute is
genuinely present (`el.outerHTML` shows `hidden=""`, confirmed by direct
inspection) but has NO EFFECT — the element stays flex-rendered, visible, the
whole time. Every vitest assertion (`expect(banner.hidden).toBe(true)`) passed
throughout, because jsdom checks the PROPERTY, not computed rendering — this class
of bug is invisible to unit tests by construction and was caught ONLY by the real-
browser e2e scenario this PR added to `chat-ux.spec.ts`. Fixed to match this
codebase's own pre-existing convention (`.wx-button-busy[hidden]`, `.wx-media-
grid[hidden]` — both already had it right): keep the base `display: flex` but add
a higher-specificity `.wx-chat-work-banner[hidden] { display: none; }` override,
rather than a `:not([hidden])` rewrite of the base rule (equivalent effect, but
matching the established pattern rather than introducing a second idiom for the
same problem).

**The general rule this confirms**: any element given a non-`none` `display` in
author CSS, whose JS-side visibility is controlled by the `hidden`
attribute/property, needs an explicit `.foo[hidden] { display: none; }` rule — the
UA default is not enough once a class rule sets `display` at equal specificity.
Vitest/jsdom cannot catch a violation of this rule; only a real-browser check can.

## What to watch for

- **The preamble's example fence and `test_preamble.py`'s no-bare-`---`-line
  guard interact only incidentally** — the example block is safe specifically
  because `strip_preamble` removes the whole preamble as one byte-exact
  prefix (never scans inside it for nested protocol), not because of
  anything `chat_tasks.py` itself does. If the preamble-stripping mechanism
  ever changes to something more granular, re-verify this reasoning still
  holds.
- **`WORKING_FRESHNESS_MS` (client, `chatPanel.ts`) and `_FRESHNESS_S`
  (server, `chat_working.py`) are two independently-maintained `10.0`
  constants**, not a shared one — both decide "is this conversation working"
  from the same cmd `activity` field but via different code paths (one
  compares in the browser against a live SSE stream's own status event, the
  other against a cached poll of `client.status()`). If one changes, check
  whether the other should too, the same hand-sync discipline Inv 20's pairs
  already require elsewhere in this codebase.
- **`extract_tasks` only ever runs on `role == "assistant"`, `kind ==
  "text"` messages** — a `tool_use`/`tool_result`/`thinking` message's text
  is never scanned, and neither is anything the OWNER wrote. This is
  deliberate (the protocol is assistant-reply-only by design) but worth
  remembering if a future change ever wants task state to originate from a
  tool result instead of the model's own prose.
- **The task card's DOM sits in normal document flow directly above the
  scrolling thread**, not literal CSS `position: sticky` — it doesn't need
  to be, since the thread already scrolls internally within its own
  fixed-height box and nothing ever scrolls the task card out of view. If
  the thread's own scroll-container structure ever changes, re-check this
  assumption still holds.
