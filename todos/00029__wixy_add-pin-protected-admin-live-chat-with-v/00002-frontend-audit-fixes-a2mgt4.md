# 00002 [a2mgt4] Frontend audit fixes F1, F3, F4, F5 and F11

## What

Resolve the Delivery Manager's frontend fix round for the Server chat pre-delivery audit: push toggle reachability (F1), immediate isolated voice-note send (F3), stale attach/stream cancellation (F4), PIN unlock copy/length/attempts (F5), and indeterminate delete/wipe timeouts (F11).

## Why

The Opus audit identified user-visible behaviors that do not meet the frozen Server chat spec. The Delivery Manager assigned this module to build space bs10 and requires failing tests before each fix.

## Context + current state

- Feature branch: `cmd/workspace-00029`; this build branch: `cmd/workspace-00029-bs10`.
- Starting revision: `a02e08021e17a5198dbb878cce5e57e560b959cc`, containing feature head `b0d3470` plus audit-preparation documentation.
- Full module brief: `http://127.0.0.1:9321/intercomm/03e49f50b4e840a0af56ff09b00b2e93`.
- Do not edit `spec/` or `docs/ai/`; do not push or merge. Commit locally with the exact `Release-note: General bug fixes and improvements.` trailer.

## Relevant files + commits

Expected frontend areas: `admin-ui/src/server/settingsSheet.ts`, `thread.ts`, `chatView.ts`, `api/http.ts`, `api/unlock.ts`, `pinPad.ts`; tests under `admin-ui/test/` and `e2e/`; rebuilt bundles under `wixy_server/static/admin/`.

## How to continue + acceptance

For every finding, add/run a regression test and observe it fail before implementing the fix, then observe it pass. Run admin-ui typecheck, Vitest, build and bundle-drift check; add/update the named E2E specs. Run Ruff check/format check and mypy, then the full Python suite alone. Commit locally and send the exact candidate SHA, red/green evidence, verification outcomes, finding-by-finding file/line summary and review notes to the Delivery Manager and Orchestrator. Do not open or merge a PR pending DM clearance.

## Links

- Frozen behavior: `spec/server-chat/00-brief.md` sections 5.1, 8, 9, 11, 12, 17.3.
- Containment decision: `spec/server-chat/01-background-containment-ruling.md`.

## Verification update — 2026-09-24

- F1-F5 and F11 are implemented. F4 also guards a stale attach rejection after a newer unlock; its regression test was observed red before the guard.
- Red/green coverage: Android push-sheet mounting; immediate isolated voice send and retry after upload failure; pending attach/detach and stale stream/401 handling; PIN status mapping and 4-digit minimum; long destructive timeout, unknown outcome and no-repeat wipe.
- `npm test`: 1,117 passed across 62 files. `npm run typecheck`: passed. `npm run build`: completed; rebuilt admin bundle and source map are included.
- Targeted Playwright: 5 passed — voice immediate-send/media playback, Android and desktop push visibility/subscription, and desktop/mobile PIN lockout copy.
- `ruff check .`, `ruff format --check .`, `mypy`: passed. Bare `pytest` with configured `-n 4`: 1,713 passed; 4 Starlette/httpx deprecation warnings.
- Remaining: create the local candidate commit with the required release-note trailer, send the exact SHA and handoff to DM + Orchestrator, and wait for exact-candidate clearance. No push or merge before clearance.
