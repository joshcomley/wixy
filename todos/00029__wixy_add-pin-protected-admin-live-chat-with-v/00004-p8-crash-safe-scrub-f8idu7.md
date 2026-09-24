# 00004 [f8idu7] Finish P8 delete/wipe erasure and hand off candidate

## What

Deliver P8 delete/wipe with crash-resumable database and media cleanup, revoked signed media URLs, and the Architect's unified pending-status contract.

## Why

The v1.5.3 candidate had two critical Sol findings: a crash could leave deleted media files without recovery work, and ignored unlink errors could leave old signed media URLs usable. The Architect's v1.5.4 ruling requires file cleanup before DB scrub, retries for locked files, and one `erasurePending` signal.

## Context + current state

- Workspace #29, Builder P8, build space `bs7`; branch `cmd/workspace-00029-bs7`.
- Base feature head: `fa8223d6a6140bfabd5332b0fdbca38701299ee2`.
- Previous candidate: `fb6b463f62da8828ec8c3cf727acd160628af802`.
- Current implementation records deleted storage IDs in the delete/wipe transaction, strictly retries failed unlink operations, gates signed media reads on a live attachment row, and resumes cleanup at startup/every two seconds.
- Follow-up to Architect's v1.5.4 ruling: background recovery now retries files before DB scrub; DELETE, wipe, and `/usage` expose one `erasurePending` field.
- The DM's fresh Sol review confirmed both critical findings and the first medium were resolved, then measured a second medium: the full unreferenced-storage scan cost 0.221 s with 100 live attachments and opened a DB connection per entry every two seconds.
- The follow-up scans only at startup or while a wipe-sweep token is pending. It enumerates candidate paths before one batched live-ID snapshot, skips journaled pending IDs, and creates a durable retry token when a startup scan fails. This preserves newly-created post-wipe uploads while avoiding routine full-tree scans and per-entry DB calls.
- Sol then found a high: cancellation after a chunk write could skip the row check, and completed tombstones were no longer scanned on ordinary ticks. The route now shields write plus post-write check; missing-upload cleanup re-marks the validated upload ID before retrying, so late bytes are removed even after prior cleanup completed.
- DM then reproduced a second test failure: the background scrubber and wipe route could both invoke `store.scrub()` for one marker. Route and worker scrub attempts now share `LiveChatStore.scrub_guard()` and re-read the marker under the lock; a route skips the scrub if the worker already completed it.
- Sol then found a concurrent cleanup/requeue race: an older file-removal pass could clear a newer late-write requeue. Schema v5 adds a tombstone generation; requeue increments it, and a cleanup pass clears pending only if its generation still matches.
- The Architect's holistic review then required R1-R3 and L1-L2 before merge. Implemented: publish delete/wipe immediately after commit; cap each WAL checkpoint wait at 250 ms; include scrub-guard acquisition in the request deadline; conditionally delete only unclaimed attachments/unpromoted uploads; prune completed tombstones after seven days while retaining pending rows. Do not edit `spec/server-chat/00-brief.md`; the Architect will reconcile it after merge.
- Keep the follow-up local. The DM owns fresh Sol review and sec.13 audit; do not push or run/arrange sec.13.
- Latest evidence after the Architect's full review fixes: affected backend store/janitor/routes/media-queue slice 150/150 passed; R1 stream-order tests cover delete and wipe; R2 concurrent send under stale reader returns 201; R3 held-guard delete returns 202 within deadline; janitor conditional-delete/pruning tests pass. The wipe marker test also passed 3/3 isolated runs with `-p no:randomly`; Ruff check/format passed; mypy passed across 206 sources. Prior Admin Vitest 1,095, strict typecheck, and P8 Server chat Playwright 7/7 remain valid; this follow-up does not touch the frontend.
- Earlier combined chat/media Playwright run was 8/11: all seven P8 tests passed; three P6b media-processing cases timed out while rows remained processing under severe CPU/disk load. This limitation is not re-tested in this continuation.

## Relevant files + commits

- Backend: `wixy_server/livechat/store.py`, `janitor.py`, `media_queue.py`, `uploads.py`, `wixy_server/routes_livechat.py`, `routes_livechat_media.py`, and `app.py`.
- Client/build/docs: `admin-ui/src/server/api/messages.ts`, `settingsSheet.ts`, `thread.ts`, the settings tests, `wixy_server/static/admin/admin.js` and map, `docs/ai/`, and `spec/server-chat/00-brief.md`.
- Coverage: `test_livechat_store.py`, `test_livechat_janitor.py`, `test_routes_livechat.py`, and P8 Server chat Playwright suite.

## How to continue + acceptance

1. Review final diff and ensure generated files have no drift.
2. Commit this follow-up with a `Release-note:` trailer.
3. Send the DM the exact base/candidate SHAs, R1-R3/L1-L2 fixes, verification, and the P6b E2E caveat; request fresh exact-SHA Sol review. DM owns sec.13. Do not push.
4. Amend Answers entry #1912 with the updated plain-English status.

## Round 8 update — Architect containment ruling

Implemented the 2026-09-24 v1.5.6 ruling from `spec/server-chat/01-background-containment-ruling.md` (commit `83bc29b`): all main and standalone-worker app tasks now use `ContainedTaskGroup`; media items and push recipients are isolated; media status degrades after three repeated media/erasure failures. Schema v6 stores the scrub token in SQLite, with a startup import for legacy `scrub.pending`; the scrubber compare-clears after a complete checkpoint and makes one best-effort checkpoint afterward. Committed deletes/wipes return 202 on any post-commit cleanup exception. The WAL `stat()` retries on `OSError`. The janitor retries unarchived failed originals hourly and removes the staged original after seven days.

The round-7 archive retention finding now has a red/green regression: a denied `os.replace` preserves the upload row and only original, then a later janitor pass archives and removes the staged copy. The 7-day expiry path is also covered. Decision 00152 now reports only observed failure facts; it no longer asserts an unproven race ordering.

Local verification: Ruff check/format and mypy over 208 sources pass; strict admin typecheck passes; Admin Vitest 1,095/1,095; focused backend slice 227/227; full Python suite 1,709/1,709; Server chat Playwright 7/7. The DM still owns the required five consecutive full-suite runs, fresh Sol review, and sec.13 audit. No push/PR.

The verified implementation is committed locally with the required `Release-note:` trailer. Send the final exact head SHA to DM and Orchestrator and wait for their review/acceptance. Do not push or run sec.13.

## Round 9 update — final Sol findings from the round-8 pass

Three additional review gaps are now fixed on top of the round-8 candidate:

- If an existing legacy `scrub.pending` file raises `OSError` on startup read, the store creates a synthesized `pending_scrub` row with `ON CONFLICT DO NOTHING` and leaves the file for a later startup retry. This prevents owed scrub work from disappearing during a transient Windows sharing denial.
- Health reads now report zero consecutive failures after 300 seconds without another failure, so `mediaProcessing` recovers while a supervised loop is healthy rather than waiting for a later failure.
- The hourly janitor now finds ready attachments that still have upload rows, deletes those raw upload rows/files immediately, and leaves deletion journaled if filesystem cleanup fails. Ready renditions need no raw-source retention window.

Regression tests first failed on the existing code, then passed after the fixes. Ruff check and `ruff format --check` pass; mypy passes across 208 sources; focused background/store/janitor slice passes 71/71. The DM's five-run full-suite acceptance and remaining Sol review continue independently on a detached snapshot. This round does not touch that snapshot. No push/PR; section 13 remains DM-owned.

## Round 10 update — health reset boundary

Sol found that the health counter's write-side reset used only the current attempt's runtime, while the read-side reset used elapsed time since the previous failure. It now uses the same wall-clock gap on both sides, so supervisor backoff is included and a new failure after five quiet minutes starts a fresh streak. A regression simulates three failures at t=1000, then a new failure at t=1301 after a 297-second attempt; the count resets to one rather than four.

Verification: Ruff, `ruff format --check`, and mypy across 208 sources pass; focused background/status tests pass 17/17. Commit this narrow change with a `Release-note:` trailer and send the exact SHA to DM; do not push or run section 13.
