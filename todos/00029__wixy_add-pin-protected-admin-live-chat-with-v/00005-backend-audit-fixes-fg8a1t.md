# 00005 [fg8a1t] Fix backend audit findings F2/F13/F6/F7/F8/F9/F10/F12

## What
Implement the Delivery Manager's backend audit fix round for eight Server chat findings.

## Why
Close image color loss, unavailable HEIF dependency reporting, privacy-test gaps, upload size underflow, PIN validation echo, malformed token handling, event-loop blocking store calls, and weak raw-byte erasure tests.

## Context+current-state
Assigned by Delivery Manager on 2026-09-24 in workspace #29. Work only in build space bs9 on `cmd/workspace-00029-bs9`; do not edit docs/spec, push, or merge. Tests must be added and observed failing before each fix, then pass after the fix. Candidate requires a local commit with the exact release-note trailer and an exact-SHA final handoff for DM clearance.

## Relevant files+commits
- `wixy_server/livechat/processing.py`
- `wixy_server/app.py`
- `wixy_server/backup/snapshot.py`, `wixy_server/reports.py`, public routes and corresponding tests
- `wixy_server/routes_livechat_media.py`, `wixy_server/livechat/uploads.py`
- `wixy_server/routes_livechat.py`, `wixy_server/livechat/tokens.py`
- `wixy_server/livechat/media_queue.py`, related async store callers
- `wixy_server/tests/test_routes_livechat.py`, `test_livechat_store.py`

## How to continue + acceptance
For every finding: write a regression test first, run it red on the current implementation, apply the narrow fix, and run it green. Then run formatting check, lint, mypy, and the full Python suite alone. Merge `origin/cmd/workspace-00029` before the candidate is frozen; create a local commit with `Release-note: General bug fixes and improvements.`. Send the DM the exact final SHA, test results and per-finding summary; wait for clearance before any PR/merge.

## Links
- DM brief: intercomm `c1d3ea5cf00d48b5b55a6dd9f02b966e`

## Update 2026-09-24 — implementation and verification

- Incorporated the feature-branch Architect ruling in `spec/server-chat/02-audit-r3-rulings.md`: F2 now normalizes all photo modes to RGB/RGBA, converts embedded profiles to sRGB when possible, preserves alpha in PNG renditions, keeps opaque PNG/static-GIF full images lossless, and handles transparent thumbnails as PNG.
- All eight DM findings are implemented. F6 and F12 guards were mutation-checked and failed under simulated exposure / bypassed scrub before the implementation was restored.
- Synchronized from feature branch `cmd/workspace-00029` at `0fe4439`; no code conflicts.
- Affected backend modules: 325 passed. Full suite: 1,743 passed, 4 existing FastAPI/Starlette deprecation warnings. `ruff format --check .`, `ruff check .`, `mypy`, and `git diff --check` are clean.
- Current state: ready for the required local candidate commit and exact-SHA DM handoff; awaiting DM clearance before any PR or merge.
