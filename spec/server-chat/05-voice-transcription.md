# 05 — Voice-note transcription (opt-in, private)

**Status:** decided (workspace 29 round 2, item 3; Architect ruling 2026-09-25). Implementation notes
and the code reality live in [`docs/ai/livechat.md`](../../docs/ai/livechat.md) §15; the privacy and
cost note is [`decisions/00166`](../../decisions/00166-voice-transcription-privacy-and-cost/decision.md).
Numbered guarantee: Invariant 50.

## 1. What the operator asked for

> Voice-note transcription — opt-in per note (a button on the note, click to transcribe;
> never automatic/on upload). Needs its own privacy/cost note as a ledger entry, not a new
> decision on locking/security.

So: a **Transcribe** button on each voice note in the Server chat. Nothing is ever transcribed
by itself, on upload, or in bulk.

## 2. The constraint that shapes everything

cmd already has an on-box speech-to-text service (`POST /api/transcribe` on the hub: no third
party, no per-request cost). But cmd's dictation path **retains what it transcribes**:

- `engine/transcribe.py` `_save_dictation_debug` keeps the audio clip and a JSON sidecar with
  the raw and cleaned transcript in `<CMD_STORAGE_DIR>/dictation-audio/` (rolling 50, on by
  default), on every path including `cleanup=0`;
- the ASR service's shadow pass appends the full transcript text to `asr-shadow.jsonl`;
- the cleanup path logs raw and cleaned text at INFO.

Sending a private chat voice note through that path would copy it (and its transcript) into
cmd's storage and logs, where this chat's delete and wipe can never reach it — breaking
Invariant 40 (chat data lives only in `server/`) and Invariant 46 (delete and wipe erase
everything). That is not acceptable, so wixy uses cmd **only through a private mode** cmd does not
have yet (§3). Until cmd ships it and the probe says so, the feature is simply off.

## 3. The contract with cmd (private mode) — built on the cmd side, as its own task

`POST /api/transcribe` with the form field `private=1` MUST mean:

1. no dictation debug-buffer save (no audio, no sidecar);
2. no transcript text in any log line (the cleanup path's INFO line included);
3. the ASR service is told not to shadow and not to log text (an `X-Voice-Private: 1` header or an
   equivalent field on the :9390 call, honoured by `asr_server.py`);
4. the uploaded bytes are held in memory only, and any temp file is deleted in `finally`.

`GET /api/transcribe/capabilities` → `{"private": true}` is the probe: wixy refuses to send
anything to a cmd that does not answer it with a literal `true`.

cmd's own tests for the mode: with `private=1` nothing is added under `dictation-audio/`, nothing
is added to `asr-shadow.jsonl`, and a sentinel phrase in the audio's transcript appears in no log
file.

## 4. What wixy sends, and when

`wixy_server/livechat/transcribe.py` (`CmdTranscriber`, the loopback-client pattern of
`pinclient.py`):

- the probe is checked first and its answer cached for 60 s (both ways); **false, absent or
  unreachable ⇒ the feature is unavailable**: the Transcribe control is hidden and the route
  answers 503 `{"error":"not_configured"}`. The standalone edition has no cmd and is always
  unavailable;
- the probe is re-checked immediately before any audio leaves (a cmd that stopped promising the
  mode in between receives nothing and the job fails);
- the request is exactly `private=1` and `cleanup=0` (no LLM ever sees the text) with the note's
  processed audio rendition, and **no `session_id` and no `context`** — nothing about the chat is
  disclosed;
- the whole-request budget is **60 s + 0.5 × the note's duration in seconds** (a 15-minute note
  on the CPU engine cannot finish in a flat 60 s);
- no retries — a lost response is not repeated on shared GPU/CPU; the user's Retry is the retry.

## 5. Storage

```
attachment_transcripts(
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','done','failed')),
  text TEXT, failure TEXT, engine TEXT,
  created_at REAL NOT NULL, updated_at REAL NOT NULL)
```

`ON DELETE CASCADE` (foreign keys are ON on every connection, including an older blue/green
process's) plus `secure_delete` plus the existing WAL scrub is what makes delete and wipe erase a
transcript with its message. A result that arrives after its message was deleted finds no row and
is discarded (never a 500, never a resurrected transcript). The machine-readable `failure` code
(`unavailable`, `warming`, `timeout`, `rejected`, `invalid_response`, `media_missing`, `too_long`,
`interrupted`, `error`) stays server-side; the wire only says `failed`.

The migration's version number is assigned when the build merges (three round-2 builds add one in
parallel); the DDL is `CREATE TABLE IF NOT EXISTS`.

## 6. The route (asynchronous)

Cloudflare cuts a proxied origin response at 100 s (a 524) and a long note can take longer, so the
route never waits for the transcript.

`POST /api/admin/server/attachments/{id}/transcribe` (`X-Wixy-Server-Token` required):

| Situation | Answer |
|---|---|
| unknown id, not a **voice** attachment, or not yet sent in a message | 404 `{"error":"not_found"}` |
| the note is still processing / failed processing | 409 `{"error":"not_ready"}` |
| a transcript is already `done` | 200 `{"transcript":{"status":"done","text":…}}` (no cmd call, works even if cmd is later gone) |
| a job is already `pending` (single-flight) | 202 `{"transcript":{"status":"pending"}}` |
| cmd cannot promise private mode / standalone | 503 `{"error":"not_configured"}` |
| more than 6 new jobs in a minute for this identity | 429 `{"error":"rate_limited","retryAfterS":n}` + `Retry-After` |
| otherwise (none, or `failed` ⇒ the retry) | upsert a `pending` row, append `message_updated`, run the job on the contained background group (Inv 47) → 202 `{"transcript":{"status":"pending"}}` |

Limits: single-flight per attachment; **one transcription in flight globally** (further jobs wait,
their rows `pending`); 6 new jobs a minute per identity; the maximum duration is the existing voice
cap (15 minutes, R11), not a new number.

On completion the job sets `done` or `failed` and appends the **existing** `message_updated` event.
`Attachment` gains `transcript: null | {status, text?}`, so both devices render from the stream.
At startup, stale `pending` rows (a job that died with its process) become `failed`, each announced
with a `message_updated`, so the owner can retry. `GET /usage` gains `transcriptionAvailable`.

## 7. The UI

A block beneath each ready voice note (`admin-ui/src/server/transcript.ts`): **Transcribe** (only
while `transcriptionAvailable`) → a spinner "Transcribing…" → the text with a per-device
**Hide/Show** (memory only, never persisted) → or a plain error with **Retry**. The block is
patched into the live bubble when only a transcript changed, so a note that is playing is never cut
off when its transcript arrives; and a slow HTTP reply never overwrites a newer stream update.
Mobile-first (tap targets follow the row's 44 px control height on a phone; long text wraps inside
the bubble at 402 px).

## 8. Privacy and cost (the ledger entry the operator asked for)

`decisions/00166` states, in one place: the cmd no-retain guarantee and its tests; loopback only, no
third party, no per-request cost (it shares the hub GPU/CPU with dictation); no LLM sees the text;
the transcript is erased with its message; and Parakeet's English-centric accuracy caveat.

## 9. Sequencing and "done"

The wixy side is built and merged against a fake cmd that implements §3's contract and probe
(`wixy_server/tests/fake_cmd.py`). It is safe to merge early: without a `private: true` answer the
button stays hidden and the route answers 503, so no audio is ever sent to a retaining cmd. The
feature switches itself on when cmd's private mode is live. It is **operator-visible done** only
when the cmd change is deployed and one real private transcription has been verified end to end,
with nothing new under `dictation-audio/` or in `asr-shadow.jsonl`.
