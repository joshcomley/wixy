# Voice repairs round 2 — parent ruling

Both complete independent proposals and both all-proposal MERGE reports were
read. The five required repair mechanisms converge across Astra and Gemini;
that agreement is design evidence, not an integrated test result. Parent owns
implementation and fresh verification. Baseline is 4983cc6, audit C0/H0/M3/L2.

- M1: required bounded request_id on Call; every caller ended carries requestId.
  Client retires only that pending request, preserving any newer adopted call.
  Keep action-time pending guard and epoch-control purging. Update literal caller
  envelope tests rather than condition correlation on writer queue occupancy.
- M2: one synchronous cached-pair/lifetime helper at admission and dequeue.
  Remove ineligible endpoints immediately; lifetime-only expiry ends the call
  while retaining authorized presence. No native work per frame. Route final
  classification retains4401 for real expiry/revocation,4408 for refresh failure,
 1001 cancellation and4429 capacity. Both review reports support this composition.
- M3: panel owns persisted-page restore after existing hidden/shield/idle/expiry
  policy. Controller keeps unconditional pagehide detach and cannot auto-open.
  Existing chatView.attach refreshes thread/SSE and fresh call presence; no audio
  or consent returns. If actual integration loses drafts/staged work or repeats
  refresh, switch to a narrow panel-authorized presence seam before freezing.
- L1: constructor failure uses end(), declining an incoming reservation while
  emitting no fabricated action before an outgoing invite.
- L2: microphone state gates starting calls only, not presence reconnection.
  Existing pulse renders ownership changes. Adopt Astra MERGE's additional
  final render after socket=null/timer cleanup, verified by parent red tests.
- Companion C1: select Gemini's source-level suppression of redundant presence
  in _drop and doomed Invite. Astra's replaceable snapshot coalescing is valid
  in principle; its failing legacy full-queue assertion alone is not proof of
  a defect. Select narrower deduplication because it resolves the reproduced
  14-ping survivor trace with measured coverage and less queue-contract change.
  Keep16-nonreplaceable overflow. No requirement to coalesce all old snapshots.

Gemini MERGE component runs are MEASURED-KNOWING, cited by parent; Astra MERGE
combination is explicitly UNEXECUTED. Parent's own pre-fix regressions reproduced
terminal/media/UI/cache defects and real Chromium hidden call bar after injected
persisted lifecycle. These are not physical BFCache or mobile acceptance.
Parent now proves the actual integrated code, strict checks and LF bundles,
then obtains a fresh independent audit. No PR/merge/launch approval exists.
Physical Android/iPad/iPhone, production Access/tunnel, sustained audio quality
and actual Slots hard-stop remain open. Parent retains confirmed merge-SHA duty.

Parent integration discriminator additionally reproduced a missing-hidden-event
case: persisted pagehide then pageshow with default lock policy reattached the
chat instead of locking. On persisted pagehide, run the existing onHidden policy;
one hiddenTransitionHandled flag deduplicates its following visibility event
until onVisible resets it. No controller auto-open or copied policy is added.
The new test failed before and passed after; all274 affected panel/grant/call
tests pass, including existing shield and renewal cases. Fresh audit must inspect
this composition, delayed/missing notifications and shield re-hide ordering.
