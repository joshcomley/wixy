# Server chat — Cookout (the two-player cooking game)

Workspace 00058. Decided brief (Triad Round 2 + orchestrator ruling, `triad/cookout/ruling.md`):
implement faithfully. Where reality contradicts a cited fact, prefer reality and record it in the
decision entry (`decisions/00193-server-chat-cookout/`).

## 0. The ask (operator, verbatim summary)

A third cooperative two-player game in the chat's `⋯` menu, **"Cookout"**. Two players alternate
picking ingredients into one shared basket (**five picks each = ten ingredients total**). On each
turn the game presents **two contrasting ingredients** from a massive static ingredient bank
("everything in there": parsley, beef, cream, toast, sugar, herbs, spices, prepared foods…). The
active player either picks one of the two, or skips both **"up to two times — so essentially three
goes before you have to pick"** (two skips per turn; must pick one of the third pair).

The game supports **Open** mode and **Blind** mode (chosen in a small start sheet when starting
Cookout). In Blind mode each player cannot see what the other person is offered or picking until
all ten picks are complete, when the whole ten-ingredient basket is revealed together.

Once all ten ingredients are picked, the AI invents **three distinct recipe concepts** that try hard
to use all ten picked ingredients (and must use most of them), plus only basic cupboard staples
("butter, salt, pepper, flour, a few things like that… nothing fancy" — never sneaking in unpicked
foods like mango, garlic, or stock). First it shows only the **three titles and descriptions**, each
with a **picture of the finished dish** above it (generated locally on Hub's ComfyUI). Full
quantities and step-by-step instructions are **not** generated upfront: either player can tap
**"Bank this"** on any of the three concepts to generate its full recipe and instructions and save
it to the shared **Recipe book**. Every round has its own expandable **mini chat** at the bottom,
sharing `gameTabs.ts` and `itemChat.ts` with Would-You-Rather and Adventure Time.

---

## 1. Flow and states

`cookout_rounds.state`:

```text
picking (turns 1..10) ──[turn 10 pick commits]──► finished
   │
   └──[new Cookout started or End game pressed]──► abandoned
```

`cookout_rounds.concepts` (once `state = 'finished'`):
`none` (while `picking`/`abandoned`) → `pending` → `ready` | `failed` | `unavailable`
(`unavailable` = no AI runner configured, e.g. the standalone edition). `failed` | `unavailable`
→ retry → `pending`.

`cookout_rounds.images` (starts when `concepts` becomes `ready`):
`none` → `pending` → `done` | `failed` (`none` in standalone or when ComfyUI is not configured).
Partial success is kept (`pictures` maps each completed slot `"a"|"b"|"c"` to its attachment id);
if any slot fails, `images = 'failed'` and `POST /cookout/{seq}/pictures/retry` regenerates only
the missing slots.

`cookout_recipes.state` (per concept `concept_id ∈ {'a','b','c'}` when **Bank this** is tapped):
row absent (not yet requested) → `pending` ("Writing recipe…") → `banked` | `failed` | `unavailable`.
A concept becomes **`banked`** (and appears in the Recipe book) **only** when its validated full
recipe is stored. Each of the three concepts is independently bankable by either player; failed or
unavailable saves are retryable on the card.

### 1.1 Players, explicit Join, and turn order

- **Creator takes Turn 1 immediately:** `POST /api/admin/server/cookout` creates the anchor message
  and `cookout_rounds` row in `state = 'picking'`, binds **Slot 1** (`player1_key = reactor_key(sender)`,
  `player1_name = sender`, `player1_email = auth.email or None`), shuffles the 5-turn culinary role
  schedule (§2.3), and immediately draws **Turn 1's initial pair** (`turn = 1, player = 1`) into
  `cookout_turns`. Player 1 can make their first pick at once without waiting on a lobby screen.
- **Explicit Join for Slot 2:** The second player binds **Slot 2** by pressing **Join**
  (`POST /cookout/{seq}/join` `{sender}`), which is available at any time while `state = 'picking'`
  (including while Player 1 is still on Turn 1). The pane shows a prominent **Join Cookout** button
  to any unlocked viewer who is not Player 1 while Slot 2 is unbound.
  - **A seat is never bound implicitly by a first move.**
  - **Turn 2's pair is never drawn or exposed until Player 2 is bound:**
    - If Player 2 joins while Turn 1 is still in progress, `POST /join` binds Slot 2; when Player 1
      completes Turn 1 (`POST /pick`), Turn 2's initial pair is drawn immediately in the same
      transaction.
    - If Player 1 completes Turn 1 *before* Player 2 has joined, Turn 1 commits and the round
      waits at `turn = 2, player = 2` with no Turn 2 row drawn yet (`current.options = null`,
      `waitingForJoin = true`); as soon as Player 2 calls `POST /cookout/{seq}/join`, that
      transaction binds Slot 2 and draws Turn 2's initial pair.
- **Strict alternation (10 turns total, 5 picks each):**
  - Odd turns (`1, 3, 5, 7, 9`) belong to **Slot 1**.
  - Even turns (`2, 4, 6, 8, 10`) belong to **Slot 2**.
  - Only the active slot may `skip` or `pick` on that turn; a request from the other slot returns
    `409 not_your_turn`, and a request from a non-player returns `409 not_player`.
- **Two skips per turn ("three goes before you have to pick"):**
  - Each active turn begins at `offer = 0` (`len(offers) == 1`, `skipsRemaining = 2`).
  - `POST /cookout/{seq}/skip` `{sender, moveId, turn, offer}` (valid when `offer ∈ {0, 1}`)
    appends a freshly drawn pair `[snapC, snapD]` to `cookout_turns.offers` (`offer` advances to
    `1`, then `2`; `skipsRemaining` becomes `1`, then `0`). Skipping never passes the turn and
    unused skips never carry over to a later turn.
  - At `offer == 2` (`len(offers) == 3`, `skipsRemaining == 0`), the skip button is disabled/hidden
    and a third skip request returns `409 skip_exhausted` — the active player must pick one of the
    two ingredients in `offers[2]`.
  - `POST /cookout/{seq}/pick` `{sender, moveId, turn, offer, ingredientId}` verifies that
    `ingredientId` is one of the two IDs in `offers[offer]`, stores `choice_id = ingredientId`, and:
    - If `turn < 10`: draws `turn + 1` with `offer = 0` and `skipsRemaining = 2` (unless `turn == 1`
      and Slot 2 is not yet bound, in which case `turn = 2` is drawn when Slot 2 joins).
    - If `turn == 10`: sets `state = 'finished'`, sets `concepts = 'pending'` (or `'unavailable'`),
      stamps `concepts_started_at = now`, `concepts_tries = 1`, `concepts_deadline_at = now + 900`,
      and starts the Stage-1 concept job (§3.1).

### 1.2 Seat identity (`_slot_of`) and its honest limit

Seat identity uses the existing Would-You-Rather rule (`wyr_game._slot_of` / `store._wyr_slot`):
each slot stores `(player_key = reactor_key(sender), player_name = sender, player_email = auth.email or None)`.
- A viewer or actor matches `slot ∈ {1, 2}` when `reactor_key(name) == player_key` AND, if both
  `player_email` and the request's verified `ServerAuth.email` are non-empty,
  `auth.email.lower() == player_email.lower()`.
- If `reactor_key(name) == player_key` but both emails are present and differ, the request is
  rejected (`you = null` on `GET`, `409 not_player` on mutations).
- The same `player_key` cannot occupy both Slot 1 and Slot 2 (`409 bad_state`).
- **Honest limit (Inv 57):** No new `HttpOnly` seat cookie is introduced (server-chat keeps its
  credentials in JS memory only). Under a shared Cloudflare Access email or when email is absent in
  local dev (`WIXY_DEV_NO_AUTH=1`), a player who deliberately switches their display name to the
  partner's name could read the partner's blind state — the exact same accepted limit
  Would-You-Rather has for hidden answers. Blind mode is a no-peeking sofa feature between two
  trusted people sharing a private chat (Inv 40), not a cryptographic boundary against impersonation
  on a shared sign-in.

### 1.3 Open mode vs. Blind mode (server-side redaction)

`blind` (`0` or `1`) is chosen when creating the round (`POST /cookout` `{..., blind: bool}`) and
is immutable for that round.

- **In Open mode (`blind = false`):**
  - Both players see `current.options`, `current.offerIndex`, `current.skipsRemaining`, both
    players' selected `picks` so far, and the full `history` of offers and choices.
- **In Blind mode (`blind = true`) while `state == 'picking'`:**
  - `cookout_view_json` redacts the response in Python before serialization based on
    `viewer_slot = _slot_of(round_, viewer_key, viewer_email)`:
    1. **Partner's picks:** `players[partner].picks` is `null` (only `pickCount: 0..5` is sent).
    2. **Current turn options:** `current.options`, `current.offerIndex`, and
       `current.skipsRemaining` are populated **only** when `viewer_slot == current.player`. When
       `viewer_slot != current.player` (including `viewer_slot is None`), all three fields are
       `null`.
    3. **Turn history:** `history` includes **only** turns where `turn.player == viewer_slot`.
- **In Blind mode when `state == 'finished'` (The Big Reveal):**
  - When Turn 10's pick commits (`state == 'finished'`), `revealed` becomes `true` and both
    `players[0].picks` and `players[1].picks` (all 10 selected ingredient snapshots) are returned in
    full to both players.
  - **Partner's skipped/unchosen pairs stay hidden forever:** even when `state == 'finished'`,
    `history` in Blind mode continues to contain only the viewer's own turns
    (`turn.player == viewer_slot`).
- **In Blind mode when `state == 'abandoned'`:**
  - An abandoned blind round **never** reveals (`revealed = false`; partner `picks` stay `null`;
    never implement `state != 'picking'` as the reveal predicate).
- **Wire & cache hygiene:** `Message.cookout` (the broadcast summary on `Message` and SSE
  `message_updated`) carries no ingredient IDs, options, or recipe text, and every personalised
  `CookoutView` response sets `Cache-Control: no-store`.

### 1.4 Abandonment and idempotency

- **Abandonment:**
  - Starting a new Cookout round (`POST /cookout`) atomically marks any open `picking` Cookout round
    as `abandoned` (bumping its `rev` and emitting `message_updated`).
  - Either bound player (or the starter before Slot 2 joins) may also explicitly end an open
    `picking` round via the pane's **End game** action (`POST /cookout/{seq}/abandon` `{sender}`).
  - A `finished` round is **never** abandoned by starting a new game or calling `/abandon`.
- **Idempotency (no global `expectedRev`):**
  - `POST /cookout` is idempotent on `clientId` (`messages.client_id`, checked before abandonar).
  - `POST /cookout/{seq}/join` is state-idempotent for the already-bound Slot 2 player (`200 OK`
    with the current view).
  - `POST /cookout/{seq}/skip` and `POST /cookout/{seq}/pick` carry `{moveId, turn, offer}`.
    Replaying a `moveId` already recorded in `cookout_turns.skip_move_ids` or
    `cookout_turns.pick_move_id` returns `200 OK` with the current filtered view without drawing or
    emitting an event. Any different `moveId` whose `turn` or `offer` does not match the active
    turn's current offer index returns `409 bad_state`.
  - `POST /cookout/{seq}/concepts/{conceptId}/bank` carries `moveId` (`cookout_recipes.bank_move_id`)
    and is state-idempotent: if that concept's recipe row is already `pending` or `banked`, it
    returns `200 OK` with the current view without spawning a duplicate job.
  - Retry routes (`/concepts/retry`, `/pictures/retry`, `/concepts/{id}/recipe/retry`) are
    state-idempotent when the target job is already `pending`.

---

## 2. Data (static repo content)

### 2.1 The ingredient bank — `wixy_server/livechat/cookout_ingredients.json`

Committed static JSON targeting **~3,000 genuine culinary ingredients** (validator accepts
`2,500–4,000`), covering everyday staples, meats, fish, vegetables, fungi, fruit, dairy/cheese,
grains/bread/pasta, beans/nuts/seeds, herbs, spices, oils/condiments, sauces/pickles, sweet/baking,
drinks/infusions, and prepared comfort foods (toast, tinned baked beans, puff pastry, ramen, etc.).
No dietary or allergen promises are made or stored.

```json
{
  "version": 1,
  "generated": "2026-10-28",
  "categories": [
    { "id": "grains-bakery", "name": "Bread, Pasta & Grains", "emoji": "🍞" }
  ],
  "staples": [
    { "id": "water", "name": "Water", "pickable": false },
    { "id": "salt", "name": "Salt", "pickable": false },
    { "id": "black-pepper", "name": "Black pepper", "pickable": false },
    { "id": "butter", "name": "Butter", "pickable": true },
    { "id": "plain-flour", "name": "Plain flour", "pickable": true },
    { "id": "cooking-oil", "name": "Cooking oil", "pickable": true },
    { "id": "granulated-sugar", "name": "Granulated sugar", "pickable": true },
    { "id": "milk", "name": "Milk", "pickable": true }
  ],
  "stopWords": ["bread", "sauce", "salad", "soup", "stew", "roast", "bake", "pie", "toast", "water"],
  "ingredients": [
    {
      "id": "thick-white-toast",
      "name": "Thick-cut white toast",
      "aliases": ["white toast", "toasted white bread"],
      "category": "prepared-pantry",
      "role": "base",
      "family": "toast-bread",
      "rarity": "everyday",
      "blurb": "Crisp golden slices ready for topping, soaking, or crumbing."
    }
  ]
}
```

- **15 categories (`categories`):**
  1. `meat-poultry` ("Meat & Poultry", `🥩`)
  2. `fish-seafood` ("Fish & Seafood", `🐟`)
  3. `vegetables` ("Vegetables & Greens", `🥦`)
  4. `fungi` ("Mushrooms & Fungi", `🍄`)
  5. `fruit` ("Fruit & Citrus", `🍋`)
  6. `dairy-eggs` ("Dairy, Cream & Eggs", `🧀`)
  7. `grains-bakery` ("Bread, Pasta & Grains", `🍞`)
  8. `legumes-nuts-seeds` ("Beans, Nuts & Seeds", `🥜`)
  9. `herbs-aromatics` ("Fresh Herbs & Aromatics", `🌿`)
  10. `spices-seasonings` ("Spices & Chilis", `🌶️`)
  11. `oils-fats-condiments` ("Oils, Fats & Condiments", `🫒`)
  12. `sauces-stocks-fermented` ("Sauces, Pastes & Pickles", `🫙`)
  13. `sweet-baking` ("Sweet, Sugar & Baking", `🍯`)
  14. `prepared-pantry` ("Prepared & Comfort Pantry", `🥫`)
  15. `drinks-alcohol` ("Splash, Brews & Infusions", `☕`)
- **Fields on each ingredient:**
  - `id`: permanent lowercase ASCII kebab-case (`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, `2–64` chars),
    append-only and never reused.
  - `name`: trimmed British-English plain text (`1–70` chars), unique across the bank after Unicode
    NFKC + case/accent folding.
  - `aliases`: optional list of `0..4` alternative names (`1–70` chars each) of the exact same
    ingredient, used by the lexical contraband scanner (§3.2).
  - `category`: one of the 15 category IDs above.
  - `role`: one of `"base" | "protein" | "produce" | "accent"` — the primary culinary role used by
    the turn draw (§2.3). Every one of the 15 categories feeds at least one role; herbs and spices
    carry `"accent"`.
  - `family`: lowercase ASCII kebab-case (`2–48` chars) grouping close variants/cuts (e.g.
    `red-onion`, `white-onion`, and `brown-onion` share `family: "onion"`).
  - `rarity`: `"everyday" | "uncommon" | "exotic"` (draw weights `8 : 3 : 1`).
  - `blurb`: short plain-text culinary description (`1–90` chars, no HTML or URLs).
- **Offline validator (`tooling/cookout/validate_bank.py`, run in `test_cookout_bank.py`):**
  Checks total count (`2,500–4,000`), schema/type/slug rules, normalized `name`/`aliases`
  uniqueness, that all 15 categories are populated and none exceeds `25%` of the bank, that each of
  the 4 roles (`base`, `protein`, `produce`, `accent`) has at least `200` entries and at least `30`
  `everyday` families, mandatory operator examples (toast, sugar, parsley, beef, cream), that the 5
  pickable staples exist in `ingredients` with matching IDs while `water`, `salt`, `black-pepper`
  do not, and runs 500 simulated maximum-skip rounds (all 10 turns × 3 offers = 60 items/round) with
  zero draw exhaustion.

### 2.2 The eight cupboard staples

The complete cupboard staples list is **eight items**:
`water`, `salt`, `black-pepper`, `butter`, `plain-flour`, `cooking-oil`, `granulated-sugar`, `milk`.

- **Free seasonings (`pickable: false`):** `water`, `salt`, and `black-pepper` are always available
  to any concept/recipe and are never offered as turn picks.
- **Pickable staples (`pickable: true`):** `butter`, `plain-flour`, `cooking-oil`,
  `granulated-sugar`, and `milk` are also ordinary entries in `ingredients` (with the same `id`) so
  they can be offered and picked during the draft. If one is picked in the 10-item basket, it
  appears in `pickedIngredientIds` and does not count against the extra-staple cap.
- **Cap:** Each concept may use **at most 4 unpicked non-seasoning staples** from
  `{butter, plain-flour, cooking-oil, granulated-sugar, milk}` (plus `water`, `salt`,
  `black-pepper`).
- **Not staples:** eggs, garlic, onion, lemon, stock, soy sauce, vinegar, cream, and cheese are
  ordinary pickable bank items — never free staples.

### 2.3 Server-authoritative draw (`cookout_bank.py`)

- **Paired culinary-role schedule:** When the round is created, the server shuffles
  `["base", "protein", "produce", "produce", "accent"]` using `secrets.SystemRandom` and stores the
  5-element array in `cookout_rounds.role_schedule`. Each role is served on **paired consecutive
  turns** — `role_schedule[(turn - 1) // 2]` — so Turn 1 (Player 1) and Turn 2 (Player 2) share the
  first role, Turn 3 and Turn 4 share the second role, and so on. Both players therefore receive the
  exact same five role opportunities (`1 base, 1 protein, 2 produce, 1 accent`), and skipping keeps
  the turn's role.
- **Pair selection rules for `(turn, player)` with target `role = role_schedule[(turn - 1) // 2]`:**
  1. **Hard exclusions (round-wide):**
     - Exclude every ingredient `id` already offered anywhere in this round (`seen_ids`, across both
       players and all skips/unchosen mates).
     - Exclude every `family` already **selected** (`choice_id`) by either player in this round
       (`picked_families`).
  2. **Soft family preference:** Prefer families not yet offered in this round (`offered_families`);
     if fewer than 2 legal families remain for `role` under that preference, relax the unpicked
     `offered_families` preference while keeping `seen_ids` and `picked_families` strictly excluded.
  3. **Per-player least-shown category within the role:**
     - Among categories that have eligible candidates in `role`, choose `cat_a` uniformly at random
       from those tied for the lowest number of items already offered to `player` in this round.
     - Temporarily increment `cat_a`'s offered count for `player` and choose `cat_b` (`cat_b != cat_a`
       when at least two categories in `role` have legal families) from those tied for the lowest
       offered count.
  4. **At least one `everyday` per pair + `8 : 3 : 1` rarity weighting:**
     - For **Option 1** (in `cat_a`): draw uniformly from eligible families in `cat_a` that have an
       `everyday` entry (falling back to any eligible family in `cat_a` only if no `everyday` family
       remains), then uniformly among that family's eligible entries.
     - For **Option 2** (in `cat_b`, excluding Option 1's `family`): choose an available rarity tier
       in `cat_b` with weights **`everyday = 8, uncommon = 3, exotic = 1`**, then choose a family
       uniformly within that tier, then an entry uniformly within that family.
     - Randomly swap `(Option 1, Option 2)` with a 50/50 coin toss so the guaranteed-everyday side
       is not predictable.
  5. **Immutable offer snapshots:** Store both options in `cookout_turns.offers` as full snapshots
     `{"id", "name", "category", "emoji", "blurb"}` (plus `family` for draw exclusions) so a future
     bank edit never alters an existing round's offers or basket.
  6. **No cross-round memory:** Draws depend only on the current round; no cross-round history is
     consulted or persisted.

---

## 3. AI jobs and local ComfyUI pictures

### 3.1 Stage 1: Three recipe concepts (`cookout_ai.py`, cmd via `cmdchat.py` — Inv 13)

- **One cmd run produces all three concepts:** Uses `CmdChatClient.spawn_run` / `get_run` /
  `cancel_run` (`wixy_server/cmdchat.py`):
  - `caller: "wixy-cookout-concepts"`, `model: "claude-sonnet-5-5"`, `effort: "medium"`,
    `spawned_by_session_id: ""`, `cwd: <storage>/projects/<slug>/server/cookout-jobs` (an empty
    non-git folder created by the server), `bucket: "subscription"`, `timeout_secs: 300`, `tag`
    omitted, `disallowed_tools`: all Adventure disallowed tools **plus** `"WebSearch"` and
    `"WebFetch"` (all tools disallowed).
  - Persist `concepts_run_id` immediately after `spawn_run` returns.
- **Prompt privacy:** The prompt carries **only** the 10 selected ingredient records (`id`, `name`,
  `category`, `blurb`, sorted by `id` so pick order and player attribution are stripped) and the 8
  allowed staples (`id`, `name`). Never a player name, email, message, or chat detail.
- **Output JSON schema (exact IDs; server resolves display names):**
  ```json
  {
    "concepts": [
      {
        "id": "a",
        "title": "Espresso-Glazed Ribeye over Crispy Toast & Charred Broccoli",
        "vibe": "Steakhouse Bistro",
        "dishType": "platter",
        "technique": "pan-fry",
        "description": "Seared ribeye steak basted in a glossy dark brown sugar and espresso reduction, served over thick-cut buttered toast alongside charred tenderstem broccoli.",
        "pickedIngredientIds": ["aged-gruyere", "dark-brown-sugar", "double-espresso", "flat-leaf-parsley", "ribeye-steak", "smoked-paprika", "tenderstem-broccoli", "thick-white-toast"],
        "stapleIds": ["salt", "black-pepper", "butter"],
        "omitted": [
          { "id": "tinned-baked-beans", "reason": "Left out so the espresso pan-sauce stays sharp and glossy." },
          { "id": "white-miso", "reason": "Gruyère already provides the savoury umami finish." }
        ]
      }
    ]
  }
  ```
  - `dishType` ∈ `bowl|traybake|stew|soup|salad|pie|pasta|rice|flatbread|sandwich|pancake|fritter|omelette|bake|dessert|platter`.
  - `technique` ∈ `roast|bake|pan-fry|simmer|steam|grill|no-cook|mixed`.

### 3.2 Deterministic validation and lexical contraband scan (no second LLM checker run)

Validation runs deterministically in Python (`parse_concepts` / `parse_recipe`):

1. **Structural & ID whitelist:**
   - Exactly 3 concepts with `id` `"a"`, `"b"`, `"c"`, unique normalized `title` (`1..90` chars),
     `vibe` (`1..40` chars), and `description` (`20..500` chars).
   - Every ID in `pickedIngredientIds` must belong to the round's 10 selected IDs (no duplicates).
     An unknown or illegal ID rejects the whole candidate.
   - `omitted` must be the **exact complement** of `pickedIngredientIds` with respect to the 10
     selected IDs, each carrying a non-empty `reason` (`1..140` chars).
   - Every ID in `stapleIds` must belong to the 8 staple IDs, must not overlap
     `pickedIngredientIds`, and **at most 4** may be non-seasoning staples
     (`butter, plain-flour, cooking-oil, granulated-sugar, milk`).
2. **Coverage & diversity rules:**
   - Every concept is asked in the prompt to try hard to use all 10 picked ingredients.
   - **Each concept must use ≥ 7** picked ingredients (`len(pickedIngredientIds) >= 7`).
   - **At least one concept must use ≥ 8** picked ingredients
     (`max(len(c.pickedIngredientIds) for c in concepts) >= 8`).
   - **The union of `pickedIngredientIds` across `"a"`, `"b"`, and `"c"` must cover all 10** picked
     ingredients.
   - **Technique/type diversity:** The three concepts must have **three distinct
     `(dishType, technique)` pairs** and at least **two distinct `dishType` values**.
3. **Lexical contraband scan:**
   - Scans every prose field (`title`, `description`, `omitted[].reason`, and in full recipes
     `ingredients[].quantity`, `ingredients[].note`, `steps[].text`, `tips[]`) against a compiled
     longest-first word-boundary dictionary of all bank `name` and `aliases` entries, **excluding**:
     - the 10 picked ingredients and every bank entry sharing one of their `family` values,
     - for a single concept/recipe, also checking that unpicked basket items listed in `omitted` are
       not claimed as used in `title`, `description`, or `steps`,
     - the 8 cupboard staples (`water`, `salt`, `black-pepper`, plus the concept's declared
       `stapleIds`), and
     - the bank's curated `stopWords` list of generic culinary nouns/verbs (`bread`, `sauce`,
       `salad`, `soup`, `stew`, `roast`, `bake`, `pie`, `toast`, `water`, `oil`, `sugar`, `salt`,
       `pepper`, `butter`, `flour`, `milk`, `pan`, `pot`, `bowl`, `plate`, `crust`, `glaze`, `broth`,
       etc. — unit-tested against the committed bank).
   - **One repair run on failure:** If structural validation or the lexical scan fails, the runner
     spawns **at most one repair run** under the same job deadline, feeding back the exact violation
     messages (including any contraband food words detected). If the repair run also fails, the job
     transitions to `failed` (retryable by the user).
   - **Honest limit:** Because the scan uses the bank's names and aliases as its food dictionary, a
     food word absent from the ~3,000-item bank could slip through prose; there is no second LLM
     checker pass.

### 3.3 Dish pictures via local ComfyUI (`wyr_images.py` & `cookout_images.py`)

- **Text first, pictures second:** As soon as `concepts` validates, `finish_cookout_concepts`
  stores `concepts = 'ready'` and publishes `message_updated` so the three titles and descriptions
  appear immediately. In the same transaction (when `ComfyImageGenerator` is configured), it sets
  `images = 'pending'`, `images_started_at = now`, `images_tries = 1`, `images_deadline_at = now + 600`.
- **Single ComfyUI graph with 3 sampling chains (`generate_many`):**
  - `ComfyImageGenerator` in `wixy_server/livechat/wyr_images.py` gains
    `generate_many(self, prompts: Sequence[str], out_dir: Path, *, seeds: Sequence[int] | None = None) -> list[Path | None]`
    for `1..3` prompts. It loads `UNETLoader` (`"1"`), `CLIPLoader` (`"2"`), and `VAELoader` (`"3"`)
    **once** and wires `len(prompts)` sampling chains (`CLIPTextEncode` → `EmptySD3LatentImage` →
    `KSampler` → `VAEDecode` → `SaveImage`) at node-ID bases `10, 20, 30` in a single `/prompt`
    submission (`1024×1024`, `DEFAULT_IMAGE_MODEL = "krea2-turbo-nvfp4"`).
  - `generate_pair` remains a thin wrapper around `generate_many([prompt_a, prompt_b], ...)` that
    raises `WyrImageError` if either slot is `None`, so Would-You-Rather is completely untouched.
- **Reuse `wyr_` prefix (Inv 54):**
  - Keep `FILE_PREFIX = "wyr_"` (`wyr_<run_id>_0`, `wyr_<run_id>_1`, `wyr_<run_id>_2`) so the
    existing ComfyUI history/output sweeper (`purge_leftovers`, `sweep_leftovers`, `_forget_run`)
    automatically cleans up Cookout runs with zero new sweep prefix risk.
- **Server-built deterministic image prompt:**
  ```text
  Photorealistic appetising food photograph of "<concept.title>", one finished cooked serving made with <resolved pickedIngredientIds + stapleIds names>. Rustic home-cooked presentation, natural kitchen light, simple ceramic plate, shallow depth of field, no people, no hands, no raw-ingredient collage, no unlisted side dishes, no text, labels, logos, or watermark.
  ```
- **Shared GPU limiter, partial success & self-healing:**
  - Runs under the existing `wyr_image_limiter` (`CapacityLimiter(1)`) and increments
    `WyrDemand.count` (`demand.count += 1` / `demand.count -= 1` in `try/finally`) so background WYR
    pool fill yields immediately.
  - Each non-null PNG returned by `generate_many` is staged via `server/cookout-tmp/` and attached
    to the anchor message as an ordinary private `photo` attachment (excluded from `list_gallery`
    and bumping `cookout_rounds.rev` in `finish_attachment`, matching `adv_rounds`).
  - `cookout_rounds.pictures` stores the JSON map `{"a": att_id, "b": att_id, "c": att_id}` for all
    slots that succeeded. If all 3 slots are present, `images = 'done'`; if 1 or 2 slots succeeded
    and the rest failed, those successful attachments are **kept** and `images = 'failed'` so
    `POST /cookout/{seq}/pictures/retry` generates only the missing slot(s) (`1..3` prompts) and
    merges them into `pictures`.
  - Orphaned `images = 'pending'` waits self-heal via `images_started_at` and `images_tries`
    (`MAX_PICTURE_TRIES = 3`, supervised 60 s sweep, matching `adventure_pack.py`).

### 3.4 Stage 2: "Bank this" full-recipe job (`cookout_ai.py`) and Recipe book

- **Save intent → full recipe → `banked`:**
  - Tapping **Bank this** on concept `conceptId ∈ {"a", "b", "c"}` calls
    `POST /cookout/{seq}/concepts/{conceptId}/bank` `{sender, moveId}`.
  - Creates/updates `cookout_recipes(anchor_message_seq, concept_id)` with `state = 'pending'` (or
    `'unavailable'` in standalone), `requested_by = sender`, `bank_move_id = moveId`,
    `started_at = now`, `tries = 1`, `deadline_at = now + 900`, and spawns a hidden cmd run
    (`caller: "wixy-cookout-recipe"`, `model: "claude-sonnet-5-5"`, `effort: "medium"`, all tools
    disallowed).
  - Input to the prompt: the concept's `title`, `vibe`, `dishType`, `technique`, `description`, and
    its frozen manifest of resolved `pickedIngredientIds` and `stapleIds` (plus `water`, `salt`,
    `black-pepper`).
- **Full-recipe JSON schema (`cookout_recipes.recipe_json`):**
  ```json
  {
    "serves": 2,
    "prepMinutes": 15,
    "cookMinutes": 20,
    "ingredients": [
      { "id": "ribeye-steak", "quantity": "2 steaks (approx. 220g each)", "note": "room temperature" },
      { "id": "thick-white-toast", "quantity": "2 thick slices", "note": "toasted golden" },
      { "id": "butter", "quantity": "2 tbsp", "note": "unsalted" }
    ],
    "steps": [
      {
        "text": "Pat the ribeye steaks dry and season all over with smoked paprika, salt, and black pepper.",
        "minutes": 3,
        "uses": ["ribeye-steak", "smoked-paprika", "salt", "black-pepper"]
      }
    ],
    "tips": [
      "Resting the steak directly on the buttered toast lets the bread soak up every drop of espresso glaze."
    ]
  }
  ```
- **Validation (`parse_recipe`):**
  - `serves` must be `2`; `prepMinutes` (`0..240`), `cookMinutes` (`0..480`), with
    `totalMinutes = prepMinutes + cookMinutes` (`1..720`) computed by the server.
  - `ingredients` (`1..24` unique IDs): must cover every ID in `concept.pickedIngredientIds` and
    `concept.stapleIds`, and may only additionally include `water`, `salt`, or `black-pepper`. Each
    item has `quantity` (`1..80` chars) and `note` (`0..120` chars).
  - `steps` (`2..20` items): `text` (`1..600` chars), `minutes` (`0..480 | null`), `uses` subset of
    the recipe's ingredient IDs; every listed ingredient ID must appear in at least one step's
    `uses`. `tips`: `0..4` strings (`1..240` chars each).
  - Runs the same lexical contraband scan (§3.2) over `quantity`, `note`, `steps[].text`, and
    `tips[]`, with at most one repair run on failure.
  - On validation success, compare-and-set transitions `cookout_recipes.state = 'banked'` and stamps
    `banked_at = now`. Only `state = 'banked'` rows appear in `GET /cookout/bank`.

### 3.5 Restarts, self-healing, standalone edition, and privacy

- **Startup & supervised sweep:** Following `adventure_pack.py`, at startup and on a supervised
  periodic sweep every `pending` concept or recipe row with a persisted `run_id` resumes polling
  that cmd run; a `pending` row without a `run_id` (or whose run died before completion and
  `tries < 2` within `deadline_at`) starts/retries cleanly. All completions are compare-and-set on
  `(state = 'pending' AND run_id = ?)`.
- **Shared cmd spawn pacing:** `CookoutRunner` uses `CapacityLimiter(2)` and a `5.0 s` minimum gap
  between `spawn_run` calls.
- **Standalone edition:** When the AI backend is not `cmd`, the game remains playable (`picking` and
  the 10-ingredient reveal work); `concepts` and any `bank` request immediately become
  `unavailable`, and `images` stays `none`.
- **Privacy (Inv 57):** All Cookout state (`cookout_rounds`, `cookout_turns`, `cookout_recipes`, and
  anchor photo attachments) is chat content — erased on anchor message delete (`ON DELETE CASCADE`)
  and on chat wipe (`store._wipe`). As with Adventure Time (Inv 56), `cmd` retains its own hidden
  `chat-spawn` record of each food-only concept/recipe run (which contains only static bank
  ingredient names/IDs and no user or chat identifiers, though its timestamp indicates a round was
  played then).

---

## 4. Server

### 4.1 Schema v21 (`store.py`, additive; v20 is deployed and never edited)

Bump `_LATEST_SCHEMA_VERSION = 21` and add `_SCHEMA_V21_COOKOUT`:

```sql
CREATE TABLE IF NOT EXISTS cookout_rounds(
  anchor_message_seq INTEGER PRIMARY KEY REFERENCES messages(seq) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('picking','finished','abandoned')),
  blind INTEGER NOT NULL DEFAULT 0 CHECK(blind IN (0, 1)),
  started_by TEXT NOT NULL,
  player1_key TEXT NOT NULL, player1_name TEXT NOT NULL, player1_email TEXT,
  player2_key TEXT, player2_name TEXT, player2_email TEXT,
  role_schedule TEXT NOT NULL,
  concepts TEXT NOT NULL DEFAULT 'none'
    CHECK(concepts IN ('none','pending','ready','failed','unavailable')),
  concepts_run_id TEXT, concepts_json TEXT, concepts_error TEXT,
  concepts_started_at REAL, concepts_tries INTEGER NOT NULL DEFAULT 0,
  concepts_deadline_at REAL,
  images TEXT NOT NULL DEFAULT 'none' CHECK(images IN ('none','pending','done','failed')),
  pictures TEXT,
  images_started_at REAL, images_tries INTEGER NOT NULL DEFAULT 0,
  images_deadline_at REAL,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cookout_rounds_state ON cookout_rounds(state);

CREATE TABLE IF NOT EXISTS cookout_turns(
  anchor_message_seq INTEGER NOT NULL
    REFERENCES cookout_rounds(anchor_message_seq) ON DELETE CASCADE,
  turn INTEGER NOT NULL CHECK(turn BETWEEN 1 AND 10),
  player INTEGER NOT NULL CHECK(player IN (1, 2)),
  offers TEXT NOT NULL,
  choice_id TEXT,
  skip_move_ids TEXT NOT NULL DEFAULT '[]',
  pick_move_id TEXT,
  PRIMARY KEY(anchor_message_seq, turn)
);

CREATE TABLE IF NOT EXISTS cookout_recipes(
  anchor_message_seq INTEGER NOT NULL
    REFERENCES cookout_rounds(anchor_message_seq) ON DELETE CASCADE,
  concept_id TEXT NOT NULL CHECK(concept_id IN ('a','b','c')),
  state TEXT NOT NULL CHECK(state IN ('pending','banked','failed','unavailable')),
  run_id TEXT, recipe_json TEXT, error TEXT,
  requested_by TEXT NOT NULL, bank_move_id TEXT,
  started_at REAL, tries INTEGER NOT NULL DEFAULT 0, deadline_at REAL,
  banked_at REAL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
  PRIMARY KEY(anchor_message_seq, concept_id)
);
CREATE INDEX IF NOT EXISTS idx_cookout_recipes_banked
  ON cookout_recipes(state, banked_at DESC, anchor_message_seq DESC);
```

- `store._wipe` explicitly deletes `cookout_recipes`, `cookout_turns`, and `cookout_rounds` before
  `DELETE FROM messages`.
- `create_message(..., wyr_anchor_seq=)` accepts a Would-You-Rather, Adventure Time, or Cookout
  anchor (`404` otherwise), and `models.py` widens `wyrRef.kind` / `wyrRefKind` to
  `"wyr" | "adventure" | "cookout"`.
- `finish_attachment` bumps `cookout_rounds.rev` and publishes `message_updated` when a Cookout
  anchor attachment finishes processing; `list_gallery` excludes
  `SELECT anchor_message_seq FROM cookout_rounds`.

### 4.2 Wire (`/api/admin/server/cookout*`)

- `Message.cookout = {state, blind, pickedCount, concepts, bankedCount, rev} | null` (joined at read
  time like `wyr` and `adventure`; contains zero ingredient or recipe data).
- `POST /api/admin/server/cookout` `{clientId, deviceId, sender, blind?: bool}` → `201 {message}`
  (`200` on a replayed `clientId`). Abandons any open `picking` Cookout round (§1.4), creates the
  text-less anchor message, binds Slot 1, and draws Turn 1's initial pair.
- `GET /api/admin/server/cookout/bank` (declared BEFORE `/cookout/{seq}`) →
  `{recipes: [{seq, conceptId, title, vibe, description, serves, prepMinutes, cookMinutes, totalMinutes, bankedAt, requestedBy, picture: Picture|null}]}`
  ordered by `banked_at DESC, anchor_message_seq DESC, concept_id ASC` (`state = 'banked'` only).
- `GET /api/admin/server/cookout/{seq}?as=<sender>` → `200 CookoutView` (`Cache-Control: no-store`):
  ```text
  {
    seq, state: "picking" | "finished" | "abandoned", rev, blind: bool, revealed: bool,
    players: [
      { slot: 1, name: string, pickCount: 0..5, picks: [IngredientSnap] | null },
      { slot: 2, name: string | null, pickCount: 0..5, picks: [IngredientSnap] | null }
    ],
    you: { slot: 1 | 2 } | null,
    current: {
      turn: 1..10, player: 1 | 2, role: "base"|"protein"|"produce"|"accent",
      waitingForJoin: bool,
      options: [IngredientSnap, IngredientSnap] | null,
      offerIndex: 0 | 1 | 2 | null,
      skipsRemaining: 0 | 1 | 2 | null
    } | null,
    history: [{ turn: 1..10, player: 1 | 2, offers: [[IngredientSnap, IngredientSnap], ...], choice: IngredientSnap | null }],
    staples: [{ id, name }],
    concepts: {
      state: "none"|"pending"|"ready"|"failed"|"unavailable",
      data: [{
        id: "a"|"b"|"c", title, vibe, dishType, technique, description,
        pickedIngredients: [IngredientSnap],
        staplesUsed: [{ id, name }],
        omitted: [{ ingredient: IngredientSnap, reason: string }]
      }] | null,
      error: string | null
    },
    images: {
      state: "none"|"pending"|"done"|"failed",
      pictures: { a: Picture | null, b: Picture | null, c: Picture | null }
    },
    recipes: {
      a: RecipeSlot, b: RecipeSlot, c: RecipeSlot
    }
  }
  ```
  where `IngredientSnap = {id, name, category, emoji, blurb}`, `Picture = {attachmentId, thumbUrl, fullUrl}`,
  and `RecipeSlot = {state: "none"|"pending"|"banked"|"failed"|"unavailable", requestedBy: string|null, bankedAt: number|null, error: string|null, data: FullRecipe|null}`.
- `POST /api/admin/server/cookout/{seq}/join` `{sender}` → `200 CookoutView`. Binds Slot 2 (and if
  the round is waiting at Turn 2 without a pair yet, draws Turn 2's initial pair).
- `POST /api/admin/server/cookout/{seq}/skip` `{sender, moveId, turn, offer}` → `200 CookoutView`.
  Validates active slot, `turn`, `offer ∈ {0, 1}`, draws and appends the next pair. `409 skip_exhausted`
  when `offer == 2`.
- `POST /api/admin/server/cookout/{seq}/pick` `{sender, moveId, turn, offer, ingredientId}` →
  `200 CookoutView`. Validates active slot, `turn`, `offer`, and `ingredientId ∈ offers[offer]`;
  advances to `turn + 1` or transitions `turn == 10` to `finished` and starts Stage 1 concepts.
- `POST /api/admin/server/cookout/{seq}/abandon` `{sender}` → `200 CookoutView`. Marks an open
  `picking` round as `abandoned` (`409 bad_state` if already `finished`).
- `POST /api/admin/server/cookout/{seq}/concepts/retry` `{sender}` → `200 CookoutView` (when
  `concepts` is `failed`, or `unavailable` and a runner now exists).
- `POST /api/admin/server/cookout/{seq}/pictures/retry` `{sender}` → `200 CookoutView` (when
  `concepts == 'ready'`, any picture slot `a`/`b`/`c` is missing, and `images != 'pending'`).
- `POST /api/admin/server/cookout/{seq}/concepts/{conceptId}/bank` `{sender, moveId}` →
  `200 CookoutView` (when `concepts == 'ready'`; starts the Stage-2 full-recipe job for `conceptId`).
- `POST /api/admin/server/cookout/{seq}/concepts/{conceptId}/recipe/retry` `{sender}` →
  `200 CookoutView` (when `recipes[conceptId].state` is `failed` or `unavailable`).
- Standard errors: `404 not_found`, `409 bad_state`, `409 not_your_turn`, `409 not_player`,
  `409 skip_exhausted`, `409 exhausted`, `422 invalid`, `503 game_unavailable`. Every mutation
   response is filtered through `cookout_view_json` for the caller and sets `Cache-Control: no-store`.

---

## 5. Client

### 5.1 Shared game frame (`gameTabs.ts` and `itemChat.ts`)

- `gameTabs.ts`: widen `GameKey` to `"wyr" | "adventure" | "cookout"`. The bottom bar holds **Chat**
  + the ONE open game tab; opening or offering Cookout closes any open WYR or Adventure tab via
  `replaceOthers` (no WYR or Adventure behaviour change).
- `itemChat.ts`: shared 60 px mini-chat strip and pop-up (`openPopup(seq, "Cookout chat")`), tagged
  `"Cookout"` in the main thread (`gameLabelFor` in `thread.ts`).

### 5.2 Cookout modules (`admin-ui/src/server/cookout/`)

`api.ts` (strict defensive parsers + REST calls), `model.ts` (per-round view cache, monotonic `rev`
guard, exponential poll backoff while `concepts`, `images`, or any `recipes[id]` is `pending`),
`cookoutGame.ts` (the pane + start sheet), `cookoutCard.ts` (main-chat bubble card),
`recipeBook.ts` (full-height Recipe book screen, following `holidayBank.ts`).

### 5.3 The pane (top to bottom, 360 px phone-first)

`[ 🍳 Cookout   (Blind badge)   Recipe book   End game / New   ✕ ]` →
- **Basket progress & turn banner:** 10 compact slot pills (5 for Player 1, 5 for Player 2) + clear
  turn prompt (`"Your turn — Pick 2 of 5 (Go 1 of 3)"` or `"Waiting for Cupcake — Pick 2 of 5"`).
  When Slot 2 is unbound and the viewer is not Player 1, shows a primary **Join Cookout** button.
- **Drafting stage (`state == "picking"`):**
  - When `current.options` is non-null: two stacked tactile ingredient cards (side-by-side on wider
    screens) showing category emoji + category badge, bold ingredient `name`, and `blurb`, with
    **Pick this** action; below them sits the full-width skip button:
    - `offerIndex == 0`: **"Neither — deal 2 new options (2 skips left)"**
    - `offerIndex == 1`: **"Neither — deal final 2 options (1 skip left)"**
    - `offerIndex == 2`: disabled/hidden badge **"Final pair — pick one of the two above"**
  - When `current.options` is `null` in Blind mode (partner's turn or waiting for Join): shows a
    covered cloche state card (*"🕵️ Secret turn: <partner> is choosing…"*), with zero ingredient
    strings anywhere in the DOM.
- **Basket tray:** Collapsible strip showing selected ingredients (or `🔒 Secret pick` cards for the
  partner in Blind mode until `finished`, when all 10 flip open together) plus a one-line footer
  listing the 8 cupboard staples.
- **Chef stage (`state == "finished"`):**
  - Revealed 10-ingredient basket banner at the top.
  - While `concepts.state == "pending"`: *"Chef is inventing 3 dishes from your 10 ingredients…"*
    with elapsed timer; if `failed` or `unavailable`, a clear message and **Try again** button.
  - When `concepts.state == "ready"`: **three vertical concept cards** (3-column grid on wide
    screens). Each card has:
    1. **Picture header** above the text: shows the signed ComfyUI dish photo (`thumbUrl`, tap →
       full-screen viewer with `fullUrl`), or a shimmering plate placeholder while
       `images.state == "pending"`, or a clean styled header with **Retry picture** when a slot is
       missing.
    2. **Title, vibe badge & description:** `title`, `vibe` + `dishType`/`technique` pills,
       `description`, used-ingredient count + chips (`"Uses 9/10"` + `"Staples: butter, salt"`), and
       any `omitted` reasons in a subtle note.
    3. **Banking controls & full recipe view:**
       - `recipes[id].state == "none"`: **"Bank this ✓"** button.
       - `recipes[id].state == "pending"`: **"Writing recipe…"** spinner state.
       - `recipes[id].state == "failed" | "unavailable"`: **"Recipe didn't finish — Try again"**.
       - `recipes[id].state == "banked"`: **"Banked ✓ — View full recipe"** badge + expandable/sheet
         recipe view displaying `Serves 2`, `prepMinutes` / `cookMinutes` / `totalMinutes`,
         checkable ingredient quantities list, numbered method steps, and chef tips.
- **Shared mini chat strip (`itemChat.ts`)** → shared composer.
- Gesture boundaries (`data-srv-gesture-boundary`) on interactive controls; Escape remains the panic
  key; no idle-lock suspension during AI/ComfyUI waits (Inv 43/55).

### 5.4 Start sheet, main-chat card, Recipe book, and `⋯` menu

- **`⋯` menu (`thread.ts`):** Adds **Cookout** — *"Pick 10 ingredients, see what the chef invents"*
  (which opens a compact start sheet with **Open mode** [default] / **Blind mode** and **Start
  Cookout**), and **Recipe book** — *"Dishes you've banked together"*. Pressing **New** inside the
  Cookout pane opens the same start sheet with the current round's mode preselected.
- **Main-chat card (`cookoutCard.ts`):** Compact summary card on the anchor message showing mode
  badge (`Open` / `Blind`), status line (`"Picking ingredients (4/10)…"`, `"All 10 picked — chef is
  thinking…"`, `"3 dish ideas ready"`, `"1 recipe banked ✓"`, or `"Ended"`), and an **Open** button
  that opens the Cookout tab.
- **Recipe book (`recipeBook.ts`):** Full-height screen below the chat header (like `holidayBank.ts`,
  closed on lock/wipe) listing completed `banked` recipes newest `bankedAt` first (thumbnail, title,
  vibe, total time, `Serves 2`). Tapping an entry loads old message history if needed and opens the
  Cookout tab directly to that concept's full recipe and mini chat.

---

## 6. Tests (all must exist and pass)

- **pytest** `test_cookout_bank.py`: runs `tooling/cookout/validate_bank.py` over the committed
  `cookout_ingredients.json` (2,500–4,000 items, 15 categories, 4 roles, ≥ 200 items & ≥ 30 everyday
  families per role, unique normalized names/aliases, 8 staples contract, stop-words list, and 500
  simulated maximum-skip 60-item rounds without exhaustion) plus negative fixtures.
- **pytest** `test_livechat_cookout.py`: migration v20→v21 from a real v20 DB; round creation in
  `picking` with Turn 1 drawn; explicit `/join` binding Slot 2 (both before and after Turn 1's pick,
  verifying Turn 2 is never drawn before Join); strict turn alternation; 2 skips per turn (3rd skip
  returns `409 skip_exhausted`, pick resets next turn's skips to 2); Open vs. Blind redaction in
  `cookout_view_json` (partner options, picks, and history `null` while `picking`; all 10 selected
  picks revealed on `finished`; partner skipped offers stay hidden even when `finished`; `abandoned`
  blind round never reveals; `Cache-Control: no-store`); `_slot_of` email verification; `moveId`
  idempotent replays on `skip`, `pick`, and `bank`; `clientId` replay on `create`; abandonment on
  new round and `/abandon` (never abandoning `finished`); anchor delete cascade and `store._wipe`
  clearing `cookout_recipes`, `cookout_turns`, `cookout_rounds`; `wyrSeq` accepted for Cookout
  anchors (`wyrRefKind = "cookout"`).
- **pytest** `test_livechat_cookout_ai.py` & `test_livechat_cookout_images.py`: `parse_concepts` and
  `parse_recipe` structural checks, coverage rules (≥ 7 each, at least one ≥ 8, union = 10, exact
  `omitted` complement, ≤ 4 non-seasoning staples, distinct `(dishType, technique)` pairs),
  deterministic lexical contraband scan (rejecting unpicked bank foods like `"mango"` or `"bacon"`
  in titles/descriptions/steps while permitting picked items, their families, staples, and
  `stopWords`), one-repair-run feedback loop, startup resume and compare-and-set completion,
  standalone `unavailable` mode, `ComfyImageGenerator.generate_many(1..3)` with `wyr_` prefix
  cleanup, partial-success attachment persistence + missing-slot `/pictures/retry`, Gallery
  exclusion, and `images_started_at`/`images_tries` self-healing.
- **vitest** (`admin-ui/src/server/__tests__/`): `cookout/api.test.ts` (defensive parsers),
  `cookout/model.test.ts` (rev monotonicity, pending poll backoff), `cookout/cookoutGame.test.ts`
  (start sheet, Join button, 2-skip button states, Blind cloche view with zero leaked DOM strings,
  10-pick reveal, 3 concept cards, independent `Bank this` → `Writing recipe…` → `Banked ✓` full
  recipe view), `cookout/cookoutCard.test.ts`, `cookout/recipeBook.test.ts`, and `gameTabs.test.ts`
  (`GameKey = "wyr" | "adventure" | "cookout"`).
- **e2e** `e2e/tests/server-cookout.spec.ts`: two players in separate browser contexts; start a
  Blind Cookout from the `⋯` menu start sheet, Player 1 picks Turn 1 immediately, Player 2 joins and
  uses 2 skips before picking on Turn 2 (verifying the 3rd skip is disabled and Player 1's DOM never
  contains Player 2's secret options or picks), complete all 10 picks, verify the simultaneous
  10-ingredient reveal and canned 3 concepts + pictures from `fake_cmd.py`, send a mini-chat message
  and open the pop-up, tap **Bank this** on a concept, verify full recipe rendering and the **Recipe
  book** screen, and check 360 px mobile layout alongside WYR and Adventure tabs.

---

## 7. Docs to update in the same change

`docs/ai/livechat.md` (new §24 for Cookout + updated game frame notes), `docs/ai/contracts.md`
(`/api/admin/server/cookout*` routes, `Message.cookout`, `wyrRefKind = "cookout"`),
`docs/ai/invariants.md` (**Inv 57** — a Cookout round and its banked recipes/pictures are anchor-owned
chat content erased on delete/wipe; Blind mode's server-side redaction, `_slot_of` shared-email
honest limit, and non-reveal on abandon; deterministic lexical contraband scan honest limit; `cmd`'s
retained food-only run copy; ComfyUI `wyr_` cleanup under Inv 54), `docs/ai/glossary.md` (Cookout
states), `docs/ai/testing.md`, `CLAUDE.md` store table (`cookout_rounds`, `cookout_turns`,
`cookout_recipes` at schema v21), and `decisions/00193-server-chat-cookout/`.
Commits carry `Release-note: General bug fixes and improvements.` (R14a: Server chat stays discreet).

---

## Appendix A. Parcel plan and frozen interfaces

To prevent merge conflicts across parallel builders, every shared file has a **single owner**:

| Parcel | Builder | Exclusive File Ownership | Depends On |
|---|---|---|---|
| **P1 — Static Ingredient Bank & Draw Engine** | **Sonnet 5.5** | `wixy_server/livechat/cookout_ingredients.json`, `wixy_server/livechat/cookout_bank.py`, `tooling/cookout/validate_bank.py`, `wixy_server/tests/test_cookout_bank.py` | Frozen `CookoutBank` interface below (exports a 60-item test fixture immediately while authoring the ~3,000-item JSON) |
| **P2 — Store v21, Game State, Routes & App Wiring** | **Sonnet 5.5** | **Sole owner** of `wixy_server/livechat/store.py`, `wixy_server/livechat/models.py`, `wixy_server/livechat/cookout_game.py`, `wixy_server/routes_livechat_cookout.py`, `wixy_server/app.py`, `wixy_server/tests/test_livechat_cookout.py` | Frozen `CookoutBank` & `CookoutRunner` protocols (uses lightweight fakes in unit tests so P2 and P3 build in parallel) |
| **P3 — AI Concept/Recipe Runner & ComfyUI Pictures** | **Sonnet 5.5** | **Sole owner** of `wixy_server/livechat/cookout_ai.py`, `wixy_server/livechat/cookout_images.py`, `wixy_server/livechat/wyr_images.py` (`generate_many`), `wixy_server/tests/fake_cmd.py`, `wixy_server/tests/test_livechat_cookout_ai.py`, `wixy_server/tests/test_livechat_cookout_images.py` | Frozen `CookoutBank` & P2 store methods below (never edits `store.py`, `models.py`, or `app.py`) |
| **P4 — Admin UI (Pane, Card, Recipe Book & Frame)** | **Opus 5.5** | **Sole owner** of `admin-ui/src/server/cookout/{api.ts, model.ts, cookoutGame.ts, cookoutCard.ts, recipeBook.ts}`, `admin-ui/src/server/{gameTabs.ts, thread.ts, api/messages.ts}`, `admin-ui/src/styles/livechat.css`, `admin-ui/src/server/__tests__/cookout*.test.ts`, and rebuilt `wixy_server/static/admin/*` bundles | §4.2 wire contract & §5.1 TS interfaces (builds in parallel against JSON fixtures) |
| **P5 — Docs, Invariant 57 & Playwright E2E** | **Sonnet 5.5** | `e2e/tests/server-cookout.spec.ts`, `docs/ai/{livechat.md, contracts.md, invariants.md, glossary.md, testing.md}`, `CLAUDE.md` store table, `decisions/00193-server-chat-cookout/` | Drafts docs in parallel; runs full-stack E2E once P1–P4 integrate |

### A.1 Frozen Python interface — P1 (`wixy_server/livechat/cookout_bank.py`)

```python
RoleKey = Literal["base", "protein", "produce", "accent"]
RarityKey = Literal["everyday", "uncommon", "exotic"]

@dataclass(frozen=True, slots=True)
class Ingredient:
    id: str
    name: str
    aliases: tuple[str, ...]
    category: str
    category_name: str
    emoji: str
    role: RoleKey
    family: str
    rarity: RarityKey
    blurb: str

    def to_snapshot(self) -> dict[str, str]:
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "emoji": self.emoji,
            "family": self.family,
            "blurb": self.blurb,
        }

@dataclass(frozen=True, slots=True)
class Staple:
    id: str
    name: str
    pickable: bool

class CookoutBank:
    def ingredient(self, ingredient_id: str) -> Ingredient | None: ...
    def staple(self, staple_id: str) -> Staple | None: ...
    @property
    def ingredients(self) -> tuple[Ingredient, ...]: ...
    @property
    def staples(self) -> tuple[Staple, ...]: ...
    @property
    def stop_words(self) -> frozenset[str]: ...
    def shuffle_role_schedule(
        self, rng: random.Random | None = None
    ) -> tuple[RoleKey, RoleKey, RoleKey, RoleKey, RoleKey]: ...
    def draw_pair(
        self,
        *,
        role: RoleKey,
        seen_ids: AbstractSet[str],
        picked_families: AbstractSet[str],
        offered_families: AbstractSet[str],
        player_offered_categories: Sequence[str],
        rng: random.Random | None = None,
    ) -> tuple[Ingredient, Ingredient]: ...
    def find_contraband_ingredients(
        self,
        text: str,
        *,
        allowed_ingredient_ids: AbstractSet[str],
        allowed_staple_ids: AbstractSet[str],
    ) -> list[str]: ...

def load_cookout_bank(path: Path | None = None) -> CookoutBank: ...
def load_cookout_bank_or_empty(path: Path | None = None) -> CookoutBank: ...
```

### A.2 Frozen Python interface — P2 (`store.py`) ↔ P3 (`cookout_ai.py`, `cookout_images.py`)

P2 provides these exact store methods for P3's runners:

```python
# Stage 1 concepts
def get_cookout_round(self, anchor_seq: int) -> dict[str, Any] | None: ...
def set_cookout_concepts_run(
    self, anchor_seq: int, run_id: str, *, expected_run_id: str | None = None
) -> bool: ...
def finish_cookout_concepts(
    self,
    anchor_seq: int,
    run_id: str | None,
    state: Literal["ready", "failed", "unavailable"],
    *,
    concepts_json: str | None = None,
    error: str | None = None,
    pictures_pending: bool = False,
) -> bool: ...
def cookout_pending_concepts(self) -> list[tuple[int, str | None]]: ...

# ComfyUI pictures (partial-success aware)
def claim_cookout_pictures(
    self, anchor_seq: int, *, stale_before: float | None, now: float
) -> Literal["claimed", "not_due", "gave_up", "gone"]: ...
def store_cookout_pictures(
    self,
    anchor_seq: int,
    slot_uploads: Mapping[str, tuple[str, int]],  # slot ("a"|"b"|"c") -> (upload_id, byte_size)
    by_email: str | None,
    *,
    all_done: bool,
    now: float,
) -> bool: ...
def fail_cookout_pictures(self, anchor_seq: int, *, now: float) -> bool: ...
def cookout_stale_pictures(self, *, stale_before: float) -> list[int]: ...

# Stage 2 full recipes
def set_cookout_recipe_run(
    self, anchor_seq: int, concept_id: str, run_id: str, *, expected_run_id: str | None = None
) -> bool: ...
def finish_cookout_recipe(
    self,
    anchor_seq: int,
    concept_id: str,
    run_id: str | None,
    state: Literal["banked", "failed", "unavailable"],
    *,
    recipe_json: str | None = None,
    error: str | None = None,
) -> bool: ...
def cookout_pending_recipes(self) -> list[tuple[int, str, str | None]]: ...
```

And P3 exports `CookoutRunner` (injected into `create_app(..., cookout_runner=...)` in `app.py`):

```python
class CookoutRunner(Protocol):
    @property
    def available(self) -> bool: ...
    @property
    def images_available(self) -> bool: ...
    def start_concepts(self, background: ContainedTaskGroup, anchor_seq: int) -> None: ...
    def start_pictures(self, background: ContainedTaskGroup, anchor_seq: int) -> None: ...
    def start_recipe(
        self, background: ContainedTaskGroup, anchor_seq: int, concept_id: str
    ) -> None: ...
    async def resume(self, background: ContainedTaskGroup) -> None: ...
    def supervise(self, background: ContainedTaskGroup) -> None: ...
```
