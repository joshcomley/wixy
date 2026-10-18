# Narrow permission lifecycle — ALL-proposal MERGE

YOUR OWN PROPOSAL HAS NO PRIVILEGE IN PHASE 2.

Read BOTH complete proposals:

- Parent workspace48 `spec/server-chat/voice-permission-proposal-astra.md`.
- `D:/Servers/Cmd/Storage/clones/wixy__worktrees/00050__wixy_group-therapy-propose-reviewer-gemini-fo/spec/server-chat/voice-permission-proposal-gemini.md`.

Parent root:
`D:/Servers/Cmd/Storage/clones/wixy__worktrees/00048__wixy_implement-voip-voice-over-ip-for-wixy-ch`.
One issue only; no whole implementation review, new workers or blanket tests.

Select ONE combined exact smallest repair, indicating adopted/rejected changes
and why. Resolve immediate release-time policy versus return-time policy:

- Gemini release hook gives the same default-lock timing as controller-first
  pagehide, but re-enters controller teardown. Check actual ordering/idempotence,
  not just its no-recursion assertion. Does a genuine exemption released long
  after the original hide reset screen-lock causal timestamps incorrectly?
- Astra tri-state preserves original hide evidence and gates recheck before any
  new presence, but leaves logical lock deferred until visible return. State
  whether that delay is required or whether immediate safe completion is better.
- Can the existing restorePresencePending marker safely gate the cached-policy
  recheck instead of adding pageHidePendingHidden? Assess exact lifetime: set on
  eligible persisted pagehide, cleared on lock/dispose and consumed on restore.
  Do not conflate a temporarily exempt hide with a completed policy decision.
- Preserve genuine exemptions still held at return, ordinary non-cache chooser
  returns, ignore mode, shield re-hide/causal evidence, renewal and unload.
  Handle absent hidden notification and both pagehide listener orders.

Evidence labels mandatory: MEASURED-BLIND / MEASURED-KNOWING / CITED; newly
composed greens must be measured or plainly UNEXECUTED. Parent four-cell RED and
four exemption controls exist in panel.test.ts. Select coverage, not test counts.
No source edits in parent; own isolated/in-memory trials only if necessary.

Bounded3-minute MERGE: exact code + risks/discriminators is enough. Astra writes
parent `spec/server-chat/voice-permission-merge-astra.md`; Gemini writes own
workspace50 `spec/server-chat/voice-permission-merge-gemini.md`. Peer parent when
ready or name concrete blocker. Parent rules and implements/proves immediately.
No PR/merge/launch approval; live acceptance and confirmed delivery SHA stay open.
