# Independent implementation audit — round 3

Reviewed HEAD: `b2c01b60eb7bb4b11e9b1dde335f245c452cf625`.

Comparison base: `7a952c6cc590e5acf67996c1a7cbcc1b474a7ddc`.

Reviewer: fresh independent senior audit, session
`664a9c17-cca9-4e39-bf3b-81cbb12927ef`, 2026-10-18. One bounded pass,
within the requested 20-minute limit. HEAD and clean working state were verified
before inspection and again before writing this report. This report is the only
authored checkout change. No implementation changes, child agents, branches,
commits, push, PR, merge or deployment were made.

## Verdict

**Code verdict: PASS for this frozen candidate within the scope of this audit.**
No actionable implementation defect was established by source inspection and
the focused checks below.

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |

There is therefore no defect reproduction or corrective patch requested by this
review. This is not a claim of exhaustive correctness. **Launch acceptance is
still OPEN**, independently of the code verdict; the outstanding gates below
are not silently converted into passes or counted as code defects.

## Independent review basis

Read the round-3 audit packet, `04-voice-calls.md`, its adopted architecture
ruling, Inv 55 and the relevant current contracts, live-chat documentation and
runbook. Inspected the complete new route, broker, protocol, controller, audio
owner and worklet, plus their auth, grant-store, app-lifetime, panel, chat-view,
thread, build and launch integration. Earlier implementation audit reports and
proposal/merge report files were not consulted. Previous lane-result summaries
incidentally returned by the lane-registration lookup were not used as evidence.

The following are source conclusions at the reviewed SHA, supported where
specified by independently executed existing tests. They are not adoption of
the parent's claimed test results.

| Boundary | Inspection and conclusion |
| --- | --- |
| Dual authorization | `wixy_server/routes_livechat_calls.py:26` and `:37` enforce exact configured Origin, no query, the public subprotocol, independent Access verification and nonempty email/finite future expiry before acceptance. `wixy_server/app.py:464` binds the real shared signature/audience/issuer verifier. First-frame validation uses the shared unlock/email/grant helper, then the earlier Access/unlock deadline. The store liveness check at `wixy_server/livechat/store.py:3043` is read-only and checks owner, revocation and idle expiry. |
| Actual native completion | `wixy_server/livechat/call_broker.py:40` owns separate admission/refresh executors with capacities 4/8. A concurrent future's completion callback releases the permit; cancellation of an awaiting coroutine does not release a running job. Submission failure and cancellation before execution release correctly. This path does not consume AnyIO's HTTP thread limiter. Socket counts and native-work counts are separate bounds. |
| Pair and consent | `call_broker.py:293` fixes caller/callee socket IDs at invitation, restricts answer to the callee, and requires both members ready before connected media. Same email/token does not confer membership on a third socket. Request correlation and the controller's generation checks preserve the winning incoming/Answer attempt during glare. |
| Terminal correlation and overflow | `call_broker.py:80`, `:180`, `:238` and `:263` defer overflow removal to the outer transition, purge old call controls/media/credits, and echo the caller's original request on every terminal. Caller terminal handling in `admin-ui/src/server/call/controller.ts:221` also works before `outgoing` is delivered. Only harmless controls/media from that socket's last terminal epoch are ignored; stale accept/ready and foreign membership are still rejected. The control queue remains capped at 16, with no general control coalescing. |
| Per-media authority and lifetime | `call_broker.py:388`, `:410` and `:446` share the cached both-member eligibility/lifetime gate at admission and dequeue. Expired/revoked/overdue members are removed and the call is cleared; lifetime expiry alone retains authorized presence. These paths perform no native I/O. `routes_livechat_calls.py:219` preserves actual expiry/revocation as 4401 and overdue refresh as 4408 even after an exceptional media exit; cancellation stays 1001 and capacity failure 4429. |
| Capture provenance and bounds | `admin-ui/src/server/call/worklet.ts:105` binds lease, revision and first-sample time while producing a buffer. `audio.ts:30` validates that provenance and returns owned storage even when its consumer throws. The controller sends that lease unchanged. Fixed capture buffers, relay queues, receiver credits and the fixed playout ring bound backlog; sequence/schema/rate checks reject malformed or excessive input. |
| Render freshness | `worklet.ts:73` acknowledges state from `process()`, not merely its port listener. `audio.ts:71` subtracts elapsed wall time and remaining audio time from the original state expiry; a delayed ack receives no fresh 300 ms allowance. `audio.ts:129` allows one state in flight and coalesces only the desired graph state. The receiver retains that original expiry, and the worklet checks sample deadlines while rendering. |
| Local ownership and teardown | `controller.ts:115`, `:138`, `:200`, `:299` and `:344` invalidate attempts, stop audio and release suspensions before network cleanup. Late permission/readiness cannot revive an old attempt. Constructor failure on Answer declines; failure before invitation invents no call action. Recorder ownership has both UI and handler guards. Disconnect renders after clearing the socket, so presence reconnection remains available without a running pulse. |
| Idle versus actual lock | The controller acquires `voiceCall` only when connected and retains it while muted. `panel.ts:699` releases suspensions idempotently and restarts the full idle period when the last one ends. `voiceCall` is absent from `isPickerOrMicOpen`. Actual lock/shield detach/disposal still reaches `chatView.detach`/`dispose` and synchronous audio teardown. Token replacement reconnects presence and ends any call, as documented. |
| Persistence and deployment wiring | Call data remains in the broker/audio ownership graph, with no call store, SSE, notification or transcription write path. `wixy_server/__main__.py:35` applies the bounded WS options; the standalone Docker entry point uses this module too. App lifespan invokes broker shutdown. Executor shutdown explicitly cannot kill running native work; declared Slots force-kill configuration is not proof of actual process drain. |

## Persisted-page, listener and renewal ordering

Inspected `admin-ui/src/server/panel.ts:1022` through `:1117`, together with
`detachChatView` at `:229`, session adoption/renewal at `:539` and `:568`, shield
restoration, and `chatView.ts:119` / `:140` / `:156`.

* The panel registers lifecycle handlers before a later unlock constructs the
  call controller. Persisted pagehide applies the existing hidden policy itself;
  it does not depend on a subsequent hidden visibility notification. The
  controller's pagehide handler then detaches unconditionally, including when
  the hidden policy permits the chat to remain open.
* With visibility-hidden first, `hiddenTransitionHandled` prevents pagehide
  from applying the same hide twice. With pagehide first, it suppresses the
  subsequent hidden event. This matters for shield mode: one hide is not
  accidentally classified as a second switch. Visible return resets the flag,
  so a real re-hide can still taint the shield and cancel restoration.
* Lock/detach clears the pending presence-restoration marker. Restoration waits
  for eligible visible chat state, checks idle-away before reattach, and sends
  expired sessions through the existing expiry/renewal policy. A shield must
  resolve through its existing policy before its chat is attached again.
* Renewal does not resurrect a locked/disposed session: the pending response
  retains session identity, and adoption into a shielded session does not attach
  a detached view. A renewal-dependent shield restore additionally requires a
  visible, untainted shield and a live renewed session. Ordinary token adoption
  into an attached chat can reconnect presence, but cannot restore consent or
  audio. Hidden-policy `ignore` remains the existing permission to keep chat
  active; this review does not redefine it as a mandatory hidden lock.
* The eligible cached-page path calls the whole `chatView.attach`, refreshing
  thread/history/media and SSE while retaining the existing view/composer and
  staged work. It does not call thread detach as part of that refresh. The
  controller's cleared session/call state means the refreshed call connection
  is presence only.

These ordering conclusions combine source tracing with the tests below. The
panel tests use a tracked/stub chat view; they are not independent real-browser
proof of every event ordering or physical BFCache eligibility. The parent's
reported real-view draft-preservation test was not rerun in this pass.

## Checks executed by this reviewer

All commands returned exit 0. No full CI or blanket regression suite was run.

1. **42 Python tests passed**, using the repository's configured four workers:

   ```text
   python -m pytest wixy_server/tests/test_livechat_call_repairs.py wixy_server/tests/test_livechat_calls.py -q -k "cancelled or saturation or overflow or media_enforces or early_terminal or exceptional_media or access_gate or origin_gate or live_socket_pair or real_uvicorn or same_identity"
   ```

   This includes real signed-JWT validation, a real local Uvicorn fragmented
   oversize rejection, controlled blocking native workers, pre-start
   cancellation, overflow transitions, early-terminal correlation, third-socket
   exclusion and both media-boundary gates. Grant-return tests use controlled
   store collaborators; exceptional-close tests inject `run_peer`. They do not
   prove actual production database/tunnel behavior or blocked-process exit.

2. **142 frontend tests passed**, from `admin-ui/`, in three non-overlapping runs:

   ```text
   npm test -- tests/server/callRepairs.test.ts tests/server/callWorklet.test.ts tests/server/panel.test.ts
   # 92 passed
   npm test -- tests/server/panelGrant.test.ts -t "shield|SECOND switch|screen lock while|page entering|pagehide|pageshow|renewal that lands|torn down"
   # 40 passed, 148 skipped
   npm test -- tests/server/call.test.ts tests/server/callAudio.test.ts
   # 10 passed
   ```

   These check attempt correlation, recorder guards, original render-ack expiry,
   capture provenance/recycling, 44.1/48 kHz synthetic resampling, expired
   playout, late microphone cleanup, cache policy, shield re-hide, renewal and
   disposal. They use controlled DOM/audio/clock collaborators, not physical
   microphones or speakers.

3. Rebuilt the worklet **in memory**, with the build's bundle/minify/IIFE/ES2022
   options and `write:false`: byte-for-byte equality with the committed
   `wixy_server/static/admin/call-worklet.js` was true. No bundle was overwritten.
   `git ls-files --eol` confirmed LF for the call sources, panel/chatView/thread
   integration and committed worklet. Base-to-HEAD `git diff --check` passed.

The parent's full 62-server/1,714-frontend totals, strict Python/TS checks,
complete frontend build and Grid Chromium duplex/stall/cache results remain
parent-supplied evidence. This pass neither reran nor relabeled them as its own.

## Unproven launch gates and limits

The code verdict does **not** certify any of the following:

* Physical Android Chrome, iPad Safari and the actual iPhone browser; microphone
  permission/device cleanup, output, screen/background behavior and real cache
  eligibility on those devices.
* The production hostname through Access and the Cloudflare tunnel, between
  different networks including cellular, with real expiry/revocation and
  network/tunnel interruption.
* The required 15-minute duplex and speakerphone runs, understandable double
  talk/echo behavior, bounded long-term drift/queues, measured one-way p95
  latency and the prescribed delay/jitter/loss challenge. A connected socket or
  synthetic tone alone does not satisfy these gates.
* Actual Slots old-process drain and hard-stop with blocked native jobs. The
  native quotas bound live work, not its duration; `shutdown(wait=False)` and
  Uvicorn's two-second grace do not establish interpreter termination.
* Final delivery. No PR or confirmed delivery merge was produced by this audit.
  The parent owns fixes if subsequently found, remaining acceptance, and the
  actual confirmed delivery merge SHA.

Already-sent network bytes and audio committed to a device output quantum cannot
be recalled. The reviewed design bounds residual audio with leases and liveness;
it does not promise instantaneous remote silence, end-to-end encryption or
mobile-telephone background continuity. Any source change after the reviewed SHA
falls outside this verdict.
