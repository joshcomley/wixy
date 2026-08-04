# The publish outcome comes from the JOB, never from the POST

## Symptom

2026-08-03 21:32 BST. The site owner pressed **Publish** on her phone and the review
drawer answered:

> **Publishing didn't work this time.**
> Nothing changed on your live site, and your edits are safe.

Both sentences were false. The publish had fully succeeded: version 29 went live, the
commit was pushed, the site was rebuilt and the live pointer swapped. She had no way to
know that, and the drawer actively told her the opposite.

## Evidence

- `D:\Servers\Devfleet\Storage\logs\Wixy\stdout.log` (~line 48957) — **two** POSTs for one
  button press:
  ```
  POST /api/admin/publish HTTP/1.1" 200 OK
  POST /api/admin/publish HTTP/1.1" 409 Conflict
  ```
  First occurrence of that pair in **19** recorded publishes across four log files.
- The report bundle she then sent by hand,
  `Storage/projects/ca/reports/20260803T203218Z.json`:
  `publishJob.stage="done"`, `error=null`, `version=29`, a clean five-line pipeline log
  ending `"published as version 29"`, `live.version=29`, `validate.ok=true`. The server
  recorded no error of any kind.
- Ledger `v29` at `2026-08-03T20:31:53.744Z`; site-repo commit `684b127a` at `20:31:57Z`
  — the commit alone landed **3.3 s** into the pipeline, with push, build, verify and
  swap still to come.

Note the log ORDER: the `200` is logged before the `409`. uvicorn logs a response when it
is sent, and the "a publish is already running" guard answers instantly — so that 409 was
NOT the already-running guard. The first publish had already finished; the retry's
preflight found the draft rev had moved on (the publish consumed it) and raised
`RevConflictError` → 409.

## Root cause

Two faults, one on top of the other.

**1. A blanket fetch policy applied to a request it does not fit.** `admin-ui/src/api.ts`
gave every admin call the same discipline (spec/05 §7): a 10 s abort and up to 3 blind
retries. That is right for the small idempotent calls it was written for. `POST
/api/admin/publish` is neither small nor idempotent — it fetches from GitHub, materializes
the draft, commits, **pushes**, rebuilds the whole site, verifies and swaps the live
pointer. Crossing 10 s is ordinary, not exceptional, especially over a phone connection.
So the client aborted a publish the server was still completing and then re-POSTed it.

**2. The drawer treated the POST's HTTP outcome as the publish result.** `publishDrawer.ts`
mapped anything that wasn't a `200` to `renderFailure()`. The server's 409 is exactly the
answer you get when your publish already ran — the drawer read "this publish already
happened" as "this publish failed".

The irony: the drawer already had the truth open in front of it. It holds an SSE stream to
`/api/admin/publish/stream` carrying the job's full state, and used it only to caption the
spinner — throwing away the terminal `stage: "done"` + `version` it was being handed. The
shell's own watch (decisions/00089) read that same job correctly and would have toasted
"Published — version 29 is live." at the same moment the drawer said it hadn't worked.

## Decided

**The publish JOB is the single source of truth for "did it publish?". The POST is a fast
path and a corroborating signal — never the verdict.**

1. **`publish` and `restore` are exempt from the blanket policy** (`LONG_RUNNING_POLICY`):
   exactly one attempt, and a 10-minute backstop timeout. Blind retry is only ever safe on
   an idempotent request. Every caller left on the default is one — keep it that way.
2. **The drawer settles from the job.** One idempotent `settleSuccess` / `settleFailure`
   pair, reached by whichever of three paths gets there first:
   - the SSE stream's terminal event (`done` → success, `failed` → failure);
   - the POST resolving `ok`;
   - a `reconcile()` poll of `GET /api/admin/state`'s `publishJob`, run whenever the POST
     resolves anything *other* than `ok` (including a thrown/aborted request).
   `reconcile` renders failure only on real evidence of it: job `failed`, no job at all, or
   the server unreachable. A job still `isRunning` keeps the running state — an unresolved
   POST is not a failure.
3. **Guard against the previous publish's ghost.** The server parks the last job on
   `app.state.publish_job` indefinitely, so a terminal snapshot proves nothing by itself.
   The shell passes `priorJobId` into the drawer and any job carrying it is ignored —
   the same guard the shell watch arms as `publishWatchArmedJobId` (decisions/00089).
   Without this, opening the drawer would instantly "succeed" with the *last* version.

**And the diagnostic report sends itself.** decisions/00095 made "Send a report" the escape
hatch; this incident showed the flaw in requiring a press. She hit a dead end, and the only
reason we could diagnose it at all is that she happened to press the button. The report now
fires automatically on both dead ends — a failed publish, and a "Fix it for me" that
couldn't fully clear the block — carrying the technical reason as its note (the owner never
sees it; the operator needs it). She's told in her own words that it went ("Your developer
has been told what went wrong."), and the manual button reappears **only** if the automatic
send didn't get through, so a report is never silently lost.

## What to watch for

- **Never put a long-running or non-idempotent endpoint on the default fetch policy.** The
  10 s abort is invisible until the day the work legitimately takes longer, and then it
  fires a duplicate of a request that must not be duplicated.
- **`reconcile`'s failure branches are the load-bearing ones.** Widening them (e.g.
  treating a running job as failed to "resolve faster") re-creates this bug exactly.
- **`priorJobId` must keep being passed.** Drop it and the drawer reads the previous
  publish's terminal record as this one's success — the mirror-image lie of this incident.
- The `409` handling in `start_publish` is unchanged and still correct; it is the client
  that must stop asking twice.
