# 07 — Live voice notes (decided)

Operator request, 2026-11-12, verbatim apart from the marked omissions:

> *"…it would be very useful to have the option to stream the message as it's being recorded to
> the other people in the chat. Is that doable? so either it would deliver 15 second chunks like
> you're doing now or could it do actual streaming coding and deliver it to the phone so you can
> kind of see it smoothly growing so it's basically almost instantaneously live so it's a bit like
> being on the phone to them but it's still voice notes. Now this would be optional … You'd long
> hold on the voice recording button and change the mode and the icon would slightly change … to
> indicate it's live mode. This would need to support pressing pause. It would need to support the
> other person saying start transcription. That would follow live and obviously maybe back update
> itself when sentence is finished … So if she's somewhere that she can't listen, it's still
> streaming across and transcribing live as well."*

Builds on spec 06 (live upload). Design record: decisions/00211. Decided; implement faithfully.

## 1. What the people see

- **Mode switch.** Long-press the microphone button, then pick **Voice note** or **Live voice
  note**. In live mode the button carries a red "LIVE" dot and a red tint. The choice stays until
  it is changed again on that device, for the life of the page. It is kept in memory only: no
  browser storage, per the round-2 ruling.
- **Sender, live mode.** Tapping record creates the message at once. The recording UI shows
  "LIVE · 0:42", with Pause/Resume and Stop. Stop finishes the note. **Cancel becomes "Delete for
  everyone"** with a confirm ("They may already have heard part of it"), because live audio may
  already have been played. It uses the normal message delete, wipe and erasure path.
- **Listener.** The message appears immediately as a voice note with a "LIVE" badge and a
  waveform that grows about every second.
  - **Play** joins at the start. **Jump to live** joins at the newest audio. Playback is ordinary
    pause/resume. While the sender is paused, the bubble says "Paused"; the stream simply waits.
  - When the sender stops, the badge goes and the bubble turns into the normal finished voice note,
    the processed m4a from spec 06. Playback continues seamlessly where possible; otherwise it
    resumes at the same position.
  - A push notification is sent exactly as for any new message (payloadless, R12).
- **Transcribe, live.** The existing Transcribe control works on a live note as soon as anyone
  taps it, and stays opt-in per Inv 50. The text then follows the recording, a few seconds behind:
  - finished sentences show normally;
  - the unfinished tail shows greyed and is rewritten as more audio arrives, including when the
    engine decides that a sentence actually ended earlier.
  - After Stop, one final pass over the whole note replaces the live text with the normal stored
    transcript.

## 2. Audio path

- **Sender.** The spec 06 live upload runs with a **1 s** timeslice in live mode, against 15 s in
  normal mode. The message is created at start with the live upload id as its attachment, in a
  new attachment status **`live`**. It is persisted from the first second, like any voice note.
- **Server, per live attachment.** One bounded decoder task feeds the growing upload into a
  long-lived ffmpeg (stdin → 24 kHz mono s16le, the call format). It keeps:
  - running peaks (one bucket per second, sent as a growing array);
  - the decoded duration so far;
  - an in-memory ring of recent PCM for listeners at the live edge.
  The decoder is a transcode under decisions/00209's progress rules. Its stall clock pauses while
  the sender is paused.
- **Listener transport.** A WebSocket, `/api/admin/server/live-voice/ws`, with the same
  authentication shape as the call socket (Access + unlock token in the first frame; Inv 55's route
  rules apply). The client subscribes `{attachmentId, from: "start" | "live" | <sampleIndex>}` and
  receives the call binary frame format, playing through the call's existing bounded AudioWorklet
  player. A listener starting from the start is fed from the stored upload, decoded faster than
  real time but credit-limited exactly like call frames, until it reaches the live edge. Control
  messages carry `{state: "recording" | "paused" | "ended", durationMs, peaks}`; `ended` tells the
  client to switch to the finished file.
- **Limits.** At most 2 live recordings at once per chat, and at most 4 listener sockets per live
  attachment. A live attachment with no chunk for 60 s while not paused, or paused for longer than
  30 minutes, is ended automatically and processed as a normal note, so nothing is lost and
  nothing hangs.

## 3. Live transcription

- Starts only on the existing `POST /attachments/{id}/transcribe` for that attachment, which is
  now also allowed while `live`.
- Every ~8 s of new audio, the server transcribes the window from the last *finalised* point to the
  live edge, capped at 90 s, through cmd's private mode exactly as Inv 50 requires: a temporary
  private file, deleted after. It splits the result at the last sentence end (`.?!` followed by a
  space or end, or the engine's own segment end when it gives one):
  - text before that point is **finalised** and appended;
  - the rest is the **provisional tail**, replaced on the next pass.
  If a window reaches 90 s with no sentence end, everything up to its last segment end is
  finalised.
- Wire: the transcript object gains `{"status":"live","text":<finalised>,"tail":<provisional>}`,
  pushed as `message_updated`. Only the finalised text is ever stored in the transcript row
  while live; the tail lives in memory.
- On Stop: one full-note pass (spec 06's 15-minute stretches) replaces the live text with the
  normal `done` transcript.

## 4. What does not change

Normal-mode voice notes, calls, deletion/wipe semantics and push are unchanged. No audio leaves
the server except to the chat's own authenticated participants, and to cmd's private
transcription only when someone has asked for it.

## 5. Acceptance

Synthetic two-browser proof through real local sockets, then the physical-device gate: the
sender's phone and Bubble's iPhone over the real tunnel. That gate has to be observed before this
is called production quality. It is the same rule as the calls feature.
