# Module brief — P2: the Cookout ingredient bank (data + loader + validator)

Repo: wixy. Your build space is a worktree on a build branch cut from the feature branch
`cmd/workspace-00058`. Your module PR targets `cmd/workspace-00058`, never `main`.

## Context (read first)

- `CLAUDE.md` (repo rules: strict mypy, ruff, capped pytest `-n 4` via bare `pytest`, every commit
  message carries `Release-note: General bug fixes and improvements.` — this is Server-chat work and the
  trailer must be exactly that).
- `triad/cookout/ruling.md` — the decided design rulings (esp. rulings 3, 6, 12).
- `triad/cookout/round-2/argon.md` §3.1–3.3 — bank schema & draw drafts (rulings override it).
- Precedent to copy for loading/validation: `wixy_server/livechat/adventure_bank.py`
  (`load_bank_or_empty`: strict static data loaded once by the app; a bad bank disables its game
  without killing chat), `wixy_server/livechat/adventure_destinations.json`, and
  `wixy_server/tests/test_adventure_bank.py` (committed-bank validity test).
- The full Cookout spec (`spec/server-chat/09-cookout.md`) is being written in parallel; this
  module's contract below is frozen — if the spec later adds to it, I will send you a delta.

## Deliverables

1. **`wixy_server/livechat/cookout_ingredients.json`** — ~3,000 genuine distinct ingredients
   (validator range 2,500–4,000), "everything from parsley to beef to spices to cream… toast, sugar,
   anything": meats and cuts, fish/seafood, vegetables, fungi, fruit, dairy/cheeses, breads/pasta/grains
   (incl. toast, crumpets, tortillas), legumes/nuts/seeds, fresh herbs/aromatics, spices/seasonings,
   oils/fats/condiments, sauces/pastes/pickles/ferments, sweet/baking (sugar, chocolate, syrups),
   prepared pantry (baked beans, instant noodles, puff pastry, crisps, fish fingers…), drinks/alcohol
   used in cooking. British-English names, everyday through exotic. **No padding**: no trivial colour/
   size variants just to hit the count; near-variants share a `family`. Author it yourself in batches
   (you may write a throwaway generator/merger script under `tooling/cookout/`, but the entries are your
   own curated content — never call the Anthropic API or any external AI/web API).
   Schema (exact):
   ```json
   {
     "version": 1,
     "categories": [ {"id": "grains-bakery", "name": "Bread, Pasta & Grains", "emoji": "🍞"} ],
     "staples": [ {"id": "water", "name": "Water", "pickable": false} ],
     "ingredients": [
       {"id": "thick-white-toast", "name": "Thick-cut white toast", "aliases": ["white toast"],
        "category": "prepared-pantry", "role": "base", "family": "toast",
        "rarity": "everyday", "blurb": "Golden slices for topping, soaking or crumbing"}
     ]
   }
   ```
   - The 15 categories exactly as Argon round-2 §3.1 lists them (ids, names, emoji).
   - `role` ∈ `base` (starches/breads/pasta/grains/potatoes/pastry/pantry carbs), `protein` (meat, fish,
     seafood, eggs, tofu/tempeh, legumes, substantial cheeses), `produce` (vegetables, fruit, fungi),
     `accent` (herbs, spices, condiments, sauces, oils, sweet, dairy accents like cream, drinks). Every
     role must be well stocked (each ≥ 300) so maximum-skip draws never run dry.
   - Staples (exact, ruling 6): `water`, `salt`, `black-pepper` (`pickable: false`); `butter`,
     `plain-flour`, `cooking-oil`, `granulated-sugar`, `milk` (`pickable: true`, and ALSO present as
     ordinary entries in `ingredients` with the same ids).
   - `id`: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, 2–64 chars, unique. `name` 1–70 chars, unique after
     case/accent folding; `aliases` 0–4 strings (common alternative names, used later by a prose scan
     that detects unpicked foods), none colliding with another entry's name/alias. `family` kebab-case
     2–48. `rarity` ∈ `everyday|uncommon|exotic` (roughly 50/35/15 %). `blurb` 1–90 chars, plain text.
2. **`wixy_server/livechat/cookout_bank.py`** — typed loader: frozen dataclasses `Category`,
   `Staple`, `Ingredient(id, name, aliases: tuple[str, ...], category, category_name, emoji, role,
   family, rarity, blurb)`, class `CookoutBank` with `ingredient(id)`, `staple(id)`, `ingredients`,
   `staples`, `staple_ids`, `categories`, `by_role(role)`, and `load_cookout_bank(path) -> CookoutBank`
   raising a typed error on any invalid content, plus `load_cookout_bank_or_none` (logs, returns None —
   the game is then unavailable but chat lives), mirroring `adventure_bank.py`. Leave a clearly marked
   place for `draw_pair` — I will send its frozen signature once the spec lands (the draw is in this
   module's scope, second checkpoint).
3. **`tooling/cookout/validate_bank.py`** — offline validator (CLI, exit non-zero with every problem
   listed): schema, all bounds above, uniqueness (ids, folded names, aliases vs names), category/role
   coverage and size range, staple rules, rarity mix sanity, and a heuristic duplicate report (names that
   differ only by plural/punctuation).
4. **`wixy_server/tests/test_cookout_bank.py`** — the committed bank passes the validator; loader
   rejects each class of bad input (small fixtures); staple ids present and consistent.

## Done means

`ruff check .`, `ruff format --check .`, `mypy`, and bare `pytest` (full suite) green in your build
space; the validator clean on the committed JSON. Send me a `FINAL HANDOFF` (session id, build branch,
exact candidate SHA, what changed, verification output summary, counts per category/role/rarity). Open
and merge your PR into `cmd/workspace-00058` only after I reply `FINAL HANDOFF CLEARED` for that exact
SHA. Use the `lane-monitor` check-in calls as you progress.

Design questions → the Architect (`ask-architect` skill); scope questions → me.
