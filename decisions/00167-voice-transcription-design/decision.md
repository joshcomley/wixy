# Decision

**Status:** accepted

**Scope:** `wixy_server/livechat/{transcribe,transcription,store,models}.py`,
`routes_livechat.py`, `admin-ui/src/server/{transcript,thread,mediaRender}.ts`. Privacy and cost:
[00166](../00166-voice-transcription-privacy-and-cost/decision.md). Spec:
`spec/server-chat/05-voice-transcription.md`.

## Decisions and why

1. **The route answers immediately (202) and a background job does the work.** Cloudflare cuts a
   proxied origin response at 100 s (a 524) and a long note on the CPU engine can take longer, so a
   synchronous route would fail exactly on the notes people most want transcribed. The job runs on
   the contained group (`ContainedTaskGroup.spawn`, Inv 47); its outcome reaches both devices through
   the **existing** `message_updated` event, so there is no new stream event type and no polling.
2. **A row per voice attachment, `ON DELETE CASCADE`.** Erasure with the message is the requirement
   (Inv 46), and a foreign key with cascade is the one mechanism that also holds when an *older*
   blue/green process — which knows nothing of transcripts — hard-deletes a message (foreign keys
   are on for every connection). Storing the transcript on the `attachments` row would have worked
   too but would have meant touching every attachment write path; a side table leaves them alone.
3. **`begin_transcript` is one write transaction, this process's in-flight set is the single-flight
   authority, and `finish_transcript` is a plain `UPDATE … WHERE
   attachment_id = ?` whose row count means "still exists".** Two racing requests cannot both get
   `started` (the loser sees the winner's `pending` row). A result for a deleted message updates
   zero rows and is discarded — no foreign-key error is ever reachable, so nothing can become a 500
   and nothing can resurrect erased text. `finish` is deliberately **not** conditional on the row
   still being `pending`: at startup the new process fails stale `pending` rows, but if another
   process's job is still alive and finishes, its (valid) result should land. Slots restarts Wixy in
   place (`nssm_restart`), so two live processes are not expected; the store is still written to
   tolerate it, and the one write that must not clobber anything — the cancelled job's `interrupted`
   record — is conditional on the row still being `pending` (`only_if_pending`).
4. **A stopped job marks itself failed; startup fails any stale `pending` row and announces each one.**
   A job cancelled by a graceful shutdown records `failed`
   (`interrupted`) under a cancel shield before the cancellation propagates, so no spinner outlives
   its process even when no restart follows. (A fleet deploy force-kills the service, so there the
   startup sweep is what clears the row.) A `pending` row in a process that has only just started
   belongs to a job that died without doing that (a hard kill); without the `message_updated` event a
   reconnecting client would keep a spinner up forever.
5. **One transcription in flight globally, single-flight per attachment, 6 new jobs a minute per
   identity, in memory.** The box's GPU/CPU is shared with dictation. Extra jobs wait (their rows
   stay `pending`) rather than being refused, because the queue is bounded by the rate limit. The
   limiter is per process; a blue/green overlap briefly doubles it, which is harmless.
6. **The probe is checked twice**: from the 60 s cache when the request is accepted (cheap), and
   **fresh from cmd** (`available(fresh=True)`, one extra loopback GET per job) immediately before the
   audio is sent. A cmd rolled back to a retaining build inside the cache window gets nothing and the
   job fails `unavailable`. (An early version re-checked the *cached* answer, which protected
   nothing; the independent review caught it and the test now flips the fake with the cache warm.)
   The cache holds both answers for 60 s and is dropped on a transport failure or any unexpected
   status (404/401/5xx other than `asr_warming`), not on a timeout, a rejection or `warming`. The
   probe itself has a whole-call time limit, so a slow cmd cannot stall `GET /usage` or the queue.
7. **No retries in the client.** A lost response that was in fact received would run the note
   through the shared engine twice. The user's Retry button is the retry.
8. **The stored transcript is text only; failure detail stays server-side.** The wire carries
   `{status}` and `text` once `done`. The machine `failure` code (`timeout`, `warming`, …) is for the
   log, never the owner. A runaway ASR result (>200,000 characters) is refused as invalid.
9. **Client: patch the block in place; never rebuild a playing note.** `thread.ts` rebuilds a whole
   bubble whenever a message object changes, which disposes its `<audio>`. A transcript-only
   `message_updated` (`differOnlyInTranscripts`) is patched into the existing block instead, so a
   note that is playing keeps playing. Anything else (media finishing, a re-signed URL, text) still
   rebuilds. Proven in a real browser by `e2e/tests/server-transcription.spec.ts` (the same `<audio>`
   element, still playing).
10. **Client: a slow `202` must not overwrite a newer stream update.** Found by the e2e suite: a job
    that finishes in milliseconds can have its `message_updated` reach the browser *before* the
    HTTP reply to the POST, and applying that reply's `pending` afterwards leaves a spinner forever.
    The block counts stream updates applied since it sent the request and ignores a `started` reply
    if any arrived.
11. **A `pending` row with no job behind it is restarted.** If a job's outcome cannot be recorded
    (a database locked past its busy timeout, a spawn that failed after the row committed) the row is
    `pending` with nothing running. The route treats "not in this process's in-flight set" as "no job"
    (`begin_transcript(restart_pending=True)`), claiming the note before its first `await` so racing
    requests still start exactly one job; otherwise the spinner would outlive everything until the next
    restart.
12. **A transcript update on a message already on screen never raises the "New messages" pill**
    (`thread.ts`): it is not an arrival.
13. **The availability flag rides on `GET /usage`** (`transcriptionAvailable`), read once per attach,
    rather than on the history payload: the history contract stays untouched and an old client
    ignores the extra key. The control therefore appears within one unlock of cmd's private mode
    coming live (the idle lock is 10 s, so that is immediate in practice).

## Alternatives rejected

- **Synchronous route with a long timeout** — 524 from Cloudflare on the notes that matter.
- **Send to cmd's plain `/api/transcribe`** — retains audio and text where delete/wipe cannot reach
  it (00166).
- **A third-party or metered speech API** — a per-request cost and the note leaves the machine; also
  contrary to this repo's rule that AI inference goes through cmd.
- **Transcribe on upload / on arrival** — the operator asked for opt-in; also doubles the load on the
  shared engine for notes nobody reads.
- **Keep the transcript only in the browser** — then the two devices could not both show it, and
  every device would pay for its own run.

## What to watch

- The migration number is assigned at merge (three builds add one); the DDL is idempotent.
- `failure` codes are a closed set in `transcription.py`; a new one needs a log line, not a UI change.
- If the media queue ever renames the voice rendition (`play.m4a`), `VOICE_RENDITION_FILENAME` in
  `transcription.py` must follow.
