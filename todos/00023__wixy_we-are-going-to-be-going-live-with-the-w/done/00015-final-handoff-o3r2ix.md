# 00015 [o3r2ix] FINAL HANDOFF to planner (pre-merge); iterate until CLEARED

## What
Self-review both branches (grade findings critical/high/medium/low; only crit/high block).
POST a structured FINAL HANDOFF to the planner's parent endpoint:
`POST http://127.0.0.1:9321/sessions/74703766-f2a8-4255-aafd-430ff10ba9a4/send` with JSON
`{"text": "<message>"}`. Include: `implementation_session_id` (this session's `$CMD_SESSION_ID`);
per-repo base SHA and candidate/head SHA (wixy branch + site-repo branch); changed-file +
behavior summary; verification commands and outcomes; deviations from the brief; both PR URLs;
self-review result incl. every recorded medium/low finding. Then END TURN and wait — do NOT
merge. If the planner replies `FINAL HANDOFF BLOCKED` with graded findings: fix, re-verify,
produce NEW candidate SHAs, send a NEW final handoff, repeat. Only `FINAL HANDOFF CLEARED`
naming the exact reviewed SHAs with 0 critical/0 high is permission to merge.

## Why
Binding operating contract (brief §8) — this is a security-gated-adjacent workstream (touches
deploy/publish pipeline) even though it isn't one of the numbered independence milestones;
the brief's own contract requires this gate regardless.

## Context / current state
Not started. This is the GATE task — everything 00001-00014 must be genuinely done (both PRs
pushed, CI green, self-review complete) before this fires.

## Files
N/A (message, not a file).

## How to continue + acceptance
Cleared response received naming the exact SHAs sent. Any implementation-affecting change
after clearance (incl. merge-conflict resolution) invalidates it — new handoff required.

## Links
Brief §8 (verbatim contract), §0 (planner session id + endpoint).
