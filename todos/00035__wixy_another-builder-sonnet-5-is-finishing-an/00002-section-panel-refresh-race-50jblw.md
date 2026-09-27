# Section panel refresh race

**ID**: 50jblw
**Status**: in progress (PR #289 open; the driver reviews and merges)
**Workspace**: 00035
**Branch**: `cmd/workspace-00035-section-refresh-race`

## Mission
While verifying the pen PR (#286), `e2e/tests/section-panel.spec.ts` "PR 2" failed about 1 run in
10, even alone on one worker. Root cause (already on main, not caused by #286): a publish makes the
mounted section panel re-read its collection; the safety check (no field focused, nothing unsaved)
ran only when the re-read was requested, and `load()` applied its answer unconditionally. So an
edit made while the re-read was in flight was silently overwritten.

## Fix
`load({ refresh: true })` re-runs the check when the answer arrives; an unsafe answer is not applied
and the refresh is deferred again (never dropped). decisions/00178; docs/ai/editor-and-admin-ui.md.

## Evidence
- Unit (`sectionPanel.test.ts`): red on the old code (the edit reverted to "Filler"), green now.
- e2e ("PR 2" holds the post-publish re-read with `page.route` until after the flip, forcing the
  race every run): 3/3 red on the old bundle, 10/10 green on the new one.

## Progress
- 2026-09-26: PR #289 opened off main (a9f821b); CI all green.
- 2026-09-26: #286 merged first (driver's order); main merged into #289, the bundle rebuilt from
  both changes (the only conflict), re-verified.
