# 00001 [k3m9qz] Publish reported "didn't work" though it succeeded

## Symptom

2026-08-03 21:32 BST, Purdi on a phone: the review drawer showed **"Publishing didn't
work this time. / Nothing changed on your live site, and your edits are safe."** The
publish had in fact fully succeeded — version 29 went live.

## Measured evidence

- `D:\Servers\Devfleet\Storage\logs\Wixy\stdout.log` around line 48957:
  `POST /api/admin/publish 200 OK` immediately followed by `POST /api/admin/publish
  409 Conflict` — TWO POSTs for one button press. First occurrence in 19 recorded
  publishes across four log files.
- `Storage/projects/ca/reports/20260803T203218Z.json` (the report Purdi sent):
  `publishJob.stage="done"`, `error=null`, `version=29`, full clean pipeline log,
  `live.version=29`, `validate.ok=true`.
- Ledger `v29` at `2026-08-03T20:31:53.744Z`; the site-repo commit `684b127a` landed
  at `20:31:57Z` — 3.3 s into the pipeline.

## Root cause

`admin-ui/src/api.ts`'s `fetchWithRetry` applies a blanket **10 s abort + 3 blind
retries** (spec/05 §7) to EVERY admin call — including `POST /api/admin/publish`,
which is long-running and NOT idempotent. When the publish round-trip crosses 10 s
(git fetch → materialize → commit → push to GitHub → build → verify → swap, over a
phone connection) the client aborts a publish the server is still completing, then
re-POSTs it. The server answers 409 (rev conflict — the first publish already
consumed the draft), `publish()` maps 409 → `{kind:"conflict"}`, and
`publishDrawer.ts` renders the failure state.

The deeper design fault: the drawer treated the POST's HTTP outcome as the
authoritative publish result, when the publish JOB is the only source of truth.

## Fixed by

1. `publish`/`restore` exempted from the blanket policy — one attempt, generous
   backstop timeout (`LONG_RUNNING_POLICY`).
2. The drawer resolves its terminal state from the JOB (SSE terminal event, plus a
   `getState()` reconcile whenever the POST doesn't resolve `ok`), guarded against a
   previous publish's leftover terminal record via `priorJobId`.
3. The diagnostic report auto-sends on a dead end instead of waiting for a button.

decisions/00114.
