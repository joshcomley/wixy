# Cookout — Kimi round-1 proposal

This is a decided spec draft for `spec/server-chat/09-cookout.md`, not a loose idea list. It follows the
Adventure Time spec's shape and the code as it exists today. In particular, the ⋯ menu is actually built
in `admin-ui/src/server/thread.ts`, not `panel.ts`; the shared game frame is real (`createGameTabs` and
`createItemChat`), and the current schema really is v20 (`store.py::_LATEST_SCHEMA_VERSION`).

Code precedents this design relies on:

- `wixy_server/livechat/wyr_game.py::wyr_view_json` and `_slot_of` for server-side, per-viewer hiding and
  player identity; a hidden value must never be sent to a browser merely with instructions not to draw it.
- `wixy_server/livechat/store.py`'s `_write_txn`, `_adv_update`, `create_adventure_round`, and wipe path for
  write-lock serialization, one `message_updated` per real change, anchor cascade, and explicit wipe.
- `wixy_server/livechat/adventure_pack.py::{CmdAdventureResearcher,AdventurePackRunner,parse_pack}` for a
  hidden cmd chat-spawn run, defensive JSON, bounded polling, retry, restart resume, and compare-and-set
  completion. `cmdchat.py` remains the only cmd chokepoint.
- `wixy_server/livechat/wyr_images.py::ComfyImageGenerator` for local Krea 2 Turbo images and, critically,
  output/history cleanup. Its current `wyr_` prefix and two-image `generate_pair` must be generalized, not
  blindly reused: Cookout needs three images and its own tracked `cookout_` prefix.
- `admin-ui/src/server/gameTabs.ts`, `itemChat.ts`, `wyrGame.ts`, `adventure/model.ts`,
  `adventure/adventureCard.ts`, and `adventure/holidayBank.ts` for the tab, mini chat, model, card, and
  full-height bank patterns.
- `adventure_bank.py::load_bank_or_empty` and `wixy_server/tests/test_adventure_bank.py` for a strict static
  bank loader plus an offline committed-data validator.

---

## A. Core game design — `spec/server-chat/09-cookout.md` draft

### 1. The game in one paragraph

One person starts Cookout, optionally in blind mode, and is player 1. The other joins as player 2. Player 1
takes the first turn. On each turn the server offers two ingredients; the player picks one, or rejects the
pair and gets another. They may reject at most two pairs, so the third pair is a forced choice. A skip never
passes the turn. Players alternate until they have five picks each (ten picks together). Blind mode then
reveals the ten selected ingredients. Three different AI recipe concepts arrive, each with a description and
later a generated picture. Either person can bank any concept independently; banking asks AI for the full
quantities, method, timings, and serving count, then puts it in the shared Recipe book.

### 2. Flow and state machine

```text
waiting  --player 2 joins-->  picking  --tenth pick-->  finished
waiting|picking  --a new Cookout starts-->  abandoned

finished.concepts: none -> pending -> ready | failed | unavailable
                         failed|unavailable --retry--> pending
finished.images:   none -> pending -> done | failed
                         failed --retry--> pending
per concept recipe: none -> pending -> banked | failed | unavailable
                         failed|unavailable --retry--> pending
```

- **Players and first turn.** `POST /cookout` binds the creator to slot 1 and records their normalized name
  key and verified sign-in email, exactly the WYR identity approach. The first other person to POST `join`
  takes slot 2. The creator always goes first; odd turns belong to slot 1, even turns to slot 2. Unlike
  Adventure's free-for-all moves, Cookout is genuinely turn-based: the wrong slot gets `409 not_your_turn`.
- **Five each.** Turns are numbered 1–10. A turn ends only on a pick. Skipping does not increment the turn.
  The final pick moves the round to `finished` and starts the concept job in the same state transition.
- **Skip budget: two PER TURN, not per game.** The operator's "three goes before you have to pick from one
  or the other" describes each presented choice, not a whole-game resource. Offers one, two, and three are
  the three goes; after rejecting offers one and two, offer three has no Skip button. The budget resets to
  two after every pick and unused skips do not carry over. A whole-game budget would let the first turn run
  out of skips later, which is not the stated "before you have to pick" rule.
- **Normal visibility.** Both players see the current pair, every earlier pair, what each person picked, and
  whose turn it is, as the moves happen.
- **Blind visibility.** Before `finished`, a player sees only their own offers and picks. For their partner
  they see name, turn ownership, and `pickCount` (0–5), but not the partner's current pair, offer number,
  skips, earlier pairs, or selected ingredients. On `finished`, both see the complete list of ten SELECTED
  ingredients at once. In blind mode, rejected and skipped options are never revealed to the partner, even
  after the final reveal; only the final basket is. This gives a clean reveal without turning the end screen
  into a dump of every rejected option.
- **Finished is stable.** Banking one concept does not end the round or prevent banking another. A finished
  round and its concepts remain available from its card and the Recipe book.
- **Abandonment.** Starting a new Cookout atomically marks every `waiting` or `picking` Cookout round
  `abandoned`; a `finished` round is never abandoned. The header's New starts a round with the same mode as
  the open one and asks for confirmation only when it would abandon an unfinished round. Closing the tab is
  not abandonment. Deleting the anchor message erases the round; a running job notices on its next poll and
  cancels its cmd run.
- **Standalone.** Picking and the final basket still work. With no cmd-backed recipe runner, the final pick
  stores `concepts = unavailable`; there are no new concepts, images, or bank jobs. Already stored concepts,
  recipes, and images remain readable. A retry becomes available if a backend is later configured.

### 3. Concurrency and idempotent replays

Every game mutation runs inside `BEGIN IMMEDIATE`; time is sampled after acquiring the write lock, following
`store.py`'s Adventure implementation. The store checks the current state, player slot, turn number, and
offer index before changing anything. The first of two racing phones wins; the loser gets `409 bad_state`
(or `not_your_turn`) and re-reads the view.

- Round creation is idempotent on the anchor message's ordinary `clientId`.
- Join is naturally idempotent for the established slot 2. Two different would-be second players race in the
  store; only one row is accepted. The same identity cannot occupy both slots.
- Skip and pick carry `{moveId, turn, offer}` (`moveId` 8–64 chars). `cook_turns.skip_move_ids` and
  `pick_move_id` persist their ids. Replaying a known move returns `200` with the current viewer-filtered
  view and appends no event. A different move aimed at an old turn/offer is `409 bad_state`, so a delayed
  request cannot silently skip a newly drawn pair or pick from an old one.
- Drawing the replacement pair and recording the skip happen in one transaction. A client never supplies
  the replacement ids or a random seed.
- Bank and job-retry actions are state-idempotent: repeating the same request while pending or after success
  returns the current view without spawning another run. A bank request also carries a `moveId`, retained on
  `cook_recipes`, to make the retry contract explicit.
- Every real change bumps the parent round's `rev` and writes one existing `message_updated` event. There is
  no new persisted or live SSE event type. A mutation responds with the fresh view; other screens re-read on
  the summary revision.

### 4. Server-authoritative ingredient draws

The bank and the draw live on the server. A client can request only an id in the exact pair currently offered
to its slot; anything else is `422 invalid`. It cannot request an arbitrary bank ingredient.

#### 4.1 What is excluded

- The two ids in a pair are always different.
- `seen` is the union of every id OFFERED anywhere in the round, whether skipped or picked. No id is offered
  twice in one round, including as the replacement after a skip. Across separate rounds it may appear again.
- Ingredients carry a `family` (`onion`, `citrus`, `chilli`, `rice`, …). The draw avoids two members of one
  family in the same pair where the remaining bank makes that possible, so "red onion vs white onion" does
  not waste a turn. Exact id exclusion is mandatory; family separation is a best-effort variety rule with a
  bounded redraw, never an unbounded loop.

#### 4.2 Category balance and fairness

There are 15 top-level categories. For each player independently, count how many options they have already
been shown in each category (skipped options count too). For each new pair:

1. Restrict to categories with at least one unseen ingredient.
2. Choose category A uniformly, using `secrets.SystemRandom`, from categories at the player's minimum count.
3. Temporarily increment A and choose B the same way, excluding A.
4. Draw one unseen ingredient from each category by weighted random without replacement. Rarity weights are
   `everyday = 8`, `uncommon = 3`, `exotic = 1`. If the B ingredient collides with A's family, make a bounded
   redraw from B, then from another minimum-count category if necessary.
5. Store both ids immediately in `cook_turns.offers`.

With the full bank, this keeps each player's category counts within one of each other after every pair, even
when they skip, so neither player can be dealt a run of spice-only choices. Selecting only spices remains a
valid player choice; the game balances offers, not their agency. Independent category counts plus identical
rarity weights give both players the same draw rules rather than giving the creator the "good" shelf.

A skip performs exactly the same draw against the updated `seen` and category counts. The rejected ids stay
in `seen`. The real bank is large enough that exhaustion is not expected; a bank that cannot produce a legal
pair returns `409 exhausted` without changing the round, and round creation with an unusable bank is `503
game_unavailable`.

### 5. Static ingredient bank

File: `wixy_server/livechat/cookout_ingredients.json`, loaded once by
`wixy_server/livechat/cookout_bank.py`. Target **3,000–4,000 ingredients**, everyday through exotic: parsley,
beef, cream, toast, sugar, and everything in between. Builder agents author the data directly by category;
there is no runtime generation, web dependency, or Anthropic/API call.

#### 5.1 Exact JSON schema

```json
{
  "version": 1,
  "generated": "YYYY-MM-DD",
  "categories": [
    {"id": "vegetables", "name": "Vegetables"}
  ],
  "staples": ["water", "salt", "black-pepper"],
  "ingredients": [
    {
      "id": "red-onion",
      "name": "Red onion",
      "category": "vegetables",
      "family": "onion",
      "rarity": "everyday",
      "tags": ["savoury", "raw", "vegetarian", "vegan"]
    }
  ]
}
```

- `id`: permanent, append-only, lowercase ASCII kebab-case, 2–64 chars, globally unique; never renumber or
  reuse an id. Display names are also unique after trimming, case-folding, and accent-folding.
- `name`: 1–80 chars of trimmed plain text, no markup or control characters.
- `category`: one of exactly these 15 ids: `vegetables`, `fruit`, `meat-poultry`, `fish-seafood`,
  `dairy-eggs`, `grains-bakery`, `legumes-nuts-seeds`, `herbs-aromatics`, `spices-seasonings`,
  `oils-fats-condiments`, `sauces-stocks-fermented`, `sweet-baking`, `drinks-alcohol`, `fungi`,
  `prepared-pantry`. The categories array gives their display names and fixed presentation order.
- `family`: lowercase ASCII kebab-case, 2–48 chars; related forms share one (for example `onion`).
- `rarity`: `everyday | uncommon | exotic`, used only for draw weighting, not as a value judgement.
- `tags`: 0–6 unique values from `savoury`, `sweet`, `raw`, `spicy`, `aromatic`, `baking`, `garnish`,
  `fresh`, `frozen`, `prepared`, `alcohol`, `vegetarian`, `vegan`, `gluten`, `dairy`, `egg`, `nuts`, `soy`,
  `fish`, `shellfish`. Tags are hints for the chef and future twists, not medical/allergen advice.

The validator accepts 2,500–5,000 entries while the intended initial size is about 3,500, requires at least
80 entries per category, and forbids one category holding more than 25% of the bank. This keeps the initial
bank honest without making every later append a schema change.

#### 5.2 Exact staples list

Only these ids may be added by AI when they were not picked:

```text
water, salt, black-pepper, butter, plain-flour, granulated-sugar,
neutral-oil, olive-oil, whole-milk, eggs, baking-powder
```

`neutral-oil` is ordinary vegetable/sunflower oil. There is deliberately no mango, onion, garlic, soy sauce,
stock, wine, herbs, or "whatever the model thinks people have". Staple entries exist in the ordinary bank
and **can also be offered and picked** — the operator explicitly asked for sugar and "everything". If a
picked ingredient is also a staple, it appears in `pickedIngredientIds`, not again in `stapleIds`; the model
may of course use it in the recipe.

#### 5.3 Validation and failure mode

`tooling/cookout/validate_bank.py` is stdlib-only and offline; `test_cookout_bank.py` runs it over the
committed file and tests malformed fixtures. It checks every rule above, including category/tag enums,
unique ids and normalized names, staple references, size bounds, JSON types, and no unexpected keys.
`cookout_bank.load_bank_or_empty` follows `adventure_bank.py`: a broken asset is logged and disables only
Cookout (`503 game_unavailable`), never the whole chat.

### 6. AI concept job

#### 6.1 Start and lifecycle

The tenth pick commits `state = finished`, the final basket, and `concepts = pending` (or `unavailable`) in
one transaction. The route then starts `CookoutConceptRunner` on the app's `ContainedTaskGroup`. Text is the
first product: once three valid concepts are stored, `concepts = ready` and they are published immediately;
pictures are a separate following job.

Use the Adventure runner's discipline: at most two AI runs in flight, spawns at least five seconds apart,
poll every five seconds, `timeout_secs = 600`, give up and cancel after 12 minutes, one retry for a cmd
`error` in the first 150 seconds, and one fresh run for malformed/semantically invalid JSON. A spawn is not
repeated after an uncertain response (`cmdchat._request(connect_errors_only=True)` precedent). A manual
`concepts/retry` starts a clean pending job after failure/unavailability.

Every completion write is compare-and-set on `(concepts = 'pending' AND concepts_run_id = this run)`. At
startup every pending row resumes its recorded run, or starts one if no run id was recorded; without a
backend it becomes `unavailable`. A deleted round lands nothing. Error text is short and generic ("The recipe
ideas didn't finish — try again"), never a raw model/server error.

#### 6.2 Backend and prompt privacy

Fleet: `CmdCookoutResearcher` over the existing `CmdChatClient.spawn_run/get_run/cancel_run`, with
`caller: "wixy-cookout-concepts"`, `model: "claude-sonnet-5-5"`, `effort: "medium"`,
`bucket: "subscription"`, an empty non-git `server/cookout-recipes` cwd, no tag, and ALL tools disallowed,
including `WebSearch` and `WebFetch` as well as Adventure's file/shell/agent list. This is culinary
invention, not research. Standalone: no runner, as in Adventure.

The prompt contains ONLY the static selected ingredient objects (id, name, category, tags) and the static
staple id/name list. It never contains a player's name, who picked what, blind mode, a chat message, a
sign-in, or free text from the chat. cmd retains its hidden run ledger/transcript as with Adventure; the
prompt is a function of the selected static bank ids only, but its timestamp reveals that a Cookout finished
then. That is an honest erasure limit for the new invariant.

Prompt contract (literal requirements):

```text
You are Cookout's playful but competent chef. Invent THREE genuinely different, appetising recipe
concepts from the supplied ingredients. Concept A is the deliberately silly "everything" recipe and
MUST use all ten picked ingredients. Concepts B and C MUST each use at least six, should use as many
as makes a good dish, and should not merely rename concept A. Together, cover every picked ingredient.
You may add only the supplied staples. Never introduce another ingredient, even as a garnish.
Use general culinary knowledge; do not browse. Concepts must be edible and food-safe, but may be fun.
Do not write quantities or method steps yet. British English.

Return exactly one JSON object and no markdown:
{"concepts": [
  {"id": "a"|"b"|"c", "title": string <= 90,
   "description": string <= 500,
   "pickedIngredientIds": [exact selected ids],
   "stapleIds": [exact permitted staple ids]
  }
] (exactly three)}
```

The input lists are JSON, not prose assembled from names. Output ids, not ingredient names, are the machine
contract.

#### 6.3 Validation

Parsing takes the last usable top-level JSON object, clips plain-text strings, drops unknown keys, and then
rejects the WHOLE candidate rather than silently repairing a bad recipe set when any of these fails:

- exactly three concepts, with unique ids `a`, `b`, `c`, non-empty unique titles and descriptions;
- every picked id is one of the ten selected ids, with no duplicates within a concept;
- every staple id is on the exact staples list and is not also in that concept's picked list;
- no other ingredient reference is accepted structurally;
- concept A uses all ten; B and C each use at least six; the union covers all ten;
- B and C each differ from every other concept by at least two picked ingredient ids OR by a clearly
  different description/cooking approach (the model is told this; the pairwise-id check is the mechanical
  part). Titles may not differ only by punctuation/case.

A stored concept is served with its ingredient and staple objects resolved from the static bank. The free
text is still model output, so no validator can prove that prose never mentions another food; the prompt and
structured-ingredient checks are the enforceable boundary, and this is an honest limit rather than a claim
of semantic proof.

### 7. Pictures

One square, photorealistic finished-dish image per concept, generated locally through the existing ComfyUI
service and Krea 2 Turbo. No external image host or image-generation API is involved.

- The server builds each prompt from the validated concept title and exact used ingredient names:

  ```text
  Photorealistic appetising food photograph of "<title>", one finished cooked serving made with
  <exact ingredient names>. Rustic home-cooked presentation, natural light, simple plate, no people,
  no hands, no raw-ingredient collage, no words, labels, logos, or watermark.
  ```

- After concepts are published, one Comfy `/prompt` submission renders all three sampling chains with a
  shared model load. Generalize `ComfyImageGenerator` to accept a namespace (`wyr` or `cookout`) and 1–3
  prompts while leaving `generate_pair`'s WYR call contract intact. Cookout uses `cookout_` filename
  prefixes. Both prefixes are covered by output-file deletion, history deletion, cancellation, and stale
  sweeps; the configured output directory check stays fail-closed (Inv 54 extended by the new invariant).
- Cookout shares the one GPU image limiter with WYR on-demand and pool work, and yields pool filling while
  any on-demand job waits. Do not run three independent GPU jobs in parallel.
- Successful PNGs become ordinary private photo attachments on the round anchor, ordinal 0/1/2 mapped to
  concept a/b/c in `cook_rounds.pictures`. Signed URLs, renditions, quota, and erasure are inherited. The
  Gallery excludes Cookout anchors just as it excludes WYR/Adventure game furniture.
- A concept with no image gets a styled text tile. A partial batch attaches its valid images and leaves the
  others text-only; zero images sets `images = failed`. `images = done` means the job ended, not that every
  slot necessarily has a file. `pictures/retry` retries only missing slots.
- Scratch lives under `server/cookout-tmp` and is always removed by the job; stale directories and Comfy
  leftovers are swept using the WYR age rules. `images_started_at`/`images_tries` plus a supervised sweep
  re-claim a wait orphaned by blue/green hand-off, ending it after three attempts.

### 8. Bank it: full recipe and Recipe book

Each concept has its own independent Bank button. Either player may bank it, in any order, including while
another concept's recipe is pending. Banking creates a `cook_recipes` row in `pending` and starts a separate
hidden cmd run; only a valid completed full recipe becomes `banked` and appears in the Recipe book.

#### 8.1 Full-recipe prompt and schema

The prompt contains only that concept's title, description, and resolved picked/staple ingredient objects.
It requires the same exact used-ingredient set as the concept (no newly appearing staple either), realistic
quantities for the serving count, safe timings and method, and exactly this JSON:

```json
{
  "title": "string <= 90",
  "description": "string <= 500",
  "serves": 2,
  "prepMinutes": 15,
  "cookMinutes": 30,
  "ingredients": [
    {"id": "red-onion", "quantity": "1 medium, finely sliced", "note": ""}
  ],
  "steps": [
    {"text": "string <= 500", "minutes": 5, "uses": ["red-onion"]}
  ],
  "tips": ["string <= 240"]
}
```

Validation: `serves` integer 1–12; prep 0–240 and cook 0–480 minutes; 1–30 ingredient rows, each with a
unique id and non-empty quantity 1–60 chars and note ≤120; exactly the concept's picked+staple id set; 2–20
steps, each text 1–500, optional minutes 0–480, and `uses` a subset of the ingredient ids; at most three
tips. Names are resolved from the bank at read time. Total time is computed as prep+cook, never trusted as a
separate model field. A banked recipe stores canonical JSON, `banked_at`, and who requested it. Failure and
retry/restart semantics mirror the concept job with `caller: "wixy-cookout-recipe"`.

#### 8.2 Recipe book

The ⋯ menu gains **Recipe book — Recipes you've banked**. It is a full-height screen following
`createHolidayBank`: newest banked recipes first, image thumbnail, title, short description, serves and total
time, and an empty state. Tapping one opens the Cookout round at that concept's full recipe (paging older
chat history until its anchor is loaded). The full recipe shows the concept picture, ingredients with
quantities, numbered steps and timings, tips, and the round's shared mini chat. All three concepts of one
round share the round's one item chat because `itemChat` is anchored to a message, not to a concept id.

The Recipe book is derived from `cook_recipes.state = 'banked'`; there is no second bank-list table. Deleting
the round's anchor removes its recipes from the book and its pictures through the attachment machinery.

### 9. Schema v21 (additive; v20 remains untouched)

```sql
CREATE TABLE IF NOT EXISTS cook_rounds(
  anchor_message_seq INTEGER PRIMARY KEY REFERENCES messages(seq) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('waiting','picking','finished','abandoned')),
  blind INTEGER NOT NULL DEFAULT 0 CHECK(blind IN (0,1)),
  player1_key TEXT NOT NULL, player1_name TEXT NOT NULL, player1_email TEXT,
  player2_key TEXT, player2_name TEXT, player2_email TEXT,
  concepts TEXT NOT NULL DEFAULT 'none'
    CHECK(concepts IN ('none','pending','ready','failed','unavailable')),
  concepts_run_id TEXT, concepts_json TEXT, concepts_error TEXT,
  images TEXT NOT NULL DEFAULT 'none' CHECK(images IN ('none','pending','done','failed')),
  pictures TEXT, images_started_at REAL, images_tries INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cook_rounds_state ON cook_rounds(state);

CREATE TABLE IF NOT EXISTS cook_turns(
  anchor_message_seq INTEGER NOT NULL REFERENCES cook_rounds(anchor_message_seq) ON DELETE CASCADE,
  turn INTEGER NOT NULL CHECK(turn BETWEEN 1 AND 10),
  player INTEGER NOT NULL CHECK(player IN (1,2)),
  offers TEXT NOT NULL,              -- JSON [[id,id], ...], 1..3 pairs
  choice_id TEXT,
  skip_move_ids TEXT NOT NULL DEFAULT '[]',
  pick_move_id TEXT,
  PRIMARY KEY(anchor_message_seq, turn));

CREATE TABLE IF NOT EXISTS cook_recipes(
  anchor_message_seq INTEGER NOT NULL REFERENCES cook_rounds(anchor_message_seq) ON DELETE CASCADE,
  concept_id TEXT NOT NULL CHECK(concept_id IN ('a','b','c')),
  state TEXT NOT NULL CHECK(state IN ('pending','banked','failed','unavailable')),
  run_id TEXT, recipe_json TEXT, error TEXT,
  requested_by TEXT NOT NULL, bank_move_id TEXT,
  banked_at REAL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
  PRIMARY KEY(anchor_message_seq, concept_id));
CREATE INDEX IF NOT EXISTS idx_cook_recipes_banked
  ON cook_recipes(state, anchor_message_seq DESC);
```

`offers` stores ids only; names are resolved from the committed bank. `skip_move_ids` is a JSON array in skip
order. There is no separate `active_turn`: the current turn is the lowest turn with null `choice_id` on a
`picking` round. There is no persistent played-ingredient table outside rounds.

All three tables are chat content. The FK chains erase them even when an older blue/green process performs
the message delete. Wipe explicitly deletes `cook_recipes`, `cook_turns`, then `cook_rounds` in the same
transaction as the other chat tables. The game chat continues to reuse `wyr_chat`; `create_message(
wyr_anchor_seq=)` accepts a Cookout anchor and `wyrRefKind` gains `"cookout"`. Historical wire names
`wyrSeq`/`wyrRef` remain unchanged.

### 10. HTTP wire

All routes are under `/api/admin/server`, call `require_server_token` first, use strict Pydantic bodies with
unknown keys forbidden, and resolve `?as=`/mutation `sender` to a slot with the WYR name+verified-email
rule. `GET /cookout/bank` is declared before `/cookout/{seq}`.

- `POST /cookout` `{clientId, deviceId, sender, blind}` → `201 {message}`, or `200` on a clientId replay.
  Creates a text-less anchor and slot 1 in `waiting`, and abandons open `waiting|picking` rounds.
- `POST /cookout/{seq}/join` `{sender}` → the filtered view; slot 2 joins and turn 1's initial pair is drawn.
- `GET /cookout/{seq}?as=<sender>` → the view below.
- `POST /cookout/{seq}/skip` `{sender, moveId, turn, offer}` → fresh pair, or `409 skip_exhausted` at offer 3.
- `POST /cookout/{seq}/pick` `{sender, moveId, turn, offer, ingredientId}` → records a pick and either draws
  the next turn's initial pair or finishes the round and starts concepts.
- `POST /cookout/{seq}/concepts/retry` `{sender}` → pending when failed/unavailable and a backend exists.
- `POST /cookout/{seq}/pictures/retry` `{sender}` → pending for missing pictures when the generator exists.
- `POST /cookout/{seq}/concepts/{conceptId}/bank` `{sender, moveId}` → that concept's full-recipe job.
- `POST /cookout/{seq}/concepts/{conceptId}/recipe/retry` `{sender}` → retry a failed/unavailable bank job.
- `GET /cookout/bank` → `{recipes: [{seq, conceptId, title, description, serves, prepMinutes,
  cookMinutes, bankedAt, bankedBy, thumbUrl}]}`, newest anchor first. The full recipe is in the round view.

Errors: `404 not_found`; `409 bad_state`, `not_your_turn`, `not_player`, `skip_exhausted`, `exhausted`;
`422 invalid`; `503 game_unavailable`. Existing 401 lock behavior is unchanged.

#### 10.1 Message summary and round view

`Message.cookout = {state, concepts, rev} | null`, joined at read time exactly like `adventure`. It carries
no ingredient or recipe content. The round view is the only ingredient-bearing read:

```text
{seq, state, rev, blind, revealed,
 players: [{slot, name, pickCount, picks: [Ingredient] | null}],
 you: {slot} | null,
 current: {turn, player, options: [Ingredient,Ingredient] | null,
           offerIndex: 0|1|2|null, skipsRemaining: 0|1|2|null} | null,
 history: [{turn, player, offers: [[Ingredient,Ingredient]], choice: Ingredient | null}],
 concepts: {state, data: [Concept] | null, error, canRetry},
 images: {state, pictures: {a: Picture|null, b: Picture|null, c: Picture|null}, canRetry},
 recipes: {a: RecipeSlot, b: RecipeSlot, c: RecipeSlot}}

Ingredient = {id, name, category, categoryName, family, rarity, tags}
Concept = {id, title, description, pickedIngredientIds, stapleIds,
           ingredients: [Ingredient], staples: [Ingredient]}
Picture = {thumbUrl, fullUrl}                       // signed, this-origin only
RecipeSlot = {state, data: FullRecipe | null, error, canRetry, bankedBy, bankedAt}
FullRecipe = {title, description, serves, prepMinutes, cookMinutes, totalMinutes,
              ingredients: [{id,name,quantity,note}], steps: [{text,minutes,uses}], tips}
```

Viewer filtering rules are exact:

- Non-blind: all offers and picks are visible throughout; `picks` is never null.
- Blind, before finished: `players[partner].picks = null`; `history` contains only the viewer's own turns;
  `current.options`, `offerIndex`, and `skipsRemaining` are present only on the viewer's own turn, else null.
  `pickCount` and current player remain visible. A non-participant gets the same partner-hidden public view,
  not either player's private data.
- Blind, finished: every player's selected `picks` is visible, but `history` still contains only the viewer's
  own offers; rejected partner options never leave the server. Concepts, pictures, and recipes are public to
  the unlocked chat once finished.
- The client parser drops unexpected hidden fields too (`picksVisible` is derived from state+viewer), but that
  is a second lock, never the enforcement mechanism. As with WYR, this is a game rule, not a new secrecy
  boundary under Inv 40; unknown-email/device-grant sessions fall back to the normalized name.

### 11. Client

#### 11.1 Registration, menu, and live updates

- `GameKey` gains `"cookout"`; the new pane registers tab label **Cookout** and aria label **Cookout game**.
  Existing one-game-at-a-time replacement in `gameTabs.ts` supplies the requested second-tab behavior.
- In `thread.ts`'s actual ⋯ menu: **Cookout — Pick ingredients, invent dinner**,
  **Cookout (blind) — Hide the basket until the big reveal**, and **Recipe book — Recipes you've banked**.
  The starter lands in the tab; the partner is offered it with a dot. New starts the same mode as the open
  round.
- `Message.cookout` and `wyrRefKind = "cookout"` are parsed defensively. `message_updated` triggers the
  model/card refresh; there is no extra stream event. Game-chat messages are tagged **Cookout** in the main
  chat and continue through the existing `wyrSeq` send path.
- `admin-ui/src/server/cookout/`: `api.ts`, `model.ts`, `cookoutGame.ts`, `cookoutCard.ts`, `recipeBook.ts`.
  The model follows the revision/no-older-view and token-renewal behavior of `adventure/model.ts`; no server
  clock is needed because there are no timed animations.

#### 11.2 Pane, phone first at 360 px

Top to bottom:

1. `[ 🍳 Cookout   Recipe book   New   ✕ ]`, with a small **Blind** badge when applicable.
2. A waiting/join panel, or ten compact progress markers grouped five per player, names and whose turn it is.
3. The current choice: two large ingredient buttons with name and category. At 360 px they stack vertically;
   on a wide screen they sit side by side. Below them a full-width **Skip — 2 left** button, disappearing on
   the third offer. On a partner's blind turn this area is a face-down card, never a hidden DOM ingredient.
4. A collapsible "Picks so far" section. Normal mode shows both histories; blind shows only the viewer's and
   a partner progress count. At the reveal, ten selected chips animate in together (a simple cut under
   reduced motion).
5. `finished`: three concept cards, stacked on a phone and up to three columns on desktop. Each has its image
   or text tile at the top, title, description, used-ingredient chips, and its own **Bank this** button and
   status. No quantities or instructions appear before banking. A banked card expands the full recipe in a
   scrollable sheet that cannot push its close button off a 360 px screen.
6. The shared fixed-height `itemChat` mini strip and the one ordinary composer. Every game control carries
   `data-srv-gesture-boundary`; Escape remains the panic key. No idle-lock suspension is held during AI or
   image waits. Lock/wipe/close resets private view state and closes the recipe sheet/book.

The main-chat card shows title, one safe status line ("Waiting for…", "Your turn — 2 of 5", "Cooking up three
ideas…", "Three ideas ready", "2 banked"), and Play/Open. In blind mode it never derives hidden picks from a
cached view. Once ready it may show concept A's thumbnail.

### 12. Tests (required)

- **pytest — bank:** `test_cookout_bank.py` and loader tests: every schema negative, normalized duplicate
  names, staple references, real-bank size/category rules, malformed bank disables only the game.
- **pytest — game/routes:** real v20→v21 migration; join identity and races; exact turn order; two skips then
  forced pick; budget reset on the next turn; stale turn/offer rejection; wrong-slot rejection; idempotent
  replays after restart; no duplicate ids over all 60 possible offers; per-player category counts differ by
  at most one with an injected RNG; rarity weighting; family-collision bound; skip replacement is fresh;
  only an offered id can be picked; normal and blind views at every state, different-sign-in filtering, no
  partner data in summaries/events; final reveal excludes rejected partner offers; new-round abandonment;
  anchor cascade and explicit wipe; mini-chat `wyrSeq`/`wyrRefKind`; Recipe book listing and deletion.
- **pytest — AI/images:** exact prompt privacy (no names/messages, no tools), defensive JSON, every concept
  coverage/ingredient/staple rejection, full-recipe schema and exact ingredient-set rejection, malformed JSON
  retry, early cmd error retry, timeout/cancel, manual retry, unavailable edition, restart resume, blue/green
  compare-and-set, banking races, partial picture success, every exit ends pending, output/history cleanup
  for both prefixes, orphaned image self-healing, Gallery exclusion. `fake_cmd.py` gains canned concept and
  full-recipe answers.
- **vitest:** defensive parsers (including refusal to retain hidden fields), model revision handling, draw
  rendering for every state, skip labels, blind face-down state, final reveal, concept/recipe cards, card,
  Recipe book, gameTabs registration/replacement and existing WYR/Adventure suites unchanged.
- **e2e `server-cookout.spec.ts`:** two people complete a normal game; blind partner cannot read hidden DOM or
  network responses; two skips then forced pick; simultaneous pick race; three concepts from fake cmd and
  their pictures; mini chat send/pop-up; independently bank two concepts; full recipes and Recipe book;
  delete/wipe erasure; a 360 px phone layout and desktop; Cookout replacing WYR/Adventure in the second tab.

### 13. Docs in the same change

`spec/server-chat/09-cookout.md`; `docs/ai/livechat.md` new §24; `contracts.md` (routes, errors, view,
`Message.cookout`, `wyrRefKind`); `invariants.md` new **Inv 57** (Cookout rounds/recipes are chat content,
blind views are server-filtered, local Comfy cleanup includes `cookout_`, cmd's retained prompt/answer
limit); `glossary.md` state machines; `testing.md`; root `CLAUDE.md` store table; and the next
`decisions/NNNNN-server-chat-cookout/` entry. Every commit uses exactly
`Release-note: General bug fixes and improvements.` under R14a.

---

## B. Optional fun twists (none is required by the core)

**Top 3 are marked ⭐.**

1. ⭐ **One-ingredient swap — "Not feeling the mango? Swap one pick and cook the three ideas again."**
   Why fun: it gives the pair one dramatic rescue after seeing the basket, exactly the operator's example.
   Cost: **M**. Clean add-on: store a new basket revision and regenerate concepts/images; keep the previous
   revision readable. No core state depends on it.
2. ⭐ **Chef's wildcard — after ten picks, flip one bonus ingredient neither person saw coming.**
   Why fun: a tiny shared suspense moment and an extra constraint without another whole turn. Cost: **S**.
   Clean add-on: one optional `wildcard_id` drawn from the least-used category and appended before concepts.
3. ⭐ **Cuisine wheel — spin a playful style such as "Italian", "street food", or "breakfast for dinner".**
   Why fun: the same basket feels different each time and gives the concepts a running joke. Cost: **S**.
   Clean add-on: a static style bank and one extra static style string in the concept prompt; no extra
   ingredients are allowed.
4. **Tonight's challenge — add one constraint like "one pan", "extra crunchy", or "ready in 30 minutes".**
   Why fun: a shared mission makes odd combinations feel intentional. Cost: **S**. Clean add-on: a static
   challenge bank and prompt/validation fields; pictures and banking are unchanged.
5. **Concept vote — both pick the dish they would actually eat; agreement crowns it "Tonight's Cookout".**
   Why fun: it gives the three pictures a playful head-to-head finish. Cost: **S–M**. Clean add-on: two
   private votes and a WYR-style reveal on the existing round; banking stays independent.
6. **Steal the last pick — once per game, offer to swap your latest pick with your partner's latest.**
   Why fun: harmless mischief and negotiation in the mini chat, especially in blind mode. Cost: **M**.
   Clean add-on: an accepted two-person move appended to the turn history before concepts; not valid after
   the concept job starts.
7. **Leftovers remix — take a banked recipe and ask for three new ideas using its main ingredients plus one
   fresh draw.** Why fun: a good silly recipe becomes a continuing storyline rather than a dead end. Cost:
   **M**. Clean add-on: a new round seeded from an existing bank entry; the original recipe is immutable.
8. **Cooked-it verdict — after cooking, add a rating and a real photo beside the AI glamour shot.**
   Why fun: the reality-versus-expectation comparison is half the joke and builds a useful personal book.
   Cost: **M–L** if ratings/photo linkage are new; the photo itself can already use the round's ordinary
   mini chat. Clean add-on: small per-recipe verdict fields, never required to bank or browse.

---

## C. Implementation plan

### Parcel 1 — ingredient bank and validator (one data/server builder)

**Owns:** `cookout_ingredients.json`, `cookout_bank.py`, `tooling/cookout/validate_bank.py`,
`test_cookout_bank.py`, bank fixtures. **No other shared files.**

Deliver the typed contract first:

```python
class CookoutBank(Protocol):
    def ingredient(self, ingredient_id: str) -> Ingredient | None: ...
    def category(self, category_id: str) -> Category | None: ...
    @property
    def categories(self) -> tuple[Category, ...]: ...
    @property
    def staples(self) -> frozenset[str]: ...
    @property
    def ingredients(self) -> tuple[Ingredient, ...]: ...
```

`Ingredient` is the exact §5 record. `load_bank_or_empty` and test injection mirror Adventure. Core and AI
builders code against this contract while category authors finish the 3,000+ entries.

### Parcel 2 — schema v21, state machine, store, routes (Sonnet 5.5)

**Owns:** `store.py`, `livechat/models.py`, new `cookout_game.py`, new `routes_livechat_cookout.py`, server
game/route tests. Depends only on Parcel 1's interface.

Also owns all v21 store methods needed by jobs, so two builders never edit `store.py`:

```text
create/join/get round; current turn; skip/pick; view data incl. attachments
set_concepts_run(expected); finish_concepts(expected run, state/json/error, images_pending)
pending_concepts(); retry_concepts(); claim/fail/finish pictures; create picture attachments
create/recipe retry; set_recipe_run(expected); finish_recipe(expected run); pending_recipes()
list_recipe_book()
```

Routes depend on a `CookoutJobs` protocol (`start_concepts`, `retry_concepts`, `start_recipe`, `retry_recipe`,
`start_pictures`, availability flags), with a fake in core tests. Core does not implement AI.

### Parcel 3 — AI jobs and local pictures (Sonnet 5.5)

**Owns:** new `cookout_ai.py`, `cookout_images.py`, their tests and canned fake-cmd responses; the agreed
namespace/batch generalization in `wyr_images.py`; image-limiter generalization. Depends on Parcels 1 and 2's
store contracts. It does not edit routes, models, or store.

The shared `cmdchat.py` run API already suffices; changes are unnecessary unless a measured mismatch appears.
Keep WYR's existing image behavior and tests bit-for-bit compatible while adding `cookout_` cleanup.

### Parcel 4 — admin UI (Opus 5.5)

**Owns:** `admin-ui/src/server/cookout/*`, `gameTabs.ts`, `api/messages.ts`, `thread.ts`, `chat.css`, related
vitest files and committed rebuilt bundles. Depends on the §10 wire fixture, not on waiting for server code.
No server edits. Only this parcel touches the shared client registry/menu and therefore cannot collide with
the server parcels.

### Parcel 5 — docs and two-player e2e (one builder)

**Owns:** §13 documents and `e2e/tests/server-cookout.spec.ts` plus Cookout-only e2e fixtures. Can start from
the frozen wire/prompt contracts in parallel, then runs against the integrated fake cmd/image stack. It does
not edit implementation files; defects return to the owning parcel.

### Integration and dependency order

1. Freeze §5 bank API, §9 SQL, §10 JSON fixtures, and job protocols before parallel code.
2. Parcel 1 starts immediately; Parcel 2 follows its interface; Parcel 4 runs concurrently against fixtures.
3. Parcel 3 starts once Parcel 2's store signatures exist. Parcel 5 writes docs/e2e concurrently.
4. One integrator (DM or a designated single builder) owns `app.py` wiring and any final cross-parcel edits,
   runs `ruff`, strict `mypy`, capped bare `pytest`, both strict TS typechecks/tests/builds, and e2e. Bundles
   are rebuilt LF and committed by the UI parcel/integrator; no PR is opened during iteration.

---

## D. Pre-commitment

**I would drop first:**

- The exact least-count category algorithm if a peer has a simpler one with equally strong per-player
  balance and no-repeat guarantees. The guarantee matters more than the algorithm.
- The exact 15-category partition and the precise 11-item staples list if a peer demonstrates better coverage
  or a more faithful "only what everyone has" boundary. I would not expand staples to arbitrary condiments.
- Menu naming and the visual layout of the reveal; those are easy to merge and not architectural.

**I will defend hardest:**

- Two skips **per turn** and alternation after exactly one pick. This is the clearest reading of the game the
  operator described and keeps every turn meaningful.
- Server-authoritative offers/picks and server-filtered blind views. CSS hiding or sending the partner's ids
  "for later" would be a real design defect, not a shortcut.
- AI references by bank id with hard selected/staple validation, concept text published before pictures, and
  full recipes generated only on Bank. These preserve the operator's flow and prevent silent ingredient
  invention.
- Anchor-cascade/wipe erasure, local image cleanup with a distinct tracked prefix, and final blind reveal of
  selected ingredients only. These are privacy and correctness properties, not cosmetic preferences.

---

## E. Open questions for the operator

None. The core is implementable with the defaults above; every twist in section B is explicitly optional.
