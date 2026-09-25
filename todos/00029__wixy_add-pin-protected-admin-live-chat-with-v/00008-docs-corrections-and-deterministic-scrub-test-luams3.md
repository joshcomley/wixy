# 00008 [luams3] Post-merge docs corrections and deterministic scrub-guard test

## What
Fix the reviewer's post-merge findings on PR #242 (two wrong doc statements: the wipe history-failure behaviour in
`docs/ai/livechat.md` and decision 00158's claim that Inv 41 documents the unlock guard; plus five stale or incomplete
statements), and replace the wall-clock assertion in `test_scrub_guard_wait_counts_against_request_deadline` with
load-independent observables (decision 00159).

## Why
The full suite failed once locally on that test (1.77 s elapsed against a 0.5 s bound) while CI on the same commit was
green; the route's own work measures about 10 ms, so the bound only tested how busy the machine was.

## Context+current-state
Delivery Manager session, branch `cmd/workspace-00029-dm-testfix` off `main` 44c270c. Docs claims were re-verified
against the code (thread.ts, settingsSheet.ts, messages.ts, tokens.py) before being rewritten.

## Relevant files+commits
- `docs/ai/{livechat,invariants,contracts}.md`, `decisions/00149,00158,00159`
- `wixy_server/tests/test_routes_livechat.py`

## How to continue + acceptance
Acceptance: ruff, format check, mypy clean; the test passes and fails when the route's guard wait is made unbounded or
fixed at 10 s (mutation-checked); full bare pytest green; PR merged with the standard release-note trailer.
