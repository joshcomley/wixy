# Decision

**Status:** accepted

**Scope:** App-lifetime background tasks, Server-chat erasure, and Windows filesystem races.

## Symptom / context

Under Windows load, file-sharing races surfaced as different failures in different tests.
Because loops and one-shot tasks shared the app lifespan task group, one escaping exception
could stop unrelated work, including the upstream watcher.

## What was decided

- Apply **Rule A**: `ContainedTaskGroup.supervise(name, loop_fn)` owns long-lived loops and
  restarts them with bounded exponential backoff; `.spawn(name, fn, *args)` contains
  one-shot failures. Exceptions are logged and counted without cancelling sibling work;
  the type exposes no raw `start_soon`.
- Keep per-item isolation in media-queue and push-recipient task groups. Three current
  consecutive failures in the media queue or erasure worker report
  `/api/admin/system/status` `server.mediaProcessing: "degraded"`; five quiet minutes reset
  the reported count.
- Apply **Rule B**: migration v6 imports legacy `server/scrub.pending` into the SQLite
  `pending_scrub` row. New scrub work is written in the same delete/wipe transaction and is
  compare-and-cleared by token. Do not add a retry loop around the legacy file: SQLite is the
  durable marker. If an import read hits a Windows access error, retain the file and create a
  durable row for retry.
- Apply **Rule C**: tolerate WAL-stat `OSError` as an incomplete scrub; convert exceptions in
  post-commit cleanup into 202; retry/expire lingering failed originals in the hourly janitor;
  preserve the fixes in decisions 00151 and 00152.

## Why

Containment protects the whole application from one worker failure, while a transactional
SQLite marker removes the Windows sharing race caused by a file-based marker. The sweep in
[`spec/server-chat/01-background-containment-ruling.md`](../../spec/server-chat/01-background-containment-ruling.md)
is binding; the code and numbered invariant 47 implement it.

## What to watch for

Do not allow `Exception` to escape into the lifespan task group, discard a legacy marker after
an unreadable-file error, or clear durable work before completion. For erasure/background
changes, acceptance requires five consecutive clean full-suite runs, with no e2e suite running
alongside them. Classify a hub-only e2e failure as host-load-only only after 10/10 passes on an
unloaded node; any failure in that control run means a real bug needs investigation.
