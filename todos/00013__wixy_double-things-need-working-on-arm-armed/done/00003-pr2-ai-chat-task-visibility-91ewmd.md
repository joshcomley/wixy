# 00003 [91ewmd] PR 2 — unmissable AI-chat task visibility

## What
Give the site owner a live task list while the AI chat works, instead of just a fading
"Assistant is working…" strip. See brief "WORKSTREAM 2":
- 2a. `wixy-tasks` fenced-JSON-block protocol added to `wixy_server/templates/chat_preamble.md`
  (mind: no bare `---` line — `test_preamble.py` pins this); new `wixy_server/chat_tasks.py`
  (`extract_tasks`); `routes_chat.py:_stream_events` emits a new `tasks` SSE event.
- 2b. `admin-ui/src/chatPanel.ts` — prominent work banner (working/all-done/hidden) + sticky
  task card; extend `ConversationStreamEvent` in `api.ts`.
- 2c. Conversation list shows working state too — server enrich `working: bool` per
  conversation (TTL-cached ~5s), list row pulses.
- Docs (`contracts.md`, `ai-chat.md`) + 1 decisions entry.

## Acceptance
Same test/build/lint gate as PR1. Live check: real conversation, small real request, watch
banner/tasks appear, list row pulses from another tab.

## Links
Brief section "WORKSTREAM 2 (PR 2)". Depends on PR1 merged first (sequential per brief).

## Outcome — DONE 2026-07-31
Merged as PR #133 (github.com/joshcomley/wixy), merge commit `0eb35eb`. Full test/lint/build
gate green. Live-verified with a real conversation on `ca.cinnamons.uk`: the `wixy-tasks` SSE
mechanism is CONFIRMED WORKING end-to-end — a real conversation's transcript showed a
correctly-formed block, extracted and streamed correctly.

**But this same live-verification pass surfaced a critical production bug**: the `working`
boolean signal (2c above) was found to be COMPLETELY BROKEN — always `false` regardless of
cmd's real state. Root cause: `activity` (cmd's own tri-state-ish enum) was being parsed as an
ISO timestamp on both server and client, and neither `"working"`/`"idle"`/`"dead"` ever parses
as a valid date, so the freshness check always evaluated false. This was NOT a PR2 regression —
the exact same bug existed in the client-side `activityState` since decisions/00034 (5
milestones before PR2), invisible the whole time because every test double shared the same
wrong ISO-timestamp assumption the implementation did.

Spun off as its own fix, decisions/00099 (merged as PR #135) — which was THEN itself found
still broken on ITS OWN live re-verification (fixed the parsing but compared against the wrong
literal, `"working"`, when cmd's real value is `"active"`), requiring a second follow-up fix,
decisions/00100 (merged as PR #136). Both are now live-verified working correctly.

Also found+fixed during PR2's own finishing touches (this session): a CRLF/sourcemap-drift CI
failure (same class as a PR1 incident) — `admin-ui/src/{api,chatPanel}.ts`, `style.css`,
`tests/chatPanel.test.ts` had picked up raw CRLF bytes on disk; fixed via delete+
`git checkout --` to force the LF clean filter, then rebuilt. A test
(`test_working_flows_through_the_same_shape_as_the_dedicated_list`) that encoded a
stronger-than-actual guarantee was corrected to prove the real `/state`-vs-dedicated-list
two-tier contract; added the missing `TestCachedWorkingFor` coverage.

Decisions: `decisions/00097-wixy-tasks-chat-visibility/`, `decisions/00099-chat-activity-enum-not-timestamp/`
(+ correction), `decisions/00100-chat-activity-active-not-working/` (new).
