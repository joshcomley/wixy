# M5 — Docs and e2e for game modes (Sonnet 5.5)

Read `modes-common.md` first. Your files: Appendix A row M5 — everything in §9 not already written by
M1–M4 for their own files, `e2e/tests/server-cookout-toastie.spec.ts`, and the e2e fixture additions.
Start once I confirm M2 (server) and M3 (chef + pictures) have merged into `cmd/workspace-00058`; M1
(data/draw) and M4 (UI) already have.

## A. Docs (§9)

M2 wrote parts of livechat / invariants / glossary / testing and `decisions/00203-server-chat-cookout-modes/`
for its own files. Read what exists, then make §9 complete and true to the CODE on the feature branch:
`contracts.md` (`mode` on create/options/view/summary/book, `GET /cookout/ingredients?mode=`,
`PickSnap.kind`, `build`, the additive `kind` on recipe-book snaps, `503 game_unavailable`, the 422
seed-mix messages), Inv 57 extension, glossary terms, `CLAUDE.md` store table (schema v22 adds
`cookout_rounds.mode`), `runbook.md` (`WIXY_COOKOUT_MODES`, the activation sequence, `activate_modes.py`
run with the hub's pythoncore-3.14 from a worktree — never a slot venv — and the `--check-rollback` rule),
and the decision record (family facet, the cap of two, the activation barrier with the review's
reproduction, why dish words and bread names are not fatal checks, the Sol+Opus picture judges
deviation if M3 records it). Don't duplicate — extend what M2/M3 wrote.

## B. e2e `e2e/tests/server-cookout-toastie.spec.ts` (§8.6)

Everything §8.6 lists, at 360×640 and the 34 px inset case: start Toasted sandwich from its tile,
intro lines, bread turn banner + one skip, Player 2 joins, the seven filling turns with kind banners,
no page/stage scroll at every turn, reveal of 8 pictures bread first, three toasted sandwiches with build
pills + pictures, Bank this, Recipe book badge; Blind variant: Player 2's DOM never contains Player 1's
bread name or picture URL before the reveal. Also run it with the wide-font stress
(`WIDE_FONT_CSS` from `server-cookout-visual.spec.ts`). The fixture server must run with
`WIXY_COOKOUT_MODES=toastie` (the mode ships disabled in production — only the fixture enables it).
Reuse `e2e/tests/cookout-helpers.ts` (keep both devices awake from before the first unlock — the 10 s
idle lock is the known cause of load flakes). No fixed sleeps.

## Definition of done

Full local e2e green (incl. the existing Cookout, Cookout-visual, WYR, Adventure suites); the new spec
×10 under a concurrent full-suite load green; red-proof (break one toastie rule, show the spec fail);
`ruff check`, `ruff format --check`, bare `pytest`. FINAL HANDOFF to me with SHA.
