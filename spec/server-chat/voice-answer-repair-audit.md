# Senior audit: Answer setup and Transcribe recovery

Cumulative subject (round 4): `22571a22efe72ebb975702b0539c8a5e41bade0c..514b133d2f703ddbace7d306dc8121b39235e5a4`
(corrected head `514b133`, "fix: close call diagnostic and transcription renewal gaps"; previous
candidate `69c071d`). Reviewer: senior audit rung (opus), 2026-10-18. Read-only review. No source,
branch or asset changes. I added only this report, plus temporary probe tests that I deleted after
running them.

## Scope and what this audit does NOT claim

- I re-reviewed the full cumulative candidate against the packet's 7 acceptance criteria, focusing
  on the round-3 repairs: F2 (capability ownership independent of history), F5 (a stall first seen
  by a socket message is now visible), and F3/F4/F6 (wording, dismissal, per-attempt traces).
- **The real reported Android Chrome -> iPhone Safari failure has not been reproduced or shown to
  be fixed.** Every result below comes from jsdom unit tests or from reading the code. I did not
  re-run the Playwright Chromium scenarios, the live private ASR probe, the full 2635-test suite or
  any physical-device test. A retest on the affected pair after release is still required, and that
  result should be recorded separately.

## Measured checks (round 4, head 514b133)

| Check | Result |
|---|---|
| Focused vitest: `call`, `callAudio`, `callDiagnostics`, `callRepairs`, `serverThread` | 5 files, 214 tests passed (209 in round 3, plus 5 new discriminators) |
| Wider vitest: `tests/server/**` + `serverThread` + `serverTranscript*` | 58 files, 1744 tests passed |
| `tsc --noEmit` and `tsc -p tsconfig.sw.json` (strict) | exit 0 / exit 0 |
| In-memory esbuild rebuild (`write:false`, `esbuild.config.mjs` options) vs committed assets | `call-worklet.js`, `admin.js`, `admin.js.map`, `admin.css`, `admin.css.map`: all byte-identical |
| `git diff --check` (cumulative range) | clean |
| EOL / `Release-note:` | LF; `Release-note: General bug fixes and improvements.` |
| Backend / wire | no `wixy_server` Python change in the range. Control types sent are still auth/invite/accept/decline/end/failed/ready/ack/lease/mute/pong. |

### Round-3 probes re-run against 514b133 (RED at 69c071d -> GREEN now)

| Probe | 69c071d (round 3) | 514b133 (round 4) |
|---|---|---|
| P1: connected stall, socket message arrives first | plain `end`, notice hidden, 0 console entries | `failed {callId}`; notice "The browser paused, so the call stopped..."; 1 console entry containing `main-thread-stalled`; expired `capture` dropped (`captureLease` not called) |
| P2: failed outgoing attempt, then an unanswered incoming call times out | trace mixed `confirm..setup-failed,incoming,remote-ended`; 1 console entry in total | 2 console entries; second trace = `incoming,remote-ended` only |
| P4: idle socket close | overlay notice shown | no overlay; one separate console trace `[socket-closed 1006]` |
| P5: silent renewal with pending, then failed, history | Transcribe hidden; 0 `/usage` calls | Transcribe visible during and after; `/usage` called for the new owner |

### New round-4 probes

| Probe | Result |
|---|---|
| P6: socket closes during a connected call | notice shown; trace kept for the attempt: `confirm,outgoing,preparing,ready,connected,socket-closed` |
| P7: Copy -> Dismiss -> late clipboard rejection | notice and `pre` stay hidden and empty; 500 ms of pulse re-renders do not bring them back |
| P9: fresh attach where the probe resolves before slow history | Transcribe present once history renders; one `/usage` call |
| P10: renewal probe gets a 401 for the new owner while the old owner's 401 arrives late | `lockNow` called exactly once (new owner only) |
| P11: detach while a probe is in flight | probe aborted; 0 further `/usage` calls in 60 s |

## Acceptance criteria (cumulative)

1. **Single setup-only resume, safe on cancellation: MET** (unchanged since round 3). One resume
   after capture. Tracks are owned before the await, `stopped` is checked after it, and a rejection
   or a context that stays suspended fails closed. A stale `prepare` cannot build a graph, keep a
   track, re-take `micPermission` or revive the call. Waiting is bounded by the 20 s setup budget.
2. **Pulse reset only on a valid initial `connected`: MET.** A duplicate `connected` cannot reset
   the clock. The broker's freshness checks and leases are unchanged. Connected stalls now fail
   closed and visibly on both detection paths (pulse and socket message).
3. **Failure signalling and pair/request/terminal semantics: MET.** Every technical failure sends
   the existing strict `failed {callId}`, which the broker maps to `audio_unavailable`, and the
   failing device shows a notice. The other device's wording no longer guesses a microphone cause
   ("couldn't connect the call" / "couldn't continue the call"). The diagnostic sink and console
   entry are wrapped in try/catch. Membership is unchanged.
4. **Diagnostic privacy and bounds: MET.** Fields are allowlisted, there are at most 32 entries,
   and there is no content, IDs, labels, URLs, tokens or exception text. No upload or persistence,
   no per-frame logging. The trace now resets on an explicit attempt, an incoming invite, a
   connection opening and detach/lock. Idle transport failures get their own trace. A failure
   during an active attempt keeps that attempt's trace. Dismissing (`noticeEpoch`) stops a late
   clipboard result from bringing back the fallback text.
5. **Capability recovery: MET.** Only GET `/usage` is used, with a 5 s abort and a 15 s retry
   while unavailable, under one owner at a time. Attach now invalidates and aborts the old owner
   without hiding Transcribe that is already known to be available, and starts the new owner's
   probe independently of history success or the wipe generation. Detach/teardown/markUnavailable
   still reset availability. Stale results and 401s are ignored. No transcription is ever started
   automatically, and the server still re-checks private mode itself before sending audio
   (`fresh=True`).
6. **Header, confirmation and lock policy: MET.** Phone button right of the overflow button, no
   dropdown, explicit recipient and Call confirmation. The notice sits below the header and has a
   "Dismiss call details" button. Idle disconnects no longer cover the thread. Multi-tap panic still
   counts taps on the notice, and lock/`pagehide`/detach clear the notice and the trace.
7. **Honest scope: MET.** The packet, docs and runbook say the controlled tests are not acceptance
   on the affected device. The `livechat.md`/`testing.md` statements now match the code.

## Findings

All five round-3 findings are **fixed**. I found no new findings.

| ID | Sev | Disposition | Verification |
|---|---|---|---|
| F5 | medium | fixed | `controller.ts` onmessage: records `main-thread-stalled`, calls `end(..., true)` and returns before `receive()`. Shown by P1 plus the new unit test. |
| F2 | medium | fixed | `thread.ts` attach: `stopTranscriptionProbe(false)` keeps known availability, and the probe starts before history. Shown by P5, P9, P10, P11 plus the new unit tests (renewal, history failure, wipe). |
| F6 | low | fixed | reset on `incoming` and in `open()`; idle `connectionFailure` gets a separate trace and console entry. Shown by P2, P4, P6. |
| F3 | low | fixed | the other device's `audio_unavailable` text is cause-neutral; the wire is unchanged. |
| F4 | low | fixed | Dismiss control, clipboard-epoch guard, and no overlay for idle transport failures. Shown by P4, P7. |

### Residual observations (not filed, unchanged from round 3)
- `CallAudio.stop()`'s `stopped` step is dropped whenever the controller tears the call down,
  because `callEpoch` is bumped first. It is a diagnostic gap only.
- The "permission was denied" text keys off any `NotAllowedError`, including a rejected
  `AudioContext.resume()`. This is unlikely on WebKit after the first activation, and the trace
  tells the cases apart.
- `getUsage`'s abort does not cover reading the response body after headers arrive (the
  `serverFetch` listener has been removed). Only the current owner's retry slot could be held up.
- If the browser refuses to construct the WebSocket during a manual "Reconnect calls", only the
  hidden status changes. That matches production behaviour and is extremely unlikely for a
  same-origin `wss:` URL.

## Verdict

**Clean at the senior rung for a diagnostic release: C0 / H0 / M0 / L0 open. All five round-3
findings are verified fixed.** The scope is bounded: this rests on jsdom unit tests, targeted
probes and reading the code, plus the author's reported Chromium runs, which I did not re-run.
**It does not show the physical Android -> iPhone failure is solved.** The retest on the affected
pair after release, and its result, are still required.