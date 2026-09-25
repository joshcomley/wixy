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
  the 10-second deadline, the committed operation publishes its event and cleans media, keeps
  the scrub owed durably (a `pending_scrub` row written in the delete/wipe transaction), and
  returns 202 `{"erasurePending":true}`. The background scrubber resumes at startup and retries
  every two seconds; `/usage` exposes the pending state as `erasurePending`. Media files are
  unlinked. The feature does not claim byte-level shredding on NTFS or SSD storage. (This
  decision's first draft used a `server/scrub.pending` file and `{"scrubPending":true}`;
  [00154](../00154-server-chat-erasure-journal/decision.md) and
  [00155](../00155-server-chat-background-containment/decision.md) replaced them.)
- The media worker re-reads the attachment after finishing. If delete or wipe removed the row,
  the worker removes media, upload, and failed directories it may have recreated. Neither action
  dispatches push notifications.
- `DELETE /api/admin/server/messages/{seq}` is authenticated and returns 204 when scrubbed or
  202 while durable background scrubbing remains; it deletes for everyone, including when the
  message was already absent. `POST /api/admin/server/wipe` is authenticated and accepts exactly
  `{"confirm":"WIPE"}`; every other body returns 422. It uses the same 204/202 scrub result.
- SSE carries `message_deleted` with `{"seq":int}` and `wiped` with `{}`. Clients remove a
  matching bubble or clear history and pending echoes; the stream remains open.

## Client timeouts and retries (audit round 3, F11)

The pre-delivery audit showed that the client's 10-second default aborted a slow but successful
erasure and then restored a message that no longer existed. The Architect's ruling
(`spec/server-chat/02-audit-r3-rulings.md`) made the stream the source of truth:

- Delete and wipe requests use a dedicated 30-second timeout. A timeout or network failure is
  an *unknown outcome*, kept distinct from a definite HTTP failure.
- Delete is idempotent: an unknown outcome is retried up to three times, after 1, 2 and 4
  seconds, and only then restored with "Couldn't confirm the delete — try again". A definite
  failure other than 401 restores the bubble at once; a 401 locks. A later `message_deleted`
  event removes the bubble regardless.
- Wipe is not idempotent (a repeat would delete anything sent since), so it is **never**
  retried. On an unknown outcome the sheet shows "Couldn't confirm — checking…" immediately,
  then the client pages the history and compares **server message sequence numbers** with the
  newest sequence it knew when it sent the wipe. It never compares browser and server clocks:
  an earlier version did, and clock skew could make it misjudge the outcome. Any message at or
  before that boundary means the wipe did not commit and the thread is restored with a retry
  message; otherwise the wipe counts as done and newer messages are kept. A `wiped` event
  settles it either way.

Details and the test map: [`docs/ai/livechat.md`](../../docs/ai/livechat.md) §6.

## Numbering note

The initial v1.2 §17.5 draft pre-allocated local decision number 00148, but this feature branch
already used 00148 for the e2e multi-tap timing rule. Spec v1.5.1 removed pre-allocation; this
decision records the next free number, 00149.
