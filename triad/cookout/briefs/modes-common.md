# Cookout game modes (Toasted sandwich first) — shared builder rules

Authority: `spec/server-chat/09c-cookout-modes.md` (frozen at 5e12eff4). Read it IN FULL before
coding — §0–§7 for intent, §8 for the tests you must write, §9 for docs, Appendix A for your exact
file ownership, the order (A.0) and the frozen interfaces (A.1–A.4). Also read
`triad/cookout/briefs/common.md` — its rules bind you (never edit `.git/info/exclude`; stage by
explicit path; FINAL HANDOFF envelope; no PR until the coordinator clears your exact SHA).

Coordinator: session `92d99463-3965-4e8c-9ff7-eca88839d7b4`. Every question and hand-in goes there
via the peer skill, `[[im]]` envelope form (≤600 chars; link longer detail).

Rules for all mode parcels:

- **Own only your Appendix A row.** If you need a change in a file another parcel owns, ask me.
- **Classic stays byte-identical.** Every existing Cookout test stays green unchanged except where
  your row explicitly owns "the mode-related edits to existing tests".
- **Frozen interfaces are frozen.** Build against A.1–A.4 exactly. If the frozen interface is wrong,
  stop and tell me with evidence; do not improvise a different shape.
- **Building ahead of a dependency:** when your dependency's module has not merged yet, build against a
  stand-in that implements the frozen interface. Keep a stand-in that must sit at a production path
  UNTRACKED (never committed, never added to any ignore file), delete it before your hand-in, and
  prove with `git ls-tree -r --name-only HEAD` that your candidate contains only your own files.
- **Merge the feature branch often** (`git fetch origin && git merge origin/cmd/workspace-00058`) — the
  chef fix and other mode parcels land during your work.
- Commits: `Release-note: General bug fixes and improvements.` (Server-chat rule R14a — never name the
  game or its features in a trailer).
- Verification before hand-in: `ruff check .`, `ruff format --check .`, `mypy` (strict), bare
  `pytest` (never `-n auto`); TS parcels also `npm run typecheck`, `npm test`, `npm run build` with the
  bundle committed and LF line endings.
- The mode ships DISABLED (`WIXY_COOKOUT_MODES` absent ⇒ Classic only). Activation is the
  coordinator's last step after deploy, never part of a merge.
