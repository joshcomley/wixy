# Media transcodes are bounded by progress; failed media can be tried again

## Symptom

2026-11-12 08:30 (UK): a voice note recorded on an iPhone (Safari `MediaRecorder` webm/opus,
no duration header, 20 MB) reached the server whole, then rendered "Couldn't process this
file". Its attachment row read `status=failed, failure=timeout`; created 08:30:04, failed
08:36:14. It was exactly 15:00 long, which is the client's auto-stop (spec §3: voice 15 min),
so it was sent automatically at the cap. The sender remembered it as about 11 minutes.

## Root cause

`processing._run` gave every voice step a fixed 5-minute wall-clock timeout
(spec/server-chat/00-brief.md §7 "Hard timeouts: 30 min for video, 5 min for others") and
ran ffmpeg at BELOW_NORMAL priority (§7). The hub's load log
(`C:\Users\josh\fleet-diag\log\2026-11-12.csv`) shows 100% CPU from 08:25 to past 08:40.
A below-normal process on a saturated host is *starved, not stuck*: it keeps advancing
slowly. The same encode command took 10 s on the same file with the box less loaded
(50 s through the full `process_voice` while still busy). The fixed limit therefore killed a
healthy encode, and short notes passed only because they finished inside the limit (a
0:41 note sent at 08:32 succeeded). The file itself decodes cleanly end to end.

Separately, a failure was a dead end. The original was archived under `failed/<id>/`
"for diagnosis" for 7 days and then deleted. Nothing could re-run it, and the failure was
not logged anywhere (`stderr.log` had no trace).

## Decided

1. **A transcode is bounded by progress** (`processing._run_transcode`). This covers the voice
   encode, the voice peaks pass, and the video encode or remux. ffmpeg gets `-nostdin -nostats
   -progress <file>` and the watchdog polls the file each second. It kills only when
   `out_time_us` has not advanced for `_STALL_S` = 120 s, or when the run passes a per-kind
   ceiling: `_VOICE_CEILING_S` = 1 h, `_VIDEO_CEILING_S` = 3 h. That ceiling is a last-resort
   bound on a trickle. stdout and stderr are drained throughout, because the peaks pass streams
   megabytes. The small fixed-cost steps (ffprobe, the one-frame poster) keep
   `_DEFAULT_TIMEOUT_S` = 5 min. Priority stays below normal, as §7 decides. Every child now gets
   `stdin=DEVNULL`.
2. **Try again.** `POST /api/admin/server/attachments/{id}/retry` flips a failed attachment of a
   sent message back to `processing` (`store.requeue_failed_attachment`, plus the usual
   `message_updated` events). `_do_work` then processes the **archived original in place**.
   It is not moved back under `uploads/`: that id is already tombstoned in `deleted_storage`,
   and a pending upload cleanup would delete it. A successful retry removes the archive. A
   failed retry leaves the file untouched and `utime`s the folder, so the janitor's seven-day
   window restarts. The wire gains `Attachment.retryable`, which the admin UI uses to show a
   "Try again" button.
3. **Failures are logged** as one WARNING line from the queue: kind, id, seconds, reason and
   ffmpeg's diagnostic. Never message content.
4. Spec §7's "5 min for others" line is annotated as superseded for transcodes. Reality wins,
   per the repo rule.

## Rejected

- *Raise the fixed timeout* (e.g. to 30 min). It only moves the cliff: a busier box or a longer
  video hits it again, and a genuinely hung ffmpeg would block a queue slot for longer.
- *Drop the below-normal priority.* §7 decided that media work must not compete with page
  serving. Starvation is handled by not killing on wall-clock time, not by out-prioritising
  the site.
- *Move the archived original back to `uploads/<id>/assembled` on retry.* That races the
  `deleted_storage` tombstone for the upload id (see above).
- *A CPU-time budget.* It cannot tell a hung process (no CPU) from a starved one (no CPU
  either). ffmpeg's own progress can.

## Watch for

- A transcode that legitimately makes no progress for 2 minutes. ffmpeg reports at least every
  0.5 s of its own run time, so this would need a host starved worse than Windows'
  anti-starvation boost allows.
- `retryable` is time-based (`updated_at` within `FAILED_ORIGINAL_RETENTION_S`). The route
  re-checks that the file exists and answers 410 `original_gone` otherwise.
- Recovery of the 2026-11-12 note: the original is hash-verified (SHA-256 `bc9ddea6…`) and
  copied to `D:\Recovery\wixy-voice-2026-11-12\` outside the janitor's reach. In production it
  is re-run with the new "Try again".
- The queue marks a row `failed` *before* moving its original to `failed/<id>/` (and on a
  Windows sharing violation keeps it staged for the janitor to retry). The retry route therefore
  accepts an original in either place, and `_do_work` processes whichever exists. Tests must wait
  for the archive move rather than assume it is done when the status flips.
- On POSIX every child runs through `nice`, which exits 126/127 for a missing or
  non-executable binary instead of raising, so `_checked` maps those exits to
  `media_unavailable`.
