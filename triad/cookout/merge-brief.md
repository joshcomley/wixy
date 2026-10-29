# Cookout — design panel, round 2 (MERGE)

All three round-1 proposals are in. Read ALL THREE in full (absolute paths, read-only — do not edit
them):

- `D:/Servers/Cmd/Storage/clones/wixy__worktrees/00058__wixy_develop-cookout-cooking-game-with-ai-rec/triad/cookout/round-1/argon.md`
- `D:/Servers/Cmd/Storage/clones/wixy__worktrees/00058__wixy_develop-cookout-cooking-game-with-ai-rec/triad/cookout/round-1/kimi.md`
- `D:/Servers/Cmd/Storage/clones/wixy__worktrees/00058__wixy_develop-cookout-cooking-game-with-ai-rec/triad/cookout/round-1/astra.md`

(They are also committed on `origin/cmd/workspace-00058` under `triad/cookout/round-1/`.)
The original brief (`triad/cookout/brief.md`, same folder) still binds: same sections A–E, same
operator verbatim ask, same rules.

## Your task

Produce the single best Cookout design you can see, taking the strongest parts of each proposal.

🔴 **YOUR OWN PROPOSAL HAS NO PRIVILEGE IN THIS PHASE.** Preferring your own because it is yours is
exactly the failure this round exists to defeat.

- Every merger is reading the PRE-merge positions simultaneously. Do not defer to "the other two
  agreed" — judge each point on its reasons; a 2-1 split is read for its reasons, never counted.
- Check every claim about the code against the code yourself (a peer can be wrong about a function,
  table or route). For each factual claim you rely on, label it **MEASURED-BLIND** (you checked it
  yourself, not knowing others' conclusions), **MEASURED-KNOWING** (checked it yourself, already knowing
  the expected answer) or **CITED** (taken from a peer unchecked).

## Output

Write `triad/cookout/round-2/<seat>.md` in your own checkout (`argon`, `kimi` or `astra`):

1. **Merge ledger** (first): for each design decision where the three differed — which proposal you
   took, what you changed, what you rejected and why. At minimum cover: skip budget semantics, turn
   order/who starts, picks per player, blind mode (what's hidden, when revealed), option drawing and
   category balance, bank schema + size + generation, staples list, AI job shape (one run for three
   concepts vs. more), validation of "only picked + staples", pictures (when/how), the bank-it full-recipe
   job, recipe book, schema v21 tables, wire routes, UI pane, parcels.
2. **The merged design** — sections A (decided spec draft, `spec/server-chat/09-cookout.md` shape),
   C (implementation plan with parcels, dependencies, interface contracts), E (genuine operator questions).
3. **The merged fun-twist list (B)** — de-duplicated across all three proposals, each with: plain-English
   one-line pitch for the operator, why it's fun, build cost S/M/L, how it layers on the core without
   the core depending on it. Rank them; mark the top 5.
4. **Remaining disagreements** — anything you believe is still genuinely open, with the evidence that
   would decide it.

When finished, send ONE short message to the orchestrator with the ABSOLUTE path, exactly as in round 1
(`re=cookout-triad-r2`), then end your turn. Do not commit or push; edit no other file.
