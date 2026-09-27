# 00009 [lr4uac] Preserve view-once metadata after transcript-row change

## What

Restore the timestamp and reactions row on view-once bubbles, and remove the trailing whitespace introduced with the transcript action/timestamp layout.

## Why

The PR #294 render refactor moved reactions and timestamp into the ordinary-message branch, so view-once bubbles no longer render either. The same candidate added six whitespace-only line endings flagged by `git diff --check`.

## Context + current state

- This was a medium behavior regression and a low style finding from the independent review of candidate `0b038ba9e2970689529dafbed5a762ad3589e8d5`.
- Both findings were explicitly authorized as non-blocking work for a later checkpoint. PR #295 shipped the separate recorder Cancel/Stop & Send controls but did not include these fixes.
- PR #294 and PR #295 are live; current engine commit is `6bf7918adbf4464332847ddc434b5ab499acea7e` on green.
- No builder is assigned and no follow-up candidate exists.

## Relevant files + commits

- `admin-ui/src/server/thread.ts` (view-once message branch; PR #294 candidate `0b038ba`).
- `admin-ui/src/server/transcript.ts` and `e2e/tests/server-transcription.spec.ts` (six whitespace-only added lines).
- PR #294 merge `d8912d2`; follow-up recording-controls PR #295 merge `6bf7918`.

## How to continue + acceptance

1. Keep previous timestamp/reactions display on view-once bubbles while retaining the new transcript action/timestamp row behavior for regular voice-note messages.
2. Add a focused regression test for view-once metadata and clear `git diff --check`.
3. Run typecheck, the affected Vitest and Playwright suites, rebuild committed bundles, and use the generic release note for Server-chat commits.
4. Send an exact-SHA FINAL HANDOFF for independent review before opening a PR.

## Outcome

Completed and verified:
- `admin-ui/src/server/thread.ts`: Timestamp and reactions row restored to view-once bubbles (sender and recipient), alongside regular text and transcribable voice messages.
- Trailing whitespace removed across `thread.ts`, `transcript.ts`, and `server-transcription.spec.ts` (`git diff --check` passes cleanly).
- Unit regression tests added in `serverThread.test.ts` (timestamp, reactions, and live update verification).
- Playwright E2E assertion added in `server-view-once.spec.ts` verifying `.wx-srv-bubble-time` on view-once bubbles (passed in 19-test run).
- Full verification clean: `npm run typecheck`, 2416 Vitest tests, 2434 pytest tests, Playwright E2E suites (`server-view-once.spec.ts`, `server-transcription.spec.ts`, `server-reactions.spec.ts`), `ruff check`, and `mypy`. Bundle rebuilt with LF line endings.

## Links

- [PR #294](https://github.com/joshcomley/wixy/pull/294)
- [PR #295](https://github.com/joshcomley/wixy/pull/295)