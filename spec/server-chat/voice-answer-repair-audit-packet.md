# Senior audit packet — Answer setup and Transcribe recovery

Review the frozen commit supplied in the audit request against production merge
`22571a22efe72ebb975702b0539c8a5e41bade0c`. The branch also contains archival
delivery receipts from that earlier release; focus on this new repair's code.
No PR or repair deployment yet. Do not change source, branch or generated assets.
Write findings and verification to `spec/server-chat/voice-answer-repair-audit.md`.

## Intent and evidence limits

The operator reports Android Chrome→iPhone Safari returns to Call just after
Answer, and separately reports Transcribe becoming unavailable/disappearing.
The actual iPhone failure has not been captured. The operator explicitly permits
a diagnostic release. The candidate handles two plausible, locally reproduced
setup gaps and provides technical details for the actual affected-device retest;
do not certify the real iPhone problem solved from those controlled models.

Context only: WebKit reports [capture/resume interaction](https://bugs.webkit.org/show_bug.cgi?id=239996)
and [interrupted contexts](https://bugs.webkit.org/show_bug.cgi?id=273511). These
are not evidence of this particular device's failure or its installed OS version.

## Changed mechanisms

- `call/audio.ts`: one resume during explicit preparation if capture left an
  activated context non-running/non-closed. Tracks are owned before the await;
  stopped guard after it. No recovery during an already-connected call.
- `call/controller.ts`: initial connected transition starts a fresh pulse clock,
  because there was no active media before consent/readiness. Connected freshness,
  leases, buffers and stall budgets are unchanged. Technical failures use the
  existing strict `failed {callId}` action and existing audio_unavailable terminal.
  Both endpoints show visible failure notices. Existing immutable membership,
  crossing requests, late controls, explicit confirmation and lock ownership apply.
- `call/diagnostics.ts`: last32 technical steps for one attempt, a one-time console
  entry on failure and explicit clipboard/selectable-text UI. Allowlisted stage,
  context/error names, numeric rate/close code, relative timings and extracted
  browser/OS version numbers only. No media, transcripts, message content, labels,
  identity, socket/call IDs, credentials, URLs, full UA or exception messages/stacks.
  No automatic upload or app persistence. Reset on new consent and detach/lock.
- `thread.ts`, `api/messages.ts`, `transcript.ts`: abortable5s GET usage capability
  checks;15s retry while unavailable and attached. Generation and controller/timer
  ownership prevent stale results/401s affecting a new attachment, even if the same
  session object is reused. Restore controls only on affirmative availability and
  clear the obsolete unavailable notice. No automatic audio request/retry; the
  backend fresh-private-capability gate is unchanged.

## Acceptance criteria

1. Preparation resume is single, bounded by existing setup ownership and safe on
   cancellation/rejection/continued suspension. Late resume cannot build a graph,
   retain a track, reacquire a pause or revive a retired call.
2. Reset pulse clock only for a valid new connected transition; actual connected
   stalls still fail closed and no capture/playback provenance or expiry is renewed.
3. Failure signaling preserves immutable pair/request correlation and all formerly
   audited lock, terminal and capacity invariants. Diagnostics cannot throw into
   ownership transitions or introduce arbitrary control forwarding.
4. Diagnostic privacy and bounds are real: no audio/content/identity/credentials/IDs/URLs/
   exception text retained, logged, uploaded or copied; no per-frame logging;
   no cross-attempt/locked-view technical trace resurrection.
5. Capability recovery remains GET-only, one current owner, aborts/cancels timers,
   ignores retired replies and cannot auto-transcribe or bypass private mode.
   Check real attach/detach/shield/wipe/dispose integration, not just helper mocks.
6. Header remains phone right of⋯, no dropdown, explicit recipient/Call confirmation.
   Failure notices and copy fallback fit phone width and do not swallow panic lock.
7. Report exact scope and measured controls; physical iPhone success is still a
   post-release observation, not a claimed result.

## Local proof already run (independent checking welcome)

- Full frontend:2630 tests across102 files; strict TypeScript; LF asset rebuild.
  (The final extra test covers a throwing diagnostic console sink.)
- Red/green tests for capture suspension, stopped pending resume, rejection/still
  suspended, cold connected pulse, unavailable Transcribe recovery without POST,
  abort/retired-owner denial, diagnostic bound/redaction and local/peer notices.
- Actual Chromium: duplex/privacy/stall/muted-idle/panic (26.9s), cache recovery,
  denied mic plus phone-width safe copy details, and capability recovery without
  audio resend;4 scenarios passed39.6s total. The browser recovery case need not
  wait15s if a fresh probe is already affirmative; the timer path is unit-tested.
- Live private synthetic-silence ASR path returned200 after a fresh private:true
  capability check. No human recording or transcript was inspected or printed.

Do not run blanket CI or dispatch children. Run focused controls as useful;
return C/H/M/L findings with reproducible defects and a bounded verdict.

## Senior round 3 repair response

The first candidate69c071d received C0/H0/M2/L3. All five findings are repaired,
with no dismissals. The original evidence above remains historical for that head.

- F5 (medium): socket-first connected stall now records main-thread-stalled,
  takes the existing failed-control/visible-notice path, and returns before
  parsing the expired message. The discriminator drives the real controller's
  socket callback before the pulse timer and verifies failed, stopped media,
  no capture lease, and copyable failure details.
- F2 (medium): attach invalidates probe ownership/aborts timers without clearing
  known availability. It starts the replacement GET before the independent
  history operation, so a history failure or wipe-generation return cannot
  strand recovery. Detach/teardown/markUnavailable still reset availability.
  Tests cover visible Transcribe during silent renewal, failed history and wipe,
  with no automatic audio POST. Existing old-owner denial/abort controls pass.
- F6 (low): incoming invites and connection openings reset diagnostics. Idle
  transport errors start a separate trace before logging; active failures retain
  their current attempt. A consecutive outgoing-failure/incoming-close/idle-close
  test verifies fresh traces and one console event for each failure.
- F3 (low): the existing wire reason audio_unavailable remains unchanged, but
  peer wording now describes a call connection/continuation failure without
  guessing microphone permission. Local exact causes retain their own wording.
- F4 (low): the notice has Dismiss call details; clear invalidates pending
  clipboard UI so a late rejection cannot recreate its fallback. Idle transport
  failure uses existing status and a separate technical console entry, without
  displaying the thread overlay. Real phone-width browser proof covers dismiss.

Five new targeted cases were RED at69c071d and GREEN after these repairs.
Full frontend2635/102 files, strictTS and LF build pass on the repaired source.
Four real Chromium scenarios pass38.2s total: duplex/privacy/stall/muted-idle/
panic26.6s; cached recovery1.0s; denied microphone, safe phone-width copy and
dismiss2.3s; Transcribe recovery without audio resend1.9s. Parent inspected the
phone-width screenshot: notice, copy fallback and Dismiss fit without covering
header controls. Browser diagnostic platform is desktop under viewport emulation,
not an actual iPhone. No backend or wire contract changed in this delta.
The affected physical Android/iPhone pair still needs a post-release retest.
