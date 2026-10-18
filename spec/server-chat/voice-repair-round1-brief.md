# Voice calls — independent repair proposals, round 1

Candidate implementation: `4829f606fcfbf53f05f1dc955bce35abb4ce3695`.
Read `voice-call-implementation-audit.md`, `04-voice-calls.md` and the actual source.
No PR or delivery yet. This is Group Therapy PROPOSE, not implementation or approval.

Every reviewer independently proposes a repair for ALL five findings:

1. H1: native asyncio cancellation releases route/AnyIO accounting while real
   grant/verifier threads still run. Bound actual work independently of awaiters,
   including initial auth, refresh, repeated cancellations and shutdown.
2. M1: capture MessagePort buffers acquire a newer server lease on main-thread
   receipt. Bind immutable sample/lease/generation metadata at sample production;
   do not relabel queued capture. Preserve pool recycling and playout freshness.
3. M2: overflow recursively removes peers/call while accept/ready continues paired
   lookups, raising KeyError. Make transitions/reentrancy safe; no swallowing errors.
4. M3: uncorrelated busy replies erase a winning incoming invitation during glare.
   Preserve incoming call ownership and explicit answer while ending only the losing
   outgoing attempt. Cover both orderings, late replies and cancellation.
5. M4: lease controls accumulate without worklet acknowledgement/liveness bounds,
   particularly while muted. Bound/coalesce controls and fail stale graphs, including
   enabled/stop traffic, preserving capture and media credits.

The brief is not evidence: reject a misdiagnosed issue with a concrete demonstration.
For EACH issue give exact files and actual repair code/diff, a red-first discriminator
and measured red/green outcomes (label unexecuted green honestly), limits, and a layer
check explaining whether any new artifact is necessary. Prefer repairing existing
state/ownership boundaries to stacking wrappers. State which own item you would drop
first for something better, which you defend hardest, and why. No coordination and
do not read another proposal until the parent starts MERGE. No subagents.

User privacy requirement: the live call belongs only to the explicitly consenting
browser pair. A third iPad/browser with the same login must receive no call audio,
incoming call prompt or automatic participation. Existing ordinary messaging is shared
with any other unlocked chat; do not claim that the entire chat never syncs. Target
devices: Android Chrome, iPad Safari, later actual iPhone browser (unconfirmed).
Connected/muted calls pause only idle lock; actual lock/shield/detach still ends audio.
No recordings/transcripts/storage. Keep real phone/tunnel/quality gates open.

Use only your named proposal path given by the parent. The two new family reviewers
have isolated managed workspaces: fetch/check out the published feature candidate
there for experiments if needed. Never edit or mount the parent's source worktree.
The original auditor may run in-memory/scratch probes but must not edit implementation
in the parent's checkout. Proposal markdown is the only allowed parent source addition.

After proposals, every reviewer will receive all proposal paths for MERGE with equal
standing. Fresh reviewers, not the proposers, will audit the integrated result.
