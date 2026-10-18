# Final candidate validation

## Final operator correction

The operator subsequently requested a separate Call confirmation, removal of the
header drop-down and the phone icon immediately **right** of ⋯. This supersedes
the placement description below. The phone now opens a nonmodal device list with
Cancel and Call buttons. No invitation or microphone activation occurs until
confirmation. Escape, Cancel, outside click and teardown dismiss the picker.
Unavailable recipients remain unselected rather than silently changing the target.

Strict TypeScript and all2617 frontend tests passed, including explicit
confirmation/cancel/detach and unavailable-selection checks. The browser scenario
now checks phone-width right-hand placement, zero header selects, no incoming
call or microphone before confirmation and picker containment within the viewport.
Its first local visual assertion caught a60px off-screen picker; anchoring the
picker to the header corrected that before publication. The existing duplex,
isolation, stall and mute/lock checks continue through the explicit confirmation.

The extra confirmation exposed a rapid-tap classification error: marking Mute as
an overlay boundary made Call→Confirm→Mute three boundary taps and locked chat.
Only the popup opener and its popup retain boundary semantics; Mute/End/Answer
are ordinary controls. Escape still reaches the panel's panic handler.
The corrected actual Chromium scenario passed in27.2s (31.6s total), including
phone-width placement/picker containment and no invitation/audio before the
confirmation, then duplex/stall/fresh-consent/muted-idle/isolation/panic checks.

Final CI also found seven existing view-once scenarios locking unexpectedly.
An actual Chromium handshake probe reproduced omitted context extraHTTPHeaders
on WebSockets: HTTP identityalice, WS identityempty, close4401. The loopback-only
E2E fixture now carries that fake identity through an HttpOnly cookie into the
fixture's WS scope, matching Access's per-request identity behavior. The actual
product socket token/identity validation is unchanged. The probe turned green
(no close, thread remains open), and all7 view-once scenarios passed locally.

The container job's ECR pull returned429 before any source build. CI now pulls
the same official Python3.14-slim tag from Docker Hub if the ECR mirror is
unavailable, then builds once. The official fallback manifest probe returned200;
actual container build/boot remains a final CI gate.

## Earlier candidate evidence

Product candidate: `baa0b5855f955f7bc60a0e5f82fa706160ac56c8`.
The product runtime through `a2030d5` has the whole-capability audit at `b2c01b6`
and the focused lifecycle audit at `a2030d5`, both PASS C0/H0/M0/L0. Later product
changes only theme and place the call controls beside the header's ⋯ menu, with
phone/hang-up/microphone SVG icons, accessible names and stable icon rendering.
No protocol, authorization, audio-processing or lifecycle behavior is changed.

Final local checks:

- Strict TypeScript (including service worker) passed.
- Call, call-repair and thread/drawing controls: 37 tests passed.
- Final CI identified an obsolete `serverChatView` thread mock missing the new
  header-mount method. Reproduced locally (5 failures), updated that fixture,
  and reran the affected42 tests plus the full frontend suite: all2615 tests
  across101 files passed. This correction changes only the test double.
- LF frontend assets rebuilt and committed; diff whitespace check passed.
- Real Chromium existing duplex scenario passed in26.7s (42.5s total): two-way
  synthetic audio, third-browser isolation, forced stall and fresh consent,
  muted idle suspension, panic teardown and fresh idle countdown.
- Dark-theme idle layout checked at320/360/390/768px and incoming-call layout
  checked at390px: controls immediately precede ⋯, share its row, have SVG icons,
  themed backgrounds and36px button widths, without document overflow.
- Preview launcher lint/format passed; unsafe test-output runtime placement was
  manually confirmed rejected. Preview source is now immutable `baa0b58` under
  Devfleet, using `.scratch/voice-preview-runtime`, with health200 after restart.

The operator reported the physical phone call worked, supplied Android Chrome
screenshots, requested the UI correction, then explicitly requested publication.
This is not a claim of documented 15-minute speakerphone acceptance, latency/jitter/
loss statistics, all mobile platforms or actual blocked-worker Slots hard-stop.
Those measurements remain unrecorded. Previous synthetic/manual component checks
and independent audit scopes remain separate evidence, as documented in the
preview and implementation-audit reports. Do not inflate them into those results.
