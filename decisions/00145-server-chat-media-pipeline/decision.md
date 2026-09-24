# Decision

**Status:** accepted

**Scope:** Server-chat photo, voice, and video uploads.

## Symptom / context

Chat attachments must be stored privately and rendered safely. Large mobile uploads and
Windows file operations need bounded work and crash recovery.

## What was decided

- Stage uploads in bounded chunks; enforce the per-project media quota and minimum free-space
  floor at upload initialization. The chunk size is configurable within a fixed range.
- Sniff file bytes before processing. Pillow and `pillow-heif` process photos; still-image
  renditions have metadata stripped, while animated GIF source bytes are preserved and a
  thumbnail is generated. ffmpeg and ffprobe normalize voice/video into served renditions.
  Each external-tool input uses the sniffed demuxer and a file-only protocol whitelist.
- Store renditions under the private `server/media/` tree. Remove ready originals; retain
  failed originals only for diagnosis, retry archiving them, and expire them after seven days.
- Keep attachment state in `processing`, `ready`, or `failed`. Serve only ready files through
  signed URLs and check the live attachment row before opening a path.
- Keep the media pipeline unavailable when either ffmpeg binary cannot be resolved; report
  that state and return 503 for uploads while text chat remains available.

## Why

Byte sniffing, bounded subprocesses, private storage, and server-side quotas reduce exposure
to hostile files and resource exhaustion. Separating upload staging from processing supports
large uploads and restart recovery.

## What to watch for

Keep dependency setup, `WIXY_FFMPEG`/`WIXY_FFPROBE`, quota defaults, and degraded/unavailable
status aligned with [`docs/ai/runbook.md`](../../docs/ai/runbook.md) and
[`docs/ai/livechat.md`](../../docs/ai/livechat.md). `DELETE /uploads/{uploadId}` must validate
the ID before filesystem access; see [00150](../00150-upload-cancel-id-validation/decision.md).
The shipped GIF pass-through is an explicit exception to the brief's still-unrevised Inv 44
wording; preserve this behavior unless a reviewed media change alters it.
