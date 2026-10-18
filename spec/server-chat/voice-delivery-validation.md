# Final candidate validation

Product candidate: `baa0b5855f955f7bc60a0e5f82fa706160ac56c8`.
The product runtime through `a2030d5` has the whole-capability audit at `b2c01b6`
and the focused lifecycle audit at `a2030d5`, both PASS C0/H0/M0/L0. Later product
changes only theme and place the call controls beside the header's ⋯ menu, with
phone/hang-up/microphone SVG icons, accessible names and stable icon rendering.
No protocol, authorization, audio-processing or lifecycle behavior is changed.

Final local checks:

- Strict TypeScript (including service worker) passed.
- Call, call-repair and thread/drawing controls: 37 tests passed.
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
