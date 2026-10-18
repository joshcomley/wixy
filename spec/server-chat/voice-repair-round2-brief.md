# Voice repairs round 2 — independent PROPOSE

Source: `4983cc662730f1a18bd95a5337d9c1a1fc45cb1b` in workspace 48.
Read `voice-call-implementation-audit-round2.md` in this directory and current
`04-voice-calls.md`, contracts and Inv 55. The audit is evidence to examine, not
an unquestionable diagnosis. Scope is all five findings together:

1. M1: terminal purge removes an unsent outgoing; caller never learns call ID,
   so its pending request and empty graph remain stuck. Cover overflow and early
   decline, with actual broker controls consumed by the controller. Preserve
   glare ownership and avoid terminating a newer incoming/accepted call.
2. M2: media admission and dequeue must enforce both members' cached authority
   and connected lifetime, without relying on a prior tick or doing per-frame
   native verification. Cover sender/receiver expiry, confirmed revocation,
   operational refresh failure and call lifetime; preserve close classification.
3. M3: cached-page restoration must restore only presence for a still-valid,
   unlocked owner, after hidden/expiry policy. Actual lock/dispose must prevent
   restoration; no call, graph, microphone or idle suspension may resume.
4. L1: synchronous audio construction failure on Answer must release server
   ringing reservation immediately. Caller failure before invite sends no fake
   call action.
5. L2: Call must visibly disable while a voice note owns the microphone, then
   become usable again without needing a presence update; keep handler guard.

Each reviewer independently proposes a fix to EVERY issue. Do not coordinate or
read other proposals before MERGE. Write the exact code/file changes and focused
RED-before/GREEN-after discriminators, honest coverage limits, layer checks and
the item you would drop first/defend hardest. A rejected diagnosis is legitimate
if measured and argued. Label unexecuted integration checks honestly.

Only trial implementation edits in your OWN isolated checkout. The parent
checkout must not receive source edits from reviewers. For a reviewer resident
in the parent, use in-memory execution for trial changes, or give exact patch
and mark any unexecuted green plainly. Do not create branches/workspaces, child
agents, commits, pushes, PRs or merges. No full CI or blanket suites. Reset only
your own trial source edits before finishing; preserve the proposal artifact.

Outputs: Astra `voice-repair-round2-proposal-astra.md` in parent spec/server-chat;
Gemini `voice-repair-round2-proposal-gemini.md` in its own workspace 50 there.
Report result via peer to parent session `584ebce2-4cdf-4fa7-9125-fa0f2f631216`.
Report within 15 minutes or explain a concrete blocker; parent owns next step.

After BOTH proposals, parent sends ALL artifacts to EACH reviewer for MERGE.
YOUR OWN PROPOSAL HAS NO PRIVILEGE IN PHASE 2. Each merge must distinguish
MEASURED-BLIND / MEASURED-KNOWING / CITED evidence. Parent rules convergence,
implements locally, freezes a proven candidate and obtains a fresh review.

Proceed-anyway rule: after two demonstrated infrastructure failures for a seat,
parent may rule transparently on available evidence, explicitly qualifying the
missing family/coverage. Never infer failure merely from quietness. Physical
Android/iPad/iPhone, production tunnel, sustained quality and actual Slots
hard-stop remain open; no launch or delivery approval follows from proposals.
