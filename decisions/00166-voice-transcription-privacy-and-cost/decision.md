# Decision

**Status:** accepted

**Scope:** the opt-in "Transcribe" control on Server chat voice notes
(`spec/server-chat/05-voice-transcription.md`). The operator asked for this note as its own ledger
entry, separate from the locking/security decisions — it says what happens to a private voice note
when someone taps Transcribe, and what it costs. The design record (why the route is asynchronous,
why the table cascades, …) is [00167](../00167-voice-transcription-design/decision.md).

## What happens to a voice note when someone taps Transcribe

1. **Nothing happens until they tap.** No note is transcribed on upload, on arrival, or in bulk.
2. wixy reads the note's already-processed audio from its own private `server/` storage and sends it
   **once**, over the box's loopback, to cmd's on-box speech-to-text service. Nothing leaves the
   machine: **no third party, no cloud speech service, no per-request bill.**
3. The text comes back, is stored in the chat's own database next to the note, and both devices
   show it. Either device can hide it locally (per device, memory only).

## The cmd no-retain guarantee (and why wixy will not work without it)

cmd's ordinary transcription route **keeps** what it transcribes: a rolling buffer of the last 50
audio clips with their transcripts in `dictation-audio/`, and the speech service's shadow log
`asr-shadow.jsonl` with the full transcript text, plus log lines. Private chat voice notes must never
land there — delete and wipe in this chat could never reach them (Invariants 40 and 46).

So wixy calls cmd **only** in cmd's *private mode* (`POST /api/transcribe` with `private=1`), which
cmd promises means: no debug-buffer save, no transcript text in any log, the speech service told not
to shadow or log text, and the bytes held in memory only (any temp file deleted in `finally`). wixy
checks `GET /api/transcribe/capabilities` for a literal `{"private": true}` first (cached 60 s) and
**asks cmd again — a fresh request, never the cached answer — immediately before any audio
leaves**; a cmd that does not answer it — or is down, or is an
older version — receives nothing, the button is hidden and the route answers 503.

cmd's tests for the mode (cmd's repo, not wixy's): with `private=1`, nothing is added under
`dictation-audio/`, nothing is added to `asr-shadow.jsonl`, and a sentinel phrase in the audio's
transcript appears in no log file. wixy's own tests prove its half: `private=1` and `cleanup=0` are
the only fields sent, `session_id` and `context` are never sent, nothing is sent when the probe is
false, and no transcript text is ever logged.

## No LLM sees the text

Every request carries `cleanup=0`, so cmd's cleanup language model — which would otherwise tidy the
raw transcript — is never invoked. No model of any kind reads the transcript; it is the speech
engine's raw output, shown as it came.

## The transcript is erased with its message

It is stored in `attachment_transcripts`, which `ON DELETE CASCADE`s from the voice attachment. So
deleting the message, or wiping the chat, removes it in the same transaction; `secure_delete` zeroes
the freed pages and the existing WAL scrub removes the rest (the tests search the raw database and
WAL bytes for a transcript sentinel after each). A transcription that finishes *after* its message was
deleted finds no row and is discarded — it can never resurrect the text. The transcript is never
sent to push notifications (which are payloadless), never logged, and never copied anywhere else.

## Cost

There is **no per-request cost**: no metered API is involved. It does use the hub's own GPU/CPU,
**shared with voice dictation**, so a long note can take a while (cmd's budget is 60 s plus half the
note's length), and wixy therefore runs **one transcription at a time**, at most 6 new ones a minute
per person, and never more than the existing 15-minute voice cap.

## Accuracy caveat

The speech engine is Parakeet, which is **English-centric**: it is good on clear English and much
weaker on other languages, heavy accents, crosstalk or noise, and it can drop or invent words. The
transcript is a convenience for skimming, not a record; the audio is the truth. An empty result is a
valid answer ("No speech was picked up.").

## What to watch

- The operator-visible feature is "done" only when cmd's private mode is deployed and one real
  transcription is verified end to end **with nothing new under `dictation-audio/` or in
  `asr-shadow.jsonl`** (a live check, not a unit test).
- If cmd's private mode ever regresses, the probe is what protects the notes; do not bypass it, do
  not add a fallback to cmd's plain route, and do not raise the probe's cache time to hide a flap.
- Any future "transcribe everything" or "auto-transcribe on arrival" idea is a **new decision** — it
  changes the cost and the privacy exposure this note describes.
