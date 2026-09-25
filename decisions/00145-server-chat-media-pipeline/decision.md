# Decision

**Status:** accepted

**Scope:** Server-chat photo, voice, and video uploads.

## Symptom / context

Chat attachments must be stored privately and rendered safely. Large mobile uploads and
Windows file operations need bounded work and crash recovery.

## What was decided

- Stage uploads in bounded chunks; enforce the per-project media quota and minimum free-space
  floor at upload initialization. The chunk size is configurable within a fixed range.
- Sniff file bytes before processing. Pillow and `pillow-heif` process photos. Every still
  image is normalized to 8-bit RGB or RGBA before its metadata is stripped: palette modes
  keep their colours, alpha is preserved, an embedded ICC profile is converted to sRGB (a
  failed conversion logs a warning and keeps the pixels), and 16-bit greyscale is scaled
  through a 0–65535 → 0–255 lookup table instead of being clipped. The metadata strip then
  rebuilds the image from those normalized pixels. The output format follows transparency:
  alpha → `full.png` + `thumb.png`; opaque PNG or static GIF → `full.png` + `thumb.jpg`; any
  other opaque source → `full.jpg` + `thumb.jpg`. Animated GIF source bytes are preserved as
  `full.gif` (an explicit exception to metadata stripping) with a first-frame thumbnail. The
  signed-media resolver accepts either `thumb.png` or `thumb.jpg`. ffmpeg and ffprobe
  normalize voice/video into served renditions. Each external-tool input uses the sniffed
  demuxer and a file-only protocol whitelist. The table and details are in
  [`docs/ai/livechat.md`](../../docs/ai/livechat.md) §8.
- Store renditions under the private `server/media/` tree. Remove ready originals; retain
  failed originals only for diagnosis, retry archiving them, and expire them after seven days.
- Keep attachment state in `processing`, `ready`, or `failed`. Serve only ready files through
  signed URLs and check the live attachment row before opening a path.
- Keep the media pipeline unavailable when ffmpeg, ffprobe or `pillow-heif` is missing; report
  that state (`mediaAvailable: false`, `mediaProcessing: unavailable`) and return 503 for
  uploads while text chat remains available. A declared `sizeBytes` below 1 is rejected.

## Why

Byte sniffing, bounded subprocesses, private storage, and server-side quotas reduce exposure
to hostile files and resource exhaustion. Separating upload staging from processing supports
large uploads and restart recovery.

## What to watch for

Keep dependency setup, `WIXY_FFMPEG`/`WIXY_FFPROBE`, quota defaults, and degraded/unavailable
status aligned with [`docs/ai/runbook.md`](../../docs/ai/runbook.md) and
[`docs/ai/livechat.md`](../../docs/ai/livechat.md). `DELETE /uploads/{uploadId}` must validate
the ID before filesystem access; see [00150](../00150-upload-cancel-id-validation/decision.md).
The GIF pass-through is an explicit exception to metadata stripping, recorded in Inv 44;
preserve this behavior unless a reviewed media change alters it.
