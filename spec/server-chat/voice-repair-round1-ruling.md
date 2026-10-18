# Architect ruling — voice repair round 1

Both actual merge reports have been read. The selected two-family panel converges
on all five safety mechanisms. Gemini did not supply a counted result; its stop
request was not confirmed by cmd. No third-model agreement is claimed.

Integrate Opus's measured merged trial as the starting point, with these parent
adaptations. This is implementation direction, not an audit or launch clearance.

| Finding | Selected repair | Coverage and retained limit |
|---|---|---|
| H1 | Dedicated executor futures, separate admission 4 and refresh 8 owners; permits return on actual future completion/cancel-before-start | Preserves nominal 4/8/12 bounds and avoids AnyIO HTTP-worker starvation. Two small executors reuse one owner class. Native work cannot be killed by coroutine cancellation; actual Slots hard-stop remains a live gate. |
| H1 operational outcome | Invalid/refused/revoked/absolute-expired credentials alone yield 4401; unavailable capacity 4429, missed verification/refresh 4408, cancellation 1001 | Explicit cancellation branch and bounded close cleanup; assert absence of spurious unauthorized-lock callbacks. |
| M2 | Deferred overflow eviction at the outer synchronous transition boundary | Adopt nested-finally depth cleanup, admission post-check, and final presence/phase-control matrix. No swallowed KeyError and no second competing pair-lock mechanism. |
| M1 | Lease + revision + first-sample time latched in the worklet, unchanged to relay | Validate fixed size/finite/integer metadata, recycle owned buffers in finally. A CallAudio/node/port instance and stopped guard supply call-generation ownership; mute revision supplies intra-call ownership. |
| M4 | One coalesced state control in flight, acknowledged only by process() | Only a timely render ack can issue a receiver lease. Remaining validity is the minimum of original wall-clock budget and audio-clock deadline. No fresh 300 ms window at receipt. Immediate changed capture-state dispatch is allowed; unique playUntil permits at most the existing ten receiver leases/s. |
| M3 | Correlate outgoing success and refusal with the real requestId; keep winning incoming ownership separate | Retire losing graph before replacement/epoch change. Add explicit acceptance-pending guard so pulses cannot re-enable repeated Answer. Never auto-answer a crossing invite. |

Both merges select executor futures and deferred eviction; their description of
these as splits concerns alternatives evaluated, not an unresolved final mechanism
vote. Astra's render-quantum and original-deadline requirements are adopted; Opus's
immediate capture-state update avoids an unnecessary extra 100 ms scheduling delay.
The separate four/eight executor owners meet the same selected quota invariant as
Astra's proposed single executor with two quotas with less counter machinery.

Evidence is not pooled into inflated totals. Opus's test results are CITED trial
evidence until rerun on this integration; Astra's component probes and proposed-only
M1/M4 paths are distinct. Reds designed after reading the audit's expected defect
are treated as MEASURED-KNOWING, even if a proposal calls them blind relative to the
other proposal. Parent integration must execute its own discriminators and actual
AudioWorklet duplex path. Add an unlocked third same-login browser: no call prompt,
audio frames, mic acquisition or automatic participation. Ordinary messaging remains
shared across unlocked views.

Update contracts/Inv 55/livechat/runbook together, rebuild LF bundles, run proportionate
checks and real local duplex/stall/privacy tests, then freeze a new candidate for a
fresh senior auditor who did not propose these repairs. No PR/merge yet. Actual phone,
hostname/Access/tunnel, 15-minute audio quality and Slots drain remain open.

Parent real-browser loop exposed two further integration edges with red tests:
late benign controls after terminal cleanup unnecessarily disconnected presence,
and a busy selected device disappeared from the dropdown, silently selecting the
unrelated observer. Retain one terminal epoch per authenticated socket solely to
discard former-pair end/decline/failure/mute/lease/ack/PCM; no authority over a new
call, no third-party exemption and no stale accept/ready. Preserve explicit selection
while unavailable and disable Call until it returns or the user selects another.
Both changes require focused negative controls and the three-browser scenario.
