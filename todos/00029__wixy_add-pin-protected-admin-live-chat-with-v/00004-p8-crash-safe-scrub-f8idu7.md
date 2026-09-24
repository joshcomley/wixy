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
- Keep the follow-up local. The DM owns fresh Sol review and sec.13 audit; do not push or run/arrange sec.13.
- Latest evidence after both medium fixes and the late-chunk fix: affected backend store/janitor/routes/media-queue slice 141/141 passed; Ruff check/format passed; mypy passed across 206 sources. Prior Admin Vitest 1,095, strict typecheck, and P8 Server chat Playwright 7/7 remain valid; the follow-up does not touch the frontend.
- Earlier combined chat/media Playwright run was 8/11: all seven P8 tests passed; three P6b media-processing cases timed out while rows remained processing under severe CPU/disk load. This limitation is not re-tested in this continuation.

## Relevant files + commits

- Backend: `wixy_server/livechat/store.py`, `janitor.py`, `media_queue.py`, `uploads.py`, `wixy_server/routes_livechat.py`, `routes_livechat_media.py`, and `app.py`.
- Client/build/docs: `admin-ui/src/server/api/messages.ts`, `settingsSheet.ts`, `thread.ts`, the settings tests, `wixy_server/static/admin/admin.js` and map, `docs/ai/`, and `spec/server-chat/00-brief.md`.
- Coverage: `test_livechat_store.py`, `test_livechat_janitor.py`, `test_routes_livechat.py`, and P8 Server chat Playwright suite.

## How to continue + acceptance

1. Review final diff and ensure generated files have no drift.
2. Commit this follow-up with a `Release-note:` trailer.
3. Send the DM the exact base/candidate SHAs, scan-scaling and late-chunk fixes, verification, and the P6b E2E caveat; request fresh exact-SHA Sol review. DM owns sec.13. Do not push.
4. Amend Answers entry #1912 with the updated plain-English status.
