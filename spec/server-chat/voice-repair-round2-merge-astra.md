# Voice repair round 2 — Astra ALL-proposal MERGE

Candidate: `4983cc662730f1a18bd95a5337d9c1a1fc45cb1b`. Date: 2026-10-18.
Scope: one combined recommendation for M1/M2/M3/L1/L2; no runtime edits.
Status: **ready for parent adjudication and focused implementation; not code approval or launch readiness**.

Both complete proposals were considered with equal standing:

- [Astra PROPOSE](voice-repair-round2-proposal-astra.md).
- Gemini PROPOSE: `D:/Servers/Cmd/Storage/clones/wixy__worktrees/00050__wixy_group-therapy-propose-reviewer-gemini-fo/spec/server-chat/voice-repair-round2-proposal-gemini.md`.

My previous proposal has no privilege. This recommendation changes it: adopt
Gemini's immediate removal of unauthorized endpoints, retain a single shared
media gate, clear matching losing-request bookkeeping without disturbing a newer
call, and correct both proposals' disconnected microphone-affordance hole.

## Evidence convention and source corrections

**CITED:** all runtime red/green results below come from the two proposal files;
none was rerun in this MERGE. Astra's originating trials were explicitly
MEASURED-KNOWING. Gemini's trials also followed the disclosed issue list; they
are not blind discovery. A changed composition does not inherit either patch's
green. Novel combinations below are **UNEXECUTED**, with concrete discriminators.
There are no new MEASURED-BLIND or MEASURED-KNOWING runtime results in this report.
Source inspection and deductions are identified separately from measurements.

Direct inspection of the frozen source corrects two Gemini factual claims:

- `routes_livechat_calls.run_peer.monitor` sleeps **0.1 seconds**, not one second.
  Grant checks sleep **2 seconds**, refreshing a **2.5-second** cached deadline,
  not five seconds. Faster cadence does not close a dequeue authorization gap.
- `call_broker.transition` drains deferred overflow evictions on the outermost
  synchronous return. It does **not** invoke `assert_invariants()`.
  Decorating `next_media` is still necessary once it can finish/remove members.

The writer pops one control before awaiting `send_json`, with a 250 ms timeout.
Queue absence therefore does not prove client adoption. Conversely, this writer
serializes sends: a completed outgoing precedes the following terminal; failed
send ends the socket. I do not claim a newly measured healthy-socket stranding
trace solely from the popped-but-unsent interval.

## M1 — Always correlate caller terminals; isolate request and call identities

Select Astra's unconditional caller correlation and Gemini's explicit clearing
of obsolete request bookkeeping. Reject Gemini's `had_outgoing` condition.

In `Call`, retain the validated bounded original request ID as a required
`request_id: str`; create it with `request_id=command.requestId`. In `finish`,
keep all existing epoch-control purging and media cleanup, then emit:

```python
terminal: JsonObject = {"type": "ended", "callId": call.id, "reason": reason}
if key == call.caller:
    terminal["requestId"] = call.request_id
self.emit(peer, terminal)
```

Only that originating caller socket receives its request ID. The callee shape
stays unchanged. This costs one already bounded string on the one in-memory call
and no additional control item. An exact legacy test dictionary is updated to
the new caller contract; it is not a compatibility reason to weaken correlation.

In `controller.receive`, before the generic unknown-call-ID rejection:

```ts
} else if (m["type"] === "ended" && m["callId"] !== callId) {
  if (outgoingRequest !== null && m["requestId"] === outgoingRequest) {
    outgoingRequest = null;
    if (callId === null) teardownCall("Call ended");
  }
  return;
} else if (m["callId"] !== callId || !callId) {
  return;
```

Known-call terminals retain the existing normal end branch. A matching old
request may lose its bookkeeping but cannot stop a newer incoming, preparing,
or connected graph. Wrong-request terminals do nothing. Once a pending attempt
is retired, a late `outgoing` cannot adopt it because its request is no longer
pending. Do not broadly tear down on unknown epochs or preserve stale outgoing
controls merely to teach the client an already finished call ID.

Also retain Gemini's action-time `outgoingRequest !== null` guard in the Call
click handler, alongside target/mic/callId checks. The rendered disabled state
is not the sole protection against a second pending invitation.

**CITED:** Astra exercised target overflow and early decline with actual broker
controls fed into its controller harness, wrong-request negative control, and
a crossing incoming call that had already been Answered. Gemini exercised the
early terminal path. Gemini's displayed test bearing “preserves glare” in its
name does not itself construct glare; a title is not coverage.

**Required discriminator, UNEXECUTED composition:** pause the writer after it
pops outgoing and before send completes; finish the call, then release it.
Assert the terminal always has requestId, successful sends retain order, send
failure tears down the socket, and neither path strands busy/audio state.
Also deliver terminal-before-outgoing directly at the controller seam, then
late outgoing, wrong request, known epoch, and an old matching request after
new incoming/prepare/connected. Count graph stops and busy transitions.

## M2 — One cached pair/lifetime gate, with immediate endpoint retirement

Select Astra's common helper structure and Gemini's `remove(expired_member)`
semantics. Reject duplicated admission/dequeue logic and Astra's finish-only
authority response. Finish-only withholds audio but leaves a known-ineligible
member registered until another worker notices; `remove` already has the
correct wake/unlink/cleanup ownership.

The helper executes synchronously within the existing transition boundary:

```python
def _media_other(self, peer: Peer, now: float) -> Peer | None:
    if not self.permitted(peer):
        self.remove(peer)
        return None
    call = self.call
    if call is None or call.state != "connected" or not call.contains(peer):
        return None
    other_id = call.callee if peer.id == call.caller else call.caller
    other = self.peers.get(other_id)
    if other is None:
        self.finish("disconnected")
        return None
    if not self.permitted(other):
        self.remove(other)
        return None
    if now >= call.until:
        self.finish("timeout")
        return None
    return other
```

`permitted` already checks registration/object identity, closed status, the
absolute deadline and cached monotonic grant deadline. Both members must pass.
This helper adds no database, JWT verification, network, task or thread work.
The 4 admission / 8 refresh native-work limits stay intact.

In `frame`, preserve unpacking, rate limits, stale-terminal epoch dropping,
current-call membership/connected/epoch/mute checks, sequence rules and leases.
Split the initial permission check from rate-budget failure: on unpermitted
submitting peer, call `remove(peer)` before raising `ValueError("media permission")`.
Rate exhaustion must not be relabeled credential revocation. After checking the
current frame's call/epoch and before changing sequence or adding media, call
the shared helper and return if it yields None. Use the returned receiver for
playout lease validation and enqueue; eliminate the duplicate recipient check.

Decorate `next_media` with `@transition`. Obtain `now`, call the helper before
outstanding-credit checks or queue pops, and on None clear this peer's media and
return None. On success use the current connected call and retain the existing
epoch/playout/credit logic. Removal finishes the pair and clears both members'
queued media/outstanding credits/capture leases; the removed endpoint also
gets its controls cleared and wake signaled. A pure call-lifetime expiry ends
the call with `timeout`, leaving authorized presence sockets available.

Preserve authorization facts. Never set `grant_until=0` to force teardown.
Keep the common route-finally classification proposed by both authors:

```python
if close_code != 1001:
    if time.time() >= peer.deadline or peer.grant_until == 0:
        close_code = 4401
    elif time.monotonic() >= peer.grant_until:
        close_code = 4408
```

This handles both normal completion and exceptions. Cancellation stays 1001;
absolute expiry or confirmed revocation earns 4401; overdue refresh earns 4408;
capacity remains 4429 with still-valid cached authority. Call lifetime alone
does not lock either owner. Closing an unauthorized socket and its surviving
partner's call are separate effects; do not lock the authorized partner.

**CITED:** both proposals report media-withholding red/greens across sender
expiry/revocation/overdue refresh and connected lifetime. Astra also reports
receiver boundaries and a route exception classifier trial. Gemini reports
immediate endpoint removal, 45 focused Python tests, three-file mypy and ruff;
these results belong to its duplicated-check patch, not the combined helper.

**Required discriminators, UNEXECUTED composition:** before admission and after
enqueue/before dequeue, independently expire either endpoint's absolute token,
set its grant to zero, make its nonzero refresh deadline overdue, or expire
call lifetime. Do not tick first. Assert no bytes returned, no new credit,
all terminal resources cleared, only unauthorized endpoint removed, and
authorized survivor preserved. Include no-call/nonmember/stale-epoch controls,
genuine control overflow, and route 4401/4408/1001/4429 cases. A byte already
passed to the transport cannot be recalled; this is an unsent-media gate, not
a hard real-time guarantee.

## M3 — Panel policy owns cached-page restoration

Select Astra's panel-owned recovery. Reject Gemini's independent controller
`pageshow`/`visibilitychange` auto-open. Checking only a retained token's expiry
cannot decide panel idle, shield, screen-lock, fading, grant or disposal policy.
Opening first and having the panel close it later is not “policy before open”.
Listener ordering is therefore a correctness condition, not a cosmetic detail.

Retain the controller's existing unconditional `pagehide -> detach` behavior:
stop graph/mic, release suspensions, close the old socket, forget its session.
Add no controller restoration listeners and retain no resumable call state.

Use the exact panel mechanism from Astra's proposal:

1. Declare `restorePresencePending` in panel state, initialized before lifecycle
   handlers can run. On persisted pagehide mark only an attached chat owner.
   On nonpersisted pagehide clear it. Preserve the existing `unloading` behavior.
2. Every `detachChatView` clears the marker before even its early return;
   panel teardown clears it too. The controller's pagehide detach does not
   itself imply the panel locked; actual panel lock/detach does.
3. Persisted pageshow calls the existing `onVisible()` only when not disposed
   and actually visible. If still hidden, retain the marker for visibilitychange.
4. At the end of `onVisible`, after existing shield/fade/renewal/idle policy,
   consume the marker only if attached, state is chat, session exists and visible.
   Return immediately after an idle-away lock. Expiry invokes existing `onExpiry`
   and must not attach the expired token.
5. A valid same-session restore uses `chatView.attach(session)`. Shield recovery
   and expiry renewal keep their existing owner-authorized attach paths. Consume
   the marker before attachment, so repeated visible/pageshow events are idempotent.

This is safe against either controller/panel pagehide listener order: only the
controller tears down call resources; only the panel can later authorize an
attach. There is no controller pageshow listener that can race the policy owner.
If visibility becomes visible before pageshow, the same owner path consumes
the marker once. If pageshow precedes visibility, no connection opens while hidden.
Those are source-based mechanism deductions, not new browser measurements.

### Whole attach versus a narrow presence method

I explicitly retain **whole-view attach for this repair**. The frozen
`ServerChatView.attach` contract already permits attached-session renewal and
requires preserving drafts/in-flight work. Direct source inspection shows it
also closes/reopens SSE and calls `thread.attach` to refresh history/media.
Thus it is not accurate to call this a side-effect-free presence-only operation:
only the **call capability** being restored is presence, never audio/consent.

A narrow alternative would add `resumeCallPresence(session)` to the view
contract, implemented as `calls.attach` only when `currentSession === session`,
identity exists and the view remains attached, with the panel retaining all
policy authority. This is a reasonable alternative but neither proposal has
measured that seam or its fixture/contract integration. It is not selected merely
because fewer effects sound better. Do not add a controller-owned policy copy,
an optional fallback that silently does nothing, or both restoration paths.

**CITED:** Astra measured the actual panel/controller using a substituted view
container: valid restore, hidden pageshow then visible, lock, expiry, disposal,
and a previously connected call whose graph/suspensions did not return. Gemini's
controller-only restoration trial cannot establish owner-before-open ordering.
Neither author measured real thread/SSE consequences of the chosen whole attach.

**Required integration discriminator:** use actual panel + chatView + thread
with socket/audio/HTTP seams, both pagehide listener orders and both
pageshow/visibility orders. Exercise hidden-ignore, hidden-lock, shield pending
and resolved, elapsed idle, token expiry with/without grant renewal, actual
manual lock and disposal. Record socket factory calls before and after owner
policy, not just final hidden UI. No transient open is allowed on denied restore.
Preserve draft, upload and staged-recording state; at most one fresh call socket,
no invite/accept/audio graph/mic acquisition/new voiceCall suspension. Check SSE
cursor and signed-media refresh behavior. Include a persisted transition with
missing/delayed hidden notification; synthetic events do not establish platform
ordering. If this test reveals draft/recording loss or repeated refresh, reverse
the whole-attach choice in favor of the narrow owner method before freezing.
This named reversal condition belongs in the next review brief.

## L1 — Release an incoming reservation when construction fails

Both proposals converge on the existing terminal mechanism:

```ts
catch { end("Calls unavailable in this browser"); return false; }
```

Use this in `activateAudio`, replacing catch-only `teardownCall`. `end` captures
the incoming ID/action, stops locally first, then sends decline. Construction
failure before an outgoing invitation sends no invented end/decline. Retain
the existing attempt-epoch fencing and asynchronous prepare-failure behavior.

**CITED:** both report Answer throwing yields decline and Call throwing before
invite emits no call action. **Integration discriminator:** feed the actual
decline to the broker or two-socket route fixture and assert immediate reservation
release, caller end, and no lingering busy/permission/audio handles. Construction
failure is a controlled seam, not proof against physical AudioContext exhaustion.

## L2 — Gate starting a call, never presence-only reconnection

Change both proposals here. Existing click handling already reconnects before
testing mic ownership; this operation acquires no microphone. Match that policy:

```ts
callButton.disabled = outgoingRequest !== null ||
  (socket?.readyState === 1 && (targets.value === "" || deps.isMicBusy()));
```

Refresh that predicate and Answer's predicate on the existing 100 ms pulse.
Use the shared `render()` there rather than duplicating the predicate in two
places. Keep action-time microphone checks because disabled UI is not authority.

**Additional required correction found by source inspection:** `disconnect()`
currently calls `teardownCall()` (which renders) **before** setting `socket=null`
and stopping the timer. Merely changing the predicate above is insufficient on
`onerror` or other paths where the old socket still appears OPEN during teardown.
Add `render()` at the end of `disconnect()`, after clearing socket/timer and
closing the old socket. This ensures its final UI uses the disconnected state,
even when no future pulse or presence message can arrive. Do not add a timer or
a broad recorder-notification API for this.

**CITED:** both authors demonstrated mic busy/idle changes with a live pulse.
Neither establishes offline recovery. Gemini explicitly acknowledges that gap;
its claim that recording stop will re-enable offline Reconnect is not supported
when the timer is gone. **UNEXECUTED combined discriminator:** record, disconnect
via onclose and via onerror while fake readyState remains OPEN, then stop recording
without any pulse/presence event. Reconnect must already be usable, including
while still recording; clicking it opens only presence. After welcome, Call is
disabled while recording and re-enables on the existing pulse when recording
ends. Also cover no available target and pending invite.

## Optional C1 — Keep bounded presence snapshot replacement

Select Astra's coalescing in `emit`, before the unchanged capacity check:

```python
if message.get("type") == "presence":
    peer.controls = deque(m for m in peer.controls if m.get("type") != "presence")
```

Presence is a replaceable snapshot; append the newest at the tail. Preserve
relative ordering and exact contents of all nonpresence controls. This scan is
bounded by 16 entries. Do not enlarge the queue, drop consent/terminal/lease/ping
controls, coalesce media, or alter the deferred-eviction boundary.

Avoiding the second presence broadcast in `remove -> finish -> presence` is a
narrower alternative for that trace alone, but does not handle stale snapshots
already queued from other transitions. A “presence dirty” outer-transition flush
would require more scheduling change without supplied comparative evidence.
Use one mechanism, not coalescing plus another unproven broadcast refactor.

**CITED:** Astra's 14-ping survivor test changed from eviction to exactly 16
controls with one final presence. **Required discriminator:** repeated snapshots
replace only snapshots, all nonreplaceable controls keep order, and a queue of
16 nonreplaceable controls still triggers real overflow. Also test the selected
M2 remove path with a nearly full survivor queue. Coalescing is a companion
availability fix, not permission to weaken mandatory overflow cleanup.

## Parent integration and acceptance boundary

Implement the above in the existing broker, route, controller and panel. No new
service, background loop, authority store, persistent call record or recording
is proposed. Use the focused repair tests and real-view lifecycle cases above,
then strict Python/TypeScript checks and LF bundle rebuild. Gemini's CITED 36
frontend tests and strict TypeScript green, and Astra's CITED in-memory greens,
do not certify this newly combined patch. Astra's previous TS compiler-host
attempt never checked source; it is not a green typecheck.

Update contracts for caller `ended.requestId`, invariants/livechat docs for both
member media checks, immediate ineligible endpoint removal, owner-authorized
cached-page restoration and replaceable presence snapshots, and testing docs
for these discriminators. Describe the chosen whole-view refresh honestly.

Parent owns adjudication, locally proven integration, freezing the candidate,
and a fresh independent review. This report changes no implementation, branch,
commit, bundle or deployment. Review the changed compositions rather than
counting two proposers' agreement as new measurements.

**Launch remains NOT READY:** physical Android/iPad/iPhone, production hostname
and Access/tunnel behavior, sustained 15-minute duplex/speakerphone quality,
latency/jitter/loss, and actual Slots drain/hard-stop remain unproven. Component
correctness, successful integration, independent acceptance and measured user
experience are separate claims.
