# P6 docs, invariant, decision entry and e2e (spec parcel P5)

Read `common.md` first. Builder: Sonnet 5.5. You own `e2e/tests/server-cookout.spec.ts` (and any e2e
helper you add for it), `docs/ai/{livechat.md, contracts.md, invariants.md, glossary.md, testing.md,
runbook.md}`, the `CLAUDE.md` store table row, and `decisions/00199-server-chat-cookout/{title,decision}.md`
(check the next free number first: max+1 across `decisions/`).

## Phase A — docs (start now)

The code reality is on the feature branch: bank (`cookout_bank.py`, `cookout_ingredients.json`),
server (`store.py` v21, `cookout_game.py`, `routes_livechat_cookout.py`), AI + pictures
(`cookout_ai.py`, `cookout_images.py`, `wyr_images.py generate_many`), UI (`admin-ui/src/server/cookout/*`
— merging now). Write spec §7's list, documenting the CODE (read it), not just the spec:

- `livechat.md`: a new Cookout section in the house style of the Adventure Time section (§23) — flow,
  states, blind redaction, draw, staples, AI jobs (concepts, repair, bank-it recipe), pictures (limiter,
  partial success, scratch cleanup, generation fencing), restarts, standalone edition, env vars, the
  frame/tab/menu, and the store table.
- `contracts.md`: every Cookout route + literal response envelopes, `Message.cookout`, `wyrRefKind
  "cookout"`, error codes (incl. `503 game_unavailable`), the server's additive fields
  (`totalMinutes`, per-ingredient `name`).
- `invariants.md`: **Inv 57** — a Cookout round is chat content (anchor-owned, cascade, wipe); blind
  redaction is server-side and never revealed for an abandoned round; the honest seat limit (WYR
  `_slot_of` rule: shared sign-in + typed partner name can read blind state); prompts carry food only;
  cmd retains the food-only prompt AND response (basket, concepts, recipes, repair feedback) which this
  server cannot erase; scratch images are attempt-owned and swept.
- `glossary.md` (states: round, concepts, images, recipe), `testing.md` (new suites, fixtures incl. the
  v20 DB fixture, the bank validator), `runbook.md` if any operational note (e.g. ComfyUI shared with WYR).
- `CLAUDE.md` store-table row: add the `cookout_rounds` / `cookout_turns` / `cookout_recipes` tables
  (schema v21) in the same style as the `adv_*` text.
- `decisions/00199-server-chat-cookout/`: the design record — panel (Argon, Kimi, Astra), the ruling's
  decisions and minority positions taken (WYR seat rule over a cookie; no second LLM checker; three
  tables), staples list and why, longest-span scan, and what to watch for. Link `triad/cookout/ruling.md`
  and `spec/server-chat/09-cookout.md`.

Docs-only changes still need `ruff format --check .` (it formats Python blocks inside .md files).

## Phase B — e2e (after the AI builder's wiring merges; I will tell you)

`e2e/tests/server-cookout.spec.ts`, two people, following `e2e/tests/server-adventure.spec.ts` and the
e2e fixture server (fake cmd returns canned Cookout concepts/recipes; ComfyUI absent or faked — mirror
how the adventure/WYR e2e handle pictures): start Open game from the ⋯ menu, Join, skips (incl. the
forced third pair), all ten picks, the three dish cards arrive, Bank this → Banked ✓ → full recipe, the
Recipe book; a Blind game where the partner's options/picks never appear in the other browser's DOM until
the reveal; End game; Cookout replacing an open Adventure/WYR tab; the mini chat; 360 px layout. Must pass
on the full local e2e run (`npx playwright test` in `e2e/`) and in CI.

Two FINAL HANDOFFs are fine (A docs, B e2e) or one combined at the end — your call; tell me which.
