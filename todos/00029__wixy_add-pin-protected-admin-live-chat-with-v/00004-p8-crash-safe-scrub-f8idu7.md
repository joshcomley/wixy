# 00004 [f8idu7] Finish P8 crash-safe delete/wipe scrub recovery

## What

Close the remaining high severity finding in P8: if the server stops after a delete/wipe commits but during its synchronous WAL scrub, startup must still know to resume the scrub.

## Why

The accepted v1.5.3 brief requires startup recovery after a crash or slot swap mid-scrub. The previous implementation wrote `scrub.pending` only after the 10-second scrub timed out, leaving a crash window with no marker.

## Context + current state

- Workspace #29, Builder P8, build space `bs7`.
- Base feature head: `fa8223d6a6140bfabd5332b0fdbca38701299ee2`.
- Candidate before this fix: `952ef5efc6894f9b774ad3213f73ad6739146ad6`.
- Implemented locally: persist the marker under the same SQLite writer transaction as each delete/wipe, return its token to the route, and clear only that token after scrub success. Added route regressions for both operations.
- First targeted route run passed 44 tests. Combined live-chat routes/store/media queue passed 100 tests; `mypy` passed 206 source files; strict lint/format passed; focused browser run passed 11/11.
- Full Python suite is running in the background; see `%TEMP%\p8-full-pytest.log` and `.err.log` on this machine.
- The Architect was asked to confirm marker timing and the brief's `scrubPending` meaning; response pending at this update.

## Relevant files + commits

- `wixy_server/livechat/store.py`
- `wixy_server/routes_livechat.py`
- `wixy_server/tests/test_routes_livechat.py`
- Current code edits are uncommitted; do not hand off until committed and reviews are complete.

## How to continue + acceptance

1. Incorporate the Architect's response if it arrives; address any code concern.
2. Finish full Python verification and confirm generated `test-results/` is removed from the worktree.
3. Commit with a `Release-note:` trailer.
4. Get a fresh independent Sol review and the required top-tier Opus audit on the exact, latest-main-converged candidate. Fix findings and repeat review/audit as required.
5. Send the Delivery Manager a FINAL HANDOFF containing exact base/candidate SHAs, changes, verification, deviations, and recorded medium/low findings. Do not open a PR, push, or merge without exact-SHA clearance.
