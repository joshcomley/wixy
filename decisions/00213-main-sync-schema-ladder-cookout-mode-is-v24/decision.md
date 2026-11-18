# 00213 - Main sync: the schema ladder and invariant numbers

**Symptom.** Merging main (live voice) into cmd/workspace-00058 conflicted: both lines used schema v22
(main: `uploads` live columns; Cookout: `cookout_rounds.mode`) and both added an Inv 58.

**Decided.** Main's numbers are already deployed, so they stay: v22 uploads live columns, v23
`attachments.live_state`, Inv 58 chat search, Inv 59 live voice. Cookout's `mode` column becomes **v24**
(`_LATEST_SCHEMA_VERSION = 24`) and the Cookout pictures invariant becomes **Inv 60**. The v24 step also
re-adds the live-voice columns if absent (all column-guarded), so a database the Cookout branch stamped 22
(which would otherwise skip main's v22/v23) still migrates fully. `activate_modes.py` requires schema >= 24.

**Also.** The live-voice heartbeat window (`PONG_TIMEOUT_S`, 6 s, real clock) dropped a test client starved
by a loaded box (close code 1000, `test_state_and_peaks_grow_as_slices_arrive`); the test kit now lifts it,
with a regression test that is red without the lift.

**Watch.** Version asserts are exact (`== 24`), never `>=`; the next migration bumps them deliberately.
