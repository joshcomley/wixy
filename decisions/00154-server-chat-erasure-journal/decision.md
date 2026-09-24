# Decision

**Status:** accepted

**Scope:** Server-chat message deletion, wipe, media cleanup, and WAL scrubbing.

## Symptom / context

Delete and wipe must take effect immediately for every client, while Windows can temporarily
deny or race filesystem operations and a stale SQLite reader can delay WAL truncation. A
committed delete must not be reported as a failed request or silently lose cleanup work.

## What was decided

- Keep hard-delete semantics. In the same SQLite transaction that removes rows, record each
  attachment/upload path owed for cleanup in `deleted_storage`, a wipe-sweep token in
  `pending_wipe_cleanup`, and a `pending_scrub` token for WAL work. These rows contain IDs and
  tokens only; none is a chat-visible message/event tombstone.
- Treat rows as authority. Compare-and-clear cleanup by generation/token so an older pass
  cannot erase a concurrent requeue. Enumerate filesystem entries before reading/removing
  them, then consult a batched live-row snapshot before acting on each directory. Use one
  idempotent worker for startup recovery and retry.
- Publish `message_deleted`/`wiped` after commit and before file work. Return 204 only when
  all cleanup and the raw-byte scrub are complete; otherwise return 202
  `{"erasurePending":true}` and let the worker finish. Check the live attachment row before
  serving media so deleted attachments return 404 while Windows holds a file open.
- Secure-delete rows and use WAL `TRUNCATE`; split checkpoint waits into 250 ms slices and
  include scrub-guard acquisition in the ten-second route deadline. After a successful scrub,
  clear only the token that was observed before it started.
- Have the hourly janitor condition its orphan/stale-row deletes on the row still being
  eligible, remove raw originals for ready attachments, retry failed-original archiving, and
  expire unarchived failed originals after seven days. Prune completed cleanup rows after
  seven days; never prune pending work.

## Why

The Architect's holistic review endorsed P8's tombstone-and-token design over the proposed
`erasure_jobs` table: transactionally recorded owed work, compare-and-clear, rows-as-authority,
enumerate-before-read, and one idempotent worker form one coherent recovery model. The review
required three fixes (publish before file work, 250 ms checkpoint slices, and bounded guard
acquisition) and two low-severity fixes (conditional janitor deletes and seven-day pruning).
All were implemented and independently reviewed. See [00149](../00149-server-chat-delete-wipe-hard-deletes/decision.md)
for the original hard-delete contract and [00151](../00151-windows-permissionerror-concurrent-delete-race/decision.md)
and [00152](../00152-archive-failed-original-never-crashes-worker/decision.md) for Windows race
findings.

## What to watch for

Never clear owed work merely because a file operation was attempted, return 204 with any work
pending, publish only after cleanup, or reintroduce a per-tick full-tree scan. A 202 is
successful deletion with recovery still running, not a retry instruction for wipe. Details:
[`docs/ai/livechat.md`](../../docs/ai/livechat.md) and
[`spec/server-chat/00-brief.md`](../../spec/server-chat/00-brief.md) §17.
