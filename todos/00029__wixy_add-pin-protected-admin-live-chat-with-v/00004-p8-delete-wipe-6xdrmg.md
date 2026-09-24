# 00004 [6xdrmg] Build P8 delete and wipe

## What

Implement P8 as a vertical slice: schema v2 migration, hard-delete store methods and protected
routes, media/upload/failed cleanup, race handling, message action sheet, wipe confirmation,
stream/UI behavior, tests, docs, and decision record.

## Why

Complete operator decision #975 as specified in `spec/server-chat/00-brief.md` §17 while keeping
deleted content out of the database/WAL and private media paths.

## Context + current state

- Assigned to builder session `38e9c31a-9b91-48c9-ac20-9c5001a2f075` in build space `bs7`.
- Initially started from feature-branch commit `4d0957f`; the latest feature-branch merge is
  `7d6584b` (accepted v1.5.3 scrub errata) and is in the bs7 history. The branch already contains
  A1 stream event parsing and handling. P8 builds on that work.
- Local decision number `00148` is already occupied by the multi-tap e2e rule; use `00149` and
  record the numbering conflict.
- Earlier v1.4 E2E runs exposed the P8/R3 action-sheet conflict. The accepted v1.5.2 spec now
  requires gesture-boundary markers for causal surfaces; P8 E2E exercises open→pick→confirm
  without waits. Decision `00148`'s 400 ms waits still apply to unrelated tap pairs.
- The initial Sol review of `18fb1cf` found incomplete WAL scrubbing, SSE ordering, stale history
  and duplicate-wipe races. The Architect's later v1.5.3 ruling superseded the v1.5.2 checkpoint
  behavior; the implementation now uses durable pending scrubs and 202 responses.
- Verification on the integrated P6b/P8 tree: full Python suite 1,675 passed (P6b merge adds no
  Python source changes); affected P8 backend slice 130 passed; full admin Vitest 1,095 passed;
  strict admin typecheck; `mypy` over 206 sources; `ruff check .` and `ruff format --check .` clean;
  admin bundles rebuilt. Full Playwright matrix: 92/94 passed; the P8 server-chat and P6b media
  suites reran 11/11 after integration. Two unrelated publish/section-editor tests timed out; the
  section-panel toggle case reproduced alone. Fresh review and formal audit remain before handoff.
- Never merge or open a PR until the Delivery Manager clears the exact candidate SHA.

## Build baseline

- Frozen source: `spec/server-chat/00-brief.md` §17, revised spec v1.5.3.
- SHA-256: `E9591AA45D572E69635212757B1CDDCA80EA15F4CC3E477F9A5D82AA7ED3BCB0`.
- Frozen spec commit: `7d6584bfedaf409bef45f5d3e527df2b943ce0ce`.
- Latest integrated feature-branch head: `fa8223d6a6140bfabd5332b0fdbca38701299ee2` (P6b final merge).
- Accepted prerequisites: P1, P2b and P5b are already on the feature branch. P6b's independent
  voice-note minimum-duration delta is outside this parcel and has been reported to the DM.

## SpecDeltaLedger

- v1.5/v1.5.1/v1.5.2 gesture-boundary rule: affects R3 and P8's trigger/menu/settings/E2E
  surfaces; architectural impact is security/gesture semantics. Status: **Implemented** using
  `data-srv-gesture-boundary`, primary-button filtering, and the `may close, never open` classifier.
- v1.5.2 voice notes shorter than 1 second: implemented in P6b and included in the integrated
  feature-branch base; no separate P8 delta.
- v1.5.3 scrub errata: both operations TRUNCATE, 204 guarantees empty WAL, 202 persists
  `scrub.pending` and resumes in the 2 s background scrubber; `/usage.scrubPending` drives UI
  polling. Status: **Implemented** with token-conditional marker clearing.

## Relevant files + commits

- Frozen acceptance: `spec/server-chat/00-brief.md` §17.1–§17.6.
- Backend: `wixy_server/livechat/store.py`, `routes_livechat.py`, `livechat/media_queue.py`.
- Frontend: `admin-ui/src/server/{api/messages.ts,messageActions.ts,thread.ts,settingsSheet.ts,chatView.ts,chat.css,gestures.ts,mediaRender.ts}`.
- Coverage/docs: `wixy_server/tests/test_livechat_store.py`, `test_routes_livechat.py`,
  `test_livechat_media_queue.py`, `admin-ui/tests/server/gestures.test.ts`,
  `admin-ui/tests/serverThread.test.ts`, `admin-ui/tests/serverSettingsSheet.test.ts`,
  `e2e/tests/server-chat.spec.ts`,
  `docs/ai/{contracts.md,livechat.md,invariants.md}`, decision `00149`.

## How to continue + acceptance

Run backend targeted and full tests, strict admin typecheck/Vitest/build, and the server-chat E2E
suite. Verify message deletion/wipe semantics, migration sequence preservation, raw-byte marker
absence from DB+WAL, exact 422 wipe guard, no push, queue races, multi-client removal, stale media
URL 404, wipe replay after reload, and long-press/double-tap behavior. Commit a stable candidate
with the required `Release-note:` trailer, complete self-review/audit, and send the DM a FINAL
HANDOFF with base/head SHAs and all verification results. Wait for clearance for that exact SHA.

## Links

- Workspace #29 `0ae788cb-70c8-4710-a411-88aa5445df15`; feature branch `cmd/workspace-00029`.
- Build branch `cmd/workspace-00029-bs7`; build space id `789e14c5-9f2d-4a90-ba3b-4007680ed41f`.
