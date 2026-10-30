# Server chat — Cookout game modes, starting with Toasted sandwich

Addendum to [`09-cookout.md`](09-cookout.md) (core), [`09a-cookout-twists.md`](09a-cookout-twists.md)
(twists) and [`09b-cookout-visual.md`](09b-cookout-visual.md) (round 2: catalogue, pictures,
picture-first screens). Same authority: decided, implement faithfully. Where this file is silent the
earlier files stand unchanged. Where reality contradicts a cited fact, prefer reality and record it in
`decisions/<max+1>-server-chat-cookout-modes/`.

## 0. The ask and what is decided

> "I'd like to add different modes to the game slowly, like pizza mode, toasted sandwich mode, and
> we'll start off with toasted sandwich mode. And the idea is it's always going to be a toasted
> sandwich, but you pick the bread, and then the ingredients, and then it generates the picture of
> that, but as a toasted sandwich." — the operator, verbatim (the authority).

**Terminology (one name per thing, used everywhere below and in the UI):**

| Term | Meaning |
|---|---|
| **game mode** (`mode`) | what the round makes. Today: **Classic** (`classic`, the existing game) and **Toasted sandwich** (`toastie`). Fixed per round. |
| **Open / Blind** | the existing way of playing (09 §1.3). Unchanged, independent of the game mode. In this file always "Open/Blind play", never "mode", to avoid two meanings. |
| **pick kind** | what one turn offers: in Classic one of the four bank roles; in Toasted sandwich `bread`, `cheese`, `main`, `produce` or `finish`. |
| **bread** | the one bread of a toasted sandwich, chosen on turn 1 from the curated bread list (§2.2). |
| **filling** | every other pick of a toasted sandwich (turns 2–8). |
| **build** | how a toasted sandwich is made (pressed, skillet-fried…), §3.3. |

**The decisions the operator is most likely to care about (each argued below):**

1. **Eight picks, four each.** Turn 1: the player who started the round picks the **bread** from two
   breads (the usual two skips). Then **seven filling turns** alternate, starting with the partner. The
   starter makes bread + 3 fillings, the partner 4 fillings: everyone makes four picks.
2. **The fillings follow a fair plan:** each player gets one **cheese**, one **main filling** and one
   **veg or fruit** turn (in a shuffled order, paired so both get the same kind back to back), and the
   partner's last turn is the **finishing touch** (a sauce, spread, pickle, herb, spice or sweet treat).
   Every toasted sandwich therefore has two cheeses offered to choose from, at least.
3. **Surprising fillings are in** — crisps, jam, chocolate, pies, curry paste, kimchi, fruit, leftover
   spaghetti hoops — but **never** a bread, pasta, rice, flour, raw dried beans, a drink, a cooking oil
   or vinegar, a stock, a setting agent or similar kitchen-only items (§2.2).
4. **The chef makes three toasted sandwiches**, all closed toasted sandwiches with the chosen bread,
   each with a different build, a title, a description and a picture of it **cut open, golden, with the
   melted filling showing**. "Bank this" writes the full recipe.
5. **Butter is free** (for the outside). Salt, pepper and water stay free. At most **two** of plain
   flour, cooking oil, sugar and milk. Nothing else that was not picked.
6. **All twelve twists work** in Toasted sandwich mode, with three adjustments: the chaos shelf is not
   offered on the bread turn (there are too few unusual breads), fridge raid means "start with a
   **bread** you have at home", and a leftover encore can only continue a round of the same game mode.
7. **Classic is untouched and stays the default.** A Classic round behaves byte-for-byte as today.
8. **Toasted sandwich is switched on separately, after the release is fully live.** It ships switched
   off. The delivery coordinator turns it on with one server setting, after a checked tool confirms no
   older server process is still running (§5.6). Before that, the start sheet shows only Classic.

---

## 1. The game modes framework

### 1.1 What a game mode is

A game mode is **data**, not code paths sprinkled through the game. Each mode defines:

| Part | What it says |
|---|---|
| identity | `id`, `label`, `emoji`, a one-line `blurb` and the 1–3 `intro` lines (§6.2) |
| draft plan | total turns (even, so both players pick equally), and the pick kind of every turn |
| pick kinds | per kind: which bank ingredients may be offered, how a pair is kept varied (`facet`), whether the chaos shelf works on it, and the player-facing `label` / banner `prompt` |
| staples | which staples are free, which are capped, and the cap |
| chef format | `classic` (today's prompt and validator) or `single-dish` (every idea is one named dish — a toasted sandwich today, a pizza later) with its parameters |
| picture style | `classic` (today's prompt) or `single-dish` with its template and per-build phrases |
| twists | which of the twelve twists the mode allows and its twist adjustments |

Adding **Pizza** later means adding one entry to `cookout_modes.json` (its base list, kinds, plan,
builds, prompt text, picture template), its tile picture and its tests. No new tables, routes, states
or UI screens. The only code a later mode may need is a new `facet` or plan rule if its data cannot
be expressed with the ones below — then that is a framework change, specified on its own.

### 1.2 Where it lives

- `wixy_server/livechat/cookout_modes.json` — the committed mode definitions (§1.4 shows the
  Toasted sandwich entry in full). Ingredients are referenced by bank id, family, category and role
  only; nothing is copied from the bank.
- `wixy_server/livechat/cookout_modes.py` — strict loader (unknown keys, bad ids, unknown kinds →
  `CookoutModesError`), resolves every kind against the loaded bank once at start-up into immutable
  candidate tuples, and exposes the frozen API of Appendix A.1. `default_modes()` is built lazily once
  per process like `default_bank()`, from `default_bank()`.
- `tooling/cookout/validate_modes.py` — the offline validator (§8.1), run by `test_cookout_modes.py`.

### 1.3 Classic is today's game, byte for byte

The `classic` entry carries only identity, `"plan": {"type": "classic"}`, `"chef": {"format":
"classic"}`, `"picture": {"format": "classic"}` and all twelve twists. Code routes a `classic` round
to the **existing** paths unchanged: `shuffle_role_schedule`, the 5-element paired `role_schedule`,
`role_for_turn`, the four roles with `facet = "category"`, today's prompts, validator constants
(`MIN_PICKED_EACH = 7`, `MIN_PICKED_BEST = 8`, `MAX_EXTRA_STAPLES = 4`) and picture template. The
golden tests of §8 prove it: the same seeded RNG gives the same draws, prompts, view JSON and picture
prompt as before this change.

### 1.4 The plan grammar and the Toasted sandwich definition

A `sequence` plan is `opening` (kinds for the first turns, in order) + `pairs` (kinds shuffled with
`secrets.SystemRandom`, each serving two consecutive turns) + `closing` (kinds for the last turns, in
order). Turns = `len(opening) + 2 × len(pairs) + len(closing)`, which the validator requires to be even
(so `picksPerPlayer = turns / 2`). Turn ownership is the core rule unchanged: odd turns Slot 1, even
turns Slot 2 (`player_of_turn`). The resolved per-turn list is stored in
`cookout_rounds.role_schedule` (§5.1).

```json
{
  "id": "toastie",
  "label": "Toasted sandwich",
  "emoji": "🥪",
  "blurb": "Pick a bread and 7 fillings, get 3 toasties",
  "intro": [
    "You're making a toasted sandwich.",
    "{starter} picks the bread first, then you take turns adding fillings — 4 picks each.",
    "The chef makes three toasted sandwiches with your bread."
  ],
  "plan": {
    "type": "sequence",
    "opening": ["bread"],
    "pairs": ["cheese", "main", "produce"],
    "closing": ["finish"]
  },
  "kinds": {
    "bread":   { "label": "the bread",          "prompt": "pick the bread",        "facet": "family",   "chaos": false,
                 "select": { "ids": ["…the 52 ids of §2.2…"] } },
    "cheese":  { "label": "a cheese",           "prompt": "add a cheese",          "facet": "family",   "chaos": true,
                 "select": { "categories": ["dairy-eggs"], "families": ["…the 19 cheese families of §2.2…"] } },
    "main":    { "label": "a main filling",     "prompt": "add a main filling",    "facet": "category", "chaos": true,
                 "select": { "roles": ["protein", "base"] } },
    "produce": { "label": "veg or fruit",       "prompt": "add veg or fruit",      "facet": "category", "chaos": true,
                 "select": { "roles": ["produce"] } },
    "finish":  { "label": "a finishing touch",  "prompt": "add a finishing touch", "facet": "category", "chaos": true,
                 "select": { "roles": ["accent"] } }
  },
  "kindOrder": ["bread", "cheese", "main", "produce", "finish"],
  "fillingRules": {
    "excludeCategories": ["grains-bakery", "drinks-alcohol"],
    "excludeFamilies": { "…": "the table of §2.2" },
    "excludeRoleCategories": [["base", "legumes-nuts-seeds"], ["base", "dairy-eggs"]],
    "excludeIds": ["…the 15 ids of §2.2…"],
    "includeIds": ["dulce-de-leche", "garlic-butter"]
  },
  "staples": { "free": ["water", "salt", "black-pepper", "butter"],
               "capped": ["plain-flour", "cooking-oil", "granulated-sugar", "milk"], "cap": 2 },
  "chef": { "format": "single-dish", "…": "§3" },
  "picture": { "format": "single-dish", "…": "§3.6" },
  "twists": ["swap", "vote", "style", "cooked", "wildcard", "fridge", "challenge", "veto",
             "encore", "lucky", "stars", "chaos"],
  "fridgeKinds": ["bread"]
}
```

**Classification (`kind_of`)** is a pure function of the mode and the bank, evaluated once at load:

1. An id in the `bread` kind's `ids` is `bread` (and nothing else).
2. Otherwise, an ingredient is **excluded from the mode** when `fillingRules` excludes it (category,
   `(category, family)`, `(role, category)` or id), unless its id is in `includeIds`.
3. Otherwise the **first** kind in `kindOrder` (after `bread`) whose `select` matches it: `cheese`
   (category AND family), then `main`, `produce`, `finish` (by role). A `select` lists any of
   `ids`, `categories`, `families`, `roles`; every listed field must match.
4. No match → excluded. The validator requires every non-excluded bank ingredient to land in exactly
   one kind, and the five pickable staples and the three seasonings to land in **none** (§3.1).

So the ingredient's own bank `role` is reused, not re-tagged: a cheese is a cheese wherever the bank
put it, and an excluded item can never be offered, swapped in, drawn as the wildcard or used as a
starter in this mode.

---

## 2. Toasted sandwich: the draft

### 2.1 The turn plan

| Turn | Player | Kind |
|---|---|---|
| 1 | Slot 1 (starter) | `bread` |
| 2, 3 | Slot 2, then Slot 1 | first pair kind |
| 4, 5 | Slot 2, then Slot 1 | second pair kind |
| 6, 7 | Slot 2, then Slot 1 | third pair kind |
| 8 | Slot 2 | `finish` |

The three pair kinds are `cheese`, `main` and `produce` in a shuffled order. Basket: 1 bread + 2
cheeses + 2 main fillings + 2 veg/fruit + 1 finishing touch = 8.

**Why this plan.** "You pick the bread, and then the ingredients": the bread is one deliberate first
choice, not a lucky draw among fillings. Pairing keeps the core's equal-opportunity rule (both players
get each filling kind once, back to back, 09 §2.3). Cheese is guaranteed because a toasted sandwich
without a melt is the exception, and two cheese turns give a choice of two different cheese families.
The finishing touch is last so the sandwich gets its sauce or spread and the partner, who did not
pick the bread, gets the extra filling. Eight picks (not ten) because a sandwich holds fewer things than
a dish; seven fillings is already a lot for one sandwich (§3.4 lets each idea leave two out).

**Who picks the bread.** The starter, on turn 1, immediately — the core's "creator takes turn 1 at
once" rule (09 §1.1) with no new lobby. The partner may join any time; as today, turn 2 is never drawn
until Slot 2 is bound.

### 2.2 Pick kinds and pools (measured on the committed bank, 2026-10-29)

**Bread — a curated list of 52 ids in 14 families**, chosen as breads you can close and toast as a
sandwich (sliced loaves, crusty and sourdough loaves, rye, enriched, speciality, Italian, baguette,
bagels, muffins and rolls). The list is committed in the mode entry:

| Family | Ids |
|---|---|
| `sandwich-bread` | `granary-bread`, `seeded-batch-loaf`, `sliced-white-bread`, `sliced-wholemeal-bread`, `thick-cut-white-toast-bread` |
| `crusty-bread` | `bloomer`, `cob-loaf`, `cottage-loaf`, `farmhouse-loaf`, `split-tin-loaf`, `tin-loaf` |
| `sourdough` | `pain-de-campagne`, `rye-sourdough`, `seeded-sourdough`, `sourdough-boule`, `sourdough-loaf`, `wholemeal-sourdough` |
| `rye-bread` | `danish-rye-bread`, `pumpernickel`, `rye-bread`, `vollkornbrot` |
| `enriched-bread` | `brioche-loaf`, `challah`, `hokkaido-milk-toast`, `milk-bread`, `hot-cross-bun` |
| `specialty-bread` | `cheese-and-onion-loaf`, `cranberry-and-walnut-sourdough`, `fruit-loaf`, `gluten-free-white-bread`, `olive-bread`, `spelt-bread`, `walnut-bread` |
| `italian-bread` | `ciabatta`, `ciabatta-roll`, `focaccia` |
| `baguette` | `french-baguette`, `demi-baguette`, `batard` |
| `bagel` | `bagel`, `sesame-bagel`, `everything-bagel` |
| `griddle-bread` | `english-muffin`, `potato-farl` |
| `soft-roll` | `floury-bap`, `barm-cake` |
| `burger-bun` | `brioche-burger-bun`, `sesame-seed-burger-bun`, `potato-bun`, `pretzel-roll` |
| `quick-bread` | `soda-bread` |
| `viennoiserie` | `croissant` |

24 are `everyday`, in 13 families; 3 are `exotic`. **Left out on purpose:** flatbreads, tortillas,
naans and pittas (they make wraps and quesadillas, not a closed toasted sandwich — a future mode),
crackers and crispbreads, crumpets, pikelets, scones, Welsh cakes, cornbread (crumbles), malt loaf,
cinnamon and Chelsea buns, pains aux raisins, a ficelle (too thin), bridge rolls (too small),
breadcrumbs, pastry, pizza bases, ready-made garlic breads, and the prepared `thick-cut-white-toast`
(already toast, and a near-copy of `thick-cut-white-toast-bread`). The sweet `hot-cross-bun`,
`fruit-loaf` and `croissant` stay in: a sweet or buttery toastie is in the "everything in there"
spirit.

**Cheese** — `dairy-eggs` entries in these 19 families: `alpine-cheese`, `american-cheese`,
`blue-cheese`, `brined-cheese`, `british-cheese`, `cheddar`, `cheese-filling`, `danish-cheese`,
`dutch-cheese`, `fresh-cheese`, `goat-cheese`, `grilling-cheese`, `hard-cheese`, `pasta-filata`,
`processed-cheese`, `semi-hard-cheese`, `sheep-cheese`, `smoked-cheese`, `soft-cheese` (176 entries,
16 families with an everyday entry, 55 exotic).

**Main filling** — role `protein` or `base` after exclusions: meat, fish, eggs, beans and tofu, plus
hearty things like potatoes, chips, mash, spaghetti hoops, stuffing, pies and ready meals (864
entries in 6 categories). **Veg or fruit** — role `produce` (605 entries, 7 categories, including
kimchi, sauerkraut and tinned fruit). **Finishing touch** — role `accent` after exclusions: sauces,
chutneys, pickles, mustards, spreads, honey and jams, herbs, spices, nuts and seeds, chocolate,
biscuits, crisps and sweets (1,060 entries, 8 categories).

**Excluded from every filling turn** (`fillingRules`):

| Rule | Excluded | Why |
|---|---|---|
| categories | `grains-bakery`, `drinks-alcohol` | breads, pasta, rice, grains, flours (no bread or raw grain in a filling turn); drinks are not a filling |
| `sweet-baking` families | `baking-chemical`, `raising-agent`, `setting-agent`, `thickener`, `yeast`, `flavouring`, `sugar-white`, `sugar-brown`, `sugar-specialty`, `sugar-unrefined` | kitchen-only, not something you eat in a sandwich |
| `oils-fats-condiments` families | `cooking-oil`, `seed-oil`, `nut-oil`, `tropical-oil`, `olive-oil`, `animal-fat`, `spread`, `white-vinegar`, `rice-vinegar`, `wine-vinegar`, `fruit-vinegar`, `herb-vinegar` | cooking fats and plain vinegars would waste a turn (flavoured oils, balsamic and malt vinegar stay) |
| `sauces-stocks-fermented` families | `stock`, `stock-cube`, `japanese-stock` | kitchen-only liquids |
| `dairy-eggs` families | `butter`, `milk`, `frozen-dairy` | butter is free anyway; milk is a capped staple; ice cream cannot survive toasting |
| `prepared-pantry` families | `flatbread`, `tortilla`, `garlic-bread`, `sliced-bread`, `crackers`, `pastry`, `pizza-dough`, `frozen-pizza`, `breakfast-bakery`, `batter`, `dried-noodle`, `instant-noodle`, `ready-grain`, `ready-rice`, `rice-snack`, `ice-cream-extras`, `ice-cream`, `jelly`, `instant-soup`, `cereal`, `yorkshire-pudding` | breads and bread-likes, raw grains and noodles, frozen or set desserts |
| role + category | base in `legumes-nuts-seeds` and in `dairy-eggs` | flours, pasta and doughs |
| ids | `cheese-rind`, `dried-egg-powder`, `egg-wash`, `dried-black-beans`, `dried-butter-beans`, `dried-cannellini-beans`, `dried-chickpeas`, `dried-fava-beans`, `dried-kidney-beans`, `falafel-mix`, `custard-powder`, `frozen-bao-buns`, `microwave-popcorn-bag`, `popcorn-kernels`, `suet-dumpling-mix` | inedible as bought, needs overnight soaking, or is a bread |
| re-included ids | `dulce-de-leche`, `garlic-butter` | genuine toastie spreads inside excluded families |

The exclusion lists are the only judgement in the pools; the validator (§8.1) keeps them honest
against the bank, and adding a bank ingredient later classifies it automatically.

### 2.3 The draw (one engine, a mode's pool per turn)

`cookout_bank.CookoutBank` gains two keyword-only arguments on `draw_pair`, `draw_replacement` and
`draw_wildcard` (Appendix A.2), defaulting to today's behaviour exactly:

- `candidates: Sequence[Ingredient] | None = None` — when given, it replaces `by_role(role)` as the
  pool (Classic never passes it).
- `facet: Literal["category", "family"] = "category"` — the axis that keeps a pair varied. With
  `"category"` the algorithm is 09 §2.3 unchanged. With `"family"` the two options must come from two
  different families (no category rule), and the least-shown tie-break counts **families** already
  shown to the active player in this round instead of categories. Needed because every bread is in
  `grains-bakery` and every cheese in `dairy-eggs`: the core's "two different categories" rule would
  make every bread or cheese pair impossible. Two breads of different families (a sourdough against a
  bagel) is exactly the contrast the core rule was written to get.

Every other draw rule is the core's: hard exclusions (every id seen this round, every picked family),
at least one `everyday` option in a normal pair, the soft offered-families preference, `8 : 3 : 1`
rarity weighting for the second option, the coin swap, immutable snapshots. `role` keeps its meaning
(the kind id) for errors and snapshots.

The game reads the kind with `mode.kind_for_turn(round_.role_schedule, turn)` and passes
`candidates = mode.kinds[kind].candidates`, `facet = mode.kinds[kind].facet`.

### 2.4 Skips, Open/Blind play, exhaustion

- **Skips:** unchanged — every turn, the bread turn included, starts at offer 0 with two skips.
- **Open/Blind play:** unchanged and server-side. In Blind play the bread is the starter's secret like
  any pick: the partner sees `🔒` in the bread slot until all eight are in. `current.role` (now the kind
  id) is redacted for a non-active viewer exactly as today.
- **Exhaustion:** keeps the core's `409 exhausted` (no skip charged, nothing written). The validator
  (§8.1) proves it cannot happen in a real round: 2,000 seeded maximum-skip Toasted sandwich rounds
  with chaos-shelf use produced no exhaustion on the committed bank (measured 2026-10-29 with these
  pools); the validator's simulation adds veto, wildcard and rescue-swap draws. The thresholds that guarantee this are validator rules, so a future bank or
  list edit that thins a pool fails CI instead of failing a game.

### 2.5 Starters in Toasted sandwich mode (fridge raid and encore)

A starter is placed by kind, never by "first free turn":

- **At most one bread starter (turn 1) and at most one filling starter (turn 2).** So a round still has
  at most two starters, one per player, as in 09a §1.3.
- **Fridge raid** = "start with a bread you have at home": `fridgeSeedId` must classify as `bread`
  (`422 invalid`, "pick a bread for this game"). The ingredient search takes `mode` and returns only
  breads (§5.4). It fills turn 1.
- **Encore** is offered only from a source round of the **same game mode** (`422 invalid` otherwise;
  the Recipe book's Remix and Leftovers buttons open the start sheet with that mode locked).
  Leftovers are always fillings (the bread can never be omitted, §3.4), so a leftovers encore has
  exactly one seed, on turn 2. A remix may seed one bread (turn 1) and/or one filling (turn 2). With a
  fridge bread, an encore may add only one filling seed. A seed that classifies as excluded →
  `422 invalid`.
- **Schedule with a filling starter of kind K on turn 2:** if K is a pair kind, that pair moves to the
  front (turns 2–3 are K; the other two pairs shuffle); if K is `finish`, the finishing-touch turn moves
  to turn 2 and the three pairs serve turns 3–8 (starter then partner). Both players still get one of
  each pair kind and the partner still gets the finishing touch.
- **Turn flow:** the core rule "a Player 2 turn is never drawn until Player 2 is bound" stands. With
  only a turn-2 seed, turn 1 (bread) is drawn at creation and, after it is picked, turn 3 (Slot 1) is
  drawn at once.

---

## 3. Toasted sandwich: the chef

### 3.1 Staples

| Staple | Classic (unchanged) | Toasted sandwich |
|---|---|---|
| water, salt, black pepper | free | free |
| butter | capped (or picked) | **free** — for the outside and anywhere else |
| plain flour, cooking oil, granulated sugar, milk | capped (or picked) | capped |
| cap on undeclared capped staples per idea | 4 | **2** |

None of the eight staples can be offered in a Toasted sandwich draft (the pools exclude them), so the
"a picked staple doesn't count against the cap" rule never arises in this mode. Why a cap of two: with
butter free, a toasted sandwich rarely needs more than milk and flour (a béchamel for a croque) or oil
(for a skillet); two keeps the picks the stars, the operator's "nothing fancy" rule. The staples are
mode data (`staples.free`, `staples.capped`, `staples.cap`), and the prompt, `basket_payload`,
`concept_manifest`, `parse_concepts` and `parse_recipe` read them from the mode (Classic reads the
existing constants, which equal its data).

### 3.2 The concepts prompt (server text; Toasted sandwich only)

`build_concepts_prompt(basket, *, mode, forbidden_names)` emits, for `chef.format == "single-dish"`,
this text in place of the Classic opening and rules (twist lines, the BASKET_JSON marker, the output
schema and the repair suffix are appended exactly as today). `{bread}` is the resolved bank name and
`{bread_id}` its id; `{n}` the number of fillings (7, or 8 with a lifted wildcard):

```text
Two friends played a cooking game and drafted the ingredients for a TOASTED SANDWICH: one bread and
{n} fillings (the JSON below). Invent THREE different toasted sandwiches from them.

Every idea is a CLOSED TOASTED SANDWICH: two pieces of the chosen bread ({bread}, id "{bread_id}") on
the outside, the fillings inside, toasted until golden and hot right through. Never an open sandwich,
a wrap, a salad, a bake where the bread is cubed or crumbed, or a dish with the bread on the side.
- Use the bread in all three ideas and name it in each title or description.
- Try hard to use every filling in every idea. Each idea must use at least {each} of the {n}
  fillings, at least one idea must use {best} or more, and between them the three ideas must use all
  {n}. Leave a filling out only when it would really clash, and say why in "omitted".
- Give each idea a different "build" from this list: {build_list}.
- Butter is always allowed (list "butter" in stapleIds when you use it); salt, black pepper and water
  are free. You may also use at most TWO of: plain flour, cooking oil, granulated sugar, milk.
  Nothing else that is not in the basket.
- Surprising fillings are part of the fun: make them taste good together.
```

`{build_list}` is `id (label: phrase)` for every build, e.g. `pressed (Pressed: in a sandwich toaster
or panini press)`. When a chef's style is on, its existing `STYLE:` line is followed by `The style
flavours the toasted sandwiches; every idea is still a closed toasted sandwich.` The prompt carries
no other new content: privacy is unchanged (food records and server constants only).

### 3.3 Output schema and builds

The model returns the core concept object with `build` in place of `dishType` and `technique`:

```json
{ "id": "a", "title": "…", "vibe": "…", "build": "skillet", "description": "…",
  "pickedIngredientIds": ["…"], "stapleIds": ["butter"], "omitted": [{ "id": "…", "reason": "…" }] }
```

The server stores `dishType = "sandwich"`, `technique` from the build's mapping, and `build`, so
every existing reader keeps working. `dishType`/`technique` sent by the model anyway are ignored (not a
violation). The builds (mode data, `chef.builds`):

| `build` | label | `technique` | prompt phrase | picture phrase |
|---|---|---|---|---|
| `pressed` | Pressed | `grill` | in a sandwich toaster or panini press | with the ridged marks of a sandwich press |
| `skillet` | Skillet-fried | `pan-fry` | fried in a pan under a weight, turned once | pan-fried until deep golden and crisp |
| `grill-toasted` | Grill-toasted | `grill` | toasted under the grill, turned, closed and finished | toasted under the grill with darker golden edges |
| `oven-baked` | Oven-baked | `bake` | baked in the oven, croque style | baked with a bubbling golden top |
| `dipped` | Dipped and fried | `pan-fry` | dipped in a batter of allowed ingredients and fried | with a crisp fried golden coating |
| `crisp-crusted` | Crisp-crusted | `pan-fry` | with a filling ingredient fried onto the outside into a crust | with a lacy, crisp, golden crust fried onto the outside |
| `jaffle` | Jaffle | `grill` | sealed at the edges in a jaffle iron | sealed at the edges in a rounded jaffle shape |

Seven builds so three distinct ones are always available, also under the no-oven challenge (six).

### 3.4 Deterministic validation (`parse_concepts(..., mode=…)`)

All core and twist checks stand (structure, id whitelist, exact `omitted` complement, both lexical
passes as amended by the chef fix, stars, wildcard, challenge, forbidden ids, one repair loop as
amended by the chef fix), with these Toasted sandwich rules in place of the Classic coverage,
diversity and staple rules:

1. **Bread everywhere:** the bread id (the effective basket's `bread`-kind item, §5.5) is in every
   concept's `pickedIngredientIds`, and is never in `omitted`. A missing bread id, a different bread
   id (it is not in the basket, so the id whitelist rejects it) or an omitted bread is a violation.
   **The prose is not checked for the bread's name.** The prompt asks the chef to name the bread, but
   a model writes "White bread toastie" for `sliced-white-bread` or "Ciabatta toastie" for
   `ciabatta-roll`, and `bank.mentions` (exact names, aliases, bare family words) does not recognise
   those normal short forms. Instead the UI shows the canonical bread name, resolved from the
   validated bread id, on every dish card (§6.4), so the player always sees which bread it is.
2. **Coverage on fillings** (F = fillings in the basket, 7 or 8): each concept uses at least `F − 2`
   fillings (5 of 7), at least one uses `F − 1` (6 of 7), and the union is all F. Why: one sandwich
   holding seven fillings is a lot; letting each idea leave out up to two clashing ones (jam and
   anchovy) keeps the chef able to make three good sandwiches, while the union rule still uses every
   pick somewhere and the best idea uses all but one — the same "try hard, use most" spirit as
   Classic's 7/8 of 10.
3. **Three different builds**, each a known build id. No-oven challenge: no `oven-baked`.
4. **Staples:** `stapleIds` ⊆ the mode's staples; at most `cap = 2` capped staples; butter, salt,
   black pepper and water never count. Pass 2's undeclared-staple scan treats butter as always
   declared in this mode.
5. **Unpicked foods and forbidden ids:** the chef fix's high-precision food scan and the swap's
   forbidden-id check apply unchanged. These are the only prose checks that can reject an answer.

Violation messages name the rule exactly ("concept b leaves out the bread 'sourdough-loaf'; the bread
must be in every idea", "concepts a and c share the build 'pressed'") so the repair run can fix it.

**Dish words are review signals, never failures.** "Still a closed toasted sandwich" is asked for in
the prompt and drawn by the picture template; it is not a fatal check. The token scan cannot read
meaning: "A closed sliced white bread toastie, never an open sandwich." keeps the words `open sandwich`,
and "a closed ciabatta roll toastie with bruschetta-inspired tomato filling" keeps `bruschetta`, yet
both describe exactly the right dish. So the mode's `reviewDishWords` (`open sandwich`, `open-faced`,
`bruschetta`, `crostini`, `tartine`, `bread pudding`, `strata`, `panzanella`, `croutons`,
`quesadilla`, `wrap`) are matched against the `food_free_tokens` of `title`, `vibe` and `description`
only to produce **signals**: `parse_concepts` returns them in `Parsed.signals` (a list of
`"concept c: 'open-faced'"` notes) alongside an accepted result. The runner logs only their count
(no prose) and never repairs or fails for them. `chef_trial.py` lists every signal in full in its
report so a person reads each one (§8.4); if trials show a real problem, the answer is a prompt change,
not a fatal word list.

Basket sizes come from the mode: `{turns, turns + 1}` = `{8, 9}` (Classic `{10, 11}`).

### 3.5 Bank this (the full recipe)

`build_recipe_prompt(concept, manifest, *, mode, twists)` adds, for a single-dish mode, before the
core schema: `This is the full recipe for one toasted sandwich idea, for two people (two sandwiches).
Keep the bread on the outside and make it the "<build label>" way: <build prompt phrase>. Butter is
always allowed.` `parse_recipe` is unchanged except that butter is in the manifest's free set (it may
appear in `ingredients[]` and prose without being declared) and the capped staples follow §3.1.
`serves` stays 2. The stored recipe keeps everything it stores today; the concept's `build` reaches the
recipe view through the concept.

### 3.6 Pictures "as a toasted sandwich"

`build_image_prompt(title, ingredient_names, *, style, mode=None, bread_name=None, build=None)`: Classic
(`mode` None or classic) is byte-identical to today. Toasted sandwich uses the mode's template:

```text
Photorealistic appetising food photograph of "{title}": one closed toasted sandwich made with
{bread}, {build_phrase}, cut in half with the two halves stacked slightly apart, the cut faces turned
toward the camera so the hot, melted filling of {fillings} shows in the cross-section. Golden, crisp, evenly toasted bread. {presentation},
shallow depth of field, no people, no hands, no raw-ingredient collage, no open sandwich, no unlisted
side dishes, no text, labels, logos, or watermark.
```

- `{fillings}` = the concept's used picks other than the bread (staple names are left out: "a filling
  of milk and plain flour" helps no picture).
- `{presentation}` = `Served simply on a wooden board in a home kitchen, natural light`, or the chef's
  style's existing `picture_phrase` when a style is on (the setting changes; the subject stays a
  toasted sandwich).
- `concept_prompts` reads `round_row["mode"]`, `bread_id` and each concept's `build`. Everything else
  in §3.3 of the core and 09a §5.4 is unchanged: the same ComfyUI graph, limiter, fencing, partial
  success, retries, attachments and ordinals.
- The template, default presentation and build phrases name no bank food (tested, §8.1), so a
  picture can never add an unpicked food.

---

## 4. Twists in Toasted sandwich mode

Every twist keeps its 09a rules except as stated. The start sheet shows only the twists in the
mode's `twists` list (today: all twelve for both modes); the server rejects a start-sheet twist the
mode does not allow with `422 invalid`, and in-game twist buttons are computed from the same list.

| Twist | Applies? | Toasted sandwich adjustment and reason |
|---|---|---|
| T1 rescue swap | yes | The replacement pair is drawn from the target's **kind** (a bread for the bread, a cheese for a cheese) with that kind's facet, so the basket stays one bread + fillings; swapping out the bread makes the new bread the one every idea must use. The swapped-out item is forbidden in generation 2 as today. |
| T2 dinner vote | yes | unchanged |
| T3 chef's style | yes | Directives as today plus the "still a closed toasted sandwich" line (§3.2); the style's picture phrase becomes the picture's setting (§3.6). A campfire jaffle or a posh-tasting toastie is the fun of it. |
| T4 we cooked it | yes | unchanged |
| T5 wildcard cloche | yes | The ninth ingredient is drawn only from the **filling** pools (`draw_wildcard(candidates=union of cheese, main, produce, finish)`), never a bread or an excluded item; labelled "a mystery 9th ingredient". The "use it in two ideas" rule stands. |
| T6 fridge raid | yes, bread only | "Start with a bread you have at home" (§2.5): the bread is the natural "what have we got tonight" choice and fills turn 1 cleanly; a filling seed would need a second seat rule for the starter. |
| T7 kitchen challenge | yes | All four rules apply; no-oven also forbids the `oven-baked` build; one-pan accepts a sandwich toaster or jaffle iron as the one vessel. |
| T8 partner veto | yes | Works on the bread turn too once the partner has joined; the replacement comes from the same kind and facet. |
| T9 leftover encore | yes, same mode | Same-mode sources only, seeds placed by kind (§2.5). |
| T10 lucky dip | yes | unchanged, the bread turn included |
| T11 secret star | yes | A player may star any own pick, the bread included ("hero bread"). |
| T12 chaos shelf | yes, fillings only | Not offered on the bread turn (`kinds.bread.chaos = false`; `canChaos = false`, the route answers `409 bad_state`): only three breads are exotic, too few for a real "weird shelf". Every filling kind has enough exotic entries (validator, §8.1). |

---

## 5. Server

### 5.1 Schema v22 (`store.py`, additive; v21 is deployed and never edited)

v21 is in production, so this is a new migration. Bump `_LATEST_SCHEMA_VERSION = 22` and add:

```sql
ALTER TABLE cookout_rounds ADD COLUMN mode TEXT NOT NULL DEFAULT 'classic';
```

- Run in `_migrate` under `if current < 22`, guarded by a `PRAGMA table_info(cookout_rounds)` check so
  a database that already has the column (a retried migration) skips the `ALTER`; then
  `PRAGMA user_version = 22`. Every existing round reads back as `classic`.
- No `CHECK` on `mode` (like `style`/`challenge`): the catalogue grows without a table rebuild; code
  validates against the loaded modes. The unknown-mode guards of §5.6 decide what a process does with
  a row whose mode it does not know.
- `role_schedule` keeps its column: a Classic round stores today's 5-element paired list; a sequence
  mode stores the resolved per-turn list of `turns` kind ids (8 for Toasted sandwich).
- `cookout_turns.turn` keeps `CHECK(turn BETWEEN 1 AND 10)`; Toasted sandwich uses 1–8. A future mode
  needing more turns is a schema change, specified with that mode.
- No other table changes. Wipe, delete, cascade and Gallery rules are unchanged.

### 5.2 Model rows (`models.py`)

`CookoutRoundRow.mode: str = "classic"`; `CookoutSummary.mode: str = "classic"`. Nothing else.

### 5.3 Game logic (`cookout_game.py`, `store.py`)

- `TOTAL_TURNS` and `PICKS_PER_PLAYER` stay as the Classic constants; every use that decides round
  flow reads `mode.turns` / `mode.picks_per_player` instead (`next_turn_draws_now`, the finishing pick,
  `pickCount`, `current_turn`, `basket` sizes).
- `role_for_turn(schedule, turn)` stays for Classic; the game calls `mode.kind_for_turn(schedule,
  turn)`, which delegates to it for Classic.
- `draw_inputs` additionally returns `player_offered_families`; `_cx_draw`, skip, veto, chaos, swap and
  wildcard draws pass the kind's `candidates` and `facet` (and the facet-matching shown list).
- `create_cookout_round(..., mode_id)` validates the mode, its allowed twists, starters by kind
  (§2.5), builds the schedule with `mode.build_schedule(rng, starter_kinds=...)` and stores `mode`.
- `PickSnap` gains `kind` (the turn's kind; a starter's or the wildcard's classification), visible
  exactly when the pick is visible.
- Idempotency (`clientId`, `moveId`, ledgers), `BEGIN IMMEDIATE` serialisation, abandonment, the chef
  gate, generations and erasure are unchanged.

### 5.4 Wire (all additive; parsers stay defensive)

- `POST /cookout` body gains `mode?: string` (default `"classic"`). Unknown → `422 invalid`. A known
  mode that is not switched on by `WIXY_COOKOUT_MODES` (§5.6) → `503 game_unavailable` ("that game
  isn't available yet"), checked before anything is written. A twist the mode does not allow →
  `422 invalid`. `extra="forbid"` stays.
- `GET /cookout/options` gains
  `modes: [{id, label, emoji, blurb, intro: [string], turns, picksPerPlayer, twists: [string], fridgeKinds: [string] | null}]`
  listing **only switched-on modes** (Classic always, first, the default). A switched-off mode is not
  listed at all, so no client can offer its tile. `intro` lines may contain `{starter}`, which the
  client replaces with the starter's name or "you".
- `GET /cookout/ingredients?q=&mode=` — with `mode=toastie` only ingredients of the mode's
  `fridgeKinds` (breads) are searched; without `mode`, or `classic`, the whole bank as today.
- `CookoutView` gains:
  ```text
  mode: { id, label, emoji, turns, picksPerPlayer,
          kinds: [{ id, label, prompt }],        // the mode's kinds, for banners and the basket sheet
          anchorKind: "bread" | null },           // public: a setting, not partner data
  current.role: string | null                     // now the kind id ("bread", "cheese"…); Classic unchanged
  players[].pickCount: 0..picksPerPlayer
  PickSnap.kind: string | null
  concepts.data[].build: { id, label } | null     // null for Classic
  ```
  `current.turn` ranges `1..turns`. Redaction is unchanged: `current.role` stays redacted for a
  non-active Blind viewer; `PickSnap.kind` rides with the pick.
- `Message.cookout` gains `mode: string` (a setting: counts and flags only, as before).
- `GET /cookout/bank` entries gain `mode: {id, label, emoji}` and `build: {id, label} | null`.
- Errors: no new codes.

### 5.5 AI read (`get_cookout_round`)

Adds `mode` (id) and `bread_id` (the effective basket's `bread`-kind item after any swap; `None` for
Classic). The runner resolves the mode with `default_modes()`, passes it to the prompt builders and
parsers, and checks the basket size against the mode (§3.4). `cookout_pending_*` tuples are unchanged.

### 5.6 The activation barrier (no v21 process may ever see a non-Classic round)

**Why a barrier, not a tolerated overlap.** v21 code accepts a database at a higher schema version and
ignores the `mode` column. Handed a Toasted sandwich round, it reads the per-turn schedule with the
Classic paired index `(turn − 1) // 2`, and `produce` is a valid Classic role. The review reproduced it
with the deployed v21 store: for the permitted schedule `bread, produce, produce, cheese, cheese, main,
main, finish`, a turn-3 pick handled by v21 commits and draws turn 4 as two `produce` items where the
plan says `cheese` — a successful, wrong write that the new process then serves. Finished rounds expose
other v21 write paths (a rescue swap of the bread draws by its bank role `base`, outside the bread
list). So no v21 writer or background job may ever be able to reach a non-Classic row.

**The setting.** `WIXY_COOKOUT_MODES` (in `Storage\.env`, read into `settings.cookout_enabled_modes:
frozenset[str]`): a comma-separated list of non-Classic mode ids that may be **created**. Absent or
empty (the default) = Classic only. An id that is not a loaded mode is ignored with a warning. Classic
can never be switched off. The setting gates only creation and the options listing; rounds of a loaded
mode that already exist keep working if the setting is later cleared.

**Activation sequence (decided):**

1. **Release.** Merge the whole feature (v22 migration + mode-aware code) with the setting absent.
   Slots deploys it; Toasted sandwich creation answers `503`, the options omit it, so no
   non-Classic row can exist while the v21 slot may still be serving or sweeping.
2. **Drain.** The Cookout runner, recovery sweep and picture jobs run inside the server process (the
   supervised background task group), so "every v21 process and worker is gone" means: no process is
   running from the previously active slot. The 09b picture batch tooling is a separate Grid task but
   never reads or writes Cookout rounds.
3. **Switch on.** The **workspace-00058 delivery coordinator** (or whoever the operator names to run
   the deploy) runs, on hub, `python tooling/cookout/activate_modes.py --enable toastie` from a
   checkout of the deployed commit. The tool refuses (non-zero exit, nothing changed) unless all hold:
   (a) Devfleet `http://127.0.0.1:9999/status` shows Wixy running; (b) the active slot named by
   `D:\Servers\Wixy\active.txt` is at a commit whose `store.py` has `_LATEST_SCHEMA_VERSION >= 22`;
   (c) the live database's `PRAGMA user_version >= 22`; (d) **no** running process has a command line
   or working directory under the other slot (`Win32_Process` scan); (e) `GET /cookout/options` on the
   live server answers. Then it writes `WIXY_COOKOUT_MODES=toastie` into `D:\Servers\Wixy\Storage\.env`
   (preserving every other line; UTF-8, LF), bounces with `POST http://127.0.0.1:9999/restart/Wixy`
   (an in-place restart of the active slot: no older code starts), and verifies that
   `GET /cookout/options` now lists `toastie`. It prints each check and its result. `--disable toastie`
   removes the id the same way (no slot checks needed to switch off).
4. **Never roll back to v21 while non-Classic rows exist.** Rollback targets are v22-or-later commits
   only (each refuses unknown modes, below). The activation tool's `--check-rollback <commit>` reports
   whether a target is safe (its `store.py` is ≥ v22, or `SELECT COUNT(*) FROM cookout_rounds WHERE
   mode != 'classic'` is 0); the runbook makes running it the first step of any Wixy rollback.

**Unknown-mode guards (in v22 and every later release, for any future mode).** A process treats a row
whose `mode` is not one of its loaded modes as untouchable:
- every mutation that interprets the round (join, skip, pick, lucky, chaos, veto, star, wildcard,
  vote, swap, bank, every retry, every We-cooked-it route) answers `409 bad_state` ("this game needs a
  newer server") before writing; abandonment (by `/abandon` or by creating a new round) only sets
  `state = 'abandoned'`, interprets nothing and stays allowed, so an unknown round can never block a
  new game;
- every background claim and recovery read (`cookout_pending_concepts`, `cookout_pending_recipes`,
  `cookout_stale_pictures`, `claim_cookout_pictures`, the startup resume) filters
  `mode IN (<loaded mode ids>)` in SQL, so no job of an unknown mode is ever claimed, resumed or failed;
- the view is served read-only with `mode.id` as stored and no `can*` actions.
This is what makes a future mode (Pizza) safe to release the same way: release with it switched off,
drain, switch on.

**Standalone edition:** one container, no blue/green overlap; the owner may set `WIXY_COOKOUT_MODES`
in the deployment's environment (documented in the guide), and the same guards apply.

### 5.7 Privacy, erasure, standalone

- Prompts: food records plus server constants chosen by mode id (the mode text, build list and
  phrases). Inv 57's statement of what cmd retains covers it.
- Erasure: one column on an anchor-owned table; nothing new to delete.
- Standalone edition: both modes are playable once switched on (the draft needs no AI); concepts are
  `unavailable` as for Classic. Mode tiles and pictures are static assets.

---

## 6. UI (built on 09b §D, phone first)

Everything below sits on the round-2 picture-first screens. Nothing here changes the shared frame, the
height budget of 09b §D.3, or the no-scrolling-while-picking rule; the Toasted sandwich screens use
fewer progress thumbnails, so they fit wherever Classic fits.

### 6.1 Start sheet: the mode picker

- A new first section, **"What are we making?"**, with one **picture tile per mode** side by side
  (two tiles fill a 360 px phone: each ≥ 150 px wide, a 1:1 picture of at most 96 px, the label, and
  the `blurb` in 12 px wrapping to two lines). Tiles are radio buttons (`role="radio"`, one group,
  arrow keys move, 44 px minimum target). **Classic** is selected by default. Only the modes
  `GET /cookout/options` lists are shown; while Toasted sandwich is switched off (§5.6) the options
  list Classic alone and the whole section is hidden, so the sheet looks exactly as it does today. A
  `503 game_unavailable` on start (the setting was cleared meanwhile) reloads the options and shows
  "That game isn't available right now".
- Tile pictures are two committed WebP files, `admin-ui/data/cookout-mode-classic.webp` (a basket of
  mixed ingredients) and `admin-ui/data/cookout-mode-toastie.webp` (a golden toasted sandwich cut in
  half), 512×512, ≤ 60 KB each, generated once on hub's ComfyUI with the §3.6 house look by
  `tooling/cookout/mode_tiles.py` and copied by `esbuild.config.mjs` with a content hash, exactly like
  the Adventure atlas images. Missing or failing picture → the mode emoji on the tile colour (same
  size).
- The existing Open/Blind choice follows under **"How do we play?"** (wording of the options
  unchanged). Inside the code the existing "modes" variables for Open/Blind are renamed (`playStyle`)
  so "mode" means one thing.
- Twists: the disclosure shows only the selected mode's twists. In Toasted sandwich mode the fridge
  raid row reads **"Start with a bread you have at home"** and searches breads; the wildcard row reads
  **"a mystery 9th ingredient"**.
- **New** inside the pane preselects the current round's mode (and its other settings, as today). An
  encore start (Remix / Leftovers) locks the mode tile to the source round's mode, with the note
  "Same game as before".

### 6.2 The intro (09b §D.2)

The mode's `intro` lines come first, then the existing Open/Blind lines, with the Classic lines kept
exactly as today for Classic. Toasted sandwich, Open play:

- "You're making a toasted sandwich."
- "You're playing non-blind mode."
- "Cupcake picks the bread first, then you take turns adding fillings — 4 picks each." ("You pick the
  bread first…" for the starter.)
- "Each turn, tap the one you want. Don't fancy either? Deal two new ones (up to twice)."
- "You'll see each other's picks as you go." (Blind: "Your picks are secret — the toasted sandwich is
  revealed when all eight are in.")
- "The chef makes three toasted sandwiches with your bread."

Still one short card, no scrolling, the twists line as 09b describes.

### 6.3 Picking

- **Title row:** the mode's emoji replaces 🍳 (`aria-label` "Toasted sandwich Cookout"); nothing else
  is added, so the row fits as 09b requires.
- **Turn banner line 1** (≤ 34 characters, the 09b rule): `"Your turn — " + kind.prompt` in Toasted
  sandwich mode: "Your turn — pick the bread", "Your turn — add a cheese", "Your turn — add a
  finishing touch". Watching: "Cupcake is picking the bread…" / "Cupcake is adding a filling…" (Blind:
  "Cupcake is choosing…", never the kind). Classic banners are unchanged. The validator caps every
  `prompt` at 22 characters so the banner fits.
- **Line 2:** "Bread · then 7 fillings · 2 new pairs left" on turn 1; "Filling 3 of 7 · 1 new pair left"
  afterwards (twist notes take the line as 09b says).
- **Progress row:** one 44 px button as in 09b, with **4 + 4** thumbnails; the starter's first slot is
  the **bread slot**, drawn with a 🍞 corner mark (filled with the bread's thumb when visible, 🔒 for a
  hidden partner bread). The basket sheet lists "Bread" first, then the fillings grouped by kind label.
- **Cards:** unchanged (two picture cards, one tap picks). The chaos shelf entry is absent from the 🎲
  sheet on the bread turn.

### 6.4 Chef, dishes, card, recipe book

- **Chef thinking (09b §D.4):** the status line reads "The chef is making three toasted sandwiches with
  your <bread name>…"; the carousel shows the eight (or nine) picks, bread first.
- **Reveal:** the 09b picture grid with the bread in its own first row ("Bread"), then the fillings
  grouped by player. "Plus cupboard staples:" lists butter first, marked "free".
- **Dish cards:** the chef stage header shows "🥪 Toasted sandwich"; each card's pills show the
  **build** label (e.g. "Skillet-fried") in place of dish type / technique, and under the title a line
  "On <bread name>" with the bread's thumbnail, the canonical name taken from the bread's snapshot in
  the basket (never from the chef's prose, §3.4); pictures are the toasted sandwich pictures. "Uses 6/7 fillings" replaces "Uses 9/10" (the bread is always used and not
  counted).
- **Full recipe:** unchanged, with the build label under the title.
- **Main-chat card:** a mode badge ("Toasted sandwich" / none for Classic, which keeps today's card);
  status lines use the mode's numbers ("Picking ingredients (3/8)…", "All 8 picked — chef is
  thinking…", "3 toasted sandwich ideas ready").
- **Recipe book:** a small 🥪 badge on Toasted sandwich entries; Remix and Leftovers carry the mode.

### 6.5 Accessibility

Mode tiles have `alt` = the mode label; the bread slot's accessible name is "Bread: <name>" (or
"Secret bread"); banners are live regions as today; contrast and 44 px targets as 09b §D.6.

---

## 7. Honest limits

- **"A closed toasted sandwich" is a meaning, and no deterministic check can read meaning.** The
  bread id is enforced in every idea, three different builds are enforced, and the picture template
  always draws a closed, cut toasted sandwich; but whether the prose describes one is left to the
  prompt. Token checks were tried in the first draft and rejected on review: they failed correct
  answers ("never an open sandwich", "bruschetta-inspired filling", "White bread toastie"). Dish words
  are surfaced as review signals for the trials instead (§3.4), and the bread's proper name is shown
  from its id rather than required in the chef's prose.
- The pools' exclusion lists are a judgement about what belongs in a sandwich; a surprising but valid
  filling might be excluded, or an odd one allowed. The lists are data, reviewed by the validator,
  and cheap to change.
- The activation barrier (§5.6) is an operational step checked by a tool, not something v21 code can
  enforce (v21 cannot be changed). Skipping the tool, or rolling back to v21 by hand while
  non-Classic rows exist, would reopen the review's corruption; the runbook and the decision entry
  say so.
- The core's food-scan limit (a food absent from the bank can slip through prose) still applies.

---

## 8. Tests (all must exist and pass; bare `pytest`, the `-n 4` cap stays)

### 8.1 pytest — modes, pools and draw (`test_cookout_modes.py`, `test_cookout_bank.py` additions)

- `validate_modes.py` over the committed files: schema and unknown keys; ids exist in the bank; turns
  even; every kind referenced by the plan exists; prompts ≤ 22 characters; labels plain text.
- **Bread pool:** every listed id exists, is in `grains-bakery`, is not a staple; ≥ 40 breads in
  ≥ 10 families with ≥ 8 families holding an `everyday` entry.
- **Classification:** every bank ingredient is in exactly one kind or excluded; no bread id in a
  filling kind; nothing from an excluded category/family/role-category/id (minus `includeIds`) in any
  kind; none of the eight staples in any Toasted sandwich kind; `cheese` ≥ 120 entries with ≥ 12
  families holding an `everyday` entry; `main`, `produce`, `finish` ≥ 300 entries in ≥ 3 categories
  each; every filling kind with `chaos: true` has ≥ 20 exotic entries in ≥ 2 facet groups.
- **Simulation:** 2,000 seeded maximum-skip Toasted sandwich rounds where each player uses chaos on a
  random filling turn, one offer per round is vetoed, a wildcard is drawn and a rescue swap of a random
  basket item is drawn; on every emitted pair/replacement: kind membership, the facet rule, distinct
  families, at least one `everyday` in a normal pair, both exotic in a chaos pair, no id repeat, no
  picked family repeat; no exhaustion.
- **Facet unit tests:** `facet="family"` allows a same-category pair of different families and refuses
  a same-family pair; the least-shown tie-break counts families; `candidates` replaces the role pool.
- **Classic golden:** with a fixed seed, `draw_pair`/`draw_replacement`/`draw_wildcard`/`search`
  without the new arguments return exactly what they returned before (fixtures recorded from the
  pre-change code).
- **Schedules:** `build_schedule` for Toasted sandwich gives `bread`, three shuffled pairs and `finish`;
  with a pair-kind turn-2 starter the pair moves to the front; with a `finish` starter the finishing
  touch is turn 2 and pairs fill 3–8; each player gets each pair kind once in every case.
- **Prompt text is food-free:** the mode's concept and recipe text, build phrases, picture template and
  default presentation scanned with `find_contraband_ingredients` (allowed: the bread pool and the
  mode's staples) return nothing.

### 8.2 pytest — server (`test_livechat_cookout_modes.py`; existing Cookout suites stay green)

- **Migration v21 → v22 from a real v21 database:** `wixy_server/tests/fixtures/livechat_v21.db`,
  produced by the deployed v21 code with Cookout rounds in every state (picking, finished with ready
  concepts, a banked recipe, pictures, a swapped generation, abandoned); after migration
  `user_version == 22`, every round's `mode == 'classic'`, every row intact, and each round's view
  JSON identical to its pre-migration golden (plus `mode` fields). Re-running the migration is a no-op.
- Creating a Toasted sandwich round: Slot 1's turn 1 pair are two breads from the list, different
  families; 8 turns alternate; the starter makes 4 picks (bread first), the partner 4; turns 2–3, 4–5,
  6–7 share a kind and turn 8 is `finish`; two skips on every turn including the bread; turn 8's pick
  finishes the round and starts concepts (one transition, one event, one job under the race test).
- Join before and after turn 1 (turn 2 never drawn before Join); Blind redaction (the partner's bread,
  kinds and options never in any non-active response; the reveal shows all 8); abandon; `clientId` and
  `moveId` replays; delete/wipe cascade.
- Mode validation: unknown mode `422`; a disallowed twist `422`; `Message.cookout.mode`; options list
  both modes with Classic first; the view's `mode` block; `PickSnap.kind`; `concepts.data[].build`;
  recipe book `mode`.
- Twists: fridge raid with a bread → turn 1 starter; with a non-bread → `422`; ingredient search with
  `mode=toastie` returns breads only; encore across modes `422`; encore leftovers → one turn-2 seed and
  its schedule; remix bread + filling; chaos on the bread turn `409 bad_state` and `canChaos == false`;
  veto and lucky dip on the bread turn; wildcard drawn from filling pools only; swapping the bread deals
  two breads, swapping a cheese deals two cheeses, the swapped-out bread forbidden in generation 2.
- Classic regression: a seeded Classic round's create/draw/view JSON equals the pre-change golden.
- **Activation gate:** with `WIXY_COOKOUT_MODES` absent, `POST /cookout {mode: "toastie"}` → `503
  game_unavailable` with no message, round or event written, and `GET /cookout/options` lists Classic
  only; with `toastie` set, creation works and the options list both; an unknown id in the setting is
  ignored; clearing the setting leaves existing Toasted sandwich rounds fully playable.
- **Overlap regression with the real v21 write logic** (`test_cookout_modes_overlap.py`): the test
  loads the deployed v21 `store.py` and `cookout_game.py` from git history at a pinned v21 commit sha
  into an isolated module namespace, over a database migrated to v22.
  1. Canary (proves the barrier is still needed): a Toasted sandwich round with the schedule `bread,
     produce, produce, cheese, cheese, main, main, finish` advanced to turn 3 by the v22 code; v21's
     `_cx_commit_pick` commits the turn-3 pick and draws turn 4 as `produce`, not `cheese`.
  2. Before activation: the v22 routes refuse to create the same round (`503`), so the database holds
     only Classic rows, and running v21's pick, skip, swap and pending-job reads over it behaves
     exactly as v21 does today.
  3. After activation: `activate_modes.py`'s decision function, fed a fake Devfleet status, slot tree,
     `user_version` and process list, refuses while any process runs from the other slot, while the
     active slot is below v22 or while the database is below v22, and writes the setting and bounces
     only when all checks pass (writer and bounce are injected fakes; `.env` lines other than the
     setting are preserved byte for byte). `--check-rollback` reports a v21 target unsafe while a
     non-Classic row exists and safe once none does.
- **Unknown-mode guards:** a round row whose `mode` is not loaded (`'pizza'` inserted directly) is
  refused by every interpreting mutation route (`409 bad_state`, nothing written), never returned by
  `cookout_pending_concepts`, `cookout_pending_recipes`, `cookout_stale_pictures` or
  `claim_cookout_pictures`, untouched by the startup resume, served read-only by `GET`, and still
  abandoned by `/abandon` and by creating a new round.

### 8.3 pytest — chef and pictures (`test_livechat_cookout_ai.py`, `test_livechat_cookout_images.py`)

- Toasted sandwich prompt: bread rule, bread name and id, coverage numbers for 7 and 8 fillings, the
  build list, butter free, the cap of two, the style line when styled; Classic prompt byte-identical.
- `parse_concepts` (mode toastie) **rejections:** bread id missing from one concept; a different
  bread id (not in the basket); bread in `omitted`; each < F − 2, best < F − 1, union short; duplicate
  or unknown build; `oven-baked` under no-oven; a third capped staple; a genuine unpicked food in prose
  (e.g. "mango" when no mango was picked); a swapped-out bread used or named.
- `parse_concepts` (mode toastie) **acceptance regressions** (the review's examples; each concept
  otherwise valid, so the whole answer must be accepted on the first attempt with no repair run):
  title "White bread toastie" with `sliced-white-bread`; "Ciabatta toastie" with `ciabatta-roll`;
  "Brioche toastie" with `brioche-burger-bun`; a description that never repeats the bread's name;
  description "A closed sliced white bread toastie, never an open sandwich." (accepted, with one
  signal `'open sandwich'` in `Parsed.signals`); "A closed ciabatta roll toastie with
  bruschetta-inspired tomato filling." with a picked tomato (accepted, signal `'bruschetta'`).
  Undeclared butter in prose accepted; wildcard basket (F = 8); stars including a starred bread;
  stored `dishType = "sandwich"` and mapped `technique`. A signal never triggers a repair run.
- `parse_recipe` (mode toastie): butter allowed undeclared; capped staples per §3.1; build label in
  the prompt.
- `fake_cmd.py`: canned Toasted sandwich concepts (three builds) and recipe for e2e.
- Pictures: the toastie prompt contains the bread name, the filling names (no staples), the build
  phrase and the default presentation or the style phrase; Classic prompt byte-identical.

### 8.4 Real-run trials (the rapid local loop, before the parcel's PR; not CI)

`tooling/cookout/chef_trial.py --mode toastie` (the chef-fix tool, extended): 40 real Toasted sandwich
baskets drawn with the real bank, modes and draw (about a quarter with twists), run through cmd with
the production prompt and validator. Bar: ≥ 38/40 accepted, ≥ 30 on the first attempt, every
remaining violation a genuine rule break (read each — a rejection of a correct toasted sandwich is a
validator defect to fix, however high the pass rate); every `Parsed.signals` entry listed and read, with
a note on each saying whether the idea really was a closed toasted sandwich; the review's example
phrasings (short bread names, "never an open sandwich", "-inspired" fillings) seeded into at least four
of the replayed answers so the trial exercises them on the real validator; then 10 Bank-this recipes
with the same bar; then
12 pictures rendered on hub's ComfyUI from accepted concepts, each checked by the round-2 checker model
(Haiku) with the question "Is this one closed toasted sandwich, cut to show its filling, with no open
sandwich and no text?" — bar ≥ 11/12, every miss looked at. Report: `triad/cookout/modes/toastie-trial.md`.

### 8.5 vitest (`admin-ui/tests/cookout/`)

`api.test.ts` (mode, kinds, `PickSnap.kind`, `build`, options `modes`, summary `mode` parsed
defensively: an unknown mode id parses as a generic mode with its label; missing fields → Classic
defaults), `startSheet.test.ts` (tiles, Classic default, arrow keys, Toasted sandwich wording for fridge
raid and wildcard, only allowed twists, New preselects the mode, encore locks it), `cookoutGame.test.ts`
(banner strings per kind and watcher/Blind wording, 4 + 4 progress with the bread slot, no chaos entry on
the bread turn, intro lines, chef status line, build pills, "Uses 6/7 fillings"), `cookoutCard.test.ts`
and `recipeBook.test.ts` (badges and numbers).

### 8.6 e2e (`e2e/tests/server-cookout-toastie.spec.ts`)

Two players in separate contexts at **360×640** (and the 09b matrix's 34 px inset case): start a
Toasted sandwich round from the start sheet's tile; the intro shows the toasted sandwich lines; Player 1's
banner reads "Your turn — pick the bread", one skip, picks a bread; Player 2 joins; the seven filling
turns alternate with the kind banners; during picking neither the page nor the stage scrolls
(`scrollHeight <= clientHeight` on the pane at every turn); the reveal shows 8 pictures, bread first;
the fake chef's three toasted sandwiches show build pills and pictures; Bank this; the Recipe book shows
the badge. A Blind variant asserts Player 2's DOM never contains Player 1's bread name or picture URL
before the reveal. The existing Cookout, Cookout-visual, WYR and Adventure e2e suites stay green.

---

## 9. Docs to update in the same change (each parcel the ones for its files)

`docs/ai/livechat.md` (Cookout: game modes, the plan grammar, kinds and pools, Toasted sandwich draft,
chef and pictures, twist adjustments), `docs/ai/contracts.md` (`mode` on create/options/view/summary/
book, `GET /cookout/ingredients?mode=`, `PickSnap.kind`, `build`), `docs/ai/invariants.md` (extend
**Inv 57**: the game mode is fixed per round and public; pools and kinds are server-side; Blind hides the
bread like any pick; mode text is server constant), `docs/ai/glossary.md` (game mode, pick kind, bread,
filling, build), `docs/ai/testing.md`, the `CLAUDE.md` store table (schema v22 adds
`cookout_rounds.mode`), `docs/ai/runbook.md` (the `WIXY_COOKOUT_MODES` setting, the activation
sequence and `activate_modes.py`, and "run `activate_modes.py --check-rollback <commit>` before any
Wixy rollback; never roll back to v21 while non-Classic rounds exist"), `docs/ai/contracts.md` also
`503 game_unavailable` for a switched-off mode, and `decisions/<max+1>-server-chat-cookout-modes/`
(this file's decisions, including the family facet, the cap of two, the activation barrier with the
review's reproduction, and why dish words and bread names are not fatal checks). Every commit carries
`Release-note: General bug fixes and improvements.` (rule R14a: a Server-chat trailer never names the
feature).

---

## 10. Challenges to the orchestrator rulings

None of the six rulings is clearly wrong; all are implemented as given. Two notes where the ruling's
wording needed a decision it did not state:

- **"Enough breads that skips never run dry" needs a change to the draw, not just more breads.** Every
  bread is in one bank category, so the core's "two different categories" rule would make every bread
  pair impossible however long the list. §2.3's `family` facet is the fix; it equally serves cheese and
  future single-category kinds (a pizza base).
- **"Disallowed twists hidden on the start sheet"** is built (the mode's `twists` list), but no twist
  needed hiding for Toasted sandwich: each works with a small adjustment (§4). Hiding fridge raid or the
  chaos shelf entirely would have removed fun the adjustments keep.

---

## Appendix A. Parcels, order and frozen interfaces

Every commit: `Release-note: General bug fixes and improvements.` PRs target `cmd/workspace-00058`.
Tooling files are fully typed and each parcel runs `mypy --strict` on its own tooling files.

| Parcel | Builder | Owns exclusively |
|---|---|---|
| **M1 — Mode data, pools and draw** | Sonnet 5.5 | `wixy_server/livechat/cookout_modes.json`, `wixy_server/livechat/cookout_modes.py`, `tooling/cookout/validate_modes.py`, the additive `candidates`/`facet` arguments in `wixy_server/livechat/cookout_bank.py`, `wixy_server/tests/test_cookout_modes.py`, the additions to `wixy_server/tests/test_cookout_bank.py` |
| **M2 — Server, v22 migration and wire** | Sonnet 5.5 | `wixy_server/livechat/store.py`, `wixy_server/livechat/models.py`, `wixy_server/livechat/cookout_game.py`, `wixy_server/routes_livechat_cookout.py`, the `cookout_enabled_modes` field in `wixy_server/settings.py`, `tooling/cookout/activate_modes.py`, `wixy_server/tests/test_livechat_cookout_modes.py`, `wixy_server/tests/test_cookout_modes_overlap.py`, `wixy_server/tests/fixtures/livechat_v21.db`, the mode-related edits to the existing Cookout server tests |
| **M3 — Chef prompts, validation and pictures** | Sonnet 5.5 | `wixy_server/livechat/cookout_ai.py`, `wixy_server/livechat/cookout_images.py`, `wixy_server/tests/fake_cmd.py`, `wixy_server/tests/test_livechat_cookout_ai.py`, `wixy_server/tests/test_livechat_cookout_images.py`, the `--mode` extension of `tooling/cookout/chef_trial.py`, `tooling/cookout/mode_tiles.py`, `admin-ui/data/cookout-mode-{classic,toastie}.webp`, `triad/cookout/modes/toastie-trial.md` |
| **M4 — UI** | **Opus 5.5** | `admin-ui/src/server/cookout/**`, the Cookout rules in `admin-ui/src/server/chat.css`, the tile copy lines in `admin-ui/esbuild.config.mjs`, `admin-ui/tests/cookout/**`, the rebuilt `wixy_server/static/admin/` bundle |
| **M5 — Docs and e2e** | Sonnet 5.5 | everything in §9, `e2e/tests/server-cookout-toastie.spec.ts`, the e2e fixture additions |

### A.0 Order (ownership conflicts with round-2 work in flight)

- **The chef-fix parcel** (`triad/cookout/briefs/r2-chef-fix.md`) owns `cookout_ai.py`,
  `cookout_bank.py` and `cookout_ingredients.json` (plus `fake_cmd.py` and the bank/AI tests) and is
  changing the lexical scan and repair loop this file builds on. **M1 and M3 start only after it has
  merged**, rebased on its result. M1 does not edit `cookout_ingredients.json` at all.
- **The round-2 UI parcel** (09b parcel 4) owns `admin-ui/src/server/cookout/**`, the Cookout CSS and
  the bundle; **M4 starts only after it has merged**, building on its picture-first screens.
- **The round-2 server parcel** (09b parcel 3) edits `_snap_json` in `cookout_game.py` and the enrichment
  calls in the routes; **M2 starts only after it has merged**.
- Then: M1 first (its interface is frozen below, so M2 and M3 may build against fakes in parallel and
  merge after M1); M3 lands the two tile pictures in an early small PR so M4's build step has them; M4
  builds against JSON fixtures of §5.4 in parallel with M2; M5 writes docs as parcels land and the e2e
  after M2–M4 merge. The trial of §8.4 must meet its bar before M3's final PR.
- **Activation is a separate, last step, not a merge.** Everything merges and deploys with
  `WIXY_COOKOUT_MODES` absent (Classic only in production). Only after the deploy has completed does
  the delivery coordinator run `activate_modes.py --enable toastie` on hub (§5.6) and confirm the
  options list Toasted sandwich. The operator's first Toasted sandwich game happens after that.

### A.1 Frozen Python interface — M1 (`cookout_modes.py`)

```python
FacetKey = Literal["category", "family"]
PlanType = Literal["classic", "sequence"]
ChefFormatKey = Literal["classic", "single-dish"]
TwistKey = Literal[
    "swap",
    "vote",
    "style",
    "cooked",
    "wildcard",
    "fridge",
    "challenge",
    "veto",
    "encore",
    "lucky",
    "stars",
    "chaos",
]


@dataclass(frozen=True, slots=True)
class PickKind:
    id: str
    label: str
    prompt: str  # <= 22 chars, completes "Your turn — "
    facet: FacetKey
    chaos: bool
    candidates: tuple[Ingredient, ...]  # resolved against the bank at load, sorted by id


@dataclass(frozen=True, slots=True)
class Build:
    id: str
    label: str
    technique: str  # one of cookout_ai.TECHNIQUES
    prompt_phrase: str
    picture_phrase: str
    uses_oven: bool


@dataclass(frozen=True, slots=True)
class StapleRules:
    free: frozenset[str]
    capped: frozenset[str]
    cap: int


@dataclass(frozen=True, slots=True)
class ChefFormat:
    format: ChefFormatKey
    dish_noun: str | None  # "toasted sandwich"
    anchor_kind: str | None  # "bread": in every idea, never omitted, named
    builds: tuple[Build, ...]
    each_missing_max: int | None  # 2: each idea uses >= F - 2 fillings
    best_missing_max: int | None  # 1
    review_dish_words: tuple[str, ...]  # signals only (§3.4), never a violation
    concept_text: str | None  # §3.2, with {bread} {bread_id} {n} {each} {best} {build_list}
    recipe_text: str | None  # §3.5, with {build_label} {build_phrase}
    style_line: str | None


@dataclass(frozen=True, slots=True)
class PictureStyle:
    format: ChefFormatKey
    template: str | None  # §3.6, with {title} {bread} {build_phrase} {fillings} {presentation}
    default_presentation: str | None


@dataclass(frozen=True, slots=True)
class CookoutMode:
    id: str
    label: str
    emoji: str
    blurb: str
    intro: tuple[str, ...]
    plan_type: PlanType
    turns: int
    picks_per_player: int
    kinds: Mapping[str, PickKind]  # Classic: the four roles, facet "category"
    staples: StapleRules
    chef: ChefFormat
    picture: PictureStyle
    twists: frozenset[TwistKey]
    fridge_kinds: frozenset[str] | None  # None = any kind (Classic)

    @property
    def basket_sizes(self) -> tuple[int, int]: ...  # (turns, turns + 1)
    def kind_of(self, ingredient_id: str) -> str | None: ...  # None = excluded in this mode
    def kind_for_turn(self, role_schedule: Sequence[str], turn: int) -> str: ...
    def build_schedule(
        self,
        rng: random.Random | None = None,
        *,
        starter_kinds: Mapping[int, str] = {},  # turn -> kind of the seed on that turn
    ) -> tuple[str, ...]: ...  # Classic: bank.shuffle_role_schedule (5 roles); sequence: per turn
    def filling_candidates(self) -> tuple[Ingredient, ...]: ...  # every non-anchor kind, for T5


class CookoutModes:
    def mode(self, mode_id: str) -> CookoutMode | None: ...
    @property
    def modes(self) -> tuple[CookoutMode, ...]: ...  # Classic first
    @property
    def default(self) -> CookoutMode: ...  # Classic


class CookoutModesError(ValueError): ...


def load_cookout_modes(bank: CookoutBank, path: Path | None = None) -> CookoutModes: ...
def default_modes() -> CookoutModes: ...
```

`build_schedule` raises `CookoutModesError` for a starter kind the plan cannot seat (the route maps it
to `422 invalid`).

### A.2 Frozen Python interface — M1 (`cookout_bank.py`, additive)

```python
def draw_pair(
    self,
    *,
    role,
    seen_ids,
    picked_families,
    offered_families,
    player_offered_categories,
    rng=None,
    rarity_mode="normal",
    candidates: Sequence[Ingredient] | None = None,
    facet: FacetKey = "category",
) -> tuple[Ingredient, Ingredient]: ...
def draw_replacement(
    self,
    *,
    role,
    keep_id,
    seen_ids,
    picked_families,
    offered_families,
    player_offered_categories,
    rarity_mode="normal",
    rng=None,
    candidates: Sequence[Ingredient] | None = None,
    facet: FacetKey = "category",
) -> Ingredient: ...
def draw_wildcard(
    self,
    *,
    seen_ids,
    picked_families,
    offered_families,
    basket_categories,
    rng=None,
    candidates: Sequence[Ingredient] | None = None,
) -> Ingredient: ...
def search(
    self, query: str, *, limit: int = 20, candidates: Sequence[Ingredient] | None = None
) -> tuple[Ingredient, ...]: ...
```

With `facet="family"`, `player_offered_categories` carries the **families** already shown to the
active player (the caller passes the list that matches the facet). Defaults reproduce today's results
for the same RNG exactly.

### A.3 Frozen wire — M2 ↔ M4

§5.4 is the contract. TypeScript additions in `api.ts`:

```ts
export interface ModeKind { readonly id: string; readonly label: string; readonly prompt: string; }
export interface CookoutModeInfo {
  readonly id: string; readonly label: string; readonly emoji: string;
  readonly turns: number; readonly picksPerPlayer: number;
  readonly kinds: readonly ModeKind[]; readonly anchorKind: string | null;
}
export interface ModeOption extends Omit<CookoutModeInfo, "kinds" | "anchorKind"> {
  readonly blurb: string; readonly intro: readonly string[];
  readonly twists: readonly string[]; readonly fridgeKinds: readonly string[] | null;
}
export interface BuildRef { readonly id: string; readonly label: string; }
// CookoutView.mode: CookoutModeInfo; Concept.build: BuildRef | null; PickSnap.kind: string | null;
// CookoutSummary.mode: string; RecipeBookEntry.mode: {id,label,emoji}; RecipeBookEntry.build: BuildRef | null;
// CookoutOptions.modes: readonly ModeOption[]
```

A view without `mode` (an older server) parses as Classic with `turns = 10`, `picksPerPlayer = 5`.

### A.4 Frozen Python interface — M2 ↔ M3

`get_cookout_round()` adds `"mode": str` and `"bread_id": str | None` (§5.5). M3 resolves the mode with
`default_modes().mode(row["mode"])`. The store's claim and recovery reads never return an unknown mode
(§5.6); if one reaches the runner anyway (a direct call), the job **aborts without writing anything**
— it must never fail, finish or claim a row of a mode this process does not know. It calls:

```python
def build_concepts_prompt(
    basket: Mapping[str, Any], *, mode: CookoutMode, forbidden_names: Sequence[str] = ()
) -> str: ...
def parse_concepts(
    response_text: str,
    *,
    bank: AiBank,
    picked_ids: Sequence[str],
    mode: CookoutMode,
    bread_id: str | None = None,
    twists: ConceptTwists = ConceptTwists(),
) -> Parsed: ...
def build_recipe_prompt(
    concept: Mapping[str, Any],
    manifest: Mapping[str, Any],
    *,
    mode: CookoutMode,
    twists: RecipeTwists = RecipeTwists(),
) -> str: ...
def parse_recipe(
    response_text: str,
    *,
    bank: AiBank,
    concept: Mapping[str, Any],
    mode: CookoutMode,
    twists: RecipeTwists = RecipeTwists(),
) -> Parsed: ...
def build_image_prompt(
    title: str,
    ingredient_names: Sequence[str],
    *,
    style: str | None = None,
    mode: CookoutMode | None = None,
    bread_name: str | None = None,
    build: Build | None = None,
) -> str: ...
```

Stored concept JSON gains `"build": str` (Toasted sandwich only); M2's view reads it and resolves the
label from the mode. `Parsed` gains `signals: tuple[str, ...] = ()` (non-fatal dish-word notes,
§3.4); it never affects acceptance or the repair loop. The AI functions take `mode` without a default
on purpose, so every call site
states it; Classic call sites pass `default_modes().default` and produce exactly today's output.

### A.5 Acceptance (the work is done when all hold)

1. All §8 tests green; Classic golden tests prove byte-identical behaviour; the migration test passes
   from the real v21 fixture.
2. The §8.4 trial meets its bars, report committed.
3. The e2e plays a full two-player Toasted sandwich round at 360×640 with no scrolling during picking.
4. Deployed with the setting absent; then `activate_modes.py --enable toastie` run by the delivery
   coordinator on hub after the deploy completed, every check printed as passed, and the options list
   Toasted sandwich.
5. The operator's first Toasted sandwich game on production: bread first, seven fillings, three
   toasted sandwich pictures, a banked recipe.
