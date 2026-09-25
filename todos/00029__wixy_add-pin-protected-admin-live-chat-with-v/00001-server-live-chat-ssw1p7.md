
## ROUND 2 kickoff 2026-09-25 ~08:05 UK (Orchestrator `bf07245f`) — operator follow-up requests

- **Operator sent new requests via chat + a screenshot** of the live Server panel (rendered inside the admin-ui
  builder shell, panel titled "Server / Cupcake" with a gear + close button) showing a large blank gap below
  the last message before the composer. Workspace moved `on_hold -> discussing` to scope a new delivery cycle;
  `cmd/workspace-00029` (the old feature branch) is superseded by the squash merge - every new branch bases on
  `origin/main`.
- **Six items, briefed to the DM (`b584352d`), one PR/review/merge/verify-live cycle each, item 1 first:**
  1. BUG: the chat panel doesn't fill available vertical space (mobile + desktop). Start in
     `admin-ui/src/server/chat.css` (`.wx-srv-chat`/`.wx-srv-thread-view`, flex:1/min-height:0 chain per its own
     comments) - check the admin-shell PANEL wrapper gives that chain a bounded height; the screenshot shows the
     builder-shell mounting context specifically, may differ from the dedicated view.
  2. New feature: reaction emojis on messages (own model/API/UI/tests; kept out of the general AI-chat component
     per decisions/00110's split).
  3. New feature: voice-note transcription, opt-in per note (a click-to-transcribe button; never automatic).
  4. New feature: a per-device "permanent unlock" toggle, PIN-gated to turn ON. **Security-relevant - routed to
     the Architect (`96bd8091`) for a ruling before building.** Architect's headline ruling (still awaiting full
     design): a PIN-gated, server-revocable device grant; while on, ALL auto-locks (idle, hidden, route-away,
     reload, 12h token expiry) are suppressed with silent token re-mint; the three DELIBERATE locks (panic
     button, multi-tap-in-chat, Escape) still lock AND pause the grant until the PIN is re-entered. My narrower
     "idle-only" proposal was rejected as too narrow for what "permanent" means to the operator.
  5. Bug: newlines in message text aren't rendered (renderer likely drops `\n`; needs `white-space:pre-wrap` or
     `<br>` conversion).
  6. Bug: the message input loses focus after Send; refocus it in the send handler and its error path.
- **Next decision number: 00160** (00159 was the last used, workspace 29's own load-independent-deadline-test
  decision).
- Not yet done: the Architect's full permanent-unlock design; the DM's new delivery record (`POST /deliveries`)
  and task list; moving the workspace `discussing -> building` once that exists.

## Update 2026-09-25 ~12:05 UTC (Orchestrator `bf07245f`) — round 2 in progress; new operator request

- **Real work confirmed** (the operator asked "has any actual work been done?"): item 1 (panel not filling
  available height) is fixed and its PR (#248) is open with checks running. Three builders are actively coding:
  reaction emojis, click-to-transcribe voice notes, and the permanent-unlock feature (item 4). The two merges
  so far (#246, #247) were the plan and the Architect's design doc, not feature code - that's why early
  progress read as "nothing happening".
- **New operator request** (verbatim): "We need checkboxes for: - Lock when I change tab - Lock when I lock my
  screen." This lands on `03-permanent-unlock.md` sec 1's suppressed-triggers list, which currently treats
  `visibilitychange -> hidden` (covers BOTH tab-switch and screen-lock - the web platform has no separate
  signal for the two) as unconditionally suppressed while a device grant is active. Routed to the Architect
  (`96bd8091`) for a ruling before the item-4 builder (`41f2ad09`) finalises that part of the logic; everything
  else in that item and all other items are unaffected and continue. My question to the Architect: is one
  checkbox (not two, given the platform constraint) the right answer, and is it a per-trigger override inside
  the permanent-unlock settings sheet, default off?

## Update 2026-09-25 ~12:20 UTC (Orchestrator `bf07245f`) — round 2: rulings and the cross-repo task

- **Item 1 (panel height) DONE and LIVE**: PR #248, main `6cd21a3`; the live site swapped to it (green slot),
  health 200, log clean. Item 5 (newlines) and 6 (refocus after send) are being done by the DM itself.
- **Lock checkboxes** ("Lock when I change tab" / "Lock when I lock my screen"): Architect ruling landed as
  `spec/server-chat/03-permanent-unlock.md` sec.8, PR #250 (main `c55e8ba`). Two independent per-device
  checkboxes, default ON, keys `wx-srv-lock-on-tab` / `wx-srv-lock-on-screen`, govern the `hidden` trigger in
  BOTH modes (this AMENDS sec.1: permanent unlock no longer blanket-suppresses `hidden`); a checkbox-caused lock
  pauses an active grant. Screen-lock detection needs Chromium's IdleDetector (no universal API; a web page
  cannot otherwise tell tab-switch from screen-lock). My review found a fail-OPEN gap (boxes differ + no
  screen-lock evidence -> silent restore); Architect accepted it and refined: ambiguous cause FAILS CLOSED and a
  device earns "no event = tab change" only after it has once observed a real screen lock
  (`wx-srv-screenlock-proven`). REQUIRED before shipping the two-way distinction: a live timing check on the
  operator's Android phone (order/timing of visibilitychange vs IdleDetector for power-button lock, app switch,
  tab switch); if the evidence misses the 500 ms window, ship the mirrored (combined) mode there and tell him.
  I will ask him when a testable build exists.
- **Item 2 (reactions): APPROVED** with additions: `by_email` audit column (never on the wire), exact code-point
  allowlist for the six emoji (heart = U+2764 U+FE0F, no normalisation, 422 otherwise), FK IntegrityError ->
  404, in-place patch of the reactions element with a test that a playing `<audio>` keeps identity and
  `currentTime`. Reuses `message_updated`; no push; invariant 49.
- **Item 3 (voice-note transcription): BLOCKED on a cmd-side no-retain mode.** The Architect read cmd's code:
  `POST /api/transcribe` ALWAYS saves audio + transcript to `dictation-audio/` (last 50) and the ASR shadow pass
  appends full text to `asr-shadow.jsonl`, which would break Inv 40/46 (chat data only in `server/`, delete/wipe
  erase everything). Ruling: wixy may depend on cmd ONLY via a new `private=1` mode (no debug save, no text in any
  log, `X-Voice-Private: 1` honoured by `asr_server.py`, bytes in memory only) plus a truthful capability probe
  `GET /api/transcribe/capabilities -> {"private": true}`; wixy calls with `private=1&cleanup=0`, no session_id,
  no context, only after the probe says true (cached 60 s); otherwise button hidden and route 503. wixy side:
  ASYNC route (202 + stream; Cloudflare cuts at 100 s), `attachment_transcripts` table with ON DELETE CASCADE,
  single-flight, 6/min/identity, cmd timeout 60 s + 0.5 x duration, stale `pending` -> `failed` at startup,
  privacy/cost note as its own decisions/ entry. The wixy side is built now against a FAKE cmd and is safe to merge
  early (dormant until the probe says true). **The cmd-side task is spawned as its own cmd workspace chat:
  session `cf8f437c-5d10-4dfb-8dc2-8b0e3ecf8abf` (project cmd, claude-sonnet-5/xhigh, brief in
  the Orchestrator's scratchpad; it must run the Opus audit before merging).** Item 3 is done only when that is
  deployed AND one real private transcription is verified end to end with nothing new under `dictation-audio/`
  or in `asr-shadow.jsonl`.
- **Item 4 (permanent unlock):** the builder (`41f2ad09`) builds `03-permanent-unlock.md` (with sec.8); it is new
  auth surface and MUST pass the Opus audit before merge.
- **Builders this round:** 0a598e4b (item 3), 2fad2e1e (item 2), 41f2ad09 (item 4); DM `b584352d`; Architect
  `96bd8091`. Delivery record seq 3 (`3c81c9f1`), 6 tasks. Next decision number 00160+.
