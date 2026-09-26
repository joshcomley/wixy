## Symptom

`e2e/tests/section-panel.spec.ts` "PR 2" (toggle a hidden Before & After pair on, Save, publish;
toggle it off, Save, publish) timed out about 1 run in 10. It failed alone on one worker on a
loaded hub, 2026-09-26, while verifying the live-drawing PR. The second Save button was "not
visible" for the full 30 s. Nothing in that PR touches the section panel. The race was on
`main`.

## Root cause

A publish success calls `SectionPanel.refresh()` (decisions/00115). `requestRefresh()` checks
that the refresh is safe: no field has focus, and the panel is not dirty (decisions/00118).
Right after a publish the panel is clean, so the re-read starts: `refreshFromServer()` →
`load()` → `GET /api/admin/content/<page>`. `load()` then applied its answer
UNCONDITIONALLY: it overwrote the collection and saved state, cleared the undo stack, and
re-rendered.

If she flipped a switch (or typed and blurred) while that GET was still out, the answer, which
predates her edit, overwrote the edit. The switch snapped back, the panel read clean, and the
Save bar vanished, so the edit was silently lost. The e2e waited for the re-read's RESPONSE
before the next edit, but the panel only renders after it has read and processed the body.
On a loaded box that render sometimes landed after the edit.

Measured: a unit test with the re-read held open, and the e2e with the re-read held by
`page.route` until after the flip. Both failed on the old code on every run (e2e 3/3), with
the flip reverted to the fetched state.

## What was decided

`load({ refresh: true })` re-runs the same safety check when the answer arrives, after the
awaits. If a field now has focus or the panel is dirty, the answer is not applied and
`refreshPending` is set, exactly as if the refresh had been requested at that moment.
`maybeRunPendingRefresh()` then re-reads once she saves, undoes or discards, or on focusout, as
before. A refresh is deferred, never dropped. The first load (not a refresh) is unchanged.

## Why

The two existing rules (flush first; defer while editing or dirty) were right, but checked at
the wrong moment only: "safe to apply" is a property of the moment the answer is applied. A
re-read's answer is exactly as stale as its request, and the only way an edit can have
happened meanwhile is on this screen, which the panel can see.

Rejected alternatives:
- **Merging the answer into her edits.** That needs a per-field three-way merge the panel does
  not have, for a case that simply waiting resolves.
- **Aborting the request.** That doesn't help: the edit can land after the response but before
  processing.

## What to watch for

- Any new path that applies fetched collection state to a mounted panel must go through the
  same check at apply time, not just at request time.
- The e2e now forces the race on every run: it holds the post-publish re-read with
  `page.route` until after the flip. So this is a deterministic regression test, not a
  timing hope. Unit test: `sectionPanel.test.ts` "keeps an edit made while the re-read is in
  flight, and re-reads again once it is safe".
