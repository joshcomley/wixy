# cmd's `activity` field is a tri-state enum, not a timestamp

## What happened

While live-verifying PR2 (decisions/00097, "unmissable AI-chat task visibility") against
the REAL production site — not the fake cmd test double every automated test uses — the
conversation-list "working" dot never once showed `true` across 68 one-second polls
during a real, continuously-active cmd session (confirmed via the session's own
transcript: a steady stream of tool calls from `11:21:19` to at least `11:21:50`, no gap
exceeding 6 seconds). Querying cmd's own `GET /sessions/<id>/status` directly (this
machine hosts both wixy and cmd, so this was a real, unmediated request) returned:

```json
{"process": {"liveness": "working", "idle_secs": 1.18, ...}, "activity": "idle", ...}
```

`activity` was the literal string `"idle"` — not an ISO timestamp. `spec/06-ai-chat.md`
already said as much, plainly, the whole time: *"Status dot from `/status`: prefer the
`activity` field (store mtime) over process liveness ... working / idle / dead."*
`activity` is cmd's own tri-state ENUM, computed server-side from a store's mtime, never
a raw timestamp wixy is meant to parse itself.

Both `wixy_server/chat_working.py`'s `_is_fresh` (new in PR2) and `admin-ui/src/
chatPanel.ts`'s `activityState` (the ORIGINAL mechanism, decisions/00034, PREDATING PR2
by five milestones) instead tried to `datetime.fromisoformat(activity)` /
`new Date(status.activity).getTime()` and compare elapsed time against a 10-second
freshness window. Since `"working"`/`"idle"`/`"dead"` never parse as a valid date, both
implementations **always** evaluated to "idle"/`NaN`/not-fresh, regardless of cmd's real
state — a total, silent failure of the underlying signal, present in production since
decisions/00034 first shipped this mechanism, five milestones before PR2 even existed.

## Why every test passed anyway

Every test — Python (`fake_cmd.py`'s `FakeSession.status`) and TypeScript
(`chatPanel.test.ts`'s `statusEvent` helper) alike — scripted `activity` as a REAL ISO
timestamp (`datetime.now(UTC).isoformat()` / `new Date().toISOString()`), because
whoever wrote each test carried the same wrong mental model the implementation did. A
genuine ISO timestamp parses fine and, freshly minted, sits well within a 10-second
window — so the buggy "parse as a date, check elapsed time" logic produced the CORRECT
answer for every test's own scripted input, purely because the test happened to feed it
exactly the (wrong) shape the implementation expected. The bug was invisible to every
layer of automated testing not because the tests were shallow, but because the
PRODUCT CODE and its TEST DOUBLES shared one consistent, self-reinforcing wrong
assumption about an external system's contract — the fake was laxer than reality in
exactly the dimension needed to hide this. Even `decisions/00034`'s own "real-browser"
verification pass (a genuine headed-browser run, not just jsdom) never caught it,
because that pass ALSO ran against `FakeCmdServer` — a real browser talking to a fake
service is still only as correct as the fake. The ONLY thing that could have caught
this is what actually did: a live request against the REAL external system.

**The general lesson**: a test double's contract must be independently verified against
the real system it stands in for — not just internally consistent with the code under
test. When both sides of an interface are authored (or assumed) by the same mental
model, unit and even browser-real E2E tests can all pass while the real integration is
completely broken. This is why the mission's own bar ("shipped end-to-end WITH LIVE
VERIFICATION," not "tests pass") exists, and why it must never be skipped even when
every automated signal is green.

## The fix

Both sides now do a plain string-equality check instead of parsing anything as time:

- `wixy_server/chat_working.py`: `_is_fresh(activity, now) -> bool` (parsed a datetime,
  compared elapsed seconds) → `_is_working(activity) -> bool` (`return activity ==
  "working"`). `_FRESHNESS_S` and the `datetime`/`UTC` imports it needed are gone
  entirely — there is no elapsed-time concept left to bound.
- `admin-ui/src/chatPanel.ts`: `activityState(status, now)` (parsed a `Date`, compared
  elapsed milliseconds) → `activityState(status)` (`return status?.activity === "working"
  ? "working" : "idle"`). `WORKING_FRESHNESS_MS` is gone.
- **The client's 2-second `workBannerTimer` (`setInterval(renderWorkBanner, 2000)`) is
  removed entirely**, not just left alone — its ENTIRE purpose was making the old
  freshness window visibly "age out" even without a new status event arriving. Once
  `activityState` is a pure enum comparison with no time component, re-rendering on a
  timer produces the IDENTICAL result as the last real event did; it's dead weight, not
  a harmless leftover. Every state this banner depends on (`latestStatus`, `latestTasks`,
  `awaitingReply`) is already re-rendered explicitly the instant it changes
  (`handleStreamEvent`/`send()`), and `routes_chat.py:_stream_events` only ever emits a
  `status` SSE event when `ChatStatus` actually changes (`if status != last_status:`) —
  so a real activity transition reaches the client within one ~1.2s poll tick regardless,
  with no independent timer needed to notice it.
- Every test that scripted `activity` as an ISO timestamp — `wixy_server/tests/
  test_chat_working.py` (rewritten: `TestFreshness` → `TestActivityState`, "fresh"/"stale"
  language replaced with the real `"working"`/`"idle"`/`"dead"` values, a new dead-state
  test added), two call sites in `test_routes_chat.py`, `admin-ui/tests/chatPanel.test.ts`
  (the `statusEvent(new Date().toISOString())` calls, and the now-obsolete "ages back to
  hidden on the periodic re-render" test rewritten to assert the real event-driven
  behavior instead), and `e2e/tests/chat-ux.spec.ts`'s `/test/chat/set-activity` calls —
  now use the real enum strings, so this exact class of drift can't silently recur.
- `fake_cmd.py`'s `FakeSession.status` default (`{"activity": None, ...}`) is unchanged —
  `None` correctly represents "no signal yet," which was never the buggy part.

## What to watch for

- **`activity` is `"working" | "idle" | "dead" | None` — never treat it as parseable
  date/time data again**, on either side of this codebase. If a future signal genuinely
  needs elapsed-time reasoning about cmd activity, it needs a NEW, explicitly-timestamped
  field from cmd — not a reinterpretation of this one.
- **A test double is only as trustworthy as its own fidelity to the real contract.**
  `fake_cmd.py`/`e2e/fixture_server.py` model cmd's shape reasonably faithfully elsewhere
  (spawned_by_session_id enforcement, thinking-message filtering) — this was the one
  place a wrong shared assumption slipped through both the fake and the code it was
  meant to validate. Worth periodically re-deriving a fake's field shapes from the real
  service's actual responses rather than only from what the code under test expects.
- **Live verification against the real external system is not optional, even when
  everything else is green** — this bug shipped, passed code review's own bar (per
  decisions/00034's real-browser pass), and survived unnoticed for five milestones
  specifically because nobody had queried real cmd's `/status` response directly and
  compared it, character for character, against what the parsing code assumed.

## Correction (decisions/00100): the enum values above are WRONG

The very next live-verification pass (re-checking THIS fix, immediately after deploy)
found that **`"working" | "idle" | "dead"` — the specific literal enum values this
decision names throughout, including in the "what to watch for" bullet directly above —
is itself wrong.** Direct confirmation against cmd's own source
(`engine/chats/session_introspect.py:_activity`) shows the real enum is `"active" | "idle"
| "done" | "unknown"`. `"working"` is never a value `activity` takes; it's a literal the
separate `process.liveness` field uses, which this decision's own evidence (the `curl`
output quoted under "What happened" above: `"process": {"liveness": "working", ...},
"activity": "idle"`) already showed side-by-side without drawing the right conclusion —
`"working"` was sitting right there as `process.liveness`'s value, one key over from
`activity`, and got attributed to the wrong field.

**Root cause of THIS decision's own mistake**: `spec/06-ai-chat.md`'s prose ("working /
idle / dead") was taken as a literal quote of cmd's wire values, and the one live sample
gathered here happened to read `activity: "idle"` — never independently confirmed what
the string looks like WHILE genuinely active, because the investigation stopped as soon
as "it's an enum, not a timestamp" was confirmed. That was necessary but not sufficient:
getting the KIND of check right (equality, not parsing) still shipped with the WRONG
literal, so `_is_working`/`activityState` continued to always evaluate false in
production — the exact same class of externally-invisible failure this decision itself
describes, just one layer deeper. See decisions/00100 for the full second incident: how
it was caught (two independent live runs, ~90-120s each, directly polling cmd's real
`/status` endpoint time-correlated against wixy's own — not just re-trusting this
decision's fix), the corrected fix, and the general lesson about re-verifying a fix's OWN
assumptions rather than stopping at "the bug class is now understood."
