# 06 — Long voice notes, uploaded live (decided)

Operator request, 2026-11-12, verbatim: *"Why does it cut off at 15 minutes? Can it do 1 minute
chunks as voice notes are recorded and stitch them together at the end? Thus enabling voice
notes of any length"*. Background: a 15:00 voice note (the old auto-stop) failed earlier that day
(decisions/00209). This spec supersedes R11's voice row in `00-brief.md` and the "15 min" bound in
`05-voice-transcription.md`. It is decided; implement it faithfully. Design record:
decisions/00210.

## 1. Limits

| | Before | Now |
|---|---|---|
| Voice max duration | 15 min (client auto-stops at 15:00) | **4 h** (`VOICE_MAX_DURATION_MS` / `VOICE_DURATION_CAP_S`) — a runaway guard for a phone left recording, not a product limit |
| Voice max size | 25 MiB | **512 MiB** (`MAX_UPLOAD_BYTES["voice"]`, client `MAX_BYTES.voice`) |
| Recorder bitrate | browser default (Safari ≈ 180 kbit/s) | request `audioBitsPerSecond: 64000` (voice quality; browsers may ignore it, the caps above still hold) |
| Voice transcode ceiling | 1 h | **6 h** (`_VOICE_CEILING_S`; the 120 s no-progress stall rule stays the real bound) |

Quota and the free-space floor (R10) still apply, now checked on every live chunk too.

## 2. Live upload — the recording is uploaded while it is being made

The recorder emits a slice every **15 s** (`MediaRecorder.start(15000)`). The operator suggested
1-minute pieces; 15 s is chosen so that at most 15 s is ever lost, at negligible request cost.
Slices of ONE `MediaRecorder` session are one continuous WebM/MP4 stream (only the first carries
the header), so the server joins them by plain concatenation in index order — exactly what
`uploads.assemble` already does. Pause/resume keeps the same recorder session.

### 2.1 Wire contract (server)

- `POST /api/admin/server/uploads` gains an optional `"live": true` (voice only; 422 for another
  kind). With `live`, `sizeBytes` may be omitted (ignored if sent) and the body must carry
  `"deviceId": str` (the same device id `POST /messages` uses). Response is unchanged: 201
  `{"uploadId","chunkBytes","maxBytes"}`, where `chunkBytes` is the normal chunk size (a slice
  is far smaller). Media-unavailable/type/quota errors are as for a normal init (quota checked
  against zero bytes at init).
- `PUT /uploads/{id}/chunks/{index}?durationMs=<int>` on a live upload accepts an index that is
  the next missing one (the count of present chunks) or a re-PUT of an existing one (idempotent
  overwrite, as today); a gap (index > count of present chunks) is 409
  `{"error":"out_of_order","next":int}`. Each accepted chunk updates the upload row's
  `size_bytes` (sum of present chunks), `last_chunk_at` and `duration_ms` (the client's own
  elapsed-recording figure, for the unsent list only). Running total over `maxBytes` → 413
  `too_large`; quota/free-space exceeded → 507 `storage_full` (chunk not stored). A chunk larger
  than `chunkBytes` → 413 as today.
- `POST /uploads/{id}/complete` on a live upload takes an optional JSON body
  `{"chunkCount": int}`; omitted = every present contiguous chunk. It then assembles exactly as
  today (count from `chunkCount`, size from the row) and returns 202 `{"attachment"}`. Missing
  chunks below `chunkCount` → 409 `incomplete` with `missing`.
- `GET /uploads/unsent?deviceId=<id>` → 200 `{"unsent":[{"uploadId","durationMs","sizeBytes",
  "startedAt","lastChunkAt"}]}`: live voice uploads of THIS device that were never completed and
  have no chunk for ≥ 20 s (so a recording in progress in another tab is not offered), newest
  first. Nothing about content.
- `DELETE /uploads/{id}` (existing) discards one.
- Normal (non-live) uploads are completely unchanged.

### 2.2 Storage

Schema bump (`_LATEST_SCHEMA_VERSION` + 1): `uploads` gains `live INTEGER NOT NULL DEFAULT 0`,
`device_id TEXT`, `last_chunk_at REAL`, `duration_ms INTEGER`. Existing rows migrate as non-live.
The janitor's stale-upload rule (24 h) measures a live upload from `COALESCE(last_chunk_at,
created_at)`, so a 4-hour recording is never swept mid-way. A live upload is private chat content
like any upload: wipe and the deletion journal treat it exactly as today.

### 2.3 Client

- `recorder.ts`: `start(15000)` (timeslice) and an `onSlice(blob, index, elapsedMs)` callback;
  the in-memory slices are still kept until the upload is confirmed, so a failed live upload
  falls back to the existing upload-at-stop path with nothing lost. `VOICE_MAX_DURATION_MS` = 4 h;
  request `audioBitsPerSecond: 64000`.
- A live uploader (new module) inits a live upload when recording starts, PUTs slices strictly
  in order (one in flight, the existing per-chunk retry policy), and on stop sends the last slice
  then `complete` with `chunkCount`. Sending the message is then the existing path with the
  returned attachment. Cancel/discard → `DELETE /uploads/{id}`. If init or a PUT fails
  permanently, it stops live-uploading and the stop path uploads the kept blob normally.
- On chat load (after unlock), `GET /uploads/unsent` for this device. Each entry shows a
  composer-adjacent card "Unsent voice note · 12:31" with **Send** (complete → send the message as
  a normal voice note) and **Discard** (DELETE). Never auto-sent: sending is the person's choice.
  No localStorage/sessionStorage/IndexedDB (round-2 ruling) — the recording lives on the server.
- Recording timer UI shows h:mm:ss past one hour; the 15:00 auto-stop is gone (4 h guard only).

### 2.4 Processing and transcription

- The peaks pass must stay bounded for a 4-hour note: choose the PCM rate so total samples stay
  ≤ 8000 × 900 (`rate = clamp(floor(7_200_000 / duration_s), 100, 8000)`), using the input probe
  or the output m4a duration. Peaks remain 64 buckets.
- Transcription of a note longer than 15 minutes runs in consecutive ≤ 15-minute stretches
  (ffmpeg `-ss/-t` into temporary private files, deleted after), each through cmd's private mode
  exactly as today (Inv 50), joined with a single space in order; one failed stretch fails the
  transcript (retryable as today). Nothing new leaves the server.
