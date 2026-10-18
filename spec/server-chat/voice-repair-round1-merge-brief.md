# Voice repair round 1 — MERGE instructions (only on parent's explicit start)

Read every complete proposal at the exact paths the parent supplies. Do not begin
this phase while still writing an independent proposal.

**YOUR OWN PROPOSAL HAS NO PRIVILEGE IN PHASE 2.**

Merge the strongest mechanisms from ALL proposals for H1 and M1–M4 into one coherent
repair. Per finding state what you took, adapted and rejected, and why. A reprint of
your own proposal without evaluating alternatives is not convergence. Refusing a
misdiagnosed issue with evidence remains legitimate. No voting/majority shortcut.

Every measured claim must be labeled **MEASURED-BLIND**, **MEASURED-KNOWING** or
**CITED**. Knowing a peer's expected result and then executing its test is measured
knowing; adopting its report/code without running it is cited. Keep component greens,
integrated greens and actual-device proof separate. Reuse valid unchanged evidence;
run aimed discriminators for changed mechanisms, not another blanket suite.

Compare these uncovered choices explicitly, rather than selecting by authorship:

- Actual synchronous completion must own capacity even under native cancellation,
  pre-start cancellation, internal auth timeout, refresh cancellation and shutdown.
  Compare private retained AnyIO jobs with fixed executor futures. Evaluate separate
  admission/refresh capacity versus a shared cap, and document any nominal bound
  changes. Busy/timeouts/capacity are not proof that the owner is unauthorized:
  preserve fail-closed audio while avoiding a spurious 4401 lock. Running blocked
  native work cannot be killed by cancelling a coroutine; name the shutdown limit.
- Overflow must not invalidate an enclosing ownership transition and then let it
  emit stale prepare/connected. Compare explicit pair/epoch checks with deferred
  eviction at the outer transition boundary. Cover invite, accept, second-ready,
  presence and shutdown; swallowing KeyError is not a repair.
- Capture provenance must be assigned at production and stay immutable across a
  partial frame, delayed MessagePort delivery, newer leases and network delay.
  Handle mute generations, call generations and storage recycling without either
  relabelling old samples or leaking the capture pool.
- Bound all graph controls, including enabled/mute and leases, to one/fixed-small
  in-flight slot, coalescing desired state. Distinguish an acknowledgement that only
  consumes a port message from one proving a render quantum actually happened.
  A graph that stops rendering while its context/main thread appear running must
  not stay apparently connected forever while muted. Preserve fast local teardown.
- Crossing invites need correlated request ownership and explicit Answer consent.
  Cover incoming/busy, busy/incoming, Answer/late-busy, Decline/late-busy, opposite
  endpoint roles and cancellation. Closing only the losing graph must never close
  a newer Answer graph or lose the winning reservation.

Propose actual integration changes and exact acceptance tests. State convergence
on mechanisms, not identical wording, and any remaining split/limit with a concrete
discriminator. Precommit tradeoffs from phase 1 are useful evidence, not binding votes.
Keep the layer check: justify necessary ownership machinery, avoid product-level
checker/registry/service layers. Keep third same-login browser negative controls.

Only the parent integrates source and owns delivery. Trial changes, if necessary,
stay in your isolated checkout; the Astra finder may only add its named merge report
to the parent checkout. No commits/push/PR/agents. Output only your named merge path,
then peer the parent. A NEW reviewer audits the integrated, locally proven candidate.
Physical Android/iPad/iPhone, tunnel, quality and Slots acceptance remain open.
