# Voice notes upload live and run up to four hours

**Symptom / ask.** The operator asked why voice notes stop at 15 minutes and whether they could
be recorded in pieces and joined, "enabling voice notes of any length" (2026-11-12, after a
15:00 note failed — decisions/00209).

**Cause of the limit.** R11 (spec/server-chat/00-brief.md) set voice to 25 MiB / 15 min as a
design choice for small files and quick processing. It is not technical. The 25 MiB cap was the
tighter of the two for Safari, which records at about 180 kbit/s, so it stops a note at about
18 minutes.

**Decided** (full contract: spec/server-chat/06-long-voice-notes.md):
- The recorder emits a 15 s slice. Slices are uploaded live to a `live` upload and joined by
  concatenation, because one MediaRecorder session is one continuous stream.
- 4 h / 512 MiB voice caps. These are runaway guards, not product limits. The recorder asks for
  64 kbit/s.
- An unfinished live upload, for example after a crash, a killed tab or a dead phone, is offered
  back to the same device as "Unsent voice note" with Send / Discard. It is never sent
  automatically.
- The peaks pass sample rate scales with duration. Transcription runs in 15-minute stretches.

**Why live upload rather than only lifting the caps.** Lifting the caps alone would make a long
note impossible to send on a weak connection: 100+ MB would upload only at stop. A crash
mid-recording would also lose everything, because the recording lives only in page memory and
the round-2 ruling forbids browser storage. Live upload makes send near-instant and leaves the
server holding all but the last ≤ 15 s.

**Why 15 s, not the operator's suggested 1 minute.** It bounds the loss on a crash to 15 s, at the
cost of 4 requests a minute.

**Rejected.**
- *Separate recordings per minute, stitched by re-encoding.* Restarting MediaRecorder leaves gaps
  and clicks, and it needs a server-side concat demuxer.
- *Local browser storage.* Forbidden by the round-2 ruling.
- *Auto-sending an abandoned recording.* Consent: the person decides.

**Watch for.**
- `out_of_order` handling: the client sends strictly one slice at a time.
- A truncated last cluster decodes fine with ffmpeg.
- The stale-upload clock runs from `last_chunk_at`.
