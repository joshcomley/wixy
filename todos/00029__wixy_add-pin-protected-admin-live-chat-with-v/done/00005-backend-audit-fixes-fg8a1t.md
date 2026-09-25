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

## Update 2026-09-24 — DM traceability addendum

- The DM added Sol's traceability rows #29, #45, #46, #51 and #76 after the first handoff. These are proof-strength gaps, not known production defects; no implementation defect surfaced.
- Added real-JWT email-redaction and Server Access-gate tests; CSRF preflight/simple-form tests; unlock-token API/media/SSE/log non-disclosure tests; and send-boundary tests for text, sender/control chars, client ID and attachment count.
- Each new row's guard was mutation-checked: serialization echoed email; API Access gate was bypassed; wildcard CORS was installed; send echoed the unlock header; and the send bound checks were disabled. Each targeted test failed as expected; all mutations were restored.
- Prior candidate `8c735cffe68cfb6d3b828c768926d09eda3291b4` is superseded by this follow-up and remains without DM clearance. Do not open a PR; new verification and replacement candidate SHA are required.

## Update 2026-09-24 — traceability proof round verified

- Added proof for Sol rows #29, #45, #46, #51 and #76. Email attribution is persisted but absent from POST/history/SSE wire data; Server unlock/API/service-worker paths reject missing JWT and accept a valid JWT; mutation preflights have no permissive CORS headers and a simple cross-origin form does not mutate; a deterministic real unlock token is absent from other API/media/SSE output, URLs and logs; all requested send boundaries are asserted.
- Each new guard was mutation-checked and failed when the respective behavior was weakened. A full run first exposed the manually seeded token-leak attachment racing the active media queue; the fixture now disables that unrelated worker and the isolated test passes.
- Affected modules: 351 passed. Final full suite: 1,760 passed, 4 existing Starlette/httpx deprecation warnings. Format, lint, mypy and diff checks pass.
- Re-fetched `origin/cmd/workspace-00029`; no new commits since `0fe4439`. Replacement candidate commit is pending. Prior candidate `8c735cf` remains superseded; no PR was opened.

## Current state after DM addendum commit

- The replacement test-proof commit is now recorded locally after the implementation commit. The earlier `8c735cf` candidate remains superseded; the current exact head will be supplied in the replacement DM handoff.
- No PR, push or merge has occurred. Awaiting exact-head final verification and DM clearance.

## Update 2026-09-24 — independent round-2 findings

- Sol's fresh review of `51513b1896aa3012a637cc9d50df381c91a1f696` reported C0/H0/M2/L1. New round: M1 correct 16-bit grayscale scaling (test now expects independently calculated midtone 128 in full and thumb; both final RGB normalization and ICC input prep use the LUT); M2 strengthen F6 proof (live public build plus positive public-file control; inspect actual pushed backup canaries); L1 redact malformed unlock-body shapes (raw JSON parsing returns generic 422 for missing/misspelled key, wrong type or non-object body).
- Red evidence: old grayscale clipping produced white at 32768 versus expected 128; missing/misspelled PIN shapes echoed under FastAPI Pydantic validation. M2 public test fails when the live pointer setup is removed; backup snapshot test fails when the parent project directory is selected as the allowlist source. All temporary mutations were restored.
- Focused M1/M2/L1 checks: 30 passed. Previous candidate `51513b1896aa3012a637cc9d50df381c91a1f696` is superseded pending full affected/full-suite verification and a new exact-SHA handoff. No PR/push/merge.
