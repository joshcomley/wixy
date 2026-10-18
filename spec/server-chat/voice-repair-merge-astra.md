# Voice repairs: Astra all-proposal MERGE recommendation

2026-10-18. One bounded comparison pass; no implementation edits or new test runs.
I read both complete actual artifacts, including Opus's source and test appendices:
[Astra proposal](voice-repair-proposal-astra.md) and
[Opus proposal](voice-repair-proposal-opus.md), against the
[merge brief](voice-repair-round1-merge-brief.md). My proposal has no priority.

Implementation reviewed remains `4829f606fcfbf53f05f1dc955bce35abb4ce3695`, base
`7a952c6cc590e5acf67996c1a7cbcc1b474a7ddc`. At comparison HEAD
`bfd77f55ffede08d4a39dede9d97388725b59a4f`, the diff from that implementation contains
only audit/proposal/brief/task documents. I also reread the current route, broker
transition code and CallAudio resource owner. This report is my only new checkout
file. It recommends a repair; it does not approve an integrated candidate.

**Recommendation:** take Opus's actual-future completion ownership and deferred
overflow eviction; adapt worker capacity into separate admission/refresh quotas.
Take both proposals' capture provenance and correlated invitation ownership. Use
render-quantum acknowledgements, bounded control snapshots and local freshness
checks, rather than treating a port acknowledgement as proof of rendering.
Neither submitted proposal is ready to integrate verbatim.

## Evidence provenance

**MEASURED-KNOWING, retained:** my earlier audit/proposal component probes: orphaned
native grant work, stale capture relabelling, overflow transitions and four glare
orders. Exact outcomes and scratch commands are in the Astra proposal. They are
not measurements of this combined recommendation. No MEASURED-BLIND claim is made.

**CITED, not rerun:** Opus reports independent red/green route cancellation tests,
overflow cases including a surviving callee, capture/control component tests,
340 selected Python tests, 1,223 selected frontend tests, strict checks and a build.
Those are evidence for Opus's isolated trial, not this merge or the parent checkout.
The source/test appendix lets us assess exactly what each assertion establishes.
Both proposals explicitly leave real-browser integration of the changed graph
protocol unexecuted. The original synthetic duplex evidence cannot fill that gap.

**CITED qualification:** Opus's table says refused routes close 4429, "never 4401".
Its supplied test asserts `4429 in codes`, but does not assert `4401 not in codes`.
Its diff adds only the capacity exception handler; the route still initializes
`close_code = 4401`, and cancellation/internal auth timeout can reach cleanup with
that value. Thus the stronger no-lock claim is unsupported and conflicts with the
supplied code. This is a repair requirement below, not a reason to discard the
executor's valid completion-accounting mechanism.

## H1: actual work owns capacity; operational failure does not revoke credentials

**Take from Opus:** a dedicated bounded `ThreadPoolExecutor`, admission before
`submit`, and release in the concurrent future's done callback. This gives an
explicit distinction between a queued job successfully cancelled before execution
and a running job whose awaiter disappeared. Both release exactly once, only when
the future is terminal. `asyncio.wrap_future` cancellation cannot free the permit
of an already-running synchronous invocation. Submission failure releases the
reserved permit synchronously. Retain the narrow offloader injection in
`validate_server_token`; HTTP callers retain their existing behavior.

**Adapt with Astra's separation:** use one executor with 12 workers, but independently
bounded counters: admission work <=4, periodic refresh work <=8, total submitted
unfinished jobs <=12. There is no additional waiting request queue. Pass the class
of work through a small internal argument or two narrow methods. JWT verification
and initial grant checks use admission capacity; established connections use refresh
capacity. A running orphan retains its category's slot. Serial JWT and initial grant
checks on one route do not consume simultaneous admission permits.

This preserves the intended 4/8 workload separation while making the true native
work bound explicit. Opus's shared pool permits up to 12 abandoned *admission* jobs
and lets them block every established refresh. That is bounded, but is a nominal
admission-work change from four and unnecessary cross-class starvation. Counters for
pending sockets and admitted sockets still have their existing separate purpose.
This does not promise fairness within a class or availability during a hung database.

**Reject Astra's retained AnyIO task implementation as the selected owner.** Its
worker-finally release handles started work, and shield protects against route
cancellation, but a private task cancelled before reaching `invoke` retains a slot
without a worker to release it. It also needs application task retention/drain
machinery. A concurrent future represents pre-start cancellation directly. This
choice is about ownership coverage, not which author supplied more green tests.

**Integration details:** put the executor/counters on the existing broker as Opus
does, or one private owner immediately beside it; no service or global registry.
Protect closed/counter checks and updates with the same small lock. Do not hold that
lock across executor shutdown: cancellation can invoke completion callbacks inline.
Broker shutdown atomically closes admission, ends peers, and calls
`shutdown(wait=False, cancel_futures=True)`. Running futures remain counted until
completion; callbacks must safely run after the event loop has closed. Prevent
duplicate release and consume exceptions without logging callable inputs or tokens.
Bound Access verification waiting as well as the existing five-second first-frame/
grant wait; Astra's proposed ten-second Access wait is a reasonable explicit limit.

**Required repair beyond both proposals:** make termination cause explicit enough
to separate invalid credentials from unavailable verification. Do not leave the
accepted route's default as 4401. Map capacity and verification/renewal timeout to
an operational close such as 4429; map native cancellation/shutdown to a non-auth
termination and re-raise cancellation after bounded cleanup. Pre-upgrade failures
still deny upgrade. Use 4401 only for actual credential failure, absolute credential
expiry, or a completed lookup establishing revocation. Protocol rejection remains
separate. In particular, `grant_until` expiring because renewal did not complete is
a fail-closed permission lease expiry, not evidence that the owner's grant was
revoked: end audio, but do not make the browser execute `lockNow("unauthorized")`.
Absolute Access/unlock expiry must still lock even during mute/silence.

**Exact acceptance:** exercise real route workers with event-blocked JWT, initial
grant and refresh callables. Repeatedly cancel routes, trigger the actual internal
auth timeout, and disconnect established peers while refresh is running. Observe
live/queued native jobs and category counters, not only route counters. Assert the
4/8/12 bounds, no replacement work for occupied slots, and release only on actual
completion. Force a future to remain pre-start, cancel it, and assert one release
and zero invocation. Close during submit/completion; assert no admission after close,
no deadlock and no counter underflow. For operational failures explicitly assert
`4401 not in codes` and no client unauthorized-lock callback. Separately assert
invalid token, completed revoked-grant result and finite absolute expiry do lock.
Test stopped/expired refresh both muted and audible. Existing peer/media teardown
must complete promptly while a worker remains blocked.

**Remaining limit:** executor threads are non-daemon and cannot be killed by coroutine
cancellation. An indefinitely blocked native call can delay process exit beyond
Uvicorn's two-second grace. A small async drain does not prove process termination.
Library I/O timeouts and the actual Slots hard-stop/drain behavior must be measured;
do not invent a guarantee from `wait=False`. The combined quotas and terminal-cause
mapping have no executed integration green yet.

## M2: defer overflow eviction until the outer synchronous transition exits

**Take Opus's transition boundary and drop my preferred pair helper.** Overflow marks
the peer closed, clears its controls, wakes its writer, and queues one eviction.
It does not unlink membership midway through the enclosing command. At outermost
exit drain evictions, using the existing finish/cleanup behavior to remove stale
call-scoped controls before any route can yield to a writer. This covers invite,
accept, second-ready, presence, tick and shutdown as one rule. Ordinary explicit
remove/finish retain their intentional semantics; the invariant is about overflow
not unexpectedly removing membership inline.

**Why reject Astra's helper as the complete solution:** its identity checks prevent
late paired emits and are small, but do not govern every emitter. In current
`presence`, `busy` is computed before an emit can recursively remove a participant
and finish the call. The outer loop can then append a stale availability snapshot
after nested cleanup published a newer one. Guarding three paired emissions alone
does not settle this wider transition-order issue. Opus's boundary makes overflow
cleanup final before returning to the event loop. Do not combine both approaches
without evidence that a second ownership mechanism is necessary.

**Adapt Opus's code:** ensure depth is decremented in a nested `finally` even if
eviction draining raises. Do not swallow that exception. Keep `drop` private; every
public mutation that can emit belongs to the transition discipline. `peer.closed`
prevents duplicate eviction entries, so with <=8 admitted peers the eviction deque
is bounded by eight, not a new unbounded work queue. No awaits inside transitions.
Document this actual invariant in Inv 55. Treat a peer closed during `add` as
unavailable; do not interpret a successful insertion alone as continuing permission.

**Exact acceptance:** invite, accept and second-ready with queue occupancies
(16,14), (16,0), (0,16), plus near-capacity surviving-peer cases. Assert no exception,
no stale incoming/prepare/connected/capture after end, pair cleared exactly once,
and each survivor receives end or is closed if its control queue cannot hold it.
Overflow presence with a third peer and assert the last surviving presence snapshot
describes current membership/availability. Cascade overflow during finish/shutdown;
assert empty eviction deque, depth zero, all removed peers closed, no media/leases
remaining. Preserve invalid-command exceptions after draining. These extend Opus's
**CITED** tests; his proposal does not supply the complete invite/presence-snapshot
matrix. No lock around the event loop and no caught `KeyError` workaround.

## M1: bind capture provenance at production and never relabel it

**Take the common mechanism**, including Opus's actual partial-frame and recycle
test examples: latch capture lease, mute revision and production time when the
first sample enters a frame; carry them with the transferable PCM. A newer lease
cannot relabel that frame, even halfway through filling it. The controller encodes
that bound lease unchanged; the broker retains its existing issuance/expiry check.
For the reported 20/250/450 ms interleaving, the wire must retain lease 1, which is
expired at broker receipt. Receipt-time tagging is rejected in both proposals.

**Adapt the implementations:** retain Astra's explicit per-attempt generation and
per-mute revision plus finite/integer/length validation. Keep Opus's distinction
between capture-lease receipt expiry and playout-state expiry, carried in the same
snapshot, so a fresh playout pulse cannot continually extend a stale capture grant.
Capture provenance stays immutable across partial frames and port/network delay.
On mute/revision changes reset partial capture and interpolation/filter history;
disable the real track immediately. The receiver never changes frame capture tags.

Use a first-sample timestamp that includes its position within a render block, or
a conservative block-start timestamp; either must never make old audio appear
younger. Retain the server lease check as the cross-clock authority. Local timestamp
checking is an additional rejection rule, not synchronized-clock proof. Do not
repeat Opus's loosely stated "lease +20 ms" as a freshness allowance: a partial
frame keeps the older lease and must meet that lease's actual expiry.

Return every valid owned 960-byte buffer to the same live node in a `finally`,
including age/mute rejection. Do not import an old node's buffers into a new
generation; after terminal node closure, discard them. Preserve five capture
buffers, the 4,800-sample playout ring, sample deadlines, credits and sequence rules.

**Exact acceptance:** drive the actual worklet through half a frame on lease 1,
then lease 2, delayed port delivery, controller encoding and broker receipt at
450 ms. Assert original lease, stale drop and no audible catch-up. Test 44.1/48 kHz,
variable render blocks, >300 ms port delay, rapid mute/unmute, a partial frame across
mute, old-call callbacks and pool exhaustion/recycling. Assert all owned buffers
are eventually recycled or disposed, never silently lost while the graph stays live.
The proposals' component evidence is **CITED** for Opus and retained
**MEASURED-KNOWING** for Astra; neither is this cross-layer integrated green.

## M4: one coalesced state in flight, acknowledged by rendering

**Take both proposals' one-flight coalescing**, including mute/enabled, capture and
playout state in the same snapshot. Take Astra's acknowledgement from `process()`;
reject Opus's port-handler acknowledgement as sufficient render evidence. The
Opus appendix acknowledges on receipt without any `process()` invocation. Its
tests exercise a missing port ack, not a port that works while rendering stalls.
An apparently running context and healthy WebSocket do not fill that proof gap.

**Selected integration:** main-thread pulses at the existing 100 ms cadence post
at most one unacknowledged snapshot. The worklet stores one pending snapshot; at
the start of an actual render quantum it applies it and acknowledges its control
id and attempt generation. Main thread validates both wall-clock ack age and the
remaining audio-clock deadline. Only a timely render ack authorizes the next
receiver lease sent to the server. Associate that receiver lease with the original
local deadline; never mint a fresh local 300 ms window when an old ack arrives.
There is no unconditional receiver-lease emission from socket/pulse progress alone.

Keep desired state coalesced while waiting, including every mute toggle. Use the
next scheduled pulse after ack rather than an unrestricted ack-driven resend loop;
do not increase the intended ten receiver leases per second. A timed-out flight
fails locally at the first available pulse at/after 300 ms. Delayed acks also check
age before acceptance, even if the timeout pulse has not run. Main-thread stalls
keep the existing independent pulse-gap fail-closed check. Silence/mute still
renders output quanta and must satisfy this same handshake.

Immediate stop closes tracks, graph, port and context without waiting for any ack;
at most one in-flight state plus one terminal stop is allowed. Late ack/capture/
permission/addModule/resume cannot revive that attempt. Preserve the finite buffer/
play credit paths instead of building another heartbeat, worker or shared-memory
transport. Acquire call idle suspension before dispatching a graph action that can
fail synchronously; teardown must release it exactly once.

**Exact discriminator:** keep main timers and `AudioContext.state === "running"`,
service incoming port state, but invoke no render quantum while muted. Assert no
render ack, no receiver lease renewal, <=1 state in flight, and local end on the
first deadline pulse (cadence can make observed end just under 400 ms after send).
Then call one quantum and prove exactly one timely ack, not two. Delay an ack beyond
300 ms; it must fail even when received before the next timeout pulse. Exercise
10,000 lease/mute changes, coalescing to the newest desired state, stale-generation
acks, stop and fresh call. The deadline itself and worklet silence remain 300 ms;
the scheduling allowance is not extra audio freshness. This combined render-ack
path is unexecuted and must pass real Chromium duplex integration after unit tests.

## M3: outgoing-request ownership must not erase the winning incoming reservation

**Take the common correlated refusal** and early retirement of the losing outgoing
activation graph. Track its request id separately from `callId`. Incoming glare
invalidates/stops only that outgoing attempt, releases its mic reservation and keeps
the incoming invitation visible. Keep the losing request id until its matching
refusal, but do not let that refusal stop any graph once a call reservation exists.
Answer is still an explicit new gesture, not implied consent from the earlier Call.

**Adapt with Astra's outgoing-success correlation:** echo requestId in both outgoing
success and unavailable, and require the pending id before adopting an outgoing
success. Take Opus's defensive cleanup before replacing an existing activation
graph, with epoch invalidation before stopping it so stale callbacks have no authority
over the new graph. Clear the stopped reference before constructing its replacement.
Make repeated Answer while the same acceptance is pending harmless; do not repeatedly
replace a graph still referenced by an asynchronous prepare. Preserve the existing
pending-Cancel socket disconnect and no-auto-resume behavior.

**Reject** any blanket unavailable teardown, accepting an incoming call automatically,
or deferring loser-graph cleanup until refusal: that cleanup could target the newer
Answer graph. No request history registry is needed beyond the existing deduplication
and one pending outgoing id. Update server envelope docs and client test fixtures.

**Exact acceptance:** integrated broker/controller tests for incoming/busy,
busy/incoming (defensive reordered delivery), Answer/late-busy, Decline/late-busy,
and pending Cancel, with A and B exchanged. Record real request ids from sent invites.
Use distinct graph objects for outgoing and Answer: assert only the loser closes,
no mic preparation before both consent, and late controls cannot revive declined/
cancelled calls. Reject wrong/old request ids without changing the winning call.
Include repeated Answer and delayed prepare completions. Component symmetry is not
an executed opposite-endpoint integration test.

## Convergence, remaining splits and acceptance boundary

This is one coherent mechanism recommendation, not a claim that Opus has accepted
my merge. Both proposals agree on the five root causes and the central safety
properties. The selected departures and their discriminators are:

| Choice still requiring integration proof | Recommendation | Deciding evidence |
|---|---|---|
| Work owner and quota policy | Concurrent futures; separate 4 admission/8 refresh, one 12-worker executor | Native/pre-start/timeout/refresh cancellation and shutdown matrix; count actual jobs |
| Overflow boundary | Opus deferred eviction, hardened depth cleanup | Invite/accept/ready plus final presence snapshot and cascade matrix |
| Render evidence | Ack from actual quantum; only then renew receiver lease | Port serviced with no rendering while muted |
| Request success correlation | Echo/check requestId for success as well as refusal | Late success/refusal after cancellation or newer Answer |

The quota and terminal-cause adaptations, render-ack integration and combined
capture path have **no integrated green measurement**. Reuse existing valid tests
and aim new tests at these changed mechanisms; do not rerun a blanket suite to
manufacture confidence. Update `routes_livechat_calls.py`, `call_broker.py`, the
token-helper injection, existing call audio/controller/worklet interfaces and their
focused tests. Update contracts, Inv 55 and livechat documentation; regenerate LF
bundles after strict checks. The app still owns one broker lifetime; main entry and
e2e fixture still share `SERVER_OPTIONS`. No schema, persistence, diagnostic token/
audio logging, service, product-facing checker or new transport is warranted.

Keep third same-login/same-token browser negative controls alongside the legitimate
same-login pair: it cannot answer, end, replace, receive an invitation or receive
PCM. Keep both-ready-before-media, voice-note mic exclusion, revocation and absolute
expiry while muted, all actual lock/shield/detach/pagehide/dispose/token teardown,
and fresh idle countdown after call end without modifying tab/screen preferences.
Keep the deliberately documented control bucket 80/s burst100; these changes must
not generate an ack/lease feedback loop that needs another increase. One process only.

After focused integration and strict/build checks, rerun the real two-browser
Chromium fake-mic duplex/stall/muted-idle/panic scenario on the new candidate. Freeze
its exact SHA for a **new reviewer**. My previous C0/H1/M4/L0 changes-required audit
is not cleared by proposal selection or by peers' isolated trial greens.

Physical Android Chrome + iPad Safari remains the first live pair. The actual iPhone
and its still-unconfirmed browser remain separate acceptance. Synchronous gesture
activation, late permission/resume behavior, device suspension/pagehide, production
hostname/Cloudflare tunnel, 15-minute speakerphone/latency/loss behavior and actual
Slots drain remain open. No mobile background-call promise and no launch approval.
