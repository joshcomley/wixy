# Live voice notes stream through the call audio path

**Ask.** The operator wants an optional "live" voice-note mode: the other person hears the note
while it is still being recorded, with pause and live transcription that corrects itself. See
spec/server-chat/07-live-voice-notes.md for the verbatim request and the full contract.

**Decided.**
- In live mode the sender uses spec 06's live upload with a 1 s timeslice.
- The server decodes the growing upload with one long-lived ffmpeg into the call's 24 kHz PCM
  frames. Listeners get them over an authenticated WebSocket and play them through the call's
  existing bounded AudioWorklet player.
- Late listeners are fed from the stored upload, faster than real time, under credit control.
- Transcription is opt-in (Inv 50). It re-transcribes a rolling window privately every ~8 s,
  finalises text at sentence ends and keeps the unfinished tail provisional.

**Why this transport.**
- *Rejected: 15 s chunks.* They are too slow for "a bit like being on the phone".
- *Rejected: MediaSource Extensions with a growing webm.* iPhone support for webm/opus through
  ManagedMediaSource is unproven, and Bubble uses an iPhone.
- *Rejected: live HLS.* It means 6+ s of latency, a playlist server and segment files.
- *Chosen: the call audio path.* It is already built, already bounded and already designed for
  both phones. Latency is about 1 s slice + upload + decode, roughly 2-3 s.

**Why cancel becomes delete.** In live mode the audio may already have been heard, so "cancel"
can only honestly mean "delete for everyone". The confirm says so.

**Watch for.**
- Resource bounds: 2 live recordings per chat, 4 listeners per note, and the auto-end rules.
- The physical-device gate (both real phones over the tunnel) is required before calling this
  production quality, as for calls.
