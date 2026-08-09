# 00008 [thkdzz] Before & After editor legibility overhaul

New brief from planner cmd session `75f673ab-803c-44ea-a863-edc04f1783e9` (received
2026-08-09), distinct from this workspace's earlier (now-complete) social-import project.
Full brief text is in the session transcript that spawned this task — summary below.

## Goal (Purdi's own words)

She said, verbatim: unclear why entries are greyed out; the "Show on site" control isn't
prominent; editing a text box "doesn't become an edited-looking box"; there's no Save button
so she doesn't know how to make changes "ready to be published"; "Queued to be published needs
figuring out… I make some changes and have no idea how to get them to the publish queue or
abandon the changes or undo what I've just done."

## Scope: 3 PRs, admin-ui only (no server/protocol.ts changes needed)

- **PR 1** — Staged Save model: edits stage locally (dirty, not auto-saved), explicit Save
  button writes the whole array via the existing `opQueue.enqueue` chokepoint, sticky Save bar
  (Save / Undo last / Discard unsaved), a "ready to publish" banner (Publish / Discard all —
  wires the already-built but unused `api.discardDraft()`), navigation guard + beforeunload.
  Chip wording in shell.ts reworded to match ("N changes ready to publish").
- **PR 2** — Move the `visible` toggle to a prominent card-header switch + plain "Hidden — not
  on your site yet" wording (replaces the small hidden chip) + "Turn all on"/"Turn all off".
- **PR 3** — Inline before/after slider preview (new `beforeAfterSlider.ts`, clip-path technique
  ported from the public gallery slider) under each 2-image card + tap-to-enlarge modal.

## Operating contract

Implementer-owned dev. Blocker path: POST to
`http://127.0.0.1:9321/sessions/75f673ab-803c-44ea-a863-edc04f1783e9/send`. FINAL HANDOFF gate
before merge (planner clears exact candidate SHA, 0 critical/0 high) — plan: PR1 alone first
(highest-priority, foundational), then PR2+PR3 together, since 2/3 build on PR1's staged-save
model. POST-RELEASE DONE REPORT after each merge+deploy+live-verify.

## Key design decisions locked in during investigation

- Deferred-save is a DELIBERATE divergence from the rest of the admin (which keeps auto-save)
  — scoped to `sectionPanel.ts` only, since it's her primary surface and the one she
  complained about. Document this in decisions/.
- `savedState` snapshot + deep-equality dirty tracking (per the brief's explicit design), not
  reference-equality — handles "typed it, then typed it back" without a false-dirty flag.
- No clone needed when snapshotting `savedState`: every existing pure helper in
  `sectionPanelModel.ts` already returns new arrays/objects rather than mutating in place, so
  a plain reference copy into `savedState` stays frozen at that snapshot.
- Undo is a single panel-wide stack of `{path, items}` pre-mutation snapshots (bounded ~50),
  not per-collection — matches "undo what I just did" regardless of which collection.
- PR1 must NOT touch the toggle/hidden-chip rendering at all (that's PR2's job) — keeps PR1
  cleanly scoped to save/dirty/publish flow only.
- Save-failure signal: `OpQueueLike` only exposes `{rev, enqueue, flushNow}` — no
  onAccepted/onError visibility from inside the panel. Use rev-before/rev-after comparison
  around `flushNow()` as the success signal (rev unchanged = failed, either network-retry-kept
  or 422-dropped; both leave `currentRev` untouched per opQueue.ts).

## PR1 status: implemented, tested, ready for FINAL HANDOFF (2026-08-09)

Branch `feat/section-panel-staged-save`. Delivered: `sectionPanelModel.ts` pure helpers
(`jsonValueEqual`/`itemsEqual`/`itemDirty`/`fieldDirty`/`cloneItems`); `sectionPanel.ts`
staged-save rewrite (stageLocal/saveNow/undo stack/discardUnsaved/discardAll/onPublishClick/
ready banner/save bar, all wired); `shell.ts` (onRequestPublish/onDraftChanged deps, chip
reworded "N changes ready to publish"/"Nothing to publish", route-change nav guard); new
CSS block for the save bar/ready banner/dirty states. Bundle rebuilt + committed (Inv 2).

Verification: `admin-ui` typecheck clean; vitest 731/731 green (42 new/updated tests in
sectionPanel.test.ts alone, incl. undo/discard/publish-auto-save/nav-guard/beforeunload/
double-click-guard coverage); e2e `section-panel.spec.ts` 11/11 green reliably in isolation
(verified across 4+ clean runs) — required 2 real fixes found via this: (a) `findCardByTitle`
needed to poll (`expect().toPass()`) instead of one-shot count, since `load()` now awaits a
concurrent `/api/admin/state` fetch too; (b) one new test permanently renamed+published the
shared "Hidden Pair" fixture item, breaking every later test searching for it by title — fixed
by using a disposable tile instead. `text-edit.spec.ts`/`ai-lane.spec.ts` updated for the new
chip wording. Full 52-test e2e suite: clean at 51/52 (1 wording fix) on one run, 44/52 on
another — the 8-test full-suite-only failures were investigated to a DEFINITIVE root cause, not
dismissed: live `read-cpu` measurement showed the shared hub box at 99.3% CPU (ALERT-level,
`vmmemWSL` at 24% — unrelated background load) at the time; a targeted headed-browser
reproduction of the specific "save button not visible" failure found consistent, correct
geometry/hit-testing in every attempt (no CSS/stacking defect); failures also hit files never
touched by this PR (`structured-controls.spec.ts`, `theme-change.spec.ts`) with a "publish
stuck running" signature consistent with pipeline timing under CPU starvation. Matches this
project's own documented precedent (testing.md: "a rare full-suite-only flake is a box-level
resource-contention characteristic"). Recorded as a non-blocking, informational finding for
FINAL HANDOFF, not treated as a code defect.

Next: commit, push, open PR, FINAL HANDOFF to planner for PR1 alone per the two-round plan;
wait for clearance before merging or starting PR2/PR3.
