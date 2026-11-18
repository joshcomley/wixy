# A live voice note is `processing` in the database with a `live_state` column, and `live` everywhere else

## Symptom / need

spec/server-chat/07 wants an attachment status `live` from the moment a live-listened recording starts.
`attachments.status` carries `CHECK(status IN ('processing','ready','failed'))`, and SQLite cannot widen a
CHECK in place.

## Decided

- Schema v23 adds `attachments.live_state` (`recording` | `paused`, NULL otherwise). The `status` column
  stays `processing` while the note is live; `_row_to_attachment` presents `status = "live"`, and the wire
  carries `liveState`.
- `claim_processing` skips `live_state IS NOT NULL`; the orphan sweep does too. Ending the live phase sets
  `live_state` NULL and holds the queue off with a short lease (`live-drain`) while the decoder drains.
- The provisional transcript tail is process memory (`models.live_tail`), the finalised text is the
  transcript row's `text` (status stays `pending`), and the wire shows `status:"live"`.

## Rejected

- *Rebuild the `attachments` table with a wider CHECK.* It is referenced by `attachment_transcripts`
  (`ON DELETE CASCADE`) and the migration would need `PRAGMA foreign_keys=OFF`, which cannot run inside the
  migration transaction; an older blue/green process would also misread the new value.
- *A separate live table.* Every existing rule (message attach, quota, delete, wipe, journal) already works on
  the attachment row; a second table would duplicate them.

## Watch for

- Every raw `status` SQL still sees `processing` for a live note, deliberately (`create_message` accepts it).
  New SQL that means "being processed" must add `live_state IS NULL`.
- An older process (no `live_state` knowledge) during a blue/green overlap would claim the `processing`
  row, find no `assembled` file and mark it failed. A deploy in the middle of a live recording is the only
  exposure; the new process's startup recovery ends such notes from their stored slices.
