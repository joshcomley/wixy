# Round 2 — all-proposal MERGE

YOUR OWN PROPOSAL HAS NO PRIVILEGE IN PHASE 2.

Read BOTH complete artifacts, regardless of authorship:

- Parent workspace 48: `spec/server-chat/voice-repair-round2-proposal-astra.md`.
- Sibling workspace 50:
  `D:/Servers/Cmd/Storage/clones/wixy__worktrees/00050__wixy_group-therapy-propose-reviewer-gemini-fo/spec/server-chat/voice-repair-round2-proposal-gemini.md`.

Parent root is
`D:/Servers/Cmd/Storage/clones/wixy__worktrees/00048__wixy_implement-voip-voice-over-ip-for-wixy-ch`.
The current source remains 4983cc6, with report/brief/task records added only.

Produce ONE best combined repair for ALL five audit issues. State which mechanism
you select per issue, what you change, what you reject and why, and remaining
integration discriminators. Do not merely repeat your own proposal. Every
measurement claim must be MEASURED-BLIND / MEASURED-KNOWING / CITED; a peer's
green is not a rerun. Existing component evidence is sufficient where honest;
no blanket testing or additional research round is requested.

Resolve these concrete splits/gaps:

1. M1: always correlate caller terminal versus correlate only when outgoing is
   still queued. An old test's exact dict equality is not a product compatibility
   requirement. Cover a writer that has dequeued outgoing but not completed send,
   early decline/overflow, wrong request, and newer incoming/accepted call safety.
2. M2: shared cached-pair gate versus duplicated checks; finish versus remove
   expired endpoint. Preserve operational 4408 versus real revocation/expiry4401,
   cancellation1001/capacity4429. Check source rather than assume monitor cadence
   or an assert_invariants hook. No native work per frame.
3. M3: owner-validated panel recovery versus independent controller recovery.
   Test whether controller can open presence before panel lock/expiry/hidden
   policy, including both listener orders and pageshow-before-visible. Actual
   lock/dispose prevents recovery. Consider whole-chat attach side effects
   (draft/SSE/media refresh) versus a narrow owned presence seam; prefer the
   smallest change whose authority and integration are actually covered.
4. L1/L2: immediate reservation release on constructor failure and microphone
   state transitions. Both proposals leave a possible disabled Reconnect button
   when recording stops after socket disconnect because the pulse is gone;
   state whether to avoid gating reconnection or use an existing ownership
   notification seam. Do not add redundant timers or a broad new API casually.
5. Optional queue coalescing: assess Astra's bounded replacement of stale
   presence snapshots versus merely avoiding duplicate broadcasts. Keep genuine
   16-nonreplaceable-control overflow behavior. Do not enlarge the queue.

Write Astra output `voice-repair-round2-merge-astra.md` in parent spec/server-chat;
Gemini output `voice-repair-round2-merge-gemini.md` in its own spec/server-chat.
No parent implementation edits, child agents, commits, pushes, PRs or merges.
Any new trial edits stay only in the reviewer's own isolated checkout and must
be reverted without disturbing unrelated work. Report via peer within 15 minutes
or identify a concrete blocker. Parent owns ruling, implementation, focused
local red/greens, a fresh review and real-device/tunnel/quality/Slots gates.
