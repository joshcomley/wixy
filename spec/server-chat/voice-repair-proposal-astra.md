# Astra — independent voice repair proposal, round 1

PROPOSE only; not implementation, convergence or approval. I authored the accepted
audit and have not read another repair proposal. No subagents were used.

Implementation baseline: `4829f606fcfbf53f05f1dc955bce35abb4ce3695`. The parent checkout
now has HEAD `74c95784f356f09cc2ef183f873e4b9f0967a118`; its changes since the baseline
are the audit, this round's brief and task notes, not implementation changes.
This proposal is my only parent-checkout addition. Experiments were in-memory or
temporary files outside the repository. All five diagnoses survive my examination.

## Evidence and precommitment

All original reds below are **MEASURED-KNOWING**: my audit probes were designed to
exercise suspected defects. Proposal greens are also MEASURED-KNOWING, not blind
independent replication. No other reviewer's measurements are cited.

| Issue | Executed red on baseline | Executed proposal evidence | Honest integration status |
|---|---|---|---|
| H1 | 16 blocked grant workers with route counters zero | Proposed work owner holds four slots after repeated caller cancellation, refuses 20 further jobs, retains slots across bounded drain, releases them only on worker return | Owner tested; route/app/token integration below not executed |
| M1 | 20 ms capture delivered at 250 ms gets lease 2; broker forwards it at 450 ms | Original red retained; exact cross-layer repair below supplied | Proposed integrated green **not executed** |
| M2 | Near-full paired queues cause accept `KeyError` | In-memory modified actual broker passes overflowing invite, accept and second-ready, with no stale phase controls | Targeted component green; not full broker/auth suite |
| M3 | Incoming then uncorrelated busy hides Answer without ending server reservation | Compiled modified actual controller passes incoming/busy, busy/incoming, Answer/late-busy, Decline/late-busy | Four component cases green; updated server wire integration not executed |
| M4 | 10,000 lease posts without any consumer acknowledgement | Exact one-flight, render-acknowledged control implementation below | Proposed integrated green **not executed** |

The audit contains the original reproduction steps and source lines. Executable
scratch artifacts, run from this repo root:

```text
python C:/Users/josh/AppData/Local/Temp/wixy-audit-4829f606.py --slow
node C:/Users/josh/AppData/Local/Temp/wixy-audit-4829f606.cjs
python C:/Users/josh/AppData/Local/Temp/wixy-proposal-astra.py
node C:/Users/josh/AppData/Local/Temp/wixy-proposal-astra.cjs
```

I would **drop my particular M2 helper first** if another proposal provides a
smaller, demonstrably safe emission/transition boundary. My requirement is that
invite as well as accept/ready survives reentrant removal, not that this helper wins.
I defend **actual-completion capacity ownership and production-time capture
provenance** hardest. A cancelled awaiter is not a finished worker; a newly received
lease is not evidence that an old captured sample is fresh. Any alternative must
pass those discriminators rather than merely reducing observed queue lengths.

## H1 — keep capacity owned by actual synchronous work

Use the existing AnyIO worker facility, with two application-lifetime owners:
four admission jobs (JWT and initial grant validation) and eight periodic grant
jobs. There is no waiting admission queue. Caller cancellation must not propagate
into the private job; crucially, actual worker return owns slot release even if
the runtime later cancels that private task during loop shutdown.

Add the following in `wixy_server/routes_livechat_calls.py`, alongside the route
workers. It is the code exercised by the owner probe, with its imports:

```python
from collections.abc import Callable


class CallWorkFull(RuntimeError):
    pass


class CallWork:
    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        self.closed = False
        self.jobs: dict[object, asyncio.Task[Any]] = {}

    async def run[T](self, fn: Callable[[], T]) -> T:
        if self.closed or len(self.jobs) >= self.capacity:
            raise CallWorkFull("call work unavailable")
        loop = asyncio.get_running_loop()
        key = object()

        def release() -> None:
            self.jobs.pop(key, None)

        def invoke() -> T:
            try:
                return fn()
            finally:
                try:
                    loop.call_soon_threadsafe(release)
                except RuntimeError:
                    pass  # Loop is gone; this owner cannot admit new work.

        async def owned() -> T:
            try:
                return await anyio.to_thread.run_sync(invoke)
            except asyncio.CancelledError:
                # Routes/drain never cancel this private task. At runtime exit,
                # the synchronous invocation still owns release if it started.
                raise
            except BaseException:
                release()  # Failed to start, or invocation already completed.
                raise

        task = asyncio.create_task(owned())
        self.jobs[key] = task
        task.add_done_callback(self._consume)
        return await asyncio.shield(task)

    @staticmethod
    def _consume(task: asyncio.Task[Any]) -> None:
        if not task.cancelled():
            task.exception()  # Consume without formatting/logging payloads.

    def close(self) -> None:
        self.closed = True

    async def drain(self, timeout: float) -> bool:
        tasks = tuple(self.jobs.values())
        if not tasks:
            return True
        _, pending = await asyncio.wait(tasks, timeout=timeout)
        return not pending and not self.jobs
```

Exact integration changes:

1. In `app.py`, import `CallWork` from the existing calls route module. Create
   `call_admission_work = CallWork(4)` and `call_grant_work = CallWork(8)` inside
   `create_app`, before the lifespan declaration. Assign them to
   `app.state.call_admission_work` and `app.state.call_grant_work`. In lifespan's
   `finally`, immediately after `livechat_call_broker.shutdown()`, use:

   ```python
   call_admission_work.close()
   call_grant_work.close()
   await asyncio.gather(call_admission_work.drain(0.25), call_grant_work.drain(0.25))
   ```

   Add `import asyncio` if absent. A timed-out drain does **not** clear jobs or
   cancel their tasks. Existing client/media cleanup proceeds with admission shut.

2. In `access_identity`, replace its `anyio.to_thread.run_sync` call with:

   ```python
   work: CallWork = ws.app.state.call_admission_work
   async with asyncio.timeout(10):
       claims: dict[str, Any] = await work.run(lambda: verify(token))
   ```

3. In `tokens.py`, add `Awaitable, Callable` from `collections.abc`. Extend only
   the shared helper's keyword arguments, preserving HTTP behavior:

   ```python
   async def validate_server_token(
       token: str,
       *,
       email: str,
       secret: bytes,
       store: LiveChatStore,
       offload_grant: Callable[[Callable[[], bool]], Awaitable[bool]] | None = None,
   ) -> ServerAuth:
       try:
           auth = verify_unlock_token(secret, token, email=email, now=time.time())
       except InvalidTokenError:
           raise _locked_401() from None
       grant_id = auth.grant_id
       if grant_id is not None:

           def check() -> bool:
               return store.is_device_grant_live(
                   grant_id=grant_id,
                   email=auth.email,
                   now=time.time(),
                   max_idle_s=GRANT_IDLE_EXPIRY_S,
               )

           live = await (
               offload_grant(check) if offload_grant is not None else anyio.to_thread.run_sync(check)
           )
           if not live:
               raise _locked_401()
       return auth
   ```

4. `calls_socket` passes
   `offload_grant=ws.app.state.call_admission_work.run` to that helper. The five
   second auth deadline still ends the route promptly. Replace the misleading
   comment that route pending slots prove non-abandonment: these owners prove it.
   `run_peer.grants` replaces only its offload with
   `await ws.app.state.call_grant_work.run(lambda: store.is_device_grant_live(...))`.
   Keep the existing cached grant deadline, monitor, and read/write worker cleanup.
5. Before the route's general exception tuple add:

   ```python
   except CallWorkFull:
       close_code = 4429
   ```

   Exhausted capacity is unavailability, not an instruction to renew a credential.

**Red/green discriminator:** block the synchronous callable on a thread event,
start four jobs, cancel their awaiting callers three times, then attempt twenty
more. Red releases accounting; proposed owner reports four actual workers and
four retained slots, rejects all twenty, and bounded drain does not relinquish
them. Release the event: all four slots disappear. A closed owner still rejects.
Those outcomes were executed. Add route-level blocked JWT/initial-grant/refresh
and repeated-disconnect tests before claiming integration green.

**Limits:** this does not kill a hung synchronous operation. HTTP/database timeout
behavior and the actual process manager's hard-stop/drain remain distinct. Do not
claim a 250 ms drain kills threads or proves Slots shutdown. Capacity remains
occupied under a genuine storage hang, deliberately failing calls closed. Task
exceptions are consumed without token-bearing traceback formatting. The private
jobs must never be registered in a scope that cancels them on route departure.

**Layer check:** one small owner class in the existing route module; no executor,
new service, persistence or extra worker pool. Two instances preserve the original
4/8 separation. The narrow helper injection avoids importing route machinery into
the token library or changing ordinary HTTP call sites.

## M1 + M4 — one bounded graph-control path, immutable capture metadata

These share a boundary and should be implemented together. Remove the unacknowledged
`lease`/`enabled` messages rather than layering another heartbeat beside them.
Use one in-flight state snapshot; acknowledge it **from process()**, not merely
from the MessagePort handler. Muted graphs must still render silent quanta to ack.

### Exact types and controller changes

Append these types to the existing `admin-ui/src/server/call/protocol.ts`:

```ts
export interface CapturedFrame {
  pcm: ArrayBuffer;
  generation: string;
  revision: number;
  captureLease: number;
  startedAt: number;
}
export interface GraphState {
  type: "state";
  generation: string;
  control: number;
  until: number;
  enabled: boolean;
  revision: number;
  captureLease: number;
}
```

In `controller.ts`, import `CapturedFrame`. Change the audio interface:

```ts
// Replace lease(): number with these two methods.
setCaptureLease(lease: number): void;
pulse(): void;
```

Change the factory capture argument to `(frame: CapturedFrame) => void`, and append
`leaseReady: (until: number, remainingMs: number) => void` as its fourth argument.
Pass it through the default `new CallAudio(capture, ack, fail, leaseReady)` factory.
Remove `captureLease`, `captureLeaseAt`, their teardown reset and the receipt-age
check from the controller: capture provenance now belongs to the graph.
Within the existing attempt-guarded capture callback, retain state, mute, socket,
main-thread-stall and bufferedAmount checks, but send:

```ts
socket.send(encodeFrame(callId, sequence++, frame.captureLease, frame.pcm));
```

The new fourth factory callback is exactly:

```ts
(until, remainingMs) => {
  if (attemptEpoch !== callEpoch || state !== "connected" || !callId) return;
  if (!(remainingMs > 0 && remainingMs <= LEASE_MS)) {
    end("Audio unavailable");
    return;
  }
  const now = win.performance.now();
  const id = ++playoutId;
  leases.set(id, { at: now + remainingMs, until });
  for (const [key, lease] of leases) if (lease.at <= now) leases.delete(key);
  if (leases.size > 4) leases.delete(leases.keys().next().value as number);
  if (!send({ type: "lease", callId, lease: id })) end("Connection too slow");
}
```

In `pulse`, after its existing connected/stale checks, replace the old block that
creates/sends a receiver lease with `audio.pulse()`. Only graph-acknowledged state
now issues a receiver lease. On a `capture` server control, call
`audio?.setCaptureLease(m["lease"])` instead of assigning controller lease fields.
Keep the current independent receive-side lease map and worklet playout deadlines.
No binary-wire offsets, call membership, idle suspension or consent changes.

### Exact CallAudio additions/replacements

Import the two types above. Replace the constructor signature (keep its activation
body unchanged) with:

```ts
constructor(
  private onCapture: (frame: CapturedFrame) => void,
  private onAdmitted: (sequence: number) => void,
  private onFailure: () => void,
  private onLeaseReady: (until: number, remainingMs: number) => void,
)
```

Add fields:

```ts
private readonly generation = crypto.randomUUID();
private revision = 0;
private captureLease = 0;
private control = 0;
private flight: { id: number; at: number; until: number } | null = null;
```

Create the node using:

```ts
this.node = new AudioWorkletNode(this.context, "wixy-call", {
  outputChannelCount: [1], processorOptions: { generation: this.generation },
});
```

Replace `node.port.onmessage` with this handler. Its recycle path intentionally
returns dropped old buffers as well as forwarded ones:

```ts
this.node.port.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
  const data = event.data;
  if (this.stopped || data["generation"] !== this.generation) return;
  if (data["type"] === "capture" && data["pcm"] instanceof ArrayBuffer) {
    const pcm = data["pcm"];
    const lease = data["captureLease"];
    const startedAt = data["startedAt"];
    const now = this.context.currentTime;
    try {
      if (pcm.byteLength === 960 && this.running && !this.muted
        && data["revision"] === this.revision
        && typeof lease === "number" && Number.isSafeInteger(lease) && lease > 0
        && typeof startedAt === "number" && Number.isFinite(startedAt)
        && startedAt <= now && now - startedAt <= 0.3) {
        this.onCapture({ pcm, generation: this.generation, revision: this.revision,
          captureLease: lease, startedAt });
      }
    } finally {
      if (!this.stopped && pcm.byteLength === 960) {
        this.node?.port.postMessage({ type: "buffer", generation: this.generation, pcm }, [pcm]);
      }
    }
  } else if (data["type"] === "stateAck") {
    const flight = this.flight;
    if (!flight || data["control"] !== flight.id) return;
    this.flight = null;
    const remainingMs = Math.min(300, (flight.until - this.context.currentTime) * 1000);
    if (performance.now() - flight.at >= 300 || remainingMs <= 0) {
      this.onFailure();
      return;
    }
    if (this.running) this.onLeaseReady(flight.until, remainingMs);
  } else if (data["type"] === "admitted" && typeof data["sequence"] === "number") {
    this.onAdmitted(data["sequence"]);
  }
};
```

Change the constructor's capture callback type to `(frame: CapturedFrame) => void`.
Add `generation: this.generation` to the five initial `buffer` messages, to `play`
messages, and to `stop`. Keep getUserMedia/resume/addModule stopped checks unchanged.
Replace the old `lease` and `setMuted` implementations with:

```ts
setCaptureLease(lease: number): void {
  if (Number.isSafeInteger(lease) && lease > this.captureLease) this.captureLease = lease;
}

pulse(): void {
  if (this.stopped || !this.running || !this.node) return;
  const now = performance.now();
  if (this.flight) {
    if (now - this.flight.at >= 300) this.onFailure();
    return; // One in flight; newer desired state remains in these fields.
  }
  const until = this.context.currentTime + 0.3;
  const id = ++this.control;
  this.flight = { id, at: now, until };
  const state: GraphState = {
    type: "state", generation: this.generation, control: id, until,
    enabled: this.running && !this.muted, revision: this.revision,
    captureLease: this.captureLease,
  };
  this.node.port.postMessage(state);
}

setMuted(muted: boolean): void {
  if (this.muted !== muted) this.revision++;
  this.muted = muted;
  for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  // No enabled post: the next pulse coalesces it into one state snapshot.
}
```

`start()` remains `this.running = true; this.setMuted(false)`. It must not dispatch
a possibly synchronous failure before the controller acquires its call suspension;
the controller already calls pulse after acquisition. Do not dispatch another
snapshot automatically on acknowledgement: that would create a render-rate control
loop instead of the intended 100 ms cadence. `stop()` also sets `flight = null`,
posts at most one final stop, disconnects/closes the port/context as before, and
never waits for acknowledgement. Thus terminal control is at most one in-flight
state plus one final stop, with resource closure as the authority.

### Exact worklet modifications

In `worklet.ts`, import `GraphState` as a type. Add these fields:

```ts
private readonly generation: string;
private pendingState: GraphState | null = null;
private revision = 0;
private captureLease = 0;
private frameLease = 0;
private frameRevision = 0;
private frameStartedAt = 0;
```

Change the constructor to
`constructor(options?: { processorOptions?: { generation?: string } })`, call `super()`
as before, then assign `this.generation = options?.processorOptions?.generation ?? ""`.
The optional signature preserves compatibility with the existing declared
`typeof AudioWorkletProcessor` constructor accepted by `registerProcessor`.
Real nodes always receive a nonempty generation from CallAudio; an omitted one
cannot match the real node's controls. Update processor test fixtures to supply it.
Immediately after reading `event.data`, reject a mismatched generation. Delete
the old `enabled` and `lease` branches. In their place use:

```ts
} else if (data["type"] === "state"
  && typeof data["control"] === "number" && Number.isSafeInteger(data["control"])
  && typeof data["until"] === "number" && Number.isFinite(data["until"])
  && typeof data["enabled"] === "boolean"
  && typeof data["revision"] === "number" && Number.isSafeInteger(data["revision"])
  && typeof data["captureLease"] === "number" && Number.isSafeInteger(data["captureLease"])) {
  this.pendingState = {
    type: "state", generation: this.generation, control: data["control"],
    until: data["until"], enabled: data["enabled"], revision: data["revision"],
    captureLease: data["captureLease"],
  };
```

The pending field is a single slot, not an array. Add
`generation: this.generation` to the existing `admitted` message. On `stop`, clear
`pendingState` as well as the existing enabled/lease/ring state and close the port.
At the very beginning of `process`, before capture or playback, insert:

```ts
const state = this.pendingState;
if (state) {
  this.pendingState = null;
  if (this.enabled !== state.enabled || this.revision !== state.revision) {
    this.captured = 0;
    this.capturePhase = 0;
    this.low = this.previous = 0;
  }
  this.enabled = state.enabled && state.until > currentTime;
  this.revision = state.revision;
  this.captureLease = state.captureLease;
  this.leaseUntil = state.until;
  this.port.postMessage({ type: "stateAck", generation: this.generation,
    control: state.control });
}
```

Require `this.captureLease > 0` in the existing capture `if` condition. Replace
`for (const value of input)` with the indexed loop below. Inside the existing
`if (this.capture !== null)` block, immediately before interpolation/write, latch
metadata **only on the first sample**, not on later state/lease updates:

```ts
// Outer loop replacement:
for (let inputIndex = 0; inputIndex < input.length; inputIndex++) {
  const value = input[inputIndex] ?? 0;
  // Existing low-pass, fractional-rate interpolation and buffer acquisition...

  // Inside `if (this.capture !== null)`, before writing its next sample:
  if (this.captured === 0) {
    this.frameLease = this.captureLease;
    this.frameRevision = this.revision;
    this.frameStartedAt = currentTime + inputIndex / sampleRate;
  }
  // Existing sample write and completion condition...
}
```

Replace the completed frame's post with:

```ts
this.port.postMessage({ type: "capture", pcm, generation: this.generation,
  revision: this.frameRevision, captureLease: this.frameLease,
  startedAt: this.frameStartedAt }, [pcm]);
```

Keep the fixed five-buffer pool, the original capture resampler, the bounded
4,800-sample playback ring, admission credits, per-sample deadlines and drift
correction. A buffer spanning a lease update retains its original lease. A mute
transition resets a partial frame; a queued pre-mute frame carries its old revision
and is dropped/recycled even if the user has already unmuted.

### M1/M4 discriminators and limits

For M1, reuse the audit's 20/250/450 ms timeline but drive the patched real worklet:
capture the frame under lease 1, apply/ack lease 2, deliver the old transferable
buffer to the main thread, then to the broker. Assert wire lease remains **1**, so
the broker drops it at 450 ms. Also test a frame spanning a lease update, generation
replacement, >300 ms port delay and mute/unmute; count returned buffers to prove
dropping cannot starve the pool. Test both 44.1 and 48 kHz and variable block sizes.

For M4, keep the AudioContext nominally running and stop servicing the worklet
port/process while muted. Drive 100 ms pulses. Assert at most one state message,
no new receiver leases before render acknowledgement, and failure at the first
pulse at/after the 300 ms acknowledgement deadline. With 100 ms scheduling cadence
the failure can occur just under 400 ms after a non-aligned send; worklet leases
still expire at 300 ms. Deliver an old ack after stop/new attempt and assert no
resource, suspension or lease revival. Repeat with rapid mute toggles: track
disable is immediate, queued controls stay bounded, desired revisions coalesce.

**These proposed integrated green tests have not been executed.** I am supplying
actual replacement code and a falsifiable test target, not reporting an implemented
fix. The existing exact reds remain measured. In particular, the late-resume,
addModule, grant-renewal, Safari activation and real mobile scheduling checks must
be rerun after integration, along with strict TS and committed LF bundle rebuilding.

**Layer check:** no new module/file, WebSocket transport, persistent state, SharedArrayBuffer,
separate worker or second heartbeat. The internal GraphState types document the
single existing MessagePort ownership boundary. One bounded snapshot replaces two
unbounded control message kinds, while capture metadata replaces receipt-time
relabelling. Receiver playout leases still expire on the receiver clock. This is
not a promise of synchronized clocks, flawless resampling quality or mobile
background calling.

## M2 — guard every pair emission against changed ownership

Keep synchronous broker transitions and the existing overflow terminal policy.
Do not add locks, deferred mutation queues or a catch-all `KeyError` handler.
Add this method to `CallBroker` immediately before `command`:

```python
def emit_pair(self, call: Call, messages: tuple[JsonObject, JsonObject]) -> bool:
    for key, message in zip((call.caller, call.callee), messages, strict=True):
        if self.call is not call:
            return False
        participant = self.peers.get(key)
        if participant is None or participant.closed:
            self.finish("disconnected")
            return False
        self.emit(participant, message)
    return self.call is call
```

Replace the invitation's two emits and following presence call with this combined
M2/M3 version (the M2 scratch test omits only the new requestId field):

```python
if not self.emit_pair(
    invited,
    (
        {
            "type": "outgoing",
            "callId": invited.id,
            "peer": target_peer.label,
            "requestId": command.requestId,
        },
        {"type": "incoming", "callId": invited.id, "peer": peer.label},
    ),
):
    return
self.presence()
```

Replace the accept `for key` emission loop with:

```python
self.emit_pair(
    call,
    (
        {"type": "prepare", "callId": call.id},
        {"type": "prepare", "callId": call.id},
    ),
)
```

Replace second-ready's combined timestamp/emission loop with:

```python
for participant in (peer, self.other(peer)):
    participant.fresh_at = now
self.emit_pair(
    call,
    (
        {"type": "connected", "callId": call.id},
        {"type": "connected", "callId": call.id},
    ),
)
```

The timestamp assignments complete before any emitting call can mutate membership.
`emit_pair` checks again before every next participant. When the first emission
finishes/removes the pair, the helper cannot enqueue a later incoming/prepare/
connected message for that ended call. `finish` already uses `get` per iteration;
`presence` already snapshots its outer iteration. Keep those behaviors.

**Measured green:** execute the audit queue setup (A=16, B=14 queued controls)
separately at invite, accept and second-ready against the in-memory modified actual
broker. All three end the pair without exception; no queued stale incoming,
prepare or connected control survives. This improves on checking only the reported
accept traceback. Add near-capacity combinations, presence and shutdown regression
cases before integration acceptance. No new third-party address or authority path.

**Layer check:** one helper consolidates an already repeated immutable-pair action;
no new state machine or asynchronous task. The helper's identity check uses the
existing Call object, not email/token equality or a second ownership registry.

## M3 — correlate outgoing replies, preserve the incoming call

In `call_broker.py`, replace the unavailable emission with:

```python
self.emit(peer, {"type": "unavailable", "requestId": command.requestId})
```

The outgoing success carries requestId in the paired invitation code above. Add
these two fields to the documented server envelopes in `docs/ai/contracts.md`;
the existing Invite already requires requestId, so no additional user input is
introduced. Incoming remains sent only to the selected callee socket.

In `controller.ts`, change the pending declaration to
`let pendingInvite: string | null = null`. All resets become `pendingInvite = null`.
On Call, set `pendingInvite = crypto.randomUUID()` and send
`{type: "invite", requestId: pendingInvite, targetConnectionId: targets.value}`.
`render` uses `pendingInvite !== null` for its disabled expression. Retain the
current pending-cancel behavior of disconnecting the socket.

Replace the incoming/outgoing and unavailable branches with:

```ts
} else if (m["type"] === "incoming" || m["type"] === "outgoing") {
  if (m["type"] === "outgoing"
    && (pendingInvite === null || m["requestId"] !== pendingInvite)) return;
  if (callId || typeof m["callId"] !== "string") throw new Error("Invalid invite");
  if (m["type"] === "incoming" && pendingInvite !== null) {
    // Retire only the outgoing attempt's empty activation graph. No mic yet.
    callEpoch++;
    audio?.stop();
    audio = null;
    deps.onBusy(false);
  }
  callId = m["callId"];
  if (m["type"] === "outgoing") pendingInvite = null;
  state = m["type"];
  callUntil = win.performance.now() + 30_000;
  status.textContent = state === "incoming"
    ? `Incoming call from ${String(m["peer"]).slice(0, 32)}` : "Calling…";
} else if (m["type"] === "unavailable") {
  if (pendingInvite === null || m["requestId"] !== pendingInvite) return;
  pendingInvite = null;
  if (callId === null) teardownCall("That person is unavailable");
```

The existing render at the end remains. Clearing the rejected pending request must
not stop a newer Answer graph: the outgoing graph was retired when incoming arrived.
An incoming invitation is never treated as consent; the Answer button still creates
its own gesture-activated graph and sends accept. A third same-login iPad still
receives only ordinary availability, not the incoming control or media.

**Measured green:** the compiled modified actual controller preserves incoming
ownership for incoming/busy and defensive busy/incoming order; Answer followed by
late busy does not stop the new Answer graph; Decline followed by late busy stays
ended and sent decline. None prepares a microphone automatically. The test records
the sent request ID rather than inventing an unrelated one. Server response-field
integration and opposite endpoint roles still need a real broker/controller test.
Update existing unit outgoing fixtures to copy their sent Invite requestId.

**Layer check:** the existing request identifier and one pending variable suffice;
no response history, extra socket, second invitation state machine or persistence.
The one globally reserved pair and explicit answering role remain unchanged.

## Integration order and boundaries retained

Implement H1 and M2 first with their discriminators; integrate M3's two wire fields
and matching client tests; integrate M1/M4 together and execute the missing greens.
Extend existing call tests rather than creating another service/test framework.
Then run strict checks and the relevant focused regression/browser loop, rebuild
the LF assets, and freeze a new SHA for **fresh reviewers**. These proposal probes
do not certify a replacement candidate.

Preserve: same-email/same-token legitimate two-device pairs; explicit consent and
both-ready media; no third-device prompt/audio/auto-participation; no token/audio
logging or storage; call-only idle suspension including mute; actual lock/shield/
detach/pagehide/token changes terminate audio; voice-note mic arbitration. Ordinary
unlocked messaging remains shared: this proposal does not claim it stops syncing.

Keep Android Chrome + iPad Safari as the first physical pair, with the actual iPhone
browser a separate acceptance target. Gesture activation, real handset audio,
production hostname/Access/tunnel, 15-minute speakerphone/latency/loss behavior and
Slots drain remain open. No new launch claim or approval is implied by this proposal.
