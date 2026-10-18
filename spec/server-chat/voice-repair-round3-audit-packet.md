# Fresh implementation audit — after round 2 repairs

Use the exact frozen SHA and base supplied in dispatch. You did not propose or
implement these repairs. Inspect actual code against `04-voice-calls.md`, current
contracts and Inv55. This is a whole implementation audit, not confirmation of
the previous reviewers' preferred patch. Do not reuse earlier verdicts or read
proposal/merge histories before independently forming findings. Parent keeps
this worktree unchanged while the audit is open.

Product: explicitly consenting two-browser live audio, relayed through hub's
existing secure connection, including same-login devices. An unrelated unlocked
third browser must receive neither prompt nor audio. No persistent call/audio
history, recording or transcription. Connected/muted calls pause idle only;
every actual lock/detach stops audio. Ending restarts a full countdown.

Audit the complete authority/resource boundaries:

- Independent exact Origin/Access signature/audience/issuer/email/expiry before
  WS upgrade; first-frame in-memory shared token/grant validation. Bounded native
  work remains actual-completion-owned4/8, including cancellation/timeouts and
  pre-start cancellation. No AnyIO HTTP-limiter starvation. Operational errors
  must not falsely instruct an owner lock.
- One immutable socket pair, both consent/ready, glare/attempt ownership, no
  third-socket join/end/media. Strict frame/schema/sequence/rate/queue bounds.
- Deferred outer-transition overflow eviction, terminal phase purge, safe last
  terminal epoch drops without granting stale accept/ready or new-call authority.
  Caller ended always correlates the original request, including before outgoing
  delivery. Wrong requests cannot retire pending attempts; old requests cannot
  tear down a newer incoming/accepted call. No stranded empty graph/busy owner.
- Shared cached authority/lifetime gate at BOTH media admission and dequeue.
  Both members remain eligible; ineligible endpoints are removed immediately.
  Call lifetime ends media while authorized presence remains. No native I/O per
  frame. Exceptional exits retain4401 real expiry/revocation versus4408 overdue
  refresh,1001 cancellation and4429 capacity. Bytes already sent cannot be recalled.
- Production-bound capture provenance; bounded transfers/credits/relay/playout;
  one graph state control in flight, actual render acknowledgement and original
  lease expiry. No late TCP/MessagePort catch-up or fresh budget on delayed ack.
- Controller pagehide always detaches. Panel alone may authorize cached-page
  presence restoration after hidden/shield/idle/expiry policy. Actual lock/dispose
  prevents restoration; no call, microphone, graph or suspension is restored.
  Whole chatView.attach refreshes thread/SSE/media and must preserve drafts and
  staged/in-flight work. Check event ordering and silent grant renewal honestly.
- Parent's additional red/green integration fix: persisted pagehide invokes the
  EXISTING onHidden policy if not already handled; hiddenTransitionHandled makes
  the following hidden notification idempotent until onVisible resets it. Inspect
  missing/delayed hidden events, both pagehide orders and shield re-hide behavior;
  do not assume a final hidden UI proves no transient unauthorized socket opened.
- Constructor failure on Answer sends decline immediately, before-invite failure
  sends no invented action. Recorder ownership disables starting calls, while
  presence reconnection stays usable with pulse stopped. disconnect final render
  occurs after socket=null. Both handler guards and UI state remain necessary.
- Presence cap remains16; remove redundant _drop/failed-Invite broadcasts without
  coalescing arbitrary controls. Single-process, memory-only broker, no call SSE
  or schema, self-hosted LF worklet/bundles, bounded actual Uvicorn options.

Parent-local proof on this runtime source (not independent audit evidence):

-62 focused Python call/repair tests pass with configured4 workers. Parent red
  tests reproduced early terminals, media admission/dequeue boundaries and queue
  duplication. Route exceptional-exit classification includes real authority
  facts at an injected run_peer seam; existing real signed-JWT, native worker,
  grant revocation and fragmented-Uvicorn tests remain green.
-1,714 frontend chat tests pass; strict TS, full mypy244 files, ruff check and
  format909 files, LF build and base-to-current diff check pass. Parent originally
  reproduced UI/cache failures before repair; current panel/grant coverage
  includes the additional missing-visibility policy regression.
-Grid scoped browser job `t-0e00986d0993` ran on hub:2 tests passed in30.9s,
  runner exit0. Actual local Chromium + backend + worklet: audible duplex,
  forced450ms stall cleanup without presence disconnect, fresh consent, muted
  idle pause, panic cleanup/full remote countdown, same-login third browser
  zeroPCM/no prompt/no mic. Persisted-page scenario with actual panel/chatView/
  thread preserves typed draft, opens exactly one new presence socket, restores
  no audio, and cannot restore after panic lock. Lifecycle events were injected;
  this is not physical BFCache eligibility or mobile-platform proof.

All claimed tests distinguish their real seams from physical acceptance. The
new combined logic must stand on current code; reviewer agreement is not proof.
You may run focused discriminators, not full CI/repeated blanket suites.

External gates STILL OPEN: physical Android Chrome/iPad Safari/actual iPhone
browser, production hostname/Access/tunnel across networks/cellular, measured
15-minute duplex/speakerphone quality and latency/jitter/loss, and actual Slots
old-process drain/hard-stop including blocked native jobs. Native executor jobs
cannot be killed by cancellation; wait=False is not a process-exit guarantee.
Report code verdict and live readiness separately; never certify these from
synthetic audio, mocks, declared config or passing component tests.

Write ONLY `spec/server-chat/voice-call-implementation-audit-round3.md`, including
reviewed SHA, C/H/M/L counts, concrete reproduced findings/file lines/repair and
honest limits. A clean result is valid. Do not edit source/branches/commits,
push, PR, merge or spawn agents. Peer parent with artifact and verdict, then
complete the assigned lane. Parent owns any repairs and delivery through an
actual confirmed merge SHA; no PR or delivery currently exists.
