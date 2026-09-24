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
- Candidate is committed locally and the exact-SHA handoff was sent to the DM. Fresh Sol review and sec.13 audit remain with the DM; do not push or run sec.13.
- Latest evidence: affected backend slice reported 134 passed plus one concurrency-sensitive assertion failure; after correcting the assertion to allow a second startup scrub, that test passed alone, and the final delete/wipe route subset passed 12/12 after removing post-scrub retries. Admin Vitest 1,095 passed; strict typecheck passed; Ruff check/format and mypy 206 sources passed; P8 Server chat Playwright 7/7 passed. Build completed and refreshed committed bundle/map.
- Earlier combined chat/media Playwright run was 8/11: all seven P8 tests passed; three P6b media-processing cases timed out while rows remained processing under severe CPU/disk load. This limitation is not re-tested in this continuation.

## Relevant files + commits

- Backend: `wixy_server/livechat/store.py`, `janitor.py`, `media_queue.py`, `uploads.py`, `wixy_server/routes_livechat.py`, `routes_livechat_media.py`, and `app.py`.
- Client/build/docs: `admin-ui/src/server/api/messages.ts`, `settingsSheet.ts`, `thread.ts`, the settings tests, `wixy_server/static/admin/admin.js` and map, `docs/ai/`, and `spec/server-chat/00-brief.md`.
- Coverage: `test_livechat_store.py`, `test_livechat_janitor.py`, `test_routes_livechat.py`, and P8 Server chat Playwright suite.

## How to continue + acceptance

1. Review final diff and ensure generated files have no drift. Complete.
2. Commit with a `Release-note:` trailer. Complete.
3. Send the DM the exact base/candidate SHAs, changes, verification, and the P6b E2E caveat. Complete; fresh Sol review and sec.13 remain pending with the DM.
4. Amend Answers entry #1912 with the plain-English final status. Complete.
