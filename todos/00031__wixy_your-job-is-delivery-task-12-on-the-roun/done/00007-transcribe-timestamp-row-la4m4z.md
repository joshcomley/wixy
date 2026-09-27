# 00007 [la4m4z] Align voice-note transcription action and timestamp

## What

Place the voice-note Transcribe/Retry action left and its message time right on one row; keep time after text when expanded.

## Outcome

PR #294 merged to `main` at `d8912d2eb18371f3639edd6d78f0f19cfe5b58df`; the layout is live. Independent verification passed: typecheck, Vitest 200/200, Playwright 12/12. The exact candidate was cleared with 0 critical / 0 high.

Two non-blocking review findings were authorized for a later checkpoint and remain open: preserve timestamp/reactions on view-once bubbles and remove six trailing-whitespace lines. Tracked as [lr4uac].

## Where shipped

[PR #294](https://github.com/joshcomley/wixy/pull/294); current production is version 77 on the green slot at `6bf7918`.