
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
