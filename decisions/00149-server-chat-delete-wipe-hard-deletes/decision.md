# Decision

**Status:** accepted  
**Scope:** PIN-protected admin Server chat, P8, spec/server-chat/00-brief.md §17.

## Decision

- Any unlocked user may hard-delete any message for everyone. Deletion removes the message row,
  its attachments and associated files, and its earlier `message`/`message_updated` events;
  it then appends one `message_deleted` event. A repeat delete is idempotent and emits no second
  event. There is no tombstone.
- Wipe removes every message, attachment, upload, media file, failed-file entry, and event, then
  appends one `wiped` event. The two `seq` counters keep their AUTOINCREMENT high-water marks.
  Push subscriptions, `secret.key`, `vapid.json`, and localStorage identity values remain.
- Every SQLite connection enables `PRAGMA secure_delete=ON`. Delete and wipe both run a TRUNCATE
  checkpoint. A 204 requires a complete checkpoint and an empty WAL. If an active reader blocks
  the 10-second deadline, the committed operation cleans media and publishes its event, durably
  writes `server/scrub.pending`, and returns 202 `{"scrubPending":true}`. The background scrubber
  resumes at startup and retries every two seconds; `/usage` exposes the pending state. Media
  files are unlinked. The feature does not claim byte-level shredding on NTFS or SSD storage.
- The media worker re-reads the attachment after finishing. If delete or wipe removed the row,
  the worker removes media, upload, and failed directories it may have recreated. Neither action
  dispatches push notifications.
- `DELETE /api/admin/server/messages/{seq}` is authenticated and returns 204 when scrubbed or
  202 while durable background scrubbing remains; it deletes for everyone, including when the
  message was already absent. `POST /api/admin/server/wipe` is authenticated and accepts exactly
  `{"confirm":"WIPE"}`; every other body returns 422. It uses the same 204/202 scrub result.
- SSE carries `message_deleted` with `{"seq":int}` and `wiped` with `{}`. Clients remove a
  matching bubble or clear history and pending echoes; the stream remains open.

## Numbering note

The initial v1.2 §17.5 draft pre-allocated local decision number 00148, but this feature branch
already used 00148 for the e2e multi-tap timing rule. Spec v1.5.1 removed pre-allocation; this
decision records the next free number, 00149.
