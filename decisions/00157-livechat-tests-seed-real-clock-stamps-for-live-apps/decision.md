# Decision

**Status:** accepted

**Scope:** `wixy_server/tests/test_routes_livechat.py` (test-only; no product code changed).

## Symptom

`TestSendHistoryUsage::test_attachment_count_boundaries[10-201]` failed intermittently: in 4 of 7
full-suite runs on the Delivery Manager's box, and it passed when run alone. The failing
response was:

```
422 {"error":"invalid","detail":"attachment 00000000000000000000000000000001 is unknown, already used, or failed"}
```

## Root cause

The test seeded its attachments with `store.create_attachment(..., now=float(index))`, i.e.
timestamps `0.0` to `9.0` (January 1970), into the store of a live app (`TestClient` runs the
lifespan). That app's janitor (`livechat/janitor.py`) sweeps immediately when it starts and then
every hour (`run_forever`). Its sweep deletes every unreferenced attachment
(`message_seq IS NULL`) older than `ORPHAN_ATTACHMENT_AGE_S` (24 h) through
`store.orphan_attachment_ids` and `delete_orphan_attachment_if_unclaimed`. To that sweep the
seeded rows were 50-year-old orphans. Whenever the startup sweep ran between the seeding and the
`POST /messages`, the attachments were already gone and the send returned 422.

The product behaviour is correct: reaping old orphans is the janitor's job. The test's fake
timestamps were the bug. The mechanism was reproduced deterministically by calling
`janitor.run_once(store=..., paths=..., now=time.time())` between the seeding and the POST while
the seeds still used the 1970 stamps: the `[10-201]` case failed every time with the message
above. With real-clock stamps the same forced sweep leaves the rows alone and the case passes.

The same near-epoch pattern existed in other tests in the module that seed a live app's store
directly, so they were exposed to the same sweep:

- the wipe-route test seeded a bare upload with `created_at=1.0` before starting the app, and
  the startup sweep's stale-upload rule (`stale_upload_ids`, 24 h, unpromoted only) could remove
  it before the wipe under test did; its 404 assertions held either way, so it proved less than
  it claimed;
- the token-audit test created an attachment at `now=1.0` inside a running app before sending
  the message that references it (same race window as the failing test);
- the delete-route, delete/wipe-open-media and publish-before-cleanup tests seeded attachments
  and uploads at `1.0`/`2.0`.

## What was decided

- Seed attachments and uploads that go into a live app's store with `time.time()` (attachment and
  upload first, the message that references them one second later).
- `test_attachment_count_boundaries` now forces a janitor sweep between the seeding and the POST,
  so an ancient stamp fails it on every run instead of only when the startup sweep lands late.
- An autouse fixture, `_live_app_seeds_must_be_recent`, refuses (`AssertionError`) an attachment
  or upload stamped older than the janitor's own window (`ORPHAN_ATTACHMENT_AGE_S` /
  `STALE_UPLOAD_AGE_S`) when the store belongs to an app built through `create_app` in that
  module. Stores built directly (`LiveChatStore(path)`, used by the stream tests, the store and
  the janitor unit tests) still accept historical stamps. `TestLiveAppSeedTimestampGuard` covers
  both halves, and the guard was mutation-checked by putting an ancient upload stamp back into
  the wipe-route test: it failed with the guard's message.
- The reviewer's low-severity nit in `test_livechat_processing.py` is closed: the 16-bit
  grayscale midtone tests now compare against the literal `128` instead of recomputing
  `round(32768 * 255 / 65535)`.

## Why

Fixing the seeds removes the intermittent failure at its cause without touching product code,
and the forced sweep plus the guard turn "a future test seeds an old stamp" from a rare
intermittent failure into an immediate, explained one. Loosening the janitor or lengthening
its window in tests would hide the behaviour the janitor is supposed to have.

## What to watch for

- Evidence is limited to what was measured: 4 failures in 7 full runs and a pass when run alone
  (Delivery Manager), the janitor code path read, and the deterministic reproduction above.
  Nothing else about the failure rate is claimed.
- The guard lives in `test_routes_livechat.py` only. A new test module that drives a live app
  and seeds the store directly needs the same fixture (or hoist it to a shared `conftest.py`).
  `test_routes_livechat_media.py` seeds through the HTTP API and needs nothing.
- If the janitor's age windows change, the guard follows them automatically (it reads the
  constants); the real-clock seeding rule does not change.
- Live apps also start background workers that pick up seeded rows in other ways: see
  [00151](../00151-windows-permissionerror-concurrent-delete-race/decision.md) for a seeded
  `processing` attachment being claimed by the real media queue.
