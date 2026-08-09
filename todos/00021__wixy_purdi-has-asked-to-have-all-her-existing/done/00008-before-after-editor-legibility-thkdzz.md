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

## PR1 shipped (2026-08-09, continuation session)

Planner cleared PR1 (0 critical/0 high) with one non-blocking MEDIUM follow-up: `saveNow()`'s
`opQueue.rev` success-inference has a real false-positive gap (a 409-refetch immediately
followed by a network error also advances `rev` without the batch landing) — planner's
explicit recommendation was to fix it as part of PR2 rather than respin PR1. Before merging,
a stray automated "snapshot: WIP before Claude session" bot commit was found on the branch
(touching only an unrelated, already-superseded handover doc — zero implementation impact),
which broke the release-note CI check and technically drifted off the cleared SHA. Rather than
force-push (blocked by this box's git safety hooks; the safer remedy they suggest — "resolve
via a fresh PR" — was used instead), the exact cleared tree was pushed as a new branch/PR #161
(byte-identical candidate `7e4df733...`) and #159 closed in its favor; the incidental commit
was preserved properly via its own tiny PR #160. Merged (merge commit `ea751c6c...`), Slots
deploy verified live, POST-RELEASE DONE REPORT sent.

## PR2 + PR3 shipped together (2026-08-09, same session)

Implemented both per the specs above, in one PR (#162, candidate `87ca220f6fdd1f891b65f28c95bca1127af9a286`) —
combined because the changes ended up too interleaved in shared files (`sectionPanel.ts`,
`style.css`, `sectionPanel.test.ts`) to cleanly split into two commits. Folded PR1's MEDIUM
follow-up into PR2 as planned: `OpQueue.enqueueTracked()`, an additive method giving
`saveNow()` a real per-batch accepted signal instead of the `rev`-comparison inference.
`decisions/00119-visibility-switch-and-tracked-save/` covers full rationale for both PRs.

A real bug was self-caught during e2e verification (not by the planner): `.wx-switch-track`/
`.wx-switch-thumb` need `pointer-events: none` or they paint over and silently swallow every
click on the real checkbox underneath — shipped past a fully-green `npm test` (jsdom doesn't
enforce real paint/stacking order) and only failed a real-browser Playwright `.check()`.
Root-caused and fixed before shipping; documented as a general lesson in decisions/00119 for
any future custom control built the same way.

Local e2e runs on this shared/loaded hub box showed transient failures across two full-suite
runs (aligner test, collection-edit, structured-controls, restore.spec.ts) — none touching any
file this PR changed; each was re-run in isolation and passed clean, confirming box contention
(worsened once by running vitest concurrently with e2e, corrected on the second run) rather
than regressions — matches this project's own documented "full-suite-only flake is a box-level
resource-contention characteristic." CI (a dedicated uncontended runner) was green throughout.

Planner cleared PR2+PR3 (0 critical/0 high, 3 LOW self-review findings all agreed non-blocking:
no double-open guard on the enlarge button — matches existing precedent; `itemNounPlural()`'s
naive pluralization — inert for today's real nouns; Turn-all-OFF's decline path isn't
unit-tested while Turn-all-ON's is — shipped as-cleared per the planner's explicit sanction
rather than respinning for a trivial 4th test). Merged (merge commit `c09395b3...`), Slots
deploy verified live.

## Final live verification (task #10) + mission complete

Drove a real headed Chrome browser at 390px width (Purdi's phone) against the REAL production
site (`ca.cinnamons.uk/admin/section/before-after`, CF Access service token) — 21/21 automated
checks passed: edit/unsaved/Save-enables/Undo, the new switch toggling + wording, Turn all on
staging every card, the inline before/after preview dragging + tap-to-enlarge modal, all
visually confirmed via screenshot too.

**Deviation, flagged explicitly rather than silently worked around**: did NOT perform the
planned "publish a trivial real change + restore" step. On navigating to production I found a
genuine PRE-EXISTING pending draft change (opCount:1, rev 221) that predates this session and
isn't mine — real in-progress work (Purdi's, most likely, or possibly an AI-lane conversation's)
sitting unpublished. Publishing anything right now would have shipped that too, which isn't a
call I have the context or authority to make. Never clicked Discard-all/Save/Publish for any
test edit; added a hard Playwright network-guard aborting any write to `/api/admin/draft` or
`/api/admin/publish` as a belt-and-braces measure; verified everything via Undo-last/
Discard-unsaved (local-only, never touches the server) instead; confirmed the pending change
was still exactly `{rev: 221, opCount: 1}`, untouched, at the end. Surfaced this to the planner
as something worth Purdi/the operator's attention next time either is in the admin — not urgent,
just noting an unpublished change exists that nobody has actioned.

Final POST-RELEASE DONE REPORT covering the complete 3-PR arc sent to the planner. **Task
complete — all 3 PRs merged, deployed, live-verified. No open items on this task.**
