# 00007 [uwullv] Final docs-versus-final-code pass and the intermittent attachment-boundary test fix

## What
Remove every pending-audit-fix caveat marker, describe the Server chat as built after audit round 3, fix the
flaky `test_attachment_count_boundaries[10-201]`, and record the root cause as decision 00157.

## Why
The next security-audit round reads the docs against the final code, so they must contradict nothing.
The operator ruled docs are not a delivery gate: this lands as a separate PR onto main after go-live.

## Context+current-state
Builder `0e5ced21` (claude-sonnet-5) in build space bs11, branch `cmd/workspace-00029-bs11`, brief from the
Delivery Manager (`dbeac31f`). Work started from feature head `2d9d2cc` (PR #234 merged). Commits are limited
to this module's own changes (no feature-branch merges after the catch-up, which was a no-op) so they can be
cherry-picked onto a fresh main-based branch; this todo commit is separate so it can be dropped.
Commits: test fix + guard + decision 00157; tests pinning the unlock 422 body and animated-GIF thumbnails;
the docs pass. Root cause of the flake: the test seeded 1970-dated attachments and the app janitor's startup
sweep (24 h orphan rule) deleted them when it landed before the POST; not a product bug.

## Relevant files+commits
- `docs/ai/{invariants,livechat,contracts,runbook,media,testing}.md`, `decisions/00145,00146,00147,00149,00157`
- `wixy_server/livechat/pinclient.py` (one stale comment), `wixy_server/tests/test_routes_livechat.py`,
  `wixy_server/tests/test_livechat_processing.py`

## How to continue + acceptance
Final handoff to the DM with the exact SHA and per-item mapping; do not open a PR or merge before clearance.
Acceptance: no pending-audit-fix marker anywhere; ruff, format check, mypy clean; full bare pytest green;
docs checker clean for these changes; `git diff --check` clean.

## Links
- DM brief: intercomm `298f2688cd254531b94c5eab137324b4`; scope update: `6c0a02c7397c4a3a83b002c0d7437f13`
