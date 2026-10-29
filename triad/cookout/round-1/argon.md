# Cookout — Triad Round 1 Proposal (`argon` seat)

**Author:** `argon` (Gemini 4 Argon High)  
**Target spec:** `spec/server-chat/09-cookout.md`  
**Status:** Round 1 independent proposal  

---

# Section A — Core Game Design (`spec/server-chat/09-cookout.md`)

# 09 — Cookout (Two-Player Ingredient Draft & AI Chef Game)

**Status:** proposed (Triad Round 1 — `argon`)  
**Parent:** [`00-overview.md`](00-overview.md) · Sibling games: [`03-would-you-rather.md`](03-would-you-rather.md), [`08-adventure-time.md`](08-adventure-time.md)  
**Touches:** `wixy_server/livechat/{store.py, models.py, cookout_bank.py, cookout_ingredients.json, cookout_game.py, cookout_chef.py, cookout_images.py, wyr_images.py}`, `wixy_server/routes_livechat_cookout.py`, `wixy_server/app.py`, `admin-ui/src/server/{gameTabs.ts, itemChat.ts, thread.ts, api.ts, types.ts}`, `admin-ui/src/server/cookout/{cookoutPane.ts, cookoutCard.ts, recipeBook.ts}`, `admin-ui/src/styles/livechat.css`, `docs/ai/{livechat.md, invariants.md}`

---

## 0. The ask

> *"Develop a game in this app like Adventure Time, which is another game where we call it Cookout and we have a bank of a few thousand different ingredients — everything from parsley to beef to all sorts of different spices to cream — and then it will take turns with each person in the chat and it will give a choice between two ingredients so it will present me with two ingredients and I'll pick one and then it will present the other person with two ingredients they'll pick one and we'll both see what the other person is presented with and what they've picked as well. There should be a blind mode where you can't see what the other person is picking. And it will do that until we've picked five ingredients each and then when we've got the ten ingredients an AI will then try and concoct three different recipe concepts using those ingredients and it must use most of them and really try to use all of them, and then only use staples if it needs to and we'll have a staples list: it shouldn't just throw in mango because it wasn't picked, it should be things like salt, pepper, butter, flour — those sorts of things. And then it will come up with these three concepts, generate a picture of what the cooked meal looks like, a title and description, and you can ask it to bank it if you want and it'll generate a recipe for it and instructions, and then bank it. Doesn't generate the full recipe initially — just the concept, description and picture. And when you're getting presented with the two options, you'll have the two options: if you say no, neither of those two options, and you'll get two options, two new options. And you can do that up to two times. So essentially, you're going to have three goes before you have to pick from one or the other."*

Five things to get right:

1. **A curated, balanced ingredient bank + explicit staples contract.** A static, offline JSON bank (`wixy_server/livechat/cookout_ingredients.json`) of ~2,600 everyday-to-exotic ingredients across 14 culinary categories — from flat-leaf parsley, ribeye beef, smoked paprika, and double cream to everyday wildcard items like white toast, brown sugar, tinned baked beans, marmite, marshmallows, and instant ramen — paired with an explicit **16-item Staples List** (salt, black pepper, butter, olive oil, vegetable oil, plain flour, white sugar, water, milk, eggs, garlic, onion, lemon, vinegar, stock/bouillon, soy sauce) that the AI chef may use freely. Any non-picked, non-staple ingredient (e.g. mango) is strictly forbidden.
2. **Alternating 10-turn draft with "neither of those" skips and server-redacted Blind Mode.** Ten turns total (`0..9`, 5 picks per player, alternating Player 1 and Player 2). On each turn, the server deals 2 contrasting ingredients. The active player may either pick one **or** press **"Neither — deal two more"** up to **2 times per turn** (giving 3 pairs total before the button disables and they must choose one of the 3rd pair). In **Open Mode** (`blind = false`), both players watch the live options, skips, and picks in real time. In **Blind Mode** (`blind = true`), `cookout_view_json` redacts the other player's offered pair, skip count, and picked ingredients on the server while `state == 'picking'`, dropping the curtain the instant the 10th ingredient is picked.
3. **Two-stage AI chef + local ComfyUI food photography.**
   - **Stage 1 (Automatic on 10th pick):** One `cmdchat.py` chat-spawn run (`caller: "wixy-cookout-concepts"`) takes **only** the 10 picked ingredients and the 16 allowed staples, and returns **3 distinct recipe concepts** — each with a `title`, an appetizing 2–3 sentence `pitch` (description), a culinary `vibe` tag, `usedPickedIds` (must use ≥ 7 of the 10 picked ingredients and across the trio aim for all 10), `staplesUsed`, and a visual `imagePrompt`. **No full recipe or method is generated yet.** Immediately after concepts validate, Hub's local ComfyUI (`127.0.0.1:8190`, `krea2-turbo-nvfp4`) renders **3 plated-dish photos** in a single batched `/prompt` graph under the shared `wyr_image_limiter`, scrubbing ComfyUI `/history` and output disk per Invariant 54 and attaching them as private anchor-message attachments (`ordinal` 0, 1, 2).
   - **Stage 2 (On demand when "Bank this" is tapped):** Tapping **Bank this** on concept `0`, `1`, or `2` immediately banks that dish into the shared **Recipe Book** and spawns a second `cmdchat.py` run (`caller: "wixy-cookout-recipe"`) to write the full structured recipe (prep/cook time, servings, ingredients with exact quantities split into *Picked* vs. *Pantry Staples*, numbered method steps, and a chef's tip).
4. **Shared single-game frame & mini chat.** Cookout registers as `"cookout"` in `gameTabs.ts` (`GameKey = "wyr" | "adventure" | "cookout"`). Because `GameTabs` enforces `replaceOthers` (one game open at a time in the second tab), opening or starting Cookout automatically replaces Would-You-Rather or Adventure Time in the second tab, reuses the shared 60px `itemChat.ts` mini chat strip (`wyr_ref_kind = "cookout"`), and adds a browsable **Recipe book** modal alongside the Holiday bank.
5. **Standalone-edition grace (`spec/independence/02 §6`).** Drafting 10 ingredients, skipping, Blind Mode, and banking a dish work with zero AI dependencies. When `WIXY_CMD_URL` is unset or unreachable, `concepts_state` / `recipe_state` settle to `'unavailable'` with a clean note, and `images_state` settles to `'done'` (`pictures: {}`) if ComfyUI is unconfigured.

---

## 1. Flow and state machine

### 1.1 Entry points

In the chat Composer's `⋯` overflow menu (`admin-ui/src/server/thread.ts`, next to **Would you rather**, **Adventure Time**, and **Holiday bank**), add two entries:

- **Cookout** (chef-hat / flame SVG icon + label `"Cookout"`).
  - If an active Cookout round exists on the loaded thread (`state` in `'picking' | 'concocting'`), tapping **Cookout** switches to the `Cookout` tab for that round without creating a new message.
  - Otherwise, tapping **Cookout** posts `POST /api/admin/server/cookout` `{sender, blind}` (using the sticky `defaultBlind` preference from `cookout_settings`), creating a new anchor message (`body = ""`) and a `cookout_rounds` row in `state = 'picking'`, and switches to the `Cookout` tab.
- **Recipe book** (open recipe-book SVG icon + label `"Recipe book"`). Opens the shared Recipe Book modal (`recipeBook.ts`) listing every banked Cookout dish, newest first.

Every Cookout anchor message renders a compact status card in the main `Chat` stream (`cookoutCard.ts`, §4.5) with an **Open kitchen →** button (and a **View recipe →** shortcut once banked) that focuses the `Cookout` tab for that `anchor_message_seq`.

### 1.2 Round lifecycle and states

Each Cookout round is keyed by `anchor_message_seq` (`PRIMARY KEY REFERENCES messages(seq) ON DELETE CASCADE`) and progresses monotonically through:

```text
picking (turns 0..9) ──[10th pick]──► concocting ──[concepts ready/failed/unavailable]──► ready
       │
       └──[new round started while still picking]──► abandoned
```

Alongside the primary `state` (`'picking' | 'concocting' | 'ready' | 'abandoned'`), a round tracks asynchronous work on three independent axes:

| Column / field | Values | Transitions |
|---|---|---|
| `state` | `'picking' \| 'concocting' \| 'ready' \| 'abandoned'` | Starts in `'picking'`. On the 10th pick (`turn_index == 9`), transitions to `'concocting'`. As soon as the Stage-1 concept job finishes (`concepts_state` becomes `'ready'`, `'failed'`, or `'unavailable'`), `state` becomes `'ready'`. Starting a new round abandons any earlier round still in `'picking'`. |
| `concepts_state` | `'none' \| 'pending' \| 'ready' \| 'failed' \| 'unavailable'` | `'none'` during `'picking'`. Set to `'pending'` inside the transaction that records the 10th pick (or `'unavailable'` immediately if `cmdchat` is unconfigured). Transitions to `'ready'` when 3 valid concepts are stored, or `'failed'` on timeout/parse failure. |
| `images_state` | `'none' \| 'pending' \| 'done' \| 'failed'` | `'none'` until `concepts_state == 'ready'`. Set to `'pending'` when `concepts_state` becomes `'ready'` (or `'done'` immediately if ComfyUI is disabled). Transitions to `'done'` once all 3 dish attachments are created, or `'failed'` if ComfyUI fails. |
| `concept[i].banked` | `boolean` (per concept `i ∈ {0, 1, 2}`) | Starts `false`. Set to `true` when either player taps **Bank this** on concept `i`. Multiple concepts from the same round may be banked independently. |
| `concept[i].recipeState` | `'none' \| 'pending' \| 'ready' \| 'failed' \| 'unavailable'` | Starts `'none'`. When concept `i` is banked, transitions to `'pending'` (or `'unavailable'` if `cmdchat` is unconfigured), then `'ready'` when the full recipe JSON arrives or `'failed'` on error. |

### 1.3 Player slots, turn order, and skip budget ("3 goes per turn")

A round has `PICKS_PER_PLAYER = 5` (`TOTAL_TURNS = 10`, `turn_index` `0..9`) and `MAX_SKIPS_PER_TURN = 2`.

- **Player 1 (`slot = 1`)** is bound at round creation (`POST /cookout`): `player1_key = reactor_key(sender)`, `player1_name = sender`, `player1_email = request_email(request)`.
- **Player 2 (`slot = 2`)** starts unbound (`NULL`) and is claimed automatically on the first action (`pick` or `skip`) by a viewer whose slot is not `1` (matched via `_slot_of(round_, viewer_key, viewer_email)` using the exact same sign-in email + display-name key rules as `wyr_game.py:86-114`).
- **Turn assignment:**
  - Even turns (`turn_index ∈ {0, 2, 4, 6, 8}`) belong to **Player 1** (picks 1–5 of Player 1).
  - Odd turns (`turn_index ∈ {1, 3, 5, 7, 9}`) belong to **Player 2** (picks 1–5 of Player 2).
- **Who can act on a turn:**
  - In **Blind Mode (`blind = true`)**, turn ownership is **strictly enforced by slot**: only Player 1 may pick or skip on even turns, and only Player 2 (or an unclaimed second player on Turn 1) may pick or skip on odd turns. If Player 1 requests a pick/skip on an odd turn (or vice versa), the server returns `409 Conflict` (`code: "not_your_turn"`). Furthermore, as explained in §1.4, the non-active player cannot even see the active turn's offered pair in `GET /cookout/{seq}`.
  - In **Open Mode (`blind = false`)**, the UI highlights whose turn it is (`"Your turn — Pick 2 of 5"` vs. `"Waiting for {partner} — Pick 2 of 5"`), and binds Player 2 when the second person acts on an odd turn. If both people are sitting on the couch looking at one phone in Open Mode, an optional `"Pass phone / tap for partner"` action is only blocked in Blind Mode; however, keeping slot enforcement consistent when two distinct devices are signed in prevents accidental double-taps across the network. Specifically: if `viewer_slot == active_slot` (or `active_slot == 2` and `player2` is not yet bound and `viewer_slot != 1`), the move is always allowed; in Open Mode (`blind = false`), if `player2` is still unbound on Turn 1 and the same device taps with a distinct `sender` name, it binds `player2_key`.
- **Skip budget ("up to two times — three goes before you have to pick"):**
  - When a turn begins, `current_skip_count = 0` and `current_pair_json = [ingA, ingB]` (Deal #1 of 3).
  - If the active player taps **"Neither — new pair (2 left)"** (`POST /cookout/{seq}/skip` `{sender, turnIndex, skipIndex: 0}`), both `ingA` and `ingB` are appended to the round's `skipped_ids` history, `current_skip_count` becomes `1`, and the server draws two fresh ingredients `[ingC, ingD]` (Deal #2 of 3).
  - If they tap **"Neither — last redraw (1 left)"** (`skipIndex: 1`), `ingC` and `ingD` are appended to `skipped_ids`, `current_skip_count` becomes `2`, and the server draws `[ingE, ingF]` (Deal #3 of 3).
  - When `current_skip_count == 2`, the skip button is disabled (`"Last pair — you must pick one"`) and any further `POST /skip` on that turn returns `409 Conflict` (`code: "skip_limit_reached"`).
  - When the active player picks one of the two currently offered ingredients (`POST /cookout/{seq}/pick` `{sender, turnIndex, ingredientId}`), the picked ingredient is appended to `picks_json` (recording `{turnIndex, slot, pickedBy, ingredient, skippedPairs, pickedAt}`), the unpicked mate from the final pair is added to `drawn_ids_json` so it cannot reappear later in the round, and:
    - If `turn_index < 9`: `turn_index` increments by 1, `current_skip_count` resets to `0`, and `current_pair_json` is populated with 2 fresh ingredients for the next turn.
    - If `turn_index == 9` (the 10th pick): `current_pair_json` becomes `null`, `state` transitions to `'concocting'`, `concepts_state` transitions to `'pending'`, and the server schedules the Stage-1 AI Chef job.

### 1.4 Blind Mode vs. Open Mode (server-enforced privacy)

Blind Mode is a per-round boolean (`cookout_rounds.blind`, `0` or `1`), initialized from `cookout_settings.default_blind` at round start and toggleable via `POST /cookout/{seq}/mode` `{sender, blind}` **only while `state == 'picking'` and `turn_index == 0` and `current_skip_count == 0`** (before the very first pick or skip is made) or stored as the sticky default for future rounds via `PUT /cookout/settings`.

- **When `blind == false` (Open Mode):**
  - Both players see the active `currentPair` (the two ingredient cards on the table), the live skip counter (`"Go 2 of 3"`), the skipped ingredients from earlier in the turn, and all picked ingredients in the 10-slot Basket tray (`picks[0..9]`).
- **When `blind == true` (Blind Mode) and `state == 'picking'`:**
  - `cookout_view_json(round_, viewer_key=..., viewer_email=...)` inspects `viewer_slot = _slot_of(round_, viewer_key, viewer_email)`:
    1. **Basket picks (`picks` array):** Any pick made by `viewer_slot` is returned in full (`{turnIndex, slot, pickedBy, hidden: false, ingredient: {...}, skippedCount}`). Any pick made by the *other* slot (or any pick when `viewer_slot is None`) is redacted on the wire to `{turnIndex, slot, pickedBy, hidden: true, ingredient: null, skippedCount: null}`! The UI renders a mystery cloche / covered plate icon (`"🔒 Secret pick #1"`) in the partner's basket column.
    2. **Current active turn (`currentTurn` object):** If `active_slot == viewer_slot` (or `active_slot == 2`, `player2` is still unbound, and `viewer_slot != 1`), `currentTurn.offered` contains the two ingredient objects `[optionA, optionB]` and `currentTurn.canAct = true`. Otherwise (`active_slot != viewer_slot`), `currentTurn.offered` is `null`, `currentTurn.hidden = true`, and `currentTurn.canAct = false` — the waiting player sees `"🕵️ {Partner} is secretly choosing Pick #2 (Go {k} of 3)..."` and cannot inspect the network tab to peek at their options.
- **The Big Reveal (`state` transitions to `'concocting'` or `'ready'`):**
  - The moment the 10th ingredient is picked (`state != 'picking'`), `cookout_view_json` stops redacting `picks`: all 10 ingredients (5 Player 1, 5 Player 2) are returned with `hidden: false` to both players. While the AI chef is concocting the 3 dishes (~10–20s), both players get to laugh at the full 10-ingredient combination they secretly assembled together!

### 1.5 Concurrency, idempotence, and abandonment

- **Single writer lock:** All mutations run inside `store._write_txn()` (`BEGIN IMMEDIATE`), incrementing `cookout_rounds.rev` and emitting a single `livechat` SSE `message` event for `anchor_message_seq` so both tabs re-render immediately.
- **Idempotent retries:**
  - Re-POSTing `POST /cookout/{seq}/pick` with `{turnIndex, ingredientId}` when `turnIndex < round.turn_index` (or `state != 'picking'`) **and** `picks[turnIndex].ingredient.id == ingredientId` returns `200 OK` with the current `cookout_view_json` (no-op). If a different `ingredientId` is submitted for an already-completed `turnIndex`, or `turnIndex > round.turn_index`, the server returns `409 Conflict` (`code: "bad_state"`).
  - Re-POSTing `POST /cookout/{seq}/skip` with `{turnIndex, skipIndex}` when `turnIndex == round.turn_index` and `skipIndex + 1 == round.current_skip_count` returns `200 OK` with the current view (idempotent retry of the same skip).
  - Re-POSTing `POST /cookout/{seq}/bank` with `{conceptIndex}` when `concepts[conceptIndex].banked == true` and `recipeState in ('pending', 'ready')` returns `200 OK` with the current view without spawning a duplicate recipe run.
- **Abandonment:** `POST /cookout` marks any earlier `cookout_rounds` row still in `state = 'picking'` as `state = 'abandoned'` (bumping its `rev` and emitting an update event). Rounds in `'concocting'` or `'ready'` are **never** abandoned by starting a new round.
- **Deletion & Wipe:** Deleting the anchor message cascades to `cookout_rounds` (`ON DELETE CASCADE`) and cancels any in-flight `concepts_run_id` or `recipe_run_ids` via `CmdChatClient.cancel_run`. `store.wipe()` drops all `cookout_rounds` rows, cancels in-flight runs, and leaves `cookout_settings` (the sticky `default_blind` toggle) untouched (paralleling `adv_settings` in Invariant 56).

---

## 2. The ingredient bank and staples (`cookout_bank.py` & `cookout_ingredients.json`)

### 2.1 Asset location, size, and categories

- **File:** `wixy_server/livechat/cookout_ingredients.json` (committed static JSON asset, loaded once and cached in memory by `wixy_server/livechat/cookout_bank.py` using the same module-level singleton pattern as `adventure_bank.py` and `wyr_questions.py`).
- **Size:** **2,500 to 3,000 distinct pickable ingredients** (target: ~2,600), validated by unit tests in `wixy_server/tests/test_cookout_bank.py` (`assert 2400 <= len(bank.ingredients) <= 3500`).
- **14 culinary categories** (with sampling weights so everyday building blocks and fun curveballs appear in a satisfying kitchen ratio):

| Category ID | Label | UI Badge Icon | Target Count | Draw Weight | Examples |
|---|---|---|---:|---:|---|
| `meat_poultry` | Meat & Poultry | 🥩 | ~220 | 1.15 | Ribeye steak, pork belly, duck breast, lamb shoulder, chicken thighs, venison sausage, crispy bacon, smoked pancetta, black pudding, chorizo |
| `fish_seafood` | Fish & Seafood | 🐟 | ~180 | 1.00 | Atlantic salmon, king prawns, sea bass, scallops, tinned sardines, smoked haddock, squid rings, crab meat, mussels, anchovy fillets |
| `vegetables` | Vegetables & Greens | 🥦 | ~320 | 1.30 | Tenderstem broccoli, charred courgette, sweet potato, baby spinach, fennel bulb, heritage tomatoes, roasted red peppers, butternut squash, asparagus, globe artichoke |
| `mushrooms_truffles` | Mushrooms & Fungi | 🍄 | ~70 | 0.65 | Chestnut mushrooms, wild chanterelles, king oyster mushrooms, dried porcini, shiitake, enoki, black truffle paste |
| `fruits_berries` | Fruits & Citrus | 🍋 | ~220 | 0.90 | Alphonso mango, pomegranate seeds, Granny Smith apple, blood orange, fresh figs, plantain, caramelized pineapple, blackberries, passionfruit, rhubarb |
| `dairy_cheeses` | Dairy, Cream & Cheese | 🧀 | ~220 | 1.10 | Double cream, burrata, aged Gruyère, halloumi, Cornish clotted cream, mascarpone, Roquefort, feta, crème fraîche, buttermilk, smoked Applewood |
| `grains_bread_pasta` | Bread, Pasta & Grains | 🍞 | ~240 | 1.15 | Thick-cut white toast, sourdough crumpets, fresh pappardelle, arborio risotto rice, udon noodles, instant ramen noodles, polenta, brioche bun, gnocchi, puff pastry |
| `legumes_nuts_seeds` | Beans, Nuts & Seeds | 🥜 | ~180 | 0.85 | Tinned baked beans, toasted pine nuts, chickpeas, black beluga lentils, pistachio kernels, tahini, crunchy peanut butter, edamame, walnuts, chestnut purée |
| `herbs_aromatics` | Fresh Herbs & Aromatics | 🌿 | ~140 | 0.95 | Flat-leaf parsley, fresh coriander, Thai basil, rosemary sprigs, lemongrass, fresh ginger root, shallots, spring onions, kaffir lime leaves, chives |
| `spices_seasonings` | Spices & Chilis | 🌶️ | ~220 | 0.95 | Smoked paprika, Kashmiri chili, chipotle in adobo, saffron threads, toasted cumin, star anise, sumac, Sichuan peppercorns, garam masala, Aleppo pepper |
| `condiments_sauces` | Condiments, Pickles & Pastes | 🫙 | ~220 | 0.95 | White miso paste, Marmite, Dijon mustard, capers, gochujang, harissa rose paste, balsamic glaze, sun-dried tomatoes, kimchi, mango chutney, Worcester sauce |
| `baking_sweet` | Sweet, Sugar & Bakery | 🍯 | ~180 | 0.75 | Dark muscovado brown sugar, heather honey, pure maple syrup, 70% dark chocolate, toasted marshmallows, digestive biscuits, salted caramel, vanilla bean paste |
| `cured_fermented` | Deli, Cured & Fermented | 🫒 | ~110 | 0.70 | Nduja, prosciutto crudo, Gordal olives, preserved lemons, sauerkraut, smoked tofu, tempeh, halloumi fries |
| `drinks_infusions` | Splash, Brews & Booze | ☕ | ~80 | 0.55 | Double espresso shot, dry cider, stout beer, coconut milk, elderflower cordial, Earl Grey tea, Mirin, crisp dry white wine, bourbon splash |

### 2.2 JSON schema of `cookout_ingredients.json`

```json
{
  "version": 1,
  "generated": "2026-10-28",
  "staples": [
    {
      "id": "salt",
      "name": "Sea salt",
      "note": "Seasoning to taste"
    },
    {
      "id": "black-pepper",
      "name": "Cracked black pepper",
      "note": "Seasoning to taste"
    }
  ],
  "categories": {
    "meat_poultry": { "label": "Meat & Poultry", "emoji": "🥩", "weight": 1.15 }
  },
  "ingredients": [
    {
      "id": "flat-leaf-parsley",
      "name": "Flat-leaf parsley",
      "category": "herbs_aromatics",
      "tier": "common",
      "blurb": "Bright, peppery fresh green herb"
    },
    {
      "id": "thick-white-toast",
      "name": "Thick-cut white toast",
      "category": "grains_bread_pasta",
      "tier": "everyday",
      "blurb": "Crisp golden slices ready for topping, soaking, or crumbing"
    }
  ]
}
```

Every ingredient entry has:
- `id`: kebab-case ASCII slug (`^[a-z0-9]+(-[a-z0-9]+)*$`), unique across both `ingredients` and `staples`.
- `name`: human-readable display name (2–40 chars, e.g. `"Ribeye steak"`, `"Flat-leaf parsley"`, `"Dark brown sugar"`).
- `category`: one of the 14 category IDs above.
- `tier`: `"common"` (weight `1.0` — familiar kitchen favourites), `"everyday"` (weight `0.85` — pantry/toast/comfort items), or `"curious"` (weight `0.55` — fun, expressive or gourmet curveballs so a pair never feels overwhelmingly obscure).
- `blurb`: short 3–8 word culinary hint displayed under the ingredient name on the choice card so neither player ever has to google an unfamiliar spice or cheese!

### 2.3 The Staples List contract

The `staples` array in `cookout_ingredients.json` defines the **exact 16 kitchen staples** that the AI chef is permitted to use freely without them being picked:

1. `salt` — Sea salt / table salt
2. `black-pepper` — Black pepper
3. `butter` — Unsalted / salted butter
4. `olive-oil` — Olive oil
5. `vegetable-oil` — Neutral cooking oil (vegetable / sunflower / rapeseed)
6. `plain-flour` — Plain / all-purpose flour (and cornflour for thickening)
7. `white-sugar` — A pinch of white caster/granulated sugar (note: characterful sugars like *dark muscovado brown sugar*, *maple syrup*, or *honey* live in the pickable bank!)
8. `water` — Water / ice
9. `milk` — Splash of milk
10. `eggs` — Hen's eggs (for binding, glazing, or poaching)
11. `garlic` — Garlic cloves
12. `onion` — Yellow or red onion
13. `lemon` — Lemon juice / zest
14. `vinegar` — Simple white wine / cider vinegar
15. `stock` — Chicken or vegetable stock cube / bouillon
16. `soy-sauce` — Light soy sauce

**Separation rule:** No item in `staples` appears in the pickable `ingredients` array (so a player is never wasted a turn picking "Salt vs. Water"), while rich/distinctive cousins (e.g. *double cream*, *smoked garlic*, *preserved lemons*, *white miso*, *dark brown sugar*, *duck eggs*, *brioche toast*) are pickable ingredients.

### 2.4 Server-authoritative pair draw algorithm (`cookout_bank.py`)

Clients never submit or influence candidate ingredients. Whenever a turn starts or a player skips, `draw_ingredient_pair(bank, *, excluded_ids, picked_categories, rng)` selects `[option_a, option_b]` using stratified sampling:

1. **Hard round exclusion:** Exclude every `id` in `round.drawn_ids_json` (which accumulates every ingredient ever dealt in `current_pair_json`, every skipped ingredient, and every picked ingredient in the current round) plus `recent_picked_ids` from the last 3 completed rounds (soft-dropped if the bank ever had fewer items, though with ~2,600 items it never exhausts).
2. **Soft category cap per round:** Count how many already-picked ingredients in `round.picks_json` belong to each category. Any category that already has **2 picked ingredients** in the current round has its category draw weight multiplied by `0.15` for the remainder of the round, preventing a 10-ingredient basket from becoming 7 spices and 3 condiments with no substance.
3. **Foundational anchor bias on early turns:** On Turns `0` and `1` (each player's first pick), at least one option in the pair is drawn from the substantive "anchor" categories (`meat_poultry`, `fish_seafood`, `vegetables`, `grains_bread_pasta`, `dairy_cheeses`, `legumes_nuts_seeds`) so every round is guaranteed to have culinary backbone.
4. **Contrasting pair rule:** `option_a` and `option_b` in the same pair are **always drawn from two different categories** (`option_a.category != option_b.category`), and at most one of the two may be `tier == "curious"`. That guarantees the player always has a fun, meaningful choice between two distinct culinary directions (and never gets stuck choosing between two nearly identical obscure chilies on their 3rd go).

---

## 3. The AI recipe jobs and ComfyUI dish pictures

### 3.1 Stage 1: Concocting the 3 Recipe Concepts (`cookout_chef.py`)

When the 10th ingredient is picked (`turn_index == 9`), `routes_livechat_cookout.py` records the pick, transitions `state = 'concocting'` and `concepts_state = 'pending'`, and schedules `generate_round_concepts(app, seq)` on the FastAPI event loop.

- **Runner:** `CmdCookoutChef` in `wixy_server/livechat/cookout_chef.py`, wrapping `CmdChatClient` (`wixy_server/cmdchat.py`), gated by `anyio.CapacityLimiter(2)` and a 2-second spawn gap, matching `CmdAdventureResearcher` (`adventure_pack.py`).
- **Privacy boundary:** The prompt sent to `cmdchat.spawn_run(..., caller="wixy-cookout-concepts")` contains **only**:
  - The 10 picked ingredients (`[{id, name, category, blurb}]`).
  - The 16 allowed staples (`[{id, name}]`).
  - Zero chat messages, zero player names, zero email addresses.
- **Prompt instructions & rules:**
  - Concoct **3 genuinely different recipe concepts** (e.g. Concept 1: a comfort/bistro main or skillet dish; Concept 2: a bold street-food, pasta, grain, or bake; Concept 3: a playful/inventive fusion or restaurant-style plate that creatively bridges the most surprising ingredients).
  - **Strict ingredient rule:**
    - Every concept **must use at least 7 of the 10 picked ingredients** (`MIN_USED_PICKED = 7`), and **at least one concept (and ideally all three) must use 8–10 of the 10 picked ingredients**, weaving even curveball picks (like toast, brown sugar, or espresso) into a cohesive dish (e.g., brown-sugar & espresso glaze, toasted sourdough pangrattato crumb, etc.).
    - The chef may supplement **only** from the 16 allowed staples (`staplesUsed`).
    - The chef **must not** introduce any unpicked ingredient that is not on the staples list (never add mango, bacon, cream, etc. unless it is one of the 10 picked items).
  - **Stage-1 output scope:** Return **only** the concept title, appetizing description (`pitch`), short culinary style tag (`vibe`), which picked ingredient IDs are used (`usedPickedIds`), which staple IDs are used (`staplesUsed`), and a ComfyUI food photography prompt (`imagePrompt`). **Do NOT generate ingredient quantities or cooking steps in Stage 1.**

#### Expected JSON output from Stage 1 (`concepts_json`):

```json
{
  "concepts": [
    {
      "index": 0,
      "title": "Espresso-Glazed Ribeye over Crispy Brioche & Charred Broccoli",
      "vibe": "Steakhouse Bistro",
      "pitch": "Seared ribeye steak basted in a dark brown sugar, espresso, and soy reduction, served atop thick-cut buttered toast that soaks up the savoury pan juices alongside garlic-charred tenderstem broccoli and melted Gruyère.",
      "usedPickedIds": [
        "ribeye-steak",
        "thick-white-toast",
        "dark-brown-sugar",
        "double-espresso",
        "tenderstem-broccoli",
        "aged-gruyere",
        "flat-leaf-parsley",
        "smoked-paprika"
      ],
      "staplesUsed": ["salt", "black-pepper", "butter", "garlic", "soy-sauce"],
      "imagePrompt": "Overhead editorial food photography of sliced medium-rare ribeye steak with glossy dark espresso glaze over thick golden toasted bread, charred tenderstem broccoli, melted gruyere cheese and fresh flat-leaf parsley on a warm ceramic plate, natural window light, shallow depth of field"
    }
  ]
}
```

#### Server-side validation (`sanitise_concepts`):

`sanitise_concepts(raw_text, *, picked_ids, staple_ids)` extracts the JSON object (using the balanced-brace scanner pattern from `adventure_pack.py:_json_objects`) and validates:
1. Exactly 3 concept objects (`index` normalized to `0, 1, 2`).
2. `title` (non-empty string, trimmed to 100 chars), `vibe` (trimmed to 40 chars), `pitch` (non-empty string, 20–500 chars), `imagePrompt` (non-empty string, 20–450 chars).
3. `usedPickedIds`: filtered to valid IDs in the round's 10 `picked_ids` (also matching by case-insensitive ingredient name if the model wrote the name instead of the slug). Must have `len(usedPickedIds) >= 6` (hard floor; prompt demands ≥ 7–10).
4. `staplesUsed`: filtered strictly to valid IDs in `staple_ids`.
5. **CAS store write:** `store.set_cookout_concepts_ready(seq, run_id=run_id, concepts=concepts, images_state='pending')` updates the row **only if** `concepts_state = 'pending' AND concepts_run_id = ?`, transitioning `state = 'ready'`, `concepts_state = 'ready'`, and `images_state = 'pending'`.

### 3.2 Dish Pictures via Local ComfyUI (`cookout_images.py` & `wyr_images.py`)

As soon as `concepts_state` transitions to `'ready'`, the server kicks off `generate_cookout_images(app, seq)` to paint one photo per concept (3 photos total).

- **Extending `ComfyImageGenerator` (`wixy_server/livechat/wyr_images.py`) with `generate_batch`:**
  - Today, `ComfyImageGenerator.generate_pair` builds a single ComfyUI `/prompt` graph (`_pair_workflow`, `wyr_images.py:86-190`) where nodes `"1"` (`UNETLoader` for `krea2-turbo-nvfp4`), `"2"` (`CLIPLoader`), and `"3"` (`VAELoader`) are loaded once and shared across two sampling chains (`10..15` and `20..25`).
  - We add `generate_batch(self, prompts: Sequence[str], out_dir: Path, *, seeds: Sequence[int] | None = None) -> tuple[Path, ...]` (with `generate_pair` delegating to `generate_batch([prompt_a, prompt_b], ...)`). For `N = 3` prompts, `_batch_workflow` wires 3 sampling chains (`10..15`, `20..25`, `30..35`) against the single shared model load (`"1"`, `"2"`, `"3"`) at `768×512`, `steps=8`, `cfg=1.0`, `euler`/`simple`.
  - **Why this matters:** Rendering 3 images in one batched `/prompt` graph takes ~15–25s on Hub's RTX 5060 Ti with zero model-reload overhead, and `_forget_run(prompt_id, entry)` deletes the `/history` entry and all 3 `wyr_<run_tag>_0/1/2` files from `WIXY_COMFY_OUTPUT_DIR` in one atomic cleanup pass!
- **Shared single-flight GPU gate & WYR pool priority:**
  - `generate_cookout_images` acquires the existing `wyr_image_limiter(app.state)` (`CapacityLimiter(1)`) and wraps the call in `with wyr_demand(app.state):` (`WyrDemand.count += 1`) so the background WYR pool pre-generator yields immediately to a live Cookout round.
- **Attachment & Gallery exclusion:**
  - Once `generate_batch` returns the 3 PNG paths on disk, `store.attach_cookout_concept_images(seq, paths)` creates 3 ordinary attachment rows on `anchor_message_seq` (`ordinal` `0, 1, 2`), sets `cookout_rounds.pictures_json = '{"0": "<att0>", "1": "<att1>", "2": "<att2>"}'`, sets `images_state = 'done'`, and bumps `rev`.
  - `finish_attachment` (`store.py:3629`) also bumps `cookout_rounds.rev` whenever an attachment on a Cookout anchor message transitions to `'ready'`, so connected clients immediately swap the shimmering plate placeholder for the rendered dish photo.
  - `list_gallery` (`store.py:3673`) excludes `SELECT anchor_message_seq FROM cookout_rounds` (just like `wyr_rounds` and `adv_rounds`) so generated dish photos stay inside Cookout and the Recipe Book rather than flooding the chat photo gallery.

### 3.3 Stage 2: "Bank this" & Full Recipe Generation (`POST /cookout/{seq}/bank`)

When either player taps **Bank this** on concept `0`, `1`, or `2`:

1. **Immediate banking transaction:**
   - Inside `_write_txn`, `concepts_json[conceptIndex].banked` is set to `true`, `bankedAt` is set to `_iso_now()`, `bankedBy` is set to `sender`, and `recipeState` is set to `'pending'` (or `'unavailable'` if `cmdchat` is not configured).
   - The dish immediately appears in `GET /api/admin/server/cookout/bank` (the Recipe Book).
2. **Background full-recipe generation (`caller: "wixy-cookout-recipe"`):**
   - `generate_concept_recipe(app, seq, concept_index)` spawns a `CmdChatClient.spawn_run` with:
     - The chosen concept's `title`, `vibe`, `pitch`, `usedPickedIds` (resolved to full ingredient names), and `staplesUsed`.
     - The full list of 10 picked ingredients and 16 allowed staples (reiterating the hard constraint: **no unpicked non-staple ingredients**).
   - The AI returns a structured recipe JSON object:

```json
{
  "prepTime": "15 mins",
  "cookTime": "20 mins",
  "serves": 2,
  "difficulty": "Easy",
  "ingredients": [
    {
      "item": "2 thick ribeye steaks (approx. 220g each)",
      "source": "picked",
      "ingredientId": "ribeye-steak"
    },
    {
      "item": "2 slices thick-cut white toast",
      "source": "picked",
      "ingredientId": "thick-white-toast"
    },
    {
      "item": "1 tbsp unsalted butter",
      "source": "staple",
      "ingredientId": "butter"
    }
  ],
  "steps": [
    "Pat the ribeye steaks dry and season generously with sea salt, cracked black pepper, and smoked paprika.",
    "Whisk together the double espresso shot, dark brown sugar, and soy sauce in a small bowl until dissolved.",
    "Sear the steaks in a hot skillet with butter and crushed garlic for 3 minutes per side, then pour in the espresso glaze and baste until glossy.",
    "Toast the thick-cut white bread, top with grated Gruyère under the grill until bubbling, slice the rested steak on top, spoon over the pan juices, and scatter with flat-leaf parsley."
  ],
  "chefNote": "Letting the toast catch the espresso-butter resting juices turns humble white bread into the best part of the plate."
}
```

3. **Validation & CAS storage:**
   - `sanitise_recipe(raw_text, *, picked_ids, staple_ids)` verifies non-empty `prepTime`, `cookTime`, `serves` (`1..8`), `ingredients` (`3..22` items, each tagged `"picked"` or `"staple"`), and `steps` (`3..12` clear method steps).
   - `store.set_cookout_recipe_ready(seq, concept_index=concept_index, run_id=run_id, recipe=recipe)` writes the recipe into `recipes_json[str(concept_index)]`, sets `recipeState = 'ready'`, bumps `rev`, and emits an SSE update so both the Cookout pane and any open Recipe Book modal immediately display the full method and quantities!

### 3.4 Self-healing recovery and manual retry

Following `adventure_pack.py` (Invariant 56):
- Every pending job records `started_at` and `tries` (`concepts_started_at`, `concepts_tries`, `images_started_at`, `images_tries`, and per-concept `recipeStartedAt`, `recipeTries`).
- On server startup (`lifespan` in `app.py`) and lazily on `GET /cookout/{seq}` when a `'pending'` job is not in `_in_flight` and its `started_at` is older than `STALE_AFTER_S = 120`:
  - While `tries < MAX_AUTO_TRIES` (`3`), the server automatically re-schedules the job.
  - Once `tries >= 3`, it settles the state to `'failed'` so the UI shows a **Retry** button (`POST /cookout/{seq}/retry` `{sender, target: "concepts" | "images" | "recipe", conceptIndex?: 0 | 1 | 2}`).

---

## 4. Schema, Wire Contract, Client UI, Recipe Book, Tests & Invariant 57

### 4.1 SQLite Schema (`_SCHEMA_V21_COOKOUT` in `wixy_server/livechat/store.py`)

Bump `_LATEST_SCHEMA_VERSION` from `20` to `21` and add an additive migration block:

```sql
CREATE TABLE IF NOT EXISTS cookout_rounds (
    anchor_message_seq  INTEGER PRIMARY KEY
                        REFERENCES messages(seq) ON DELETE CASCADE,
    rev                 INTEGER NOT NULL DEFAULT 1,
    state               TEXT    NOT NULL DEFAULT 'picking'
                        CHECK (state IN ('picking','concocting','ready','abandoned')),
    blind               INTEGER NOT NULL DEFAULT 0
                        CHECK (blind IN (0, 1)),
    started_by          TEXT    NOT NULL,
    player1_key         TEXT    NOT NULL,
    player1_name        TEXT    NOT NULL,
    player1_email       TEXT,
    player2_key         TEXT,
    player2_name        TEXT,
    player2_email       TEXT,
    turn_index          INTEGER NOT NULL DEFAULT 0
                        CHECK (turn_index BETWEEN 0 AND 10),
    current_skip_count  INTEGER NOT NULL DEFAULT 0
                        CHECK (current_skip_count BETWEEN 0 AND 2),
    current_pair_json   TEXT,
    current_skips_json  TEXT    NOT NULL DEFAULT '[]',
    picks_json          TEXT    NOT NULL DEFAULT '[]',
    drawn_ids_json      TEXT    NOT NULL DEFAULT '[]',
    concepts_state      TEXT    NOT NULL DEFAULT 'none'
                        CHECK (concepts_state IN ('none','pending','ready','failed','unavailable')),
    concepts_json       TEXT,
    concepts_run_id     TEXT,
    concepts_started_at TEXT,
    concepts_tries      INTEGER NOT NULL DEFAULT 0,
    images_state        TEXT    NOT NULL DEFAULT 'none'
                        CHECK (images_state IN ('none','pending','done','failed')),
    pictures_json       TEXT    NOT NULL DEFAULT '{}',
    images_started_at   TEXT,
    images_tries        INTEGER NOT NULL DEFAULT 0,
    recipes_json        TEXT    NOT NULL DEFAULT '{}',
    created_at          TEXT    NOT NULL,
    updated_at          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cookout_rounds_state
    ON cookout_rounds(state, anchor_message_seq DESC);

CREATE TABLE IF NOT EXISTS cookout_settings (
    singleton     INTEGER PRIMARY KEY CHECK (singleton = 1),
    default_blind INTEGER NOT NULL DEFAULT 0 CHECK (default_blind IN (0, 1)),
    updated_at    TEXT    NOT NULL
);
```

And update three existing places in `store.py` / `models.py`:
1. **`list_gallery` (`store.py:3673`):** Add `AND a.message_seq NOT IN (SELECT anchor_message_seq FROM cookout_rounds)` alongside `wyr_rounds` and `adv_rounds`.
2. **`finish_attachment` (`store.py:3629`):** Add `UPDATE cookout_rounds SET rev = rev + 1, updated_at = ? WHERE anchor_message_seq = ?` alongside `adv_rounds`.
3. **`Message.cookout` summary & `wyr_ref_kind` (`models.py`):**
   - Widen `wyr_ref_kind` validation to `("wyr", "adventure", "cookout")` so `itemChat.ts` mini-chat messages can attach to `{"kind": "cookout", "seq": <anchor_seq>}`.
   - Attach a compact `cookout` summary on `message_json` when the message is a Cookout anchor:
     ```json
     {
       "rev": 12,
       "state": "ready",
       "blind": true,
       "turnIndex": 10,
       "pickedCount": 10,
       "player1Name": "Josh",
       "player2Name": "Hannah",
       "conceptsState": "ready",
       "imagesState": "done",
       "conceptTitles": [
         "Espresso-Glazed Ribeye over Crispy Brioche",
         "Smoked Paprika & Gruyère Fonduta Bake",
         "Charred Broccoli & Ribeye Ramen Bowl"
       ],
       "bankedCount": 1
     }
     ```

### 4.2 HTTP Routes (`wixy_server/routes_livechat_cookout.py`)

All routes sit under `/api/admin/server/cookout` and enforce `require_server_token(request)` (Inv 42). Every mutation body uses `ConfigDict(extra="forbid")`.

| Method & Path | Request Body / Query | Response (`200 OK`) | Purpose |
|---|---|---|---|
| `POST /api/admin/server/cookout` | `{"sender": "Josh", "blind"?: bool}` | `CookoutView` | Abandons any `'picking'` round, creates anchor message + `cookout_rounds` row with Turn 0 pair drawn, returns viewer-filtered view. |
| `GET /api/admin/server/cookout/bank` | — | `{"recipes": [BankedRecipeView, ...]}` | Lists all banked concepts across all rounds, newest `bankedAt` first, including dish photo URL, picked ingredients, staples used, and full recipe (`ready`/`pending`/`failed`/`unavailable`). |
| `GET /api/admin/server/cookout/settings` | — | `{"defaultBlind": bool}` | Returns sticky game settings. |
| `PUT /api/admin/server/cookout/settings` | `{"defaultBlind": bool}` | `{"defaultBlind": bool}` | Updates sticky `default_blind` preference. |
| `GET /api/admin/server/cookout/{seq}?as=<sender>` | Query `as` (viewer display name) | `CookoutView` | Returns the viewer-filtered round view (enforcing Blind Mode redaction while `state == 'picking'`). Triggers lazy self-healing if a pending job is stale. |
| `POST /api/admin/server/cookout/{seq}/mode` | `{"sender": "Josh", "blind": bool}` | `CookoutView` | Toggles `blind` on the current round before any pick/skip has occurred (`turn_index == 0 and current_skip_count == 0`), and updates `default_blind`. |
| `POST /api/admin/server/cookout/{seq}/pick` | `{"sender": "Josh", "turnIndex": 0, "ingredientId": "ribeye-steak"}` | `CookoutView` | Picks one of the 2 active options for `turnIndex`. On `turnIndex == 9`, transitions to `'concocting'` and launches Stage 1 AI + image jobs. |
| `POST /api/admin/server/cookout/{seq}/skip` | `{"sender": "Josh", "turnIndex": 0, "skipIndex": 0}` | `CookoutView` | Rejects both active options (`skipIndex` `0` or `1`, max 2 per turn) and deals 2 fresh ingredients. |
| `POST /api/admin/server/cookout/{seq}/bank` | `{"sender": "Josh", "conceptIndex": 0}` | `CookoutView` | Marks concept `0`, `1`, or `2` as `banked = true` and launches Stage 2 full-recipe generation (`wixy-cookout-recipe`). |
| `POST /api/admin/server/cookout/{seq}/retry` | `{"sender": "Josh", "target": "concepts" \| "images" \| "recipe", "conceptIndex"?: int}` | `CookoutView` | Re-runs a `'failed'` or `'unavailable'` concepts, images, or full-recipe job (`tries` reset to `1`). |

### 4.3 Viewer-filtered `CookoutView` JSON wire shape

```json
{
  "anchorSeq": 142,
  "rev": 5,
  "state": "picking",
  "blind": true,
  "viewerSlot": 1,
  "players": {
    "player1": { "name": "Josh", "bound": true },
    "player2": { "name": "Hannah", "bound": true }
  },
  "turnIndex": 3,
  "picksPerPlayer": 5,
  "totalTurns": 10,
  "maxSkipsPerTurn": 2,
  "currentTurn": {
    "turnIndex": 3,
    "activeSlot": 2,
    "activePlayerName": "Hannah",
    "pickNumberForPlayer": 2,
    "skipCount": 1,
    "skipsRemaining": 1,
    "canAct": false,
    "hidden": true,
    "offered": null,
    "skippedThisTurn": []
  },
  "picks": [
    {
      "turnIndex": 0,
      "slot": 1,
      "pickedBy": "Josh",
      "hidden": false,
      "ingredient": {
        "id": "ribeye-steak",
        "name": "Ribeye steak",
        "category": "meat_poultry",
        "categoryLabel": "Meat & Poultry",
        "emoji": "🥩",
        "blurb": "Richly marbled beef cut ideal for high-heat searing"
      },
      "skippedCount": 0
    },
    {
      "turnIndex": 1,
      "slot": 2,
      "pickedBy": "Hannah",
      "hidden": true,
      "ingredient": null,
      "skippedCount": null
    }
  ],
  "staples": [
    { "id": "salt", "name": "Sea salt" },
    { "id": "black-pepper", "name": "Cracked black pepper" },
    { "id": "butter", "name": "Unsalted butter" }
  ],
  "conceptsState": "none",
  "imagesState": "none",
  "concepts": [],
  "createdAt": "2026-10-28T15:30:00Z",
  "updatedAt": "2026-10-28T15:31:12Z"
}
```

When `state == "ready"`, `concepts` contains the 3 concept objects, each with its resolved attachment URL (once `attachment.status == "ready"`) and its independent `banked` + `recipeState` + `recipe` payload:

```json
{
  "index": 0,
  "title": "Espresso-Glazed Ribeye over Crispy Brioche & Charred Broccoli",
  "vibe": "Steakhouse Bistro",
  "pitch": "Seared ribeye steak basted in a dark brown sugar, espresso, and soy reduction...",
  "usedPicked": [
    { "id": "ribeye-steak", "name": "Ribeye steak", "emoji": "🥩" }
  ],
  "staplesUsed": [
    { "id": "butter", "name": "Unsalted butter" },
    { "id": "garlic", "name": "Garlic cloves" }
  ],
  "image": {
    "attachmentId": "9f8c...1a",
    "status": "ready",
    "url": "/api/admin/server/attachments/9f8c...1a",
    "width": 768,
    "height": 512
  },
  "banked": true,
  "bankedBy": "Hannah",
  "bankedAt": "2026-10-28T15:34:10Z",
  "recipeState": "ready",
  "recipe": {
    "prepTime": "15 mins",
    "cookTime": "20 mins",
    "serves": 2,
    "difficulty": "Easy",
    "ingredients": [
      { "item": "2 thick ribeye steaks (220g each)", "source": "picked", "ingredientId": "ribeye-steak" },
      { "item": "1 tbsp unsalted butter", "source": "staple", "ingredientId": "butter" }
    ],
    "steps": [
      "Pat the ribeye steaks dry and season generously..."
    ],
    "chefNote": "Letting the toast catch the resting juices..."
  }
}
```

### 4.4 Client UI (`admin-ui/src/server/cookout/cookoutPane.ts`)

Designed phone-first (`360×640` viewport) inside the shared game frame (`gameTabs.ts` + 60px `itemChat.ts` bottom bar):

1. **Top Header Bar (44px):**
   - Left: Round title (`"🍳 Cookout"`), current mode pill (`"👁️ Open"` or `"🕵️ Blind"` — clickable to toggle before Turn 0's first move), and a `"📖 Recipe book"` button.
   - Right: `"New round"` button (with a confirmation guard if `state == 'picking'` and `turnIndex > 0`).
2. **Stage A — The Kitchen Draft (`state == 'picking'`):**
   - **Turn Banner & Go Indicator:** Clear pill at the top:
     - When `currentTurn.canAct == true`: `"Your turn (Pick 2 of 5) · Go 1 of 3"` in warm amber/terracotta accent.
     - When `currentTurn.canAct == false`: `"Waiting for Hannah (Pick 2 of 5) · Go 2 of 3"`.
   - **The Dual Choice Cards (or Blind Curtain):**
     - If `currentTurn.offered` is present: Two tactile side-by-side (or stacked on narrow screens) ingredient cards with an `"OR"` badge between them. Each card shows the category emoji, category label pill, bold ingredient `name`, and culinary `blurb`, plus a primary **"Pick this"** action (tapping the card picks it immediately).
     - Below the two cards sits the Skip button:
       - `skipCount == 0`: **"Neither of these — deal 2 new options (2 skips left)"**
       - `skipCount == 1`: **"Neither of these — deal final 2 options (1 skip left)"**
       - `skipCount == 2`: Disabled badge **"Final pair (Go 3 of 3) — pick one above!"**
     - If `currentTurn.hidden == true` (Blind Mode on partner's turn): Renders a warm animated kitchen cloche card: *"🕵️ Blind Mode: {activePlayerName} is secretly choosing Pick #{pickNumberForPlayer} (Go {skipCount + 1} of 3)..."*
   - **The 10-Slot Ingredient Basket (2 columns × 5 rows below the choice cards):**
     - Left column: **Player 1's 5 slots**; Right column: **Player 2's 5 slots**.
     - Filled slots show `"🥩 Ribeye steak"` (or `"🔒 Secret pick"` in Blind Mode for the partner's column). Empty slots show a dashed outline (`"Pick #3"`).
     - Collapsible footer chip: *"🧂 Allowed pantry staples (16): salt, pepper, butter, olive oil, flour, eggs, garlic, onion, lemon..."* so both players always know what the AI chef has on the shelf.
3. **Stage B — The Reveal & Concocting (`state == 'concocting'`):**
   - If the round was played in Blind Mode, all 10 basket chips flip open with a celebratory reveal banner: **"🎉 Curtain up! Here are all 10 ingredients in the kitchen:"** showing Josh's 5 picks and Hannah's 5 picks side by side.
   - Chef progress card with animated simmering pot indicator: *"👩‍🍳 Chef is concocting 3 dish concepts from your 10 ingredients..."*
4. **Stage C — The 3 Dish Concepts & Banking (`state == 'ready'`):**
   - Full basket summary strip at the top (all 10 picked ingredients as compact pills).
   - **3 Recipe Concept Cards** (swipeable horizontal carousel on 360px mobile or 3-pill selector `"Dish 1 · Dish 2 · Dish 3"` + vertical stack on wider screens):
     - **Hero Dish Photo (16:9 / 3:2):** Renders the local ComfyUI photo (`image.url`), or a shimmering plate skeleton while `imagesState == 'pending'` / attachment processing. Tapping the photo opens the existing lightbox.
     - **Header:** Dish `title` + `vibe` badge (e.g. `"Steakhouse Bistro"`).
     - **Appetizing Pitch:** The 2–3 sentence `pitch`.
     - **Ingredient Breakdown Pills:**
       - **"Used from your basket (8/10):"** green/warm pills for each `usedPicked` ingredient.
       - **"Plus pantry staples:"** muted pills for each `staplesUsed` item.
     - **Primary Action Footer:**
       - When `banked == false`: **"📖 Bank this & write full recipe"** button.
       - When `banked == true` and `recipeState == 'pending'`: **"✨ Banked! Writing full recipe & instructions..."** (with spinner).
       - When `banked == true` and `recipeState == 'ready'`: Collapsible/expanded **Full Recipe View** right inside the card (Prep/Cook time, Serves, Difficulty, Ingredients with exact measurements split into *Your Picked Ingredients* and *Pantry Staples*, numbered Method Steps, and Chef's Note) plus a **"✓ In Recipe Book"** badge.

### 4.5 Main-chat Anchor Card (`cookoutCard.ts`) & Recipe Book (`recipeBook.ts`)

- **`cookoutCard.ts`:** Compact card rendered inside the main `Chat` stream for a Cookout anchor message:
  - While `state == 'picking'`: `"🍳 Cookout · Pick 4 of 10 (🕵️ Blind mode)"` + **"Open kitchen →"**.
  - While `state == 'concocting'`: `"🍳 Cookout · 10 ingredients picked — Chef is concocting 3 dishes…"` + **"Open kitchen →"**.
  - When `state == 'ready'`: Shows the 3 concept titles (and thumbnail if rendered), `"1 banked"` badge if any concept is banked, and **"Open kitchen →"**.
- **`recipeBook.ts`:** Modal opened from the `⋯` menu (**Recipe book**) or from the Cookout pane header:
  - Lists every banked dish across all rounds (`GET /api/admin/server/cookout/bank`).
  - Each entry shows the dish photo, title, vibe, date & who banked it, the 10-ingredient round basket it came from, and (when `recipeState == 'ready'`) the complete expandable recipe card with ingredients, quantities, and step-by-step instructions (plus a **Retry recipe** button if `recipeState == 'failed'`).

### 4.6 Shared Game Frame, Mini Chat & Idle-Lock Integration

- **`gameTabs.ts`:** Widen `GameKey` to `"wyr" | "adventure" | "cookout"`. Because `GameTabs.offer()` and `GameTabs.open()` pass `replaceOthers` by default, only one game ever occupies the second tab at a time: whichever game (`wyr`, `adventure`, or `cookout`) has the highest `anchor_message_seq` is offered on thread load, and starting or clicking into any game replaces the previous one in the second tab.
- **`itemChat.ts`:** When the `Cookout` tab is active, `MiniStrip` binds to `{kind: "cookout", seq: activeCookoutSeq, label: "🍳 " + titleOrTurnSummary}` so messages sent from the 60px bottom strip carry `wyr_ref = {kind: "cookout", seq}`.
- **Idle-lock rule:** On `lock()` / session detach, `cookoutPane.destroy()` and `recipeBook.close()` clear all DOM nodes and in-memory round views.

### 4.7 Tests & Documentation (`Inv 57`)

1. **`wixy_server/tests/test_cookout_bank.py`:** Validates `cookout_ingredients.json` (≥ 2,400 unique ingredients, all 14 categories populated, all 16 staples disjoint from pickable ingredients, pair draw never repeats within a round, pair options come from distinct categories, category cap downweights categories with 2 picks).
2. **`wixy_server/tests/test_cookout_game.py`:** Covers the full 10-turn state machine, 2-skip-per-turn cap (`skip_limit_reached` on 3rd skip), idempotent pick/skip/bank replays, strict Blind Mode redaction in `GET /cookout/{seq}?as=...` (partner's current pair and picked items are `null` during `'picking'` and revealed on the 10th pick), Stage 1 concept validator (rejects unpicked non-staple ingredients, enforces `usedPickedIds` floor), ComfyUI 3-image batch attachment & Gallery exclusion, Stage 2 banking & full recipe generation, message delete cascade, and `wipe()` behaviour.
3. **`admin-ui/src/server/__tests__/cookout.test.ts` (vitest) & `e2e/tests/cookout.spec.ts` (Playwright):** Verifies opening Cookout from `⋯`, playing a 10-pick round with skips, Blind Mode curtain, viewing 3 concepts, banking a concept, and reading the full recipe in the Recipe Book.
4. **Docs (`docs/ai/livechat.md` §24 & `docs/ai/invariants.md` Inv 57):** Document the Cookout state machine, schema v21, and **Invariant 57** (Cookout ingredient draft, server-enforced Blind Mode redaction, strict picked+staples AI recipe constraint, ComfyUI 3-image batch cleanup per Inv 54, and cascade/wipe rules).

---

# Section B — Fun Twists (7 Self-Contained Ideas, Top 3 Marked)

All 7 twists below are designed as **strictly additive layers** on top of the Section A core: the core state machine (`picking -> concocting -> ready` + `bank`) does not depend on any of them, and each can be shipped or toggled independently.

### ⭐ Twist 1 (TOP 3 — Operator's Idea): "Send One Back to the Kitchen" (Post-Concoction Ingredient Swap)
- **One-line pitch:** After the 3 dish concepts arrive, if one rogue ingredient ruined the synergy, the couple gets **one** chance per round to swap out a single picked ingredient (choosing from a fresh 2-option draw) and have the AI Chef re-concoct the 3 concepts.
- **Why it's genuinely fun for a couple:** Sometimes a Blind Mode draft produces 9 dream ingredients plus *Marmite* or *Tinned Sardines* that hijacks all 3 dishes. Giving the couple one post-reveal "Send one back!" rescue turn creates a hilarious shared negotiation (*"Okay, whose fault is the sardines? Swap it!"*) and a second dramatic reveal.
- **Build cost:** **S** (~80 LoC server + ~60 LoC UI).
- **How it layers cleanly on the core:** Adds one nullable integer column `swap_used INTEGER NOT NULL DEFAULT 0` (and `swap_candidates_json TEXT`) on `cookout_rounds` plus `POST /cookout/{seq}/swap` (`{sender, dropTurnIndex}` -> draws 2 replacement candidates; `{sender, dropTurnIndex, replacementId}` -> replaces `picks_json[dropTurnIndex]`, sets `swap_used = 1`, resets `concepts_state = 'pending'`, and re-runs Stage 1).

### ⭐ Twist 2 (TOP 3): Chef's Vibe Roulette (Optional Style / Occasion Modifier)
- **One-line pitch:** Before or after the 10th pick, the couple can spin a 1-tap **"Chef's Vibe"** wheel (or leave it on *Chef's Choice*) — e.g. *🕯️ Date-Night Bistro*, *🌮 Late-Night Street Food*, *🔥 Pub Comfort Classic*, *👑 Chaotic Michelin Tasting Menu*, or *☀️ Cozy Sunday Brunch* — steering how the AI Chef interprets the 10 ingredients.
- **Why it's genuinely fun for a couple:** Turning the exact same 10 ingredients (say, ribeye, toast, brown sugar, and broccoli) into *Late-Night Street Food* vs. *Chaotic Michelin Tasting Menu* changes the whole personality of the 3 concepts and their ComfyUI plating photos.
- **Build cost:** **S** (~40 LoC server + ~45 LoC UI).
- **How it layers cleanly on the core:** A single nullable `vibe_filter TEXT` column on `cookout_rounds` (default `NULL` = balanced variety across the 3 concepts). Passed as a one-line style directive into the `wixy-cookout-concepts` prompt; zero changes to turn logic or banking.

### ⭐ Twist 3 (TOP 3): "We Actually Cooked This!" Stamp & Couple Rating in the Recipe Book
- **One-line pitch:** Inside the Recipe Book, any banked recipe can be stamped **"🍽️ Cooked Together"** with a 1–5 heart/star rating from each partner, short tasting notes, and an optional real-life photo attachment from their phone camera side-by-side with the AI's ComfyUI concept photo ("Expectation vs. Reality").
- **Why it's genuinely fun for a couple:** Cookout bridges a cosy sofa chat game with actually cooking dinner together in the real kitchen! Comparing the AI's glossy ComfyUI dish photo with their real kitchen creation ("Expectation vs. Reality") turns the Recipe Book into a shared scrapbook of dinners they invented together.
- **Build cost:** **M** (~120 LoC server + ~110 LoC UI).
- **How it layers cleanly on the core:** Stored inside `recipes_json[idx].cookedLog` (`{cookedAt, ratingP1, ratingP2, note, realPhotoAttachmentId}`) via `POST /cookout/{seq}/cooked`. Zero impact on the picking or AI generation flow.

### Twist 4: The "Hospital Pass" (Once-Per-Game Swap With Partner's Last Pick in Open Mode)
- **One-line pitch:** In Open Mode, once per game each player has a **"Steal / Veto token"** that lets them force their partner to re-draw one of the two options currently on the table.
- **Why it's genuinely fun for a couple:** When you see your partner hovering over *Durian* or *Anchovies* in Open Mode, burning your one Veto token to sweep that card off the table sparks instant banter.
- **Build cost:** **S** (~60 LoC server + ~40 LoC UI).
- **How it layers cleanly on the core:** Only active when `blind == 0`; consumes a boolean flag `p1_veto_used` / `p2_veto_used` and replaces one half of `current_pair_json`.

### Twist 5: The 11th Ingredient "Wildcard Cloche" (Optional Bonus Dare)
- **One-line pitch:** When all 10 picks are in, before the AI Chef starts, the server offers a mysterious glowing **"Wildcard Cloche"** — the couple can either go straight to the kitchen with their 10 picks, or dare to lift the cloche to add a mandatory 11th `curious`-tier curveball ingredient that the AI *must* feature in Dish #3.
- **Why it's genuinely fun for a couple:** High-drama "press your luck" moment right after the 10th pick when both players are feeling confident about their basket.
- **Build cost:** **S** (~55 LoC server + ~50 LoC UI).
- **How it layers cleanly on the core:** Optional step between Turn 9 and `concocting`; appends an 11th item (`slot = 0`, `"Wildcard"`) to `picks_json` if accepted.

### Twist 6: "Fridge Raid" Seed (Pin 1 Real Ingredient From Home Before Starting)
- **One-line pitch:** When starting a Cookout round, either player can optionally type/search **1 ingredient they actually have in the fridge tonight** (e.g. *"chicken thighs"* or *"halloumi"*) as Pick #1, and draft the remaining 9 turns around it.
- **Why it's genuinely fun for a couple:** Lets the couple use Cookout both as a pure fantasy game *and* as an actual "what should we do with these chicken thighs tonight?" dinner generator.
- **Build cost:** **S** (~50 LoC server autocomplete over `cookout_ingredients.json` + ~60 LoC UI).
- **How it layers cleanly on the core:** Pre-populates Turn 0 (`picks_json[0]`) at `POST /cookout` if `seedIngredientId` is supplied, starting the interactive draft at `turn_index = 1`.

### Twist 7: Blind Taste-Test Vote ("Which of the 3 Dishes Wins Tonight?")
- **One-line pitch:** Once the 3 concepts and photos appear, both players secretly tap their #1 favourite of the 3 dishes; if both pick the same dish, it triggers a **"🎯 Dinner Match!"** animation and auto-banks that dish with full recipe generation!
- **Why it's genuinely fun for a couple:** Echoes Would-You-Rather's two-player reveal mechanic — discovering you both independently picked Dish #2 makes choosing what to bank effortless.
- **Build cost:** **S** (~65 LoC server + ~60 LoC UI).
- **How it layers cleanly on the core:** Adds `votes_json` (`{"1": 2, "2": 2}`) on `cookout_rounds`; when both slots vote and match, automatically invokes the existing `bank` transition on that `conceptIndex`.

---

# Section C — Implementation Plan (Parallel Delivery Train)

Following the `build` and `delegate` skills, the implementation splits cleanly into **5 self-contained builder parcels** with frozen interface contracts so multiple workers can build in parallel without file collisions.

### Dependency Graph

```text
  ┌──────────────────────────────────────────┐
  │ Parcel 1: Ingredient Bank & Draw Engine  │
  │ (cookout_ingredients.json,               │
  │  cookout_bank.py, test_cookout_bank.py)  │
  └───────────────────┬──────────────────────┘
                      │
  ┌───────────────────▼──────────────────────┐    ┌──────────────────────────────────────────┐
  │ Parcel 2: Store Schema v21, Game Engine  │    │ Parcel 3: AI Chef & ComfyUI Batch        │
  │ & HTTP Routes (store.py, models.py,      │◄───│ (cookout_chef.py, cookout_images.py,     │
  │  cookout_game.py, routes_livechat_*)     │    │  wyr_images.py generate_batch, tests)    │
  └───────────────────┬──────────────────────┘    └──────────────────────────────────────────┘
                      │
  ┌───────────────────▼──────────────────────┐
  │ Parcel 4: Admin UI — Cookout Pane, Card, │
  │ Recipe Book & GameTabs Wiring            │
  │ (admin-ui/src/server/**, livechat.css)   │
  └───────────────────┬──────────────────────┘
                      │
  ┌───────────────────▼──────────────────────┐
  │ Parcel 5: E2E Playwright Suite, Docs &   │
  │ Invariant 57 (e2e/, docs/ai/*)           │
  └──────────────────────────────────────────┘
```

*(Note: Parcels 1, 3, and the UI components of Parcel 4 can be built **concurrently in Wave 1** against the frozen JSON & Python function signatures below; Parcel 2 integrates Parcels 1 & 3 in Wave 2; Parcel 5 verifies the assembled stack in Wave 3.)*

### Parcel Breakdown & Model Assignments

| Parcel | Scope & Exact Files | Assigned Model | Why |
|---|---|---|---|
| **Parcel 1: Ingredient Bank & Stratified Draw Engine** | `wixy_server/livechat/cookout_ingredients.json`, `wixy_server/livechat/cookout_bank.py`, `wixy_server/tests/test_cookout_bank.py` | **Sonnet 5.5** | Pure data generation (~2,600 ingredients across 14 categories + 16 staples) and self-contained Python sampling algorithm with unit tests. Zero imports from `store.py` or `app.py`. |
| **Parcel 2: Store Schema v21, State Machine & HTTP Routes** | `wixy_server/livechat/store.py` (`_SCHEMA_V21_COOKOUT`, `list_gallery`, `finish_attachment`, CRUD methods), `wixy_server/livechat/models.py` (`CookoutRoundRow`, `Message.cookout`, `wyr_ref_kind`), `wixy_server/livechat/cookout_game.py`, `wixy_server/routes_livechat_cookout.py`, `wixy_server/app.py`, `wixy_server/tests/test_cookout_game.py` | **Sonnet 5.5** (audited by **Opus 5.5** per `audit` skill for schema migration + auth routes) | Server store migration, `BEGIN IMMEDIATE` state transitions, Blind Mode server redaction, and FastAPI endpoints following `routes_livechat_adventure.py`. |
| **Parcel 3: AI Chef Jobs & ComfyUI 3-Image Batch** | `wixy_server/livechat/cookout_chef.py`, `wixy_server/livechat/cookout_images.py`, `wixy_server/livechat/wyr_images.py` (add `generate_batch`), `wixy_server/tests/test_cookout_chef.py`, `wixy_server/tests/test_cookout_images.py` | **Sonnet 5.5** | Follows `adventure_pack.py` (`CmdChatClient.spawn_run` + defensive JSON parser + CAS contract) and `wyr_images.py` (`_batch_workflow` + Inv 54 cleanup). |
| **Parcel 4: Admin UI — Cookout Pane, Card, Recipe Book & Game Frame** | `admin-ui/src/server/cookout/{cookoutPane.ts, cookoutCard.ts, recipeBook.ts}`, `admin-ui/src/server/{gameTabs.ts, itemChat.ts, thread.ts, api.ts, types.ts}`, `admin-ui/src/styles/livechat.css`, `admin-ui/src/server/__tests__/cookout.test.ts` + `npm run build` | **Opus 5.5** | High-craft mobile-first UI (360×640), Blind Mode curtain animations, 3-concept carousel, expandable Recipe Book, and strict TypeScript wiring into `thread.ts` and `gameTabs.ts`. |
| **Parcel 5: Playwright E2E, Docs & Invariant 57** | `e2e/tests/cookout.spec.ts`, `docs/ai/livechat.md` (§24), `docs/ai/invariants.md` (Inv 57), `CLAUDE.md` store table update | **Sonnet 5.5** | End-to-end verification and documentation alignment. |

### Frozen Interface Contracts Between Parcels

1. **Parcel 1 (`cookout_bank.py`) exports:**
   - `Ingredient(NamedTuple)`: `id: str`, `name: str`, `category: str`, `category_label: str`, `emoji: str`, `tier: str`, `blurb: str`
   - `Staple(NamedTuple)`: `id: str`, `name: str`, `note: str`
   - `load_bank() -> CookoutBank`
   - `draw_pair(bank: CookoutBank, *, excluded_ids: AbstractSet[str], picked_categories: Sequence[str], turn_index: int, rng: random.Random | None = None) -> tuple[Ingredient, Ingredient]`
2. **Parcel 3 (`cookout_chef.py` & `cookout_images.py`) exports:**
   - `sanitise_concepts(raw: str, *, picked_ids: AbstractSet[str], staple_ids: AbstractSet[str]) -> list[dict[str, Any]] | None`
   - `sanitise_recipe(raw: str, *, picked_ids: AbstractSet[str], staple_ids: AbstractSet[str]) -> dict[str, Any] | None`
   - `CmdCookoutChef.generate_concepts(picked: Sequence[Ingredient], staples: Sequence[Staple]) -> tuple[str | None, list[dict[str, Any]] | None]`
   - `CmdCookoutChef.generate_recipe(concept: dict[str, Any], picked: Sequence[Ingredient], staples: Sequence[Staple]) -> tuple[str | None, dict[str, Any] | None]`
   - `ComfyImageGenerator.generate_batch(prompts: Sequence[str], out_dir: Path, *, seeds: Sequence[int] | None = None) -> tuple[Path, ...]`
3. **Parcel 2 (`routes_livechat_cookout.py`) & Parcel 4 (`admin-ui`) contract:**
   - Exact REST paths in §4.2 and exact `CookoutView` / `BankedRecipeView` JSON shapes in §4.3.

---

# Section D — Pre-Commitment (Drop First vs. Defend Hardest)

### What I will drop or adapt first if a peer has a sharper idea

1. **Skip budget scope (2 skips per turn vs. 2 skips per player across the whole 5-pick game):**
   - In §1.3, I specified **2 skips per turn** ("3 goes before you have to pick from one or the other") because the operator's phrasing — *"when you're getting presented with the two options, you'll have the two options: if you say no, neither of those two options, and you'll get two options, two new options. And you can do that up to two times. So essentially, you're going to have three goes before you have to pick from one or the other"* — directly describes the binary choice on a single turn.
   - However, if a peer makes a compelling gameplay case that **2 skips per player per round** (so you have to ration your skips across your 5 picks rather than skipping twice on every single turn) creates higher tension, or if we want a constant `SKIP_BUDGET_MODE` / per-player pool, the schema supports both trivially (`p1_skips_left`, `p2_skips_left` vs `current_skip_count`), and I am happy to converge on whichever reading the panel agrees is most fun (or flag it cleanly for the operator).
2. **Exact category taxonomy and count in `cookout_ingredients.json`:**
   - Whether we use 12, 14, or 16 categories (or merge `mushrooms_truffles` into `vegetables` and `cured_fermented` into `condiments_sauces` / `meat_poultry`) is completely flexible as long as we have ~2,500+ varied ingredients, a stratified draw that prevents 8-spice baskets, and the explicit staples list.
3. **Which 3 twists make the final cut:**
   - Beyond Twist #1 (the operator's post-concoction single-ingredient swap, which we should definitely highlight), I am happy to trade Twist #2 or #3 for any stronger twist proposed by `kimi` or `astra`.

### What I will defend hardest

1. **Server-enforced Blind Mode redaction (`cookout_view_json`) tied to `_slot_of(round_, viewer_key, viewer_email)`:**
   - Blind Mode must **not** be a CSS-only blur in the browser. Just like Would-You-Rather hides the partner's unrevealed choice on the server (`wyr_game.py:139-227`), `GET /cookout/{seq}?as=<sender>` must redact `currentTurn.offered` when it is the other player's turn and redact the other player's `picks[i].ingredient` until the 10th pick transitions `state` out of `'picking'`. That also means Blind Mode requires strict per-slot turn enforcement so Player 1 cannot accidentally tap or peek during Player 2's secret turn.
2. **Two-stage AI split (Stage 1 = 3 Concepts + ComfyUI Photos only; Stage 2 = On-demand Full Recipe per banked concept) + strict server-side ingredient validation:**
   - The operator explicitly asked that Stage 1 *"doesn't generate the full recipe initially — just the concept, description and picture"* and that banking a dish triggers the full recipe and instructions. Furthermore, the server validator (`sanitise_concepts` / `sanitise_recipe`) must enforce the picked-ingredients + allowed-staples contract (`usedPickedIds` subset of the 10 picked IDs, `staplesUsed` subset of the 16 staple IDs) so the AI never sneaks unpicked ingredients like mango into a concept.
3. **Single-graph ComfyUI 3-image batch (`generate_batch`) under the shared `wyr_image_limiter` + full Invariant 54 cleanup + Gallery exclusion:**
   - Hub has a single RTX 5060 Ti (16 GB). Running 3 separate ComfyUI `/prompt` calls or bypassing `wyr_image_limiter` would fight with WYR image generation and waste time reloading node weights. Extending `ComfyImageGenerator` with `generate_batch` renders all 3 dish photos in a single ComfyUI graph against one shared model load, increments `WyrDemand` so the background WYR pool yields immediately, scrubs `/history` and `WIXY_COMFY_OUTPUT_DIR` per Invariant 54, and excludes `cookout_rounds` anchor messages from `list_gallery` while bumping `cookout_rounds.rev` in `finish_attachment`.

---

# Section E — Open Questions for the Operator

Our spec above chooses sensible, ready-to-build defaults for every detail so engineering is not blocked. The only two gameplay preferences worth confirming if the operator has a strong feeling are:

1. **Skip budget — "2 skips per turn" vs. "2 skips per player across the 5-pick game":**
   - **Default in this spec:** **2 skips per turn** (every time it is your turn to pick 1 ingredient, you get up to 3 pairs before you must pick one of the 3rd pair).
   - **Alternative:** **2 skips per player across the whole 5-pick game** (so you have to save your 2 skips for when you truly hate both options).
2. **Banking multiple concepts from the same round:**
   - **Default in this spec:** Each of the 3 concepts has its own **Bank this** button, so if the couple loves two (or all three) of the dishes from a great round, they can bank more than one into the Recipe Book. (If he prefers a strict "pick only 1 winner to bank per round", that's a one-line toggle.)
