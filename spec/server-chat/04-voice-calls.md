# Private live voice calls — workspace 48

Status: frozen implementation brief, 2026-10-18. The workspace Architect adopts the
[senior architecture ruling](voice-call-architecture-review.md), including its security,
resource, freshness and real-audio acceptance gates. This adds only `voiceCall` to the
frozen `SuspendReason` interface; existing lock policies remain authoritative.

## Delivered shape

Unlocked participants can select another available connection, Call, Accept/Decline,
Mute and End. One immutable two-socket pair at a time, including two devices using the
same Access identity. Hub relays 24 kHz mono int16 PCM over same-origin authenticated
WebSockets. No recording, transcription, database entries, history or notifications.
A call attempt pauses the automatic idle countdown on a device from the moment it sends an
invite or shows an incoming call, through ringing and connecting, into connected or muted
(operator decision #2136). The server bounds it: 30 s ringing, 20 s setup. Any end releases
that pause and restarts a fresh countdown. Every actual lock/detach ends audio. The pause is
liveness-stamped: the call controller's 100 ms tick refreshes it, and a pause not refreshed for 3 s
(the page was frozen, e.g. a phone auto-locking mid-ring) stops excusing the page. On return the
silence counts as idle time, so a page frozen past the idle period locks at once with no fade and a
late release never grants a fresh window. After two unanswered incoming rings in a row with no
activity on the device, further incoming rings take no pause until it is touched again.

## Protocol

`/api/admin/server/calls/ws`, public subprotocol `wixy-call-v1`, no query strings.
Explicit configured allowed origin; verified Access email/expiry before upgrade;
unlock token in first JSON frame, including shared grant validation. All control
messages are strict schemas, no arbitrary payload forwarding. Presence is ephemeral.
The review defines states, roles, timeouts, queue/credit/lease limits and failure rules.
The control bucket is 80/s with burst 100: 50 media acknowledgements plus ten lease
refreshes per second exceed the review's provisional 30/s total. All other bounds apply.

Binary is exactly 1008 bytes: 48-byte header + 480 little-endian int16 samples.
Header: bytes 0 version=1, 1 kind=1; bytes 2–3 reserved zero; bytes 4–19 call UUID;
20–23 uint32 sender sequence; 24–31 uint64 capture sample index; 32–35 uint32 capture
lease; 36–39 uint32 receiver playout lease; 40–47 reserved zero. Header integers are
big-endian. Client sets receiver lease zero; only relay fills it. Leases expire in
300 ms on the issuer's monotonic clock and are never extended by receiving audio.
Receiver acknowledges after bounded worklet admission; at most five frames in flight.

## Modules and acceptance

1. Relay: explicit shared token/grant validation, Access verifier seam, strict call
   protocol, bounded in-memory broker, socket route, lifespan drain and server WS limits.
   Prove dual auth, same-email pairing/third-party rejection, expiry/revocation, state
   races, stale leases, bounded credits/queues, shutdown and malformed/flooded data.
2. Browser: transport/controller, bounded AudioWorklet resampling and playout, controls,
   recorder arbitration, attach/detach integration and dedicated idle suspension.
   Prove late-permission cleanup, mute/idle semantics, terminal resource cleanup,
   generation isolation, policy-preserving lock/shield behavior and bounded worklet ports.
3. Validation/docs: real two-browser synthetic duplex through actual local sockets,
   strict checks, committed LF bundles, docs contracts/invariants/runbook. Physical-device
   listening/tunnel gate in the ruling remains explicit outstanding acceptance until
   observed; do not describe synthetic-only proof as production call quality.
4. Delivery: freeze locally proven head, independent security/concurrency audit, final
   PR/checks and one workspace delivery merge. Owner: workspace full-stack developer.
   Record the confirmed merge SHA; an open PR is not completion.

TLS protects transport; the trusted hub/Cloudflare relay can see PCM. End-to-end
encryption, mobile telephone background guarantees, multi-worker coordination and
external TURN exposure require a revised design. A failed real-audio gate must be
reported and resolved before calling this capability delivered.
