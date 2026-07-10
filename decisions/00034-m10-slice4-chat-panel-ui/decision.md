# Milestone 10 slice 4: the chat panel UI

Builds the admin-ui side of spec/05 §6 / spec/06 §1: the `#/chat` conversation
list and `#/chat/<conv>` detail view, replacing the `comingSoon` placeholder
`shell.ts` has carried since M7's own spec/05 read. Backend slices 1-3
(cmdchat.py, conversations store, send/stream/rename/handover) are unchanged;
this slice is almost entirely `admin-ui/`, plus one small backend addition
(the `includeThinking` query param, decision 3 below).

## Decision 1: a hand-rolled markdown renderer, not a new npm dependency

spec/05 §6 requires "markdown rendering incl. fenced code." `admin-ui` has
**zero** runtime npm dependencies today (`package.json` lists only
dev-tooling: esbuild/jsdom/typescript/vitest). Rather than adding the first
one, `admin-ui/src/markdown.ts` hand-rolls a minimal parser (paragraphs,
headings, fenced code, lists, inline code/bold/italic/links) — matching this
project's established Python-side preference for a small hand-rolled parser
over a new dependency for a well-scoped subset (`builder/theme.py`,
`builder/jsonschema_lite.py`). It deliberately **never uses `innerHTML`** with
message content — every node is built via `document.createElement`/
`textContent`, so untrusted (agent-authored) text can never be interpreted as
markup regardless of content; verified by a test that feeds it a literal
`<img src=x onerror=...>` string and confirms it renders as inert text, not a
DOM element. Links are restricted to `http(s)://` schemes only (a
`javascript:` URL gets its text but no `href` at all). Known, accepted
limitation: no nested emphasis (bold containing italic) — genuinely tricky
even for real parsers, and not something chat replies need.

## Decision 2: the list view's status dot is provisioning-only, not live
working/idle

spec/05 §6 describes the list's status dot as "working/idle/done" and spec/06
§1 says it comes "from the poll cache." Building a literal cross-stream
activity cache (tracking each conversation's last-observed `ChatStatus` even
when its own panel isn't open) is a real, separable backend extension — no
such cache exists, and decisions/00032 already explicitly rejected polling
cmd per list-render as wasteful. This slice's list dot instead reflects
`ConversationSummary.status` (pending/ready/failed — the provisioning state
already built in slice 2), which IS unambiguous and IS what the list
genuinely needs to show ("starting…" for a still-provisioning conversation,
a failure reason for one that didn't come up). The OPEN conversation's own
status strip DOES show live working/idle, driven by that conversation's own
open stream — the clearly-specified, unambiguous part of spec/06 §1's UI
mapping. If the deployed UX ever shows the list-level distinction matters
(M13 live verification), that's the moment to build the cache — not before,
on a guess.

Relatedly, the open conversation's status strip only distinguishes
working/idle (not "dead") — spec/06 §1's own warning ("process.kind: 'none'
does NOT mean dead") rules out inferring death from process state, and a
genuinely dead/unreachable cmd already surfaces through the stream's `error`
event (the offline banner), a materially different and already-correct
signal. "Working" = `ChatStatus.activity` timestamp within the last 10s
(`WORKING_FRESHNESS_MS`) — generous relative to the stream's 1.2s poll
cadence so a couple of missed ticks don't flicker the indicator.

## Decision 3: `includeThinking` reconnects the existing stream; no new
endpoint

spec/06 §1: "thinking hidden behind a 'show reasoning' toggle default-off...
lazily fetched with `include_thinking=true` only when the toggle opens." cmd
never includes `kind: "thinking"` entries unless asked, and spec/04 §8's
admin API index lists no dedicated endpoint for this. `_stream_events` (slice
3) already accepted `include_thinking` as a Python param but never had it
wired to anything externally — this slice threads it all the way through:
`GET .../stream?includeThinking=true` (new query param on the existing
route), `openConversationStream`'s new third arg, and `chatPanel.ts`'s
reasoning toggle closes the current stream and reopens with the flag set
(clearing and rebuilding the message list — simpler and more obviously
correct than trying to merge two different message sets client-side).
`fake_cmd.py`'s `/messages` route was extended to actually filter
`kind == "thinking"` by the param (it silently ignored the param before this
slice), since a test asserting "hidden by default, shown when toggled" needs
the fake to genuinely simulate that cmd-side behavior, not just accept and
discard the parameter.

## Decision 4: the "Preview updated" chip links to `#/pages`, not a specific
page

spec/05 §6: the chip should link "to `#/edit/<likely page>`." `GET .../state`'s
`upstream.aheadOfPublished` carries `{sha, subject, author, when}` per commit
— no page-level attribution. Guessing a "likely" page from a commit subject
string would be unreliable (worse than an honest, neutral link) and building
real git-diff-based page attribution is out of proportion for this slice.
Links to the pages list instead, letting the owner pick from there — a
documented, deliberate simplification, not an oversight.

## Decision 5: `mountChatPanel` is injectable via `ShellDeps`, mirroring
`mountEditView`

The real `mountChatPanel` opens a genuine `EventSource` for detail views the
instant it mounts. jsdom (this project's test environment) doesn't implement
`EventSource` at all — confirmed by an actual crash the first time a
shell-level test tried to mount `#/chat/<conv>`. Rather than polyfilling
`EventSource` globally in test setup, `ShellDeps` gained `mountChatPanel?:
MountChatPanelFn`, the exact same shape and reasoning `mountEditView` already
has (that one exists because jsdom can't render a real iframe either).
`shell.test.ts`'s list-view test still exercises the REAL `mountChatPanel`
(no `EventSource` involved there, so no reason to fake it); only the
detail-view routing test injects a fake, verifying shell.ts passes the right
conversation id through and tears the panel down on navigation.

## Real-browser verification (not just unit tests)

`chatPanel.test.ts`/`markdown.test.ts` (36 new tests) cover the logic
thoroughly, but per this whole chain's own repeated finding (decisions/00030
and earlier: real bugs are consistently invisible to jsdom), this slice was
ALSO driven through a genuine headed browser: a throwaway script spun up a
real `wixy_server` (temp git site repo, `WIXY_DEV_NO_AUTH=1`) against a real
`FakeCmdServer` (the same ephemeral-port uvicorn double the automated tests
use) and drove the full flow — create a conversation, watch it become ready,
receive a scripted reply with a grouped tool-action row and markdown
formatting, expand the tool row, send a message (confirming idempotency-key
tracking on the fake), and stop the fake cmd server to confirm the offline
banner appears. Every step passed; screenshots confirm the layout renders
cleanly. This ALSO doubles as an early prototype of slice 5's E2E 7 fixture
approach (same `FakeCmdServer` double, same "inject cmdchat_client into
create_app" wiring) — nothing new to invent there.

One real bug was found and fixed IN THE VERIFICATION SCRIPT itself (not the
product): the newly-created fake session defaults to `ready=False`, and the
script forgot to flip it, so the conversation sat "pending" until the
client's own readiness timeout — a good reminder that `FakeSession.ready`
needs explicit setting in any ad-hoc script, same as the automated tests
already know to do.

Two console `503` errors appeared during the run and were investigated
properly rather than dismissed: traced to the browser's own implicit
`/favicon.ico` request (no `<link rel="icon">` in `admin_shell.html`) hitting
`routes_public.py`'s deliberate, spec'd "Site not yet published" 503 (spec/04
§3 — "never a crash") — because the verification script's throwaway site was
never actually published. This is a PRE-EXISTING, already-understood pattern:
`e2e/fixture_server.py`'s own docstring already documents publishing one
initial build before the server starts specifically to avoid this "correct
but noisy" 503 for real E2E runs (a prior milestone's fix, not something new
here). Confirmed unrelated to chat and not worth re-investigating — noted
here so a future session doesn't re-chase it a second time.

## A real bug found while planning slice 5, fixed before this PR merged

While tracing through the composer's own `send()` logic to plan E2E 7's
send-retry-on-502 flow, `pendingIdempotencyKey` was found to NOT exist —
`send()` minted a brand new idempotency key on *every* call, including a
manual retry click after a failed send. This directly violates spec/06 §1
("Include the idempotency key so a UI retry can't double-send") and §3's
failure table verbatim wording ("manual retry with the **same** idempotency
key") — the whole point of the key is defeated if a retry gets a fresh one;
cmd would treat it as a genuinely new, un-deduplicated send. Fixed by
generating the key once per compose ATTEMPT (`pendingIdempotencyKey ??= ...`)
and clearing it only after a successful send, so a failed attempt's retry
reuses the same key while a genuinely new message (composed after success)
gets a fresh one. Caught before this PR merged (not a follow-up commit to a
landed main) — a new test
(`chatPanel.test.ts`: "a retry after a failed send reuses the same
idempotency key...") asserts this explicitly, using a fake `crypto.randomUUID`
that returns a DIFFERENT value per call (the original fake always returned a
fixed `"test-uuid"`, which couldn't have distinguished "reused" from
"coincidentally identical" — a test-quality gap worth remembering: a
constant-valued fake can hide exactly the bug it should catch).

## Files changed

- `admin-ui/src/markdown.ts` (new) — the renderer.
- `admin-ui/src/chatPanel.ts` (new) — list + detail views.
- `admin-ui/src/api.ts` — `ConversationSummary`/`ChatMessageData`/
  `ChatStatusData`/`ConversationStreamEvent`/`SendMessageResult` types, 4 new
  `AdminApi` methods, `openConversationStream`.
- `admin-ui/src/shell.ts` — wires the real chat panel in, `mountChatPanel`
  injectable dep, `comingSoon` removed (now unreachable — every route kind is
  handled explicitly).
- `admin-ui/src/style.css` — `.wx-chat-*` + `.wx-markdown` rules.
- `wixy_server/routes_chat.py` — `includeThinking` query param threaded to
  `_stream_events`.
- `wixy_server/tests/fake_cmd.py` — `/messages` now actually filters by
  `include_thinking`.
- `wixy_server/tests/test_routes_chat.py` — 1 new backend test for the
  hide/show-thinking behavior.
- `admin-ui/tests/markdown.test.ts` (new, 16 tests), `admin-ui/tests/
  chatPanel.test.ts` (new, 20 tests), `admin-ui/tests/api.test.ts` (+7),
  `admin-ui/tests/shell.test.ts` (updated/added chat-routing tests).

**Verification**: mypy strict clean (91 Python files), ruff check + format
clean, full Python suite green (535 passed, +1 from slice 3's close, for the
`includeThinking` test). admin-ui: `tsc --noEmit` clean, 214 tests passed —
up from 170 at the M9-close handover's own baseline (slices 1-3 were
backend-only, so admin-ui was untouched until this slice; 44 net new tests
across markdown/chatPanel/api/shell). `npm run build` succeeded and the
rebuilt bundle is committed (CI's drift check compares against a fresh
build). All 8 pre-existing E2E flows still pass locally, confirming the
shell.ts routing change didn't regress anything else. Plus the real-browser
pass described above.
