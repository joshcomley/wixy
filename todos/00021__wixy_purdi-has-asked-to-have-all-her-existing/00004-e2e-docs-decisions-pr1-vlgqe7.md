# 00004 [vlgqe7] Engine D4: e2e + docs + decisions + ship PR1

## What
Close out engine PR1 (everything in D1-D4 of the brief): e2e coverage, docs/ai updates,
decisions/00117 entry, full verification matrix, round-(a) FINAL HANDOFF to planner, merge,
verify Slots deploy.

## Why
PR1 is the foundation (visible convention + toggle UI + editor read-back safety) that the
site-repo PR's CI depends on being MERGED (not just open) before it can pass parity.

## Context / current state
Not started. Depends on 00001/00002/00003 all complete. Planner-specified scope:
- e2e: extend `e2e/fixture_server.py`'s e2e-only gallery fixture (`_GALLERY_HTML:71-101` /
  `_GALLERY_JSON:103-116` / `adminSections` registry block `:155-224`) with the toggle field
  + a hidden seed item — NOT the shared mini-site (showcase count assertion at
  `collection-edit.spec.ts:36-38`). New/extended specs: `section-panel.spec.ts` (toggle off
  → publish → built page lacks the figure; toggle on → present again; 422-gate-accepts-
  visible-false spec, pattern at `:294`); `collection-edit.spec.ts` (inline structural edit
  with a hidden item present → publish preview shows it STILL hidden — the round-trip proof).
- Docs (same PR): `docs/ai/builder.md`, `contracts.md` (§2 adminSections kinds; §5/§8 schema
  note), `editor-and-admin-ui.md` (toggle control + read-back rule + ghost styling),
  `serving-and-overlay.md` (preview-only marker), `invariants.md` (new invariant sibling of
  Inv 10; register marker/read-back pair under Inv 20; note under Inv 26 that `visible` is
  schema-legal), `testing.md`. Run `op call aim-doc.doc_rules` first, apply its mapping.
- `decisions/00117-<slug>/{title.md,decision.md}` (verify max+1 at commit time — was 00116
  as of brief writing, so check current max first) — why item-key convention not
  `data-wx-if`, publish/preview asymmetry, canonical only-false-stored form, read-back
  hand-synced pair, born-shown add semantics.
- Release-note trailers: PR1 suggested "You can now choose which before-and-after photos are
  shown on your site with a simple on/off switch."

## Relevant files
`e2e/fixture_server.py`, `e2e/tests/section-panel.spec.ts`, `e2e/tests/collection-edit.spec.ts`,
`docs/ai/*.md` (listed above), `decisions/00117-*/`.

## How to continue + acceptance
Full verification matrix: `ruff check . && ruff format .`, `mypy`, bare `pytest` (capture to
log once), both TS packages typecheck+test+build+commit, `npx playwright test` in `e2e/`.
Self-review full diff, record medium/low findings honestly. THEN POST a `FINAL HANDOFF`
(round a) to planner session `75f673ab-803c-44ea-a863-edc04f1783e9` via
`http://127.0.0.1:9321/sessions/75f673ab-803c-44ea-a863-edc04f1783e9/send` — base SHA + head
SHA, changed-file/behavior summary, verification outcomes, deviations, PR URL, self-review
result. WAIT for `FINAL HANDOFF CLEARED` for that exact SHA before merging — do not merge on
silence/timeout/old clearance/different-SHA clearance. After clearance: merge, watch CI,
confirm Slots deployed (`GET https://ca.cinnamons.uk/api/version` sha == merged main sha,
poll a few minutes).

## Links
Depends on 00001 [w54r03], 00002 [s1stlw], 00003 [4myclw]. Unblocks 00006 [iuylh3] (site-repo
PR CI needs this merged+deployed). Then continue to 00007 [rusa0k] (round-b handoff).
