# Symptom
The operator wanted a Gallery in the ⋯ menu: the media history, tap-to-open pop-up (player for video), a download link on every item, and a "download all" that remembers, per device, how far it got so that days later it fetches only the new media — plus suitably sized thumbnails for every image and video, generated at send time from now on.

# Decided
- **One thumbnail size, one code path.** Photos already had a 480px `thumb`; videos only a 960px `poster` (too big to load a screenful). Videos now also get `thumb.jpg` (long edge 480) cut from the poster by `processing.make_thumbnail`, the SAME function the backfill uses, so old and new media can never differ. It is a rendition named `thumb`, which the signed-media route already served, so no new rendition name or route branch.
- **Backfill at start-up, not a migration.** `thumbnails.backfill_thumbnails` (janitor task start, idempotent, Pillow only — works with no ffmpeg) adds `thumb` to ready photos/videos lacking it. The row update is a compare-and-set on the exact rendition list (`add_thumb_rendition`), so a view-once conversion or delete racing the write wins and the orphan file is removed. No schema change.
- **`GET /gallery`, a store query, not the history endpoint.** Newest-first `(message_seq, ordinal)` paging; excludes view-once (Inv 52), non-ready, voice and the would-you-rather round's generated pictures. Items carry freshly signed URLs per response, like every other media URL.
- **Downloads are fetch -> blob -> anchor, one at a time.** Only this gives true "one at a time", honest progress, failure detection, and a mark that moves only after a file FULLY arrived. Per-item links use the server's `dl=1` (attachment disposition + a clean `wixy-<date>-<time>-<id8>.<ext>` name); `dl` is deliberately outside the HMAC (grants nothing `inline` doesn't). Files are at most the 30 MB upload cap, so holding one blob in memory is fine.
- **The mark** is `{seq, ordinal, at}` in `localStorage`, advanced per file, oldest-first. Individual Download links never move it (they could skip older files).
- **Idle lock is suspended for the run** (`suspend("mediaPlaying")`, like a playing video) because a multi-file run outlasts the 10 s default; every other lock trigger still aborts it.
- **Every gallery control is a gesture boundary** — otherwise two quick taps on Next (or a few Download links) are the lock double-tap. Found by the e2e (a machine-speed menu -> tile -> next chain tripped the boundary-chain lock); the e2e now paces its taps like a person.

# Why not
- Re-listing via `/messages`: pages 50 *messages*, carries everything, and can't be filtered to media or counted cheaply.
- Plain `<a download>` clicks in a loop for "download all": the browser starts them all at once, can't tell when one finished or failed, and a "mark" set on click would claim files that never arrived.
- A thumbnail for video generated on the fly per request: CPU on every grid load; and not "generated when media is sent" as asked.
- A rendition name `gthumb`: a second name for the same thing in every client switch.

# Watch for
- A new place that creates ready photo/video attachments must go through `processing.process_*` (so `thumb` exists) — or the backfill will quietly add it at next start.
- Anything that touches `renditions` for view-once must keep `view_once_renditions IS NULL` out of `list_gallery`/`thumbless_attachments` (Inv 52).
- `localStorage` may be unavailable: the mark just doesn't stick, everything is re-offered. Not an error.
- Browsers may prompt once to allow multiple downloads; declining stops the saves but the mark only advances for files that were handed over.
