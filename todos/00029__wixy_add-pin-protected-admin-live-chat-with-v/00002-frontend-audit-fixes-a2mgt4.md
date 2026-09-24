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

## Review expansion — 2026-09-24

The DM and Architect sent follow-up requirements after the first candidate. Work now also includes:

- Architect ruling `spec/server-chat/02-audit-r3-rulings.md` at `0fe4439`: DELETE retries unknown outcomes up to three times after 1/2/4 seconds and restores after exhaustion; wipe never retries and reconciles with history; add the delayed 12-second DELETE E2E.
- DM traceability addendum `http://127.0.0.1:9321/intercomm/5427146c13d04130bd365fc460b02991`: add proof for rows #13, #27, #42, #64, #65, #69 and #70, retaining F1 mounted-toggle and F3 send-before-Send e2e proof.
- Superseding corrected matrix `http://127.0.0.1:9321/intercomm/65b0d0958d5347fc8bf7b745e2155695` (replaces the earlier stale file:line pointers).
- Prior candidate `76982876395918a18a533333e3f3f6034b2ce551` remains local; expanded work will produce a new candidate and require a new exact-SHA DM handoff.
- Red-first traceability proof is being added for rows #13/#27/#42/#64/#65/#69/#70. One additional F11 defect was found red-first: `wiped` history reconciliation dropped a newer `message` stream event that arrived during the refetch. The fix preserves post-request confirmed messages while clearing older history; report as `P-F11` in the replacement handoff.

## Expanded verification update — 2026-09-24

- F11 now follows Architect ruling: 30s dedicated DELETE/wipe transport policy; DELETE performs up to three explicit retries after 1/2/4 seconds on unknown network outcomes and restores with the confirmation copy after exhaustion; wipe is never retried, refetches all history, preserves only post-request messages when committed, and restores/re-enables retry only when older messages remain.
- Fixture has a post-commit DELETE response delay control. The two-client E2E holds the HTTP response 12 seconds; both bubbles disappear before the response and stay removed after it.
- Sol proof rows: #13 token-surface E2E; #27 settings rename/persistence E2E; #42 no title/favicon/nav signal E2E; #64 desktop contextmenu E2E plus unit; #65 clipboard success/media-only/rejection unit; #69 used/quota/unavailable/failure unit; #70 real settings Lock E2E. Each has a red probe documented in the builder transcript.
- New real defect `P-F11`: a post-request message event arriving during wipe history reconciliation was lost when old state cleared; a red-first regression test exposed it, and reconciliation now preserves post-request confirmed stream messages.
- Current E2E: 9 passed (six server-chat proof/delayed-delete cases, desktop+Android push, immediate voice send/media playback). Earlier desktop/mobile PIN lockout e2e also passed.
- Current `npm test`: 1,133 passed across 64 files; `npm run typecheck` passed; `npm run build` passed; `ruff check .`, `ruff format --check .`, and mypy (208 files) passed; bare `pytest` with fixed `-n 4`: 1,713 passed, 4 Starlette/httpx deprecation warnings.
- Remaining: commit the replacement candidate with the required release-note trailer, send its exact SHA and this expanded handoff to the live DM + Orchestrator, then wait for exact-SHA clearance. No push/merge.

## Replacement candidate committed — 2026-09-24

- Expanded work is committed locally on `cmd/workspace-00029-bs10` as the replacement candidate; its exact SHA and parent are in the peer handoff. The prior candidate is superseded.
- Red-first probes passed for all seven proof rows and F11. Additional `P-F11` stream-message preservation regression also failed before its fix and passes now.
- Final counts at handoff: Vitest 1,133/64 files; pytest 1,713 with 4 deprecation warnings; 9 targeted E2E cases passed; TypeScript, Ruff, mypy and post-commit bundle drift check passed.
- No PR, push, or merge. Await exact-SHA Delivery Manager clearance.
