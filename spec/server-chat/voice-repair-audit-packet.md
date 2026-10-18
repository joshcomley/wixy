# Fresh audit packet — repaired private voice calls

Audit the exact candidate SHA supplied in the dispatch, against base
`7a952c6cc590e5acf67996c1a7cbcc1b474a7ddc`. This is a fresh implementation audit,
not proposal confirmation. Read current source and intent independently; do not
reuse prior audit verdicts. The parent keeps this worktree unchanged until verdict.

Intent: `04-voice-calls.md`, current contracts/Inv 55/livechat docs and the adopted
`voice-repair-round1-ruling.md`. The product is explicit two-person browser audio,
relayed via hub's existing secure web connection, no recordings/transcripts/history.

Acceptance to audit:

- Independently verify Access signature/audience/issuer/email/finite expiry and exact
  configured Origin/subprotocol/no query before upgrade. First-frame in-memory unlock
  token uses shared grant authorization, no URL/cookie/log token. Both credential
  deadlines and grant rechecks apply during silence and mute.
- Actual future completion owns native capacity: admission <=4 and refresh <=8,
  including caller cancellation, actual auth timeout, pre-start cancel, slow refresh
  and shutdown. Call work does not borrow AnyIO's HTTP thread limiter. Operational
  failure stops audio without a false 4401 owner lock; actual refusal/revocation/expiry
  remains an authorization failure. No unbounded waiting jobs or hidden orphan work.
- One immutable consenting socket pair, including same-email/same-token pairs; third
  sockets cannot answer/end/replace or receive prompts/PCM. No audio before both consent
  and both ready. Glare/cancellation/delayed controls cannot transfer consent or graphs.
- Overflow eviction waits for the outer synchronous transition and removes stale phase
  controls. Cleanup depth survives exceptions. Removed peers lose media/credits/leases.
  One last terminal epoch per socket permits ONLY benign former-pair controls/PCM to
  be discarded: no new-call authority, no third-party exemption, no stale accept/ready.
- Fixed PCM/header/schema/rate bounds, five capture transfer buffers and receiver credits,
  bounded ring/relay queues. Capture lease/revision/first-sample time is immutable at
  production. Old MessagePort/TCP data cannot be relabelled or played in catch-up bursts.
- One coalesced graph control in flight, acknowledged only in a render quantum. Muted
  graphs must also prove rendering. Only a timely ack issues a receiver lease with
  remaining original wall/audio validity. No fresh deadline on delayed acknowledgement,
  feedback loop, unlimited state traffic or automatic call restart.
- Every actual lock/shield/detach/pagehide/dispose/session change stops local audio,
  including late async resources. Connected and muted calls hold exactly one idle-only
  suspension; end restarts a full countdown without altering tab/screen preferences.
  Voice-note and call microphone ownership are exclusive. Repeated Answer is harmless.
- Device selection does not silently switch from a busy chosen phone to another tab.
  Ordinary messages still sync to other unlocked chat views; do not claim otherwise.
- Real Uvicorn uses shared size/queue/no-compression options. Single-process broker,
  no call schema/SSE persistence, no audio/token diagnostics, self-hosted LF worklet
  and bundles. TLS is not E2EE; trusted hub/Cloudflare can see live PCM.

Parent-local evidence, not a substitute for independent inspection:

- 43 call/repair Python tests pass with four workers. Real signed JWT routes and real
  Uvicorn fragmented oversize rejection; actual internal auth deadline and native
  cancellation/worker-quota tests, revocation versus slow refresh, late former-epoch
  controls and third-party rejection, removed-receiver erasure and overflow matrix.
- 1,702 frontend chat regressions passed with four workers. Parent-specific red/greens
  include repeated Answer, delayed ack with frozen audio clock, buffer recycle on
  callback failure, cleanup depth and admitted cancellation. Additional target-selection
  and operational-close cases pass. Strict TS and rebuilt assets pass.
- Full mypy (244 files), ruff/format and diff checks pass. Proposal code fences were
  formatted mechanically to satisfy repository checks; no proposal evidence is inflated.
- Real three-context Chromium fake-mic scenario passed: audible duplex, 450 ms forced
  main-thread stall, fresh consent, muted idle pause, panic cleanup/fresh countdown;
  unrelated same-login unlocked third browser receives zero audio frames, no incoming
  prompt and no microphone. Worklet asset 200/JS MIME asserted. Existing physical-device
  behavior and measured mouth-to-ear latency are NOT inferred from this graph test.

Open external gates: actual Android Chrome/iPad Safari, actual iPhone browser still
unconfirmed, production HTTPS/Access/tunnel, 15-minute duplex/speakerphone and network
stress/latency, actual Slots drain/hard-stop. Native executor work cannot be killed by
coroutine cancellation, and wait=False is not a process-exit guarantee. Report launch
readiness separately; these gates remain open even if code audit is clean.

Report all real findings by C/H/M/L severity with exact file/line, trigger and concrete
repair. A no-finding result is valid. Do not edit implementation, branch, commit, push,
PR, merge or spawn agents. Only write the named round-2 audit report, then peer parent.
Focused tests are allowed; no full CI or repeated blanket suites. The parent alone
owns repairs and delivery through a confirmed merge SHA.
