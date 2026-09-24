# Server chat — ruling: background-task containment + the Windows file-race class

Architect ruling, 2026-09-24, binding (brief v1.5.6; folded into §17 of `00-brief.md` at the
v1.5.5+ reconciliation after P8 merges). Implemented in P8 round 8.

## The finding (measured by the Delivery Manager on hub)

Full-suite pytest fails a *different* test each run, always a Windows concurrent-file-access
race inside a background worker:
- run A: `PermissionError` in `media_queue._archive_failed_original` `os.replace`;
- run B: `FileNotFoundError` at the same site;
- run C: `PermissionError` reading `scrub.pending` in `store.scrub_pending_token()`.

Five call sites had been fixed one at a time (`decisions/00151`, `00152`) and new ones kept
appearing. Point fixes are not converging, because two root causes sit underneath them:

1. **Nothing contains a background failure.** The watcher, erasure worker, media queue and
   janitor, and every per-message push dispatch (`routes_livechat.py`
   `background.start_soon(_dispatch)`) and the AI chat's readiness tracker
   (`routes_chat.py`), all run as children of the ONE lifespan task group in `app.py`. An
   exception escaping any of them cancels the whole group. A Windows file race in the chat's
   erasure worker can therefore stop the site's **upstream watcher** (the owner's draft
   preview stops updating), not just the chat.
2. **`scrub.pending` is a file.** CPython opens files on Windows without
   `FILE_SHARE_DELETE`, so a reader holding the marker makes the writer's
   `os.replace`/`unlink` fail, and vice versa. Retrying around that treats the symptom.

## Rule A — every background task is contained, enforced by type

- **`wixy_server/background.py`** provides a `ContainedTaskGroup` that wraps the lifespan
  task group and exposes **only** two methods:
  - **`supervise(name, loop_fn)`** — for app-lifetime loops (the watcher, the erasure
    worker, the media queue, the janitor):
    - it runs `await loop_fn()`;
    - on `Exception` (never `BaseException`, so cancellation and shutdown still propagate)
      it logs with `exc_info`, records health, sleeps with backoff (1 s, doubling, capped
      at 60 s, reset after 300 s of healthy running), and restarts;
    - a loop that *returns* is logged and restarted too.
  - **`spawn(name, fn, *args)`** — for one-shot tasks (the push dispatch per message, the AI
    chat readiness tracker): on `Exception` it logs, records health, and returns. It never
    propagates.
- **`app.state.background_tasks` IS the `ContainedTaskGroup`.** There is no raw
  `start_soon` on it, so mypy rejects any future uncontained spawn. This makes the wrong
  thing impossible rather than documented.
- **Per-item isolation inside inner task groups:**
  - the media queue's dispatch group — `_handle_claimed` catches `Exception`, logs, and
    leaves the claimed row alone, so the lease expiry re-claims it: a natural retry;
  - `push.dispatch_push_notifications`'s per-recipient `deliver`.
  One failing item must not cancel its in-flight siblings.
- **Health, so degradation is never silent:** each supervised task records
  `consecutiveFailures` and `lastFailureAt` (epoch seconds). `GET /api/admin/system/status`
  `server.mediaProcessing` becomes `"degraded"` when the media queue or the erasure worker has
  ≥3 consecutive failures; the decoy renders "Degraded". The ERROR log per failure is kept.
- **New invariant 47:** no app-lifetime background task may let an `Exception` escape into
  the lifespan task group. Every spawn goes through `ContainedTaskGroup`, and inner task
  groups isolate per item.
- **Why a supervisor rather than a try/except per tick in each loop:** it is one mechanism
  applied uniformly, it also covers failures in loop scaffolding (a claim query raising
  "database is locked"), and the type system enforces it. The media queue still gets the
  per-item layer, because its items run concurrently in an inner group.

## Rule B — the scrub marker moves into SQLite (root cause; no retry helper)

- **Migration v6:** `pending_scrub(singleton INTEGER PRIMARY KEY CHECK(singleton = 1), token
  TEXT NOT NULL)`, upserted with a fresh token **inside the delete/wipe transaction**. This is
  strictly stronger than the file: it is atomic with the deletion, so a rolled-back
  transaction leaves no marker. The file could outlive a rollback.
- **After a complete scrub:** compare-and-clear in a write transaction (delete the row only
  if the token still matches), then run one best-effort TRUNCATE.
  - The clear leaves a WAL frame that holds only the `pending_scrub` page and no chat
    content, so the §17 204 guarantee ("deleted text absent from `server.db` +
    `server.db-wal`") still holds.
  - `/usage` and the 202 decision read the row instead of the file.
- **Legacy import:** migration v6 imports a legacy `scrub.pending` file (insert a token row,
  then unlink it). If the unlink fails, it is logged and retried at the next startup, so a
  pre-upgrade pending scrub is never lost.
- **All file-marker code is removed:** `scrub_pending_path`, `_write_scrub_pending_marker`
  and the file-based `clear_scrub_pending`.
- **The Delivery Manager's proposed PermissionError retry helper is NOT adopted** for the
  marker: remove the file instead of retrying around it.

## Rule C — the remaining Windows/erasure-surface sweep (do all of it in round 8)

1. **The WAL `stat()` in `store.scrub()`.** SQLite deletes `server.db-wal` whenever the last
   connection closes, which per-call connections make frequent (measured earlier: the first
   WAL probe was fooled by exactly this). A `stat()` can therefore hit a delete-pending file
   and raise `PermissionError`. Treat any `OSError` other than `FileNotFoundError` as "not
   complete yet" and loop; never raise from `scrub()`.
2. **Post-commit route steps never produce an error status.** In `delete_message` and
   `wipe_chat`, everything after the commit and `notifier.publish()` — file cleanup, sweep,
   scrub, the pending check — is wrapped so that an `Exception` logs and returns **202
   `{"erasurePending": true}`**. §17.1 already says "never an error, never a rollback": a
   500 after the commit makes the sender's screen restore a message that no longer exists
   anywhere. The durable owed-state guarantees the worker finishes.
3. **Unarchived failed originals must not linger.** With the round-7 early return, a failed
   attachment whose archive move failed keeps its source in `uploads/<id>/assembled` with a
   live upload row. The L1 conditional stale-upload rule then never removes it, so the
   original (with its EXIF/GPS) stays forever. The hourly janitor therefore:
   - retries the archive move for FAILED attachments whose `uploads/<id>/assembled` still
     exists;
   - once the attachment is older than `FAILED_RETENTION_S` (7 days), deletes the source and
     the upload row regardless, queueing tombstones as usual.
4. **Keep every existing point fix** (00151, 00152, the round-7 preserve-in-place archive
   rule). They stay correct, and A is the backstop behind them.

## Answers to the questions asked

- **(a)** A + B, not 1 + 2 as proposed: a supervisor instead of per-tick try/except
  (plus per-item isolation in inner groups), and the marker moved into SQLite instead of a
  retry helper.
- **(b)** The additional sites are the push per-message dispatch, the AI chat readiness
  tracker, the watcher (all in the shared group), the WAL `stat()`, the post-commit route
  steps, and lingering unarchived failed originals. They are all listed above: one sweep, not
  another failing run.
- **(c)** §17 does not forbid a background tick failing and retrying. Its guarantees rest on
  durable owed-state, compare-and-clear, and idempotent work. A failed tick leaves owed-state
  untouched and the next tick retries. The constraints: a failure must never clear owed-state,
  never produce a 204, and never produce an error status after the commit (C2).

## Tests (acceptance)

- **Watcher survives:** with a chat loop patched to raise on its first tick, the watcher
  keeps running, the loop restarts with backoff, and health shows the failures; after 3
  failures, `mediaProcessing` reads `"degraded"`.
- **One-shot tasks:** a push dispatch that raises does not cancel the lifespan group, and
  the next message's push still goes out. The same holds for a raising AI chat readiness
  tracker.
- **Media queue:** one item raising does not cancel its in-flight sibling, and the failed
  item is re-claimed after the lease.
- **Type enforcement:** `app.state.background_tasks` exposes no `start_soon`; a mypy-checked
  usage test covers it.
- **Marker atomicity:** a rolled-back delete leaves no `pending_scrub` row; compare-and-clear
  keeps a newer token; a legacy `scrub.pending` file is imported then removed.
- **`scrub()` tolerance:** with `stat()` raising `PermissionError` once, `scrub()` returns
  False or retries, and does not raise.
- **Post-commit containment:** an exception injected after the commit → 202, and the worker
  completes it later.
- **Linger cleanup:** a failed attachment with a lingering source is archived on the next
  janitor pass, or deleted after 7 days.
- **Stability:** **5 consecutive full-suite runs on hub with zero failures** (bare `pytest`,
  the `-n 4` cap). The races are load-dependent, so one green run proves nothing.
