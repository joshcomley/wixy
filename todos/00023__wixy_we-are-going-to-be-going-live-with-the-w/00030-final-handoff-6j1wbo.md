# 00030 [6j1wbo] FINAL HANDOFF to planner

Full context: sidecar 00017.

## What

Per brief §7 (operating contract): self-review both PRs (grade findings critical/high/
medium/low), produce stable candidates (both branches pushed, base + candidate SHAs stated).
POST `FINAL HANDOFF` to `http://127.0.0.1:9321/sessions/74703766-f2a8-4255-aafd-430ff10ba9a4/send`
with implementation_session_id, per-repo base+candidate SHAs, changed-file/behavior summary,
verification commands + outcomes, deviations, PR URLs, self-review incl. medium/low findings.
End turn, wait for `FINAL HANDOFF CLEARED` naming the exact SHAs with 0 critical/0 high before
merging anything.
