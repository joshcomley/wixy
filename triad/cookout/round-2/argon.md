# Cookout — Triad Round 2 Merged Design (`argon` seat)

**Merger:** `argon` (Gemini 4 Argon High)  
**Inputs read in full:** `triad/cookout/brief.md`, `triad/cookout/merge-brief.md`, `triad/cookout/round-1/argon.md`, `triad/cookout/round-1/kimi.md`, `triad/cookout/round-1/astra.md`  
**Target spec:** `spec/server-chat/09-cookout.md`

---

## Code-Fact Verification Key

Every factual claim about the existing `wixy` codebase relied upon in this merge has been verified directly against the repository files:

- **[MEASURED-BLIND]** — Checked directly in the repository by `argon` during Round 1 before reading `kimi.md` or `astra.md`.
- **[MEASURED-KNOWING]** — Checked directly in the repository during Round 2 to verify a specific claim or design point raised in `kimi.md` or `astra.md`.
- **[CITED]** — Taken from a peer without re-reading the file (unused below: every code claim was verified directly in the tree).

Key verified code facts:
1. `wixy_server/livechat/store.py:390` **[MEASURED-BLIND]**: `_LATEST_SCHEMA_VERSION = 20` (`_SCHEMA_V20_ADVENTURE`).
2. `wixy_server/livechat/store.py:1400-1404, 1460-1464` **[MEASURED-BLIND]**: `create_message(wyr_anchor_seq=...)` checks game-round existence inside `BEGIN IMMEDIATE` and inserts into `wyr_chat(message_seq, anchor_seq)`; `models.py` exposes `wyrRef = {"seq": ..., "kind": "wyr" | "adventure"}`.
3. `wixy_server/livechat/store.py:3269-3286` **[MEASURED-KNOWING]**: `_wipe` explicitly deletes `drawing_strokes`, `drawings`, `wyr_chat`, `wyr_rounds`, `adv_rounds`, and `adv_rejected` before `DELETE FROM messages` so wipe intent is never left implicit in `ON DELETE CASCADE`, while leaving `wyr_topics` and `adv_settings` untouched.
4. `wixy_server/livechat/store.py:3625-3638, 3673-3674` **[MEASURED-BLIND]**: `finish_attachment` bumps `adv_rounds.rev` and emits `message_updated` when an anchor attachment finishes processing; `list_gallery` excludes `SELECT anchor_message_seq FROM wyr_rounds` and `SELECT anchor_message_seq FROM adv_rounds`.
5. `wixy_server/livechat/wyr_game.py:54-70` & `store.py:2155-2167` **[MEASURED-BLIND]**: `_slot_of` / `_wyr_slot` binds each player by `(reactor_key(sender), verified_email)`: a request asserting a player's display name under a different verified `ServerAuth.email` is rejected (`None` on read, `WyrNotPlayerError` on write); an absent email (`WIXY_DEV_NO_AUTH=1`) falls back to `reactor_key(sender)`.
6. `wixy_server/livechat/tokens.py:7-9, 137-180` & `docs/ai/invariants.md:1231-1236` **[MEASURED-KNOWING]**: Unlock tokens are held only in JS memory (`X-Wixy-Server-Token` header; *"never localStorage/sessionStorage/cookies/URLs"*), and device-grant sessions still populate `ServerAuth.email` with the verified CF Access email.
7. `wixy_server/livechat/wyr_images.py:83, 115-261, 317-350` **[MEASURED-BLIND]**: `ComfyImageGenerator` runs against local ComfyUI (`DEFAULT_IMAGE_MODEL = "krea2-turbo-nvfp4"`), checks `--output-directory` against `WIXY_COMFY_OUTPUT_DIR` (fail-closed, Inv 54), currently exposes only 2-image `generate_pair` with `FILE_PREFIX = "wyr_"`, and cleans up `/history` + output files in `_forget_run` and `sweep_leftovers`.
8. `wixy_server/livechat/adventure_pack.py:57-78, 306-333, 451-798` **[MEASURED-BLIND]**: `CmdAdventureResearcher` calls `CmdChatClient.spawn_run` (`model="claude-sonnet-5-5"`, `effort="medium"`, `DISALLOWED_TOOLS` denying file/shell/agent tools), `AdventurePackRunner` enforces `CapacityLimiter(2)` and `spawn_gap_s = 5.0`, and `parse_pack` scans backwards over `_json_objects(response_text)`.
9. `admin-ui/src/server/gameTabs.ts:11-23` **[MEASURED-BLIND]**: `GameKey = "wyr" | "adventure"`; `open()` and `offer()` call `replaceOthers()`, so only one game tab ever occupies the second tab at the bottom alongside `Chat`.
10. `admin-ui/src/server/thread.ts:250-415` **[MEASURED-BLIND]**: The `⋯` overflow menu (`moreMenu`) is constructed in `thread.ts` (not `panel.ts`), and `holidayBank.ts:1-208` **[MEASURED-KNOWING]** mounts as a full-height dialog below `header.offsetHeight` so the header's panic `✕` button and lock gestures remain reachable.

---

# 1. Merge Ledger

For every design decision where `argon`, `kimi`, and `astra` differed, the table and detailed rationale below record what was adopted, what was modified, what was rejected, and why.

| # | Decision Area | `argon` (R1) | `kimi` (R1) | `astra` (R1) | Merged Choice & Why |
|---|---|---|---|---|---|
| **1** | **Skip budget semantics** | **2 skips per turn** (3 pairs max per turn; resets on pick). | **2 skips per turn** (3 offers max per turn; resets on pick). | **2 skips per turn** (3 attempts max per turn; resets on pick). | **Unanimous (`argon` + `kimi` + `astra`): 2 skips per turn.** Directly matches *"when you're getting presented with the two options... up to two times. So essentially, you're going to have three goes before you have to pick"*. |
| **2** | **Turn order & who starts** | Starter is Player 1 and takes Turn 1 immediately (`picking`); odd/even alternation. | Starter is Player 1 and takes Turn 1 after Player 2 joins (`waiting -> picking`); odd/even alternation. | Starter is Player 1; waits in `waiting` for Player 2 to join, then flips a random coin for `first_slot`. | **Took `argon` + `kimi` on starter goes first (`Slot 1 = odd turns 1,3,5,7,9`, `Slot 2 = even turns 2,4,6,8,10`); hybrid start (`argon` instant Turn 1 + `kimi`/`astra` explicit `/join` route).** Rejected `astra`'s coin toss because the operator explicitly said *"it will present me with two ingredients and I'll pick one and then it will present the other person with two ingredients"*. Starting in `picking` with Turn 1 drawn lets Player 1 pick immediately (no dead waiting screen), while `POST /cookout/{seq}/join` binds Player 2 before Turn 2's Blind options are revealed. |
| **3** | **Player identity & slot binding** | WYR `(reactor_key(sender), auth.email)` rule (`_slot_of`). | WYR `(reactor_key(sender), auth.email)` rule (`_slot_of`). | New `POST /cookout/seat` `HttpOnly` cookie (`wx_cookout_seat`) + `cookout_players` table. | **Took `kimi` + `argon` (WYR `_slot_of` verified-email + normalized-name rule); rejected `astra`'s `wx_cookout_seat` cookie.** Verified in `tokens.py:7-9` **[MEASURED-KNOWING]** that server-chat avoids cookies by design, and in `tokens.py:137-180` **[MEASURED-KNOWING]** that device-grant sessions still carry `auth.email`. `astra` explicitly pre-committed (§D) to dropping the extra cookie if existing credentials suffice. |
| **4** | **Picks per player** | Fixed **5 picks per player** (10 total). | Fixed **5 picks per player** (10 total). | Configurable `3 / 5 / 7` (default 5) in a start sheet. | **Took `kimi` + `argon` (fixed 5 picks per player = 10 picks total).** `astra` pre-committed (§D) to dropping `3 / 5 / 7` in v1 to avoid UI/test matrix bloat. Moved `3 / 5 / 7` basket size to Section B as an optional twist. |
| **5** | **Blind mode: entry, redaction & reveal** | Mode toggle + `cookout_settings` table; server redacts partner's active pair & picks until 10th pick; reveals all 10 on finish. | Two `⋯` menu entries (`Cookout` and `Cookout (blind)`); no settings table; redacts partner's active pair, picks, AND rejected history; even after finish, partner's rejected/skipped pairs stay hidden. | Start sheet toggle; no settings table; server redacts partner's active pair, picks, and rejected history; **abandoning a blind round never reveals partner picks**. | **Took `kimi` + `astra` (dropped `argon`'s `cookout_settings` table; kept partner's skipped/rejected pairs hidden even after finish; enforced `astra`'s rule that `abandoned` blind rounds never reveal hidden picks).** Passing `blind` at `POST /cookout` (from the `⋯` menu or `New` button) eliminates an entire SQLite table while preserving sticky mode on `New`. |
| **6** | **Option drawing & category/family balance** | 14 categories; distinct categories per pair; soft cap after 2 picks; anchor bias on Turns 1–2; `tier` weights. | 15 categories; **per-player least-shown category selection**; **`family` deduplication** (`red-onion` vs `white-onion`); rarity weights `8:3:1`. |Shuffled role schedule (`base, protein, produce, produce, accent`); **round-wide `family` exclusion** + 3-round soft family exclusion; at least 1 `everyday` per pair. | **Merged `kimi`'s per-player least-shown 15-category selector + `astra`/`kimi`'s round-wide `family` exclusion (plus 3-round soft exclusion of recent picked IDs) + `argon`/`astra`'s rule that every pair contains at least one `everyday` ingredient.** This mathematically prevents 8-spice baskets, prevents "red onion vs white onion" across turns, and guarantees a player on Offer 3 never faces two obscure ingredients. |
| **7** | **Bank schema, size & validation** | ~2,600 items (2,400–3,500), 14 categories, `{id, name, category, tier, blurb}`. | ~3,500 items (2,500–5,000, min 80/category, max 25%/category), 15 categories, `{id, name, category, family, rarity, tags}`, `tooling/cookout/validate_bank.py`. | ~2,600 items (2,400–3,000), 21 categories, `{id, name, aliases, family, category, roles, familiarity, flavour, preparation, note}`, `tooling/cookout/validate_bank.py`. | **Took `kimi`'s 15-category schema + `family` + `rarity` + `tags`, added `argon`/`astra`'s short `blurb` (`<= 90` chars) and `argon`'s category `emoji`, with target size ~2,800–3,200 (validator accepts 2,400–4,500, min 80/category) and `tooling/cookout/validate_bank.py`.** Gives rich culinary metadata without `astra`'s 10-field per-row authoring burden. |
| **8** | **Staples list & pickability** | 16 staples (included onion, garlic, lemon, stock, soy sauce); excluded all 16 from pickable bank. | **11 true cupboard staples** (`water, salt, black-pepper, butter, plain-flour, granulated-sugar, neutral-oil, olive-oil, whole-milk, eggs, baking-powder`); staples (except water) can also be picked. | **8 staples** (`water, salt, black-pepper, butter, plain-flour, neutral-oil, granulated-sugar, white-vinegar`); at most **4 non-water extra staples per concept**; staples except water can be picked. | **Took `kimi` + `astra` (rejected `argon`'s 16-item list and rejected `argon`'s ban on picking sugar/butter).** `kimi` and `astra` rightly pointed out that garlic, onion, soy sauce, lemon, and stock are flavour-defining ingredients that should not be smuggled in unpicked, and the operator explicitly named *"sugar"* as pickable. Merged list has **10 cupboard staples** (`water, salt, black-pepper, butter, plain-flour, granulated-sugar, neutral-oil, olive-oil, whole-milk, eggs`), with `water/salt/black-pepper` never offered as turn picks and at most **4 non-seasoning extra staples per concept**. |
| **9** | **AI job shape (one run vs. checker run)** | 1 `cmdchat.py` run for 3 concepts (`claude-sonnet-5-5`, `medium`), 1 run per banked recipe. | 1 `cmdchat.py` run for 3 concepts (`claude-sonnet-5-5`, `medium`, `spawn_gap_s = 5.0`, all tools including `WebSearch`/`WebFetch` denied), 1 run per banked recipe, 1 retry on invalid JSON. | 2 sequential `cmdchat.py` runs per job (generator + separate LLM manifest checker) + up to 2 more on repair. | **Took `kimi` + `argon` (1 `cmdchat.py` run for the 3 concepts + 1 automatic retry if validation fails; rejected `astra`'s second LLM checker run).** Verified in `adventure_pack.py:57-78, 485-495` **[MEASURED-BLIND]** that `cmdchat.py` runs have a 5s spawn gap and CLI startup cost; running a second LLM pass doubles wait latency. Instead, we run `astra`'s lexical contraband scan deterministically in Python (§10 below). |
| **10** | **Validation of "only picked + staples"** | Structural ID subset check (`usedPickedIds`, `staplesUsed`) + `>= 6` picked floor; accepted names or IDs. | Strict ID-only check; **Concept A must use all 10 picked IDs, Concepts B & C `>= 6`, union covers all 10**; pairwise diversity check; whole-set rejection + 1 retry. | `>= 8/10` floor + `omits` with reason + **deterministic lexical scan of prose against bank names** + LLM checker. | **Combined `kimi`'s strict ID validation & Concept A = all 10 (or `>= 8` with explicit `omitted` reason) / Concepts B & C `>= 7` / union = all 10 + `astra`'s deterministic Python lexical contraband scan over `title`/`description`/`steps`!** Zero extra LLM latency, catches unpicked foods (like `"mango"`) in both arrays and prose, and retries once on failure. |
| **11** | **Pictures (when/how, prompt, prefix, cleanup)** | Starts after concepts ready; LLM writes `imagePrompt`; `generate_batch` in `wyr_images.py`; `wyr_image_limiter` + `WyrDemand`. | Starts after concepts ready; **server builds prompt deterministically** from validated title + used ingredient names; generalizes `ComfyImageGenerator` with `cookout_` prefix covered by cleanup; self-healing `images_started_at`/`images_tries`. | Starts after concepts ready; **server builds prompt deterministically**; `generate_many(1..3)`; shared limiter/demand; self-healing sweep. | **Took `kimi` + `astra`'s server-built deterministic image prompt (rejected `argon`'s LLM-authored `imagePrompt`), `generate_batch` (1–3 prompts, shared UNET/CLIP/VAE load), `cookout_` prefix added to `ComfyImageGenerator`'s `OWNED_PREFIXES = ("wyr_", "cookout_")` for Inv 54 cleanup, and `adventure_pack.py`-style `images_started_at`/`images_tries` self-healing.** |
| **12** | **Bank-it full-recipe job lifecycle** | Marks `banked = true` immediately on tap, then runs recipe job. | Marks recipe slot `pending` on tap, runs `wixy-cookout-recipe`, and transitions to **`banked` only when the validated full recipe is stored**. | Marks job `queued/running` ("Writing recipe…") on tap, and transitions to **`banked` only when the validated full recipe is stored**. | **Took `kimi` + `astra` (`pending -> banked | failed | unavailable`; rejected `argon`'s pre-recipe `banked = true`).** Matches the operator's exact words: *"ask it to bank it if you want and it'll generate a recipe for it and instructions, and then bank it"*, and prevents half-baked title-only entries in the Recipe Book. |
| **13** | **Recipe Book** | Modal listing banked dishes from `GET /cookout/bank`. | Full-height screen (`createHolidayBank` pattern) under chat header; derived from `cook_recipes.state = 'banked'`; tapping opens the round (paging history if needed) at that concept's full recipe. | Full-height screen under chat header (`holidayBank.ts` pattern); lists `banked` recipes plus optional `saving` (pending/failed) section; tapping loads old anchor history and opens the concept's recipe. | **Took `kimi` + `astra` (`holidayBank.ts` full-height screen below `header.offsetHeight`, derived from `cookout_recipes`, showing `banked` recipes + any in-flight `pending`/`failed` saves, and paging history on tap to open the Cookout pane at that recipe).** |
| **14** | **Schema v21 tables** | 2 tables: `cookout_rounds` (all turns/concepts/recipes as JSON columns) + `cookout_settings`. | **3 tables:** `cook_rounds`, `cook_turns` (`PRIMARY KEY(anchor_message_seq, turn)`), `cook_recipes` (`PRIMARY KEY(anchor_message_seq, concept_id)`). | 6 tables: `cookout_rounds`, `cookout_players`, `cookout_offers`, `cookout_concepts`, `cookout_jobs`, `cookout_actions`. | **Took `kimi`'s 3-table relational design (`cookout_rounds`, `cookout_turns`, `cookout_recipes`), enhanced with `started_at`/`tries` columns for self-healing recovery.** Avoids `argon`'s single-row JSON contention when two concepts are banked concurrently, and avoids `astra`'s 6-table over-decomposition while keeping per-turn `moveId` receipts and per-concept recipe rows normalized and indexed. |
| **15** | **Wire routes & view JSON** | `/api/admin/server/cookout*`; single `/retry` endpoint. | `/api/admin/server/cookout*`; explicit `moveId`, `turn`, `offer` on `/skip` & `/pick`; per-target `/concepts/retry`, `/pictures/retry`, `/concepts/{id}/bank`, `/concepts/{id}/recipe/retry`. | `/api/admin/server/cookout*`; `operationId` + `expectedRev`; `Cache-Control: no-store`. | **Took `kimi`'s clean REST route layout + `moveId`/`turn`/`offer` idempotency contract + `astra`'s `Cache-Control: no-store` on viewer-filtered responses.** |
| **16** | **UI pane & parcels** | 360px phone-first pane + carousel/stack + 5 parcels. | 360px phone-first pane + expandable recipe sheet + **5 parcels with `Parcel 2` owning all `store.py` methods** so `Parcel 3` never collides on `store.py`. | 360px phone-first pane + **P0 contract freeze & single-owner rule** (`P2` sole owner of `store.py`/`models.py`/`app.py`; `P4` sole owner of `thread.ts`/`gameTabs.ts`). | **Combined `kimi` + `astra`'s strict single-owner parcel boundaries (`P2` owns `store.py`, `models.py`, `app.py`; `P3` owns `cookout_ai.py`, `cookout_images.py`, `wyr_images.py`; `P4` Opus 5.5 owns all `admin-ui` files).** Zero merge conflicts across parallel builders. |

---

# 2. The Merged Design

## Section A — Decided Specification Draft (`spec/server-chat/09-cookout.md`)

# 09 — Cookout (Two-Player Ingredient Draft & AI Chef Game)

**Status:** decided (Triad Round 2 merged specification)  
**Parent:** [`00-overview.md`](00-overview.md) · Sibling games: [`03-would-you-rather.md`](03-would-you-rather.md), [`08-adventure-time.md`](08-adventure-time.md)  
**Touches:** `wixy_server/livechat/{store.py, models.py, cookout_bank.py, cookout_ingredients.json, cookout_game.py, cookout_ai.py, cookout_images.py, wyr_images.py}`, `wixy_server/routes_livechat_cookout.py`, `wixy_server/app.py`, `tooling/cookout/validate_bank.py`, `admin-ui/src/server/{gameTabs.ts, itemChat.ts, thread.ts}`, `admin-ui/src/server/cookout/{api.ts, model.ts, cookoutGame.ts, cookoutCard.ts, recipeBook.ts}`, `admin-ui/src/styles/livechat.css`, `docs/ai/{livechat.md, contracts.md, invariants.md, glossary.md, testing.md}`

---

### 1. Product summary and checked code precedents

Cookout is the third cooperative two-player game in the private Server chat, alongside Would-You-Rather (`wyr_game.py`) and Adventure Time (`adventure_game.py`). Two players alternate turns drafting **five ingredients each** (**ten ingredients total**) into a shared shopping basket. On each turn, the server offers **two contrasting ingredients** from a committed static bank of ~3,000 everyday-to-exotic foods. The active player may pick one of the two, or press **Neither — deal two more** up to **two times per turn** (giving three pairs—three "goes"—before they must choose one of the third pair).

In **Open mode** (`blind = false`), both players watch every offer, skip, and pick live. In **Blind mode** (`blind = true`), each player sees only their own offers and picks while drafting; the partner's active options, skips, and chosen ingredients are redacted on the server (`cookout_view_json`) until the tenth pick commits, when all ten selected ingredients are revealed together.

Once the tenth ingredient is picked, the server runs a hidden `cmdchat.py` chat-spawn job (`caller: "wixy-cookout-concepts"`) that invents **three distinct recipe concepts** using the picked basket plus a tight **10-item cupboard staples list** (and never any unpicked non-staple food). Each concept publishes its **title** and **appetizing description** immediately, followed by a finished-dish photograph painted locally on Hub's **ComfyUI** (`krea2-turbo-nvfp4`) in a single 3-chain `/prompt` batch. Quantities and method steps are **not** generated upfront: either player may tap **Bank this** on any of the three concepts to trigger a second `cmdchat.py` job (`caller: "wixy-cookout-recipe"`) that writes the full ingredients list, quantities, timings, and step-by-step instructions and saves the dish into the shared **Recipe book**.

---

### 2. Flow and state machine

```text
picking (turns 1..10) ──[10th pick commits]──► finished
   │
   └──[new Cookout started or round ended while picking]──► abandoned

finished.concepts: none ──► pending ──► ready | failed | unavailable
                                        failed | unavailable ──[retry]──► pending
finished.images:   none ──► pending ──► done | failed
                                        failed ──[retry]──► pending
per-concept recipe (a, b, c):
                   none ──[Bank this]──► pending ──► banked | failed | unavailable
                                                     failed | unavailable ──[retry]──► pending
```

#### 2.1 Players, turns, and slot identity

- **Player 1 (`slot = 1`)** is bound when the round is created (`POST /api/admin/server/cookout`): `player1_key = reactor_key(sender)`, `player1_name = sender`, `player1_email = auth.email or None`.
- **Turn 1 starts immediately:** Creating the round sets `state = 'picking'`, draws Turn 1's initial pair (`turn = 1, player = 1, offer = 0`), and returns the round so Player 1 can make their first pick immediately without waiting on a lobby screen.
- **Player 2 (`slot = 2`)** is bound when a second distinct person either presses **Join** (`POST /cookout/{seq}/join` `{sender}`, available at any point during `picking`, including while Player 1 is on Turn 1) or, in Open mode, makes their first Turn 2 move. The same identity cannot occupy both slots (`409 bad_state`).
- **Slot verification (`_slot_of`):** Following `wyr_game.py:54-70` and `store.py:2155-2167` **[MEASURED-BLIND]**, a viewer or actor is matched to `slot ∈ {1, 2}` by `reactor_key(sender)` plus verified `ServerAuth.email`: if both the slot's stored email and the request's `auth.email` are non-empty and differ, the request is treated as a stranger (`you = null` on `GET`, `409 not_player` on mutations).
- **Strict alternation (10 turns total, 5 each):**
  - Odd turns (`turn ∈ {1, 3, 5, 7, 9}`) belong to **Slot 1**.
  - Even turns (`turn ∈ {2, 4, 6, 8, 10}`) belong to **Slot 2**.
  - Only the active slot may `skip` or `pick` on that turn; any request from the other slot returns `409 not_your_turn`.
- **Two skips per turn ("three goes before you have to pick"):**
  - Each turn starts at `offer = 0` with one pair of ingredients (`len(offers) == 1`, `skipsRemaining = 2`).
  - `POST /cookout/{seq}/skip` with `{sender, moveId, turn, offer}` (valid when `offer ∈ {0, 1}`) appends a newly drawn pair `[idC, idD]` to `cookout_turns.offers` (`offer` becomes `1`, then `2`; `skipsRemaining` becomes `1`, then `0`). Skipping never changes whose turn it is or the pick count.
  - At `offer == 2` (`len(offers) == 3`), the skip button is hidden/disabled and a third `skip` request returns `409 skip_exhausted` — the player must pick one of the two ingredients in `offers[2]`.
  - `POST /cookout/{seq}/pick` with `{sender, moveId, turn, offer, ingredientId}` validates that `ingredientId` is one of the two IDs in `offers[offer]`, records `choice_id = ingredientId`, and:
    - If `turn < 10`: inserts `turn + 1` with its initial pair (`offer = 0`, `skipsRemaining = 2`), resetting the skip allowance to 2 for the next turn.
    - If `turn == 10`: transitions `cookout_rounds.state = 'finished'`, sets `concepts = 'pending'` (or `'unavailable'` if no AI runner is configured), and schedules the Stage-1 concept job in the same transaction.

#### 2.2 Open mode vs. Blind mode (server-enforced redaction)

`blind` (`0` or `1`) is set at round creation (`POST /cookout` `{..., blind: bool}`) and is immutable for that round.

- **In Open mode (`blind = false`):**
  - Both players see the active `current.options` pair, `offerIndex` (`0..2`), `skipsRemaining` (`2..0`), both players' `picks` so far, and the full `history` of offers and choices across all completed turns.
- **In Blind mode (`blind = true`) while `state == 'picking'`:**
  - `cookout_view_json` filters the payload on the server before serialization based on `viewer_slot = _slot_of(round_, viewer_key, viewer_email)`:
    1. **Partner's picks:** `players[partner].picks` is `null` (only `pickCount: 0..5` is visible).
    2. **Current turn options:** `current.options`, `current.offerIndex`, and `current.skipsRemaining` are populated **only** when `viewer_slot == current.player` (so on Turn 2, Slot 2 must be bound via `/join` to read Turn 2's options). When `viewer_slot != current.player` (including `viewer_slot is None`), `current.options`, `current.offerIndex`, and `current.skipsRemaining` are all `null`.
    3. **Turn history:** `history` contains **only** turns where `turn.player == viewer_slot`.
- **In Blind mode when `state == 'finished'` (The Big Reveal):**
  - As soon as Turn 10's pick commits (`state == 'finished'`), `revealed` becomes `true` and both `players[0].picks` and `players[1].picks` (all 10 selected ingredients) are returned in full to both players so they can enjoy the combined basket reveal while the AI chef cooks up the 3 concepts.
  - **Partner's rejected/skipped pairs stay private:** Even when `state == 'finished'`, `history` in Blind mode continues to include only the viewer's own turns (`turn.player == viewer_slot`), so rejected options never clutter the reveal.
- **In Blind mode when `state == 'abandoned'`:**
  - Abandoning an unfinished Blind round does **not** set `revealed = true`: partner picks remain `null` so abandoning cannot be used to peek at an unfinished secret basket.
- **Transport hygiene:** `Message.cookout` (the main-chat/SSE summary) never contains ingredient IDs, options, or recipe text, and `GET /cookout/{seq}` sets `Cache-Control: no-store`.

#### 2.3 Concurrency, idempotent replays, abandonment, and erasure

- All mutations run inside `store._write_txn()` (`BEGIN IMMEDIATE`), sampling `time.time()` only after the write lock is held (`store.py:2493-2495` **[MEASURED-KNOWING]**).
- **Idempotency:**
  - `POST /cookout` is idempotent on `clientId` (`messages.client_id`).
  - `POST /cookout/{seq}/join` is idempotent for the already-bound Slot 2 player.
  - `POST /cookout/{seq}/skip` and `POST /cookout/{seq}/pick` require `{moveId, turn, offer}`. Replaying a `moveId` already recorded in `cookout_turns.skip_move_ids` or `cookout_turns.pick_move_id` returns `200 OK` with the current viewer-filtered view and writes no event. A different `moveId` targeting a past `turn` or stale `offer` returns `409 bad_state`.
  - `POST /cookout/{seq}/concepts/{conceptId}/bank` carries `moveId` (`cookout_recipes.bank_move_id`) and is state-idempotent: if `conceptId` is already `pending` or `banked`, it returns `200 OK` with the current view without starting a duplicate run.
- **Abandonment:** Starting a new Cookout round (`POST /cookout`) atomically marks any earlier `picking` Cookout round as `abandoned` (bumping its `rev` and emitting `message_updated`). A `finished` round is **never** abandoned by starting a new round.
- **Erasure (Delete & Wipe):** Deleting the anchor message cascades through `cookout_rounds`, `cookout_turns`, and `cookout_recipes` (`ON DELETE CASCADE`) and best-effort cancels any in-flight cmd runs. `store._wipe()` explicitly deletes `cookout_recipes`, `cookout_turns`, and `cookout_rounds` alongside the other game tables (`store.py:3278-3285` **[MEASURED-KNOWING]**).

---

### 3. Static ingredient bank, draw algorithm, and staples

#### 3.1 Ingredient bank (`wixy_server/livechat/cookout_ingredients.json`)

- **Size & authoring:** **2,800–3,500 distinct culinary ingredients** (validator accepts `2,400..4,500`, with at least `80` per category and no category exceeding `20%` of the bank). Authored offline as committed static JSON and validated by `tooling/cookout/validate_bank.py` + `wixy_server/tests/test_cookout_bank.py`. Zero runtime API calls.
- **15 culinary categories** (with UI display names and badge emojis):
  1. `meat-poultry` ("Meat & Poultry", 🥩)
  2. `fish-seafood` ("Fish & Seafood", 🐟)
  3. `vegetables` ("Vegetables & Greens", 🥦)
  4. `fungi` ("Mushrooms & Fungi", 🍄)
  5. `fruit` ("Fruit & Citrus", 🍋)
  6. `dairy-eggs` ("Dairy, Cream & Cheese", 🧀)
  7. `grains-bakery` ("Bread, Pasta & Grains", 🍞)
  8. `legumes-nuts-seeds` ("Beans, Nuts & Seeds", 🥜)
  9. `herbs-aromatics` ("Fresh Herbs & Aromatics", 🌿)
  10. `spices-seasonings` ("Spices & Chilis", 🌶️)
  11. `oils-fats-condiments` ("Oils, Fats & Condiments", 🫒)
  12. `sauces-stocks-fermented` ("Sauces, Pastes & Pickles", 🫙)
  13. `sweet-baking` ("Sweet, Sugar & Baking", 🍯)
  14. `prepared-pantry` ("Prepared & Comfort Pantry", 🥫 — e.g. *thick-cut white toast*, *tinned baked beans*, *instant ramen noodles*, *puff pastry*, *tortilla chips*)
  15. `drinks-alcohol` ("Splash, Brews & Infusions", ☕ — e.g. *double espresso*, *dry cider*, *stout*, *coconut milk*, *elderflower cordial*)

- **JSON schema of `cookout_ingredients.json`:**
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
      { "id": "granulated-sugar", "name": "Granulated sugar", "pickable": true },
      { "id": "neutral-oil", "name": "Neutral cooking oil", "pickable": true },
      { "id": "olive-oil", "name": "Olive oil", "pickable": true },
      { "id": "whole-milk", "name": "Whole milk", "pickable": true },
      { "id": "eggs", "name": "Eggs", "pickable": true }
    ],
    "ingredients": [
      {
        "id": "thick-white-toast",
        "name": "Thick-cut white toast",
        "category": "prepared-pantry",
        "family": "toast-bread",
        "rarity": "everyday",
        "blurb": "Crisp golden slices ready for topping, soaking, or crumbing",
        "tags": ["savoury", "sweet", "prepared", "vegetarian", "vegan", "gluten"]
      }
    ]
  }
  ```
  - `id`: permanent lowercase ASCII kebab-case (`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, 2–64 chars).
  - `name`: trimmed British-English display name (1–70 chars, unique after case- and accent-folding).
  - `category`: one of the 15 category IDs.
  - `family`: lowercase ASCII kebab-case (`2–48` chars) grouping near-synonyms/cuts (e.g. `red-onion` and `white-onion` share `family: "onion"`; `flat-leaf-parsley` and `curly-parsley` share `family: "parsley"`).
  - `rarity`: `"everyday" | "uncommon" | "exotic"` (draw weights `8 : 3 : 1`).
  - `blurb`: short plain-text culinary hint (`1–90` chars).
  - `tags`: `0..6` values from `("savoury", "sweet", "raw", "spicy", "aromatic", "baking", "garnish", "fresh", "frozen", "prepared", "alcohol", "vegetarian", "vegan", "gluten", "dairy", "egg", "nuts", "soy", "fish", "shellfish")`.

#### 3.2 Exact Staples List contract

The 10 cupboard staples are:
`water`, `salt`, `black-pepper`, `butter`, `plain-flour`, `granulated-sugar`, `neutral-oil`, `olive-oil`, `whole-milk`, `eggs`.

- **No flavour-hijacking staples:** Garlic, onion, lemon, stock, soy sauce, herbs, cream, cheese, bacon, and mango are **not** free staples — they live in the pickable bank and may only be used if picked.
- **Pickability:** `water`, `salt`, and `black-pepper` (`pickable: false`) are never offered as turn choices; the other 7 staples (`butter`, `plain-flour`, `granulated-sugar`, `neutral-oil`, `olive-oil`, `whole-milk`, `eggs`) also exist in `ingredients` so "sugar" or "butter" can be offered and picked as the operator asked. If a staple is picked in the round's basket, it appears in `pickedIngredientIds` (and not duplicated in `stapleIds`).
- **Per-concept extra-staple cap:** Beyond `water`, `salt`, and `black-pepper`, each concept may add **at most 4 unpicked staples** from `{butter, plain-flour, granulated-sugar, neutral-oil, olive-oil, whole-milk, eggs}`.

#### 3.3 Server-authoritative pair draw (`cookout_bank.py`)

When drawing `[optionA, optionB]` for `player ∈ {1, 2}`:
1. **Hard round exclusions:** Let `seen_ids` be every ingredient `id` offered anywhere in this round (`cookout_turns.offers` across both players and all skips), and `seen_families` be their `family` values. Exclude `seen_ids` unconditionally, and exclude `seen_families` whenever at least 2 categories have unseen families. Also soft-exclude ingredient IDs picked in the 3 most recent other Cookout rounds (derived from `cookout_turns.choice_id`, relaxed if needed).
2. **Per-player least-shown category balance:** For the active `player`, count how many options in each of the 15 categories have already been offered to that player in this round (including skipped pairs).
   - Pick `category_a` uniformly at random (`secrets.SystemRandom`) from the eligible categories tied for the player's minimum count.
   - Temporarily increment `category_a`'s count and pick `category_b` uniformly from the remaining categories tied for the player's minimum count (`category_b != category_a`).
3. **Rarity & everyday floor:**
   - Draw `option_a` from `category_a` with `rarity == "everyday"` (falling back to weighted `8 : 3 : 1` only if `category_a` has no unseen everyday family).
   - Draw `option_b` from `category_b` (excluding `option_a.family`) using rarity weights `everyday = 8`, `uncommon = 3`, `exotic = 1`, then randomly swap the order of `(option_a, option_b)` with a fair coin.
   - Result: every pair offers two distinct categories, two distinct families, at least one familiar everyday ingredient, and even category exposure across all 5 turns and up to 10 skips per player.

---

### 4. AI Jobs and Local ComfyUI Pictures

#### 4.1 Stage 1: Three Recipe Concepts (`cookout_ai.py`)

- **Backend:** `CmdCookoutRunner` wrapping `CmdChatClient` (`wixy_server/cmdchat.py`), using `caller = "wixy-cookout-concepts"`, `model = "claude-sonnet-5-5"`, `effort = "medium"`, `timeout_secs = 600`, in an empty non-git `server/cookout-jobs/` directory, with **all tools disallowed** (`DISALLOWED_TOOLS` from `adventure_pack.py:64-78` **plus** `"WebSearch"` and `"WebFetch"`).
- **Pacing & concurrency:** Shares `CapacityLimiter(2)` and `spawn_gap_s = 5.0`, polls every `5.0s`, gives up and cancels after 12 minutes, retries once on an early cmd `error` (`<= 150s`), and retries **once** with a fresh run if the output JSON fails `parse_concepts` validation.
- **Prompt privacy:** Contains **only** the 10 selected `Ingredient` records (`{id, name, category, blurb, tags}`) sorted by `id` (stripping pick order and player attribution) and the 10 allowed `Staple` records (`{id, name}`). Zero player names, zero emails, zero chat messages.
- **Prompt & output schema:**
  ```json
  {
    "concepts": [
      {
        "id": "a",
        "title": "Espresso-Glazed Ribeye over Crispy Toast & Charred Broccoli",
        "vibe": "Steakhouse Bistro",
        "description": "Seared ribeye steak basted in a glossy dark brown sugar and espresso reduction, served over thick-cut buttered toast that catches the pan juices alongside charred tenderstem broccoli and melted Gruyère.",
        "pickedIngredientIds": ["aged-gruyere", "dark-brown-sugar", "double-espresso", "flat-leaf-parsley", "ribeye-steak", "smoked-paprika", "tenderstem-broccoli", "thick-white-toast", "tinned-baked-beans", "white-miso"],
        "omitted": [],
        "stapleIds": ["salt", "black-pepper", "butter"]
      }
    ]
  }
  ```
- **Server-side validation (`parse_concepts`):**
  1. **Structure:** Exactly 3 concepts with `id` equal to `"a"`, `"b"`, `"c"`, unique non-empty `title` (`1..90` chars), `vibe` (`1..40` chars), and `description` (`20..500` chars).
  2. **Ingredient ID whitelist:** Every ID in `pickedIngredientIds` must belong to the round's 10 selected IDs (no duplicates). Every ID in `stapleIds` must belong to the 10 allowed staple IDs, must not appear in `pickedIngredientIds`, and at most 4 may be non-seasoning staples (`butter, plain-flour, granulated-sugar, neutral-oil, olive-oil, whole-milk, eggs`).
  3. **Coverage & diversity ("most, really try for all"):**
     - **Concept `"a"`** is the "Everything" dish: it is instructed to use all 10 picked ingredients and **must use at least 8 of the 10** (`len(pickedIngredientIds) >= 8`). Any omitted basket item (`0..2`) must appear in `omitted: [{"id": ..., "reason": ...}]`.
     - **Concepts `"b"` and `"c"`** must each use **at least 7 of the 10** picked ingredients (`len(pickedIngredientIds) >= 7`), with any omitted items listed in `omitted`.
     - **Union coverage:** The union of `pickedIngredientIds` across `"a"`, `"b"`, and `"c"` must cover **all 10** picked ingredients.
  4. **Deterministic prose contraband scan:** A compiled word-boundary matcher checks `title` and `description` against the bank's non-picked, non-staple ingredient names (excluding generic culinary nouns or items sharing a `family` with a picked ingredient). If an unpicked ingredient name (e.g. `"mango"`, `"salmon"`, `"bacon"`) appears in prose, the candidate is rejected and retried once.
  5. **Compare-and-set completion:** `store.finish_cookout_concepts(anchor_seq, run_id, state='ready', concepts_json=..., pictures_pending=...)` updates `cookout_rounds` **only if** `concepts == 'pending' AND concepts_run_id IS run_id`, atomically setting `images = 'pending'`, `images_started_at = now`, `images_tries = 1` when `ComfyImageGenerator` is configured, bumping `rev`, and appending `message_updated`.

#### 4.2 Dish Pictures via Local ComfyUI (`cookout_images.py` & `wyr_images.py`)

- **Deterministic server-built image prompt:** For each validated concept `c ∈ {a, b, c}`, the server builds the ComfyUI prompt from `c.title` and the resolved bank `name`s of `c.pickedIngredientIds`:
  ```text
  Photorealistic appetising food photograph of "<title>", one finished cooked serving made with <used ingredient names>. Rustic home-cooked presentation, natural kitchen light, simple ceramic plate, shallow depth of field, no people, no hands, no raw-ingredient collage, no text, labels, logos, or watermark.
  ```
- **Single-graph 3-image batch (`ComfyImageGenerator.generate_batch`):**
  - Extend `ComfyImageGenerator` (`wyr_images.py`) with `generate_batch(self, prompts: Sequence[str], out_dir: Path, *, seeds: Sequence[int] | None = None, prefix_tag: str = "wyr_") -> tuple[Path, ...]` for `1..3` prompts, wiring chains at node bases `10, 20, 30` against the single shared `UNETLoader` (`"1"`), `CLIPLoader` (`"2"`), and `VAELoader` (`"3"`). `generate_pair` delegates to `generate_batch` with `prefix_tag="wyr_"` so all existing WYR callers and tests remain untouched.
  - Cookout passes `prefix_tag="cookout_"`. `OWNED_PREFIXES = ("wyr_", "cookout_")` is checked by `purge_leftovers` and `_is_orphaned_wyr_entry` so every run deletes its `/history` entry and `cookout_*` output files in `_forget_run` and `sweep_leftovers` (Inv 54).
- **Shared GPU limiter & priority:** Runs under `wyr_image_limiter` and `with wyr_demand(...):` so background WYR pool generation yields immediately.
- **Attachments, Gallery exclusion & self-healing:**
  - The 3 PNGs are staged via `server/cookout-tmp/` and attached in one transaction as ordinary `photo` attachments (`ordinal` `0, 1, 2` mapped to `{"a": att0, "b": att1, "c": att2}` in `cookout_rounds.pictures`), setting `images = 'done'`.
  - `finish_attachment` (`store.py:3629`) bumps `cookout_rounds.rev` when a Cookout attachment finishes processing, and `list_gallery` (`store.py:3673`) excludes `SELECT anchor_message_seq FROM cookout_rounds`.
  - Orphaned `images = 'pending'` waits self-heal via `images_started_at` and `images_tries` (`MAX_PICTURE_TRIES = 3`, supervised sweep every 60s, identical to `store.py:3012-3076` **[MEASURED-KNOWING]**).

#### 4.3 Stage 2: "Bank this" Full-Recipe Job (`cookout_ai.py`) & Recipe Book

- When either player taps **Bank this** on concept `conceptId ∈ {"a", "b", "c"}` (`POST /cookout/{seq}/concepts/{conceptId}/bank` `{sender, moveId}`):
  - The store inserts/updates `cookout_recipes(anchor_message_seq, concept_id)` with `state = 'pending'` (or `'unavailable'` if `cmdchat` is unconfigured), `requested_by = sender`, `bank_move_id = moveId`, `started_at = now`, `tries = 1`.
  - `CookoutRecipeRunner` spawns a hidden cmd run (`caller = "wixy-cookout-recipe"`, `model = "claude-sonnet-5-5"`, `effort = "medium"`, all tools disallowed) with **only** that concept's `title`, `vibe`, `description`, and resolved `picked` + `staple` ingredient objects.
- **Full-recipe JSON schema (`recipe_json`):**
  ```json
  {
    "title": "Espresso-Glazed Ribeye over Crispy Toast & Charred Broccoli",
    "description": "Seared ribeye steak basted in a glossy dark brown sugar and espresso reduction...",
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
        "text": "Pat the ribeye steaks dry and rub all over with smoked paprika, salt, and cracked black pepper.",
        "minutes": 3,
        "uses": ["ribeye-steak", "smoked-paprika", "salt", "black-pepper"]
      }
    ],
    "tips": [
      "Letting the toast sit under the resting steak for 2 minutes turns humble bread into the best part of the plate."
    ]
  }
  ```
- **Validation (`parse_recipe`):**
  - `serves` (`1..12`), `prepMinutes` (`0..240`), `cookMinutes` (`0..480`), `totalMinutes` computed by the server as `prepMinutes + cookMinutes`.
  - `ingredients` (`1..30` unique `id`s): the set of `id`s must equal `concept.pickedIngredientIds ∪ concept.stapleIds` (plus optional `water`, `salt`, `black-pepper`), each with non-empty `quantity` (`1..60` chars) and `note` (`0..120` chars).
  - `steps` (`2..20` items): non-empty `text` (`1..500` chars), optional `minutes` (`0..480`), `uses` subset of the recipe's ingredient IDs; every listed ingredient ID must appear in at least one step's `uses`, and the deterministic contraband scan verifies no unpicked food was introduced in step prose.
  - On validation success, compare-and-set transitions `cookout_recipes.state = 'banked'` and stamps `banked_at = now`.

---

### 5. Schema v21, HTTP Wire Contract, and Client UI

#### 5.1 Additive Schema v21 (`wixy_server/livechat/store.py`)

Bump `_LATEST_SCHEMA_VERSION = 21` and apply `_SCHEMA_V21_COOKOUT`:

```sql
CREATE TABLE IF NOT EXISTS cookout_rounds(
  anchor_message_seq INTEGER PRIMARY KEY REFERENCES messages(seq) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('picking','finished','abandoned')),
  blind INTEGER NOT NULL DEFAULT 0 CHECK(blind IN (0,1)),
  started_by TEXT NOT NULL,
  player1_key TEXT NOT NULL, player1_name TEXT NOT NULL, player1_email TEXT,
  player2_key TEXT, player2_name TEXT, player2_email TEXT,
  concepts TEXT NOT NULL DEFAULT 'none'
    CHECK(concepts IN ('none','pending','ready','failed','unavailable')),
  concepts_run_id TEXT, concepts_json TEXT, concepts_error TEXT,
  concepts_started_at REAL, concepts_tries INTEGER NOT NULL DEFAULT 0,
  images TEXT NOT NULL DEFAULT 'none' CHECK(images IN ('none','pending','done','failed')),
  pictures TEXT, images_started_at REAL, images_tries INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cookout_rounds_state ON cookout_rounds(state);

CREATE TABLE IF NOT EXISTS cookout_turns(
  anchor_message_seq INTEGER NOT NULL
    REFERENCES cookout_rounds(anchor_message_seq) ON DELETE CASCADE,
  turn INTEGER NOT NULL CHECK(turn BETWEEN 1 AND 10),
  player INTEGER NOT NULL CHECK(player IN (1,2)),
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
  started_at REAL, tries INTEGER NOT NULL DEFAULT 0,
  banked_at REAL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
  PRIMARY KEY(anchor_message_seq, concept_id)
);
CREATE INDEX IF NOT EXISTS idx_cookout_recipes_banked
  ON cookout_recipes(state, banked_at DESC, anchor_message_seq DESC);
```

#### 5.2 HTTP Routes (`/api/admin/server/cookout*`)

All routes require `require_server_token(request)` and strict Pydantic request models (`extra="forbid"`). `GET /cookout/bank` is declared before `/cookout/{seq}`.

| Method & Path | Request Body / Query | Response | Behaviour |
|---|---|---|---|
| `POST /cookout` | `{clientId, deviceId, sender, blind?: bool}` | `201 {message}` (`200` on replay) | Abandons any open `picking` round, creates anchor message + `cookout_rounds` row in `picking` with Slot 1 bound and Turn 1's initial pair drawn in `cookout_turns`. |
| `GET /cookout/bank` | — | `200 {recipes: [...], saving: [...]}` | Lists all `banked` recipes (newest `banked_at` first, with signed thumbnail URL, title, vibe, description, serves, prep/cook/total minutes, `seq`, `conceptId`) plus any `pending`/`failed` rows in `saving`. |
| `GET /cookout/{seq}?as=<sender>` | Query `as` (viewer name) | `200 CookoutView` (`Cache-Control: no-store`) | Returns viewer-filtered round view (enforcing Blind Mode server redaction). |
| `POST /cookout/{seq}/join` | `{sender}` | `200 CookoutView` | Binds Slot 2 (`player2_key`, `player2_name`, `player2_email`) if unbound; idempotent for Slot 2. |
| `POST /cookout/{seq}/skip` | `{sender, moveId, turn, offer}` | `200 CookoutView` | Rejects `offers[offer]` (`offer ∈ {0, 1}`) on active `turn`, draws and appends a fresh pair; `409 skip_exhausted` if `offer == 2`. |
| `POST /cookout/{seq}/pick` | `{sender, moveId, turn, offer, ingredientId}` | `200 CookoutView` | Records `choice_id = ingredientId` from `offers[offer]`; either creates `turn + 1` or finishes the round (`turn == 10`) and starts Stage 1 concepts. |
| `POST /cookout/{seq}/concepts/retry` | `{sender}` | `200 CookoutView` | Retries a `failed` or `unavailable` concepts job when runner is available. |
| `POST /cookout/{seq}/pictures/retry` | `{sender}` | `200 CookoutView` | Retries a `failed` ComfyUI picture batch for missing slots. |
| `POST /cookout/{seq}/concepts/{conceptId}/bank` | `{sender, moveId}` | `200 CookoutView` | Creates/resumes `cookout_recipes` row for `conceptId ∈ {"a","b","c"}` in `pending` and starts Stage 2 full-recipe job. |
| `POST /cookout/{seq}/concepts/{conceptId}/recipe/retry` | `{sender}` | `200 CookoutView` | Retries a `failed` or `unavailable` full-recipe job for `conceptId`. |

Standard error codes: `404 not_found`, `409 bad_state` / `not_your_turn` / `not_player` / `skip_exhausted` / `exhausted`, `422 invalid`, `503 game_unavailable`.

#### 5.3 Public summary (`Message.cookout`) and `CookoutView` shape

- **`Message.cookout`:** `{state, blind, pickedCount, concepts, bankedCount, rev} | null`. Carries zero private ingredients or recipe text. `wyrRefKind` widens to `"wyr" | "adventure" | "cookout"`.
- **`CookoutView`:**
  ```text
  {
    seq, state: "picking" | "finished" | "abandoned", rev, blind, revealed,
    players: [
      { slot: 1, name: string, pickCount: 0..5, picks: [Ingredient] | null },
      { slot: 2, name: string | null, pickCount: 0..5, picks: [Ingredient] | null }
    ],
    you: { slot: 1 | 2 } | null,
    current: {
      turn: 1..10, player: 1 | 2,
      options: [Ingredient, Ingredient] | null,
      offerIndex: 0 | 1 | 2 | null,
      skipsRemaining: 0 | 1 | 2 | null
    } | null,
    history: [{ turn: 1..10, player: 1 | 2, offers: [[Ingredient, Ingredient], ...], choice: Ingredient | null }],
    staples: [{ id, name }],
    concepts: { state: "none"|"pending"|"ready"|"failed"|"unavailable", data: [Concept] | null, error: string | null, canRetry: boolean },
    images: { state: "none"|"pending"|"done"|"failed", pictures: { a: Picture|null, b: Picture|null, c: Picture|null }, canRetry: boolean },
    recipes: { a: RecipeSlot, b: RecipeSlot, c: RecipeSlot }
  }
  ```

#### 5.4 Client UI (`admin-ui/src/server/cookout/`, 360px phone-first)

- **`⋯` menu (`thread.ts`):** Adds **Cookout** ("Pick ingredients, invent dinner"), **Cookout (blind)** ("Hide your picks until the big reveal"), and **Recipe book** ("Recipes you've banked").
- **Tab registration (`gameTabs.ts`):** `GameKey = "wyr" | "adventure" | "cookout"`. Opening or offering Cookout automatically replaces any open WYR or Adventure tab in the second tab slot (`replaceOthers`).
- **Cookout Pane (`cookoutGame.ts`):**
  1. **Header bar:** `[ 🍳 Cookout   (Blind badge)   Recipe book   New   ✕ ]`.
  2. **Progress & Turn bar:** 10 compact basket progress pills (5 for Player 1, 5 for Player 2) + turn status (`"Your turn — Pick 2 of 5 (Go 1 of 3)"` or `"Waiting for Hannah — Pick 2 of 5"`). If Slot 2 is unbound and viewing the pane, shows a prominent **Join Cookout** button (and auto-joins on tap).
  3. **Choice stage (`picking`):**
     - When `current.options` is visible: two large tactile ingredient cards (stacked vertically at 360px, side-by-side on desktop) showing category emoji + category pill, bold ingredient `name`, and `blurb`. Below them sits the full-width skip button: **"Neither — deal 2 new options (2 left)"** (`offerIndex == 0`), **"Neither — deal final 2 options (1 left)"** (`offerIndex == 1`), or hidden/disabled **"Final pair — pick one above"** (`offerIndex == 2`).
     - When `current.options` is `null` in Blind mode (partner's turn): renders a covered kitchen cloche card (*"🕵️ Secret turn: {partner} is choosing Pick #{n}..."*) with zero hidden ingredient data in DOM attributes.
  4. **Picks basket:** Collapsible basket tray showing selected ingredients (or covered `🔒 Secret pick` placeholders for the partner in Blind mode until `finished`, when all 10 flip open together) plus a compact footer note listing the 10 allowed cupboard staples.
  5. **Finished stage (`finished`):**
     - Three concept cards (stacked on 360px mobile, 3-column grid on wide screens). Each card reserves a 16:9 / square image header at the top (showing the rendered ComfyUI dish photo or a shimmering plate placeholder while `images.state == "pending"`, or a clean styled text header if text-only), followed by `title`, `vibe` badge, `description`, used-ingredient pills (`"Uses 9/10"` + `"Plus staples: butter, salt"`), and its independent **Bank this** button.
     - Tapping **Bank this** transitions that card's button to **"Writing recipe…"** (`recipes[id].state == "pending"`). Once `state == "banked"`, the card shows **"Banked ✓ — View full recipe"**, expanding a scrollable recipe sheet inside the pane with `serves`, `prepMinutes`/`cookMinutes`/`totalMinutes`, exact ingredient quantities, numbered method steps, and chef tips.
  6. **Shared mini chat (`itemChat.ts`):** Fixed 60px `MiniStrip` (`popupTitle: "Cookout chat"`) above the shared composer, sending with `wyrSeq = activeCookoutSeq` (`wyrRefKind = "cookout"`).

---

## Section C — Implementation Plan, Dependencies, and Interface Contracts

To guarantee zero file collisions across parallel builders, shared files have a **single designated owner**:

| Parcel | Builder Model | Owned Files (Exclusive) | Depends On |
|---|---|---|---|
| **P0 — Contract Freeze** | Orchestrator / Lead | `spec/server-chat/09-cookout.md` (this merged spec), canonical JSON wire fixtures | None (starts first) |
| **P1 — Ingredient Bank & Validator** | **Sonnet 5.5** | `wixy_server/livechat/cookout_ingredients.json`, `wixy_server/livechat/cookout_bank.py`, `tooling/cookout/validate_bank.py`, `wixy_server/tests/test_cookout_bank.py` | P0 contract (runs in parallel with P2, P3, P4; exports a small 60-item test bank fixture immediately while authoring the full ~3,000-item JSON) |
| **P2 — Store v21, Game Engine, Routes & App Wiring** | **Sonnet 5.5** | **Sole owner** of `wixy_server/livechat/store.py`, `wixy_server/livechat/models.py`, `wixy_server/livechat/cookout_game.py`, `wixy_server/routes_livechat_cookout.py`, `wixy_server/app.py`, `wixy_server/tests/test_livechat_cookout.py`, `wixy_server/tests/test_routes_livechat_cookout.py` | P1 `CookoutBank` protocol & P3 `CookoutJobRunner` protocol (uses lightweight fakes in unit tests so P2 and P3 build in parallel) |
| **P3 — AI Jobs & Local ComfyUI Pictures** | **Sonnet 5.5** | **Sole owner** of `wixy_server/livechat/cookout_ai.py`, `wixy_server/livechat/cookout_images.py`, `wixy_server/livechat/wyr_images.py` (`generate_batch` + `OWNED_PREFIXES`), `wixy_server/tests/fake_cmd.py` (canned Cookout responses), `wixy_server/tests/test_livechat_cookout_ai.py`, `wixy_server/tests/test_livechat_cookout_images.py` | P1 `CookoutBank` protocol & P2 store job methods (never edits `store.py`, `models.py`, or `app.py`) |
| **P4 — Admin UI (Pane, Card, Recipe Book & Frame)** | **Opus 5.5** | **Sole owner** of `admin-ui/src/server/cookout/{api.ts, model.ts, cookoutGame.ts, cookoutCard.ts, recipeBook.ts}`, `admin-ui/src/server/{gameTabs.ts, thread.ts, api/messages.ts}`, `admin-ui/src/styles/livechat.css`, `admin-ui/tests/server/cookout*.test.ts`, plus rebuilt `wixy_server/static/admin/*` bundles | P0 wire contract (builds in parallel with P1–P3 against JSON fixtures) |
| **P5 — Docs, Invariant 57 & Playwright E2E** | **Sonnet 5.5** | `e2e/tests/server-cookout.spec.ts`, `docs/ai/{livechat.md, contracts.md, invariants.md, glossary.md, testing.md}`, `CLAUDE.md` store table, `decisions/NNNNN-server-chat-cookout/` | Drafts in parallel; runs full-stack E2E once P1–P4 integrate |

### Frozen Interface Contracts Between Parcels

1. **P1 (`cookout_bank.py`) → P2 & P3:**
   ```python
   @dataclass(frozen=True, slots=True)
   class Ingredient:
       id: str
       name: str
       category: str
       category_name: str
       emoji: str
       family: str
       rarity: Literal["everyday", "uncommon", "exotic"]
       blurb: str
       tags: tuple[str, ...]


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
       def staple_ids(self) -> frozenset[str]: ...
       def draw_pair(
           self,
           *,
           seen_ids: AbstractSet[str],
           player_offered_categories: Sequence[str],
           recent_picked_ids: AbstractSet[str] = frozenset(),
           rng: random.Random | None = None,
       ) -> tuple[Ingredient, Ingredient]: ...
   ```

2. **P2 (`store.py`) → P3 (`cookout_ai.py`, `cookout_images.py`):**
   - `set_cookout_concepts_run(anchor_seq: int, run_id: str, expected_run_id: str | None = None) -> bool`
   - `finish_cookout_concepts(anchor_seq: int, run_id: str | None, state: Literal["ready", "failed", "unavailable"], *, concepts_json: str | None = None, error: str | None = None, pictures_pending: bool = False) -> bool`
   - `cookout_pending_concepts() -> list[tuple[int, str | None]]`
   - `claim_cookout_pictures(anchor_seq: int, *, stale_before: float | None, now: float) -> Literal["claimed", "not_due", "gave_up", "gone"]`
   - `create_cookout_picture_attachments(anchor_seq: int, images: Mapping[str, tuple[str, int]], by_email: str | None, now: float) -> bool`
   - `fail_cookout_pictures(anchor_seq: int, *, now: float) -> bool`
   - `set_cookout_recipe_run(anchor_seq: int, concept_id: str, run_id: str, expected_run_id: str | None = None) -> bool`
   - `finish_cookout_recipe(anchor_seq: int, concept_id: str, run_id: str | None, state: Literal["banked", "failed", "unavailable"], *, recipe_json: str | None = None, error: str | None = None) -> bool`
   - `cookout_pending_recipes() -> list[tuple[int, str, str | None]]`

3. **P3 (`cookout_ai.py`, `cookout_images.py`) → P2 (`routes_livechat_cookout.py`, `app.py`):**
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

---

## Section E — Genuine Open Questions for the Operator

**None block building the core game.** All three panel seats converged on the core mechanics (2 skips per turn, 5 picks per player = 10-ingredient shared basket, server-filtered Blind mode revealed on the 10th pick, 3 concepts first with local ComfyUI pictures, and independent on-demand full-recipe generation into the Recipe book when **Bank this** is tapped).

The only optional follow-up choice for the operator is **which (if any) of the ranked Fun Twists in Section 3 below** he would like added after or alongside the core build.

---

# 3. The Merged Fun-Twist List (Section B — De-Duplicated & Ranked)

All three proposals contributed fun twist ideas (`argon`: 7, `kimi`: 8, `astra`: 9). De-duplicating overlapping ideas across the three seats yields **12 distinct twists**. Every twist is strictly additive — **the core game in Section A depends on none of them**.

The **Top 5 Recommended Twists** are marked with **⭐ TOP 1–5**.

### ⭐ TOP 1 — One-Ingredient Rescue Swap ("Send One Back to the Kitchen") *(Proposed by all 3: `argon` #1, `kimi` #1, `astra` #1 — Operator's example)*
- **Plain-English pitch:** *"Love the basket, hate the sardines? After the three dish ideas arrive, swap out one rogue ingredient and make the chef cook up three new ideas."*
- **Why it's fun:** A Blind Mode draft can occasionally land one ingredient (like Marmite or tinned sardines) that hijacks all three concepts. Giving the couple **one** post-reveal rescue swap turns a culinary disaster into a hilarious shared negotiation (*"Whose fault is the anchovies? Swap it!"*) and a second dramatic reveal.
- **Build cost:** **M**
- **How it layers on the core:** Adds a once-per-round `POST /cookout/{seq}/swap` action after `concepts = 'ready'` that draws 1 replacement pair for a chosen turn (`1..10`), records the swapped basket revision, and re-runs Stage 1 concepts + pictures while keeping any already-banked recipe attached to its original snapshot.

### ⭐ TOP 2 — Blind Dinner Vote ("Tonight's Winner") *(Proposed by all 3: `argon` #7, `kimi` #5, `astra` #2)*
- **Plain-English pitch:** *"Once the three dishes and photos appear, both of you secretly tap the one you'd actually eat tonight — then flip them over to see if you matched."*
- **Why it's fun:** Gives the three concept cards a playful head-to-head finish just like Would-You-Rather's reveal: agreeing crowns **"🎯 Tonight's Cookout!"** automatically, while disagreeing sparks instant banter in the mini chat.
- **Build cost:** **S**
- **How it layers on the core:** Two nullable columns (`vote1`, `vote2` ∈ `{'a','b','c'}`) on `cookout_rounds`, redacted in `cookout_view_json` until both have voted. Banking remains completely independent so either player can still bank any dish.

### ⭐ TOP 3 — Chef's Vibe / Cuisine Wheel ("Dinner in Disguise") *(Proposed by all 3: `argon` #2, `kimi` #3, `astra` #5)*
- **Plain-English pitch:** *"Spin a style wheel — like 'Late-Night Street Food', 'Cosy Country Pub', 'Chaotic Michelin Tasting Menu', or 'Breakfast for Dinner' — to steer how the chef interprets your ten ingredients."*
- **Why it's fun:** The exact same 10-ingredient basket feels completely different when plated as *Late-Night Street Food* versus *Chaotic Michelin*, giving the concepts and ComfyUI photos a shared theme.
- **Build cost:** **S**
- **How it layers on the core:** One optional `vibe_preset` enum chosen from a static server allowlist before `finished` and passed as a one-line style directive in `build_concepts_prompt`. Zero extra ingredients allowed; zero changes to turn or banking logic.

### ⭐ TOP 4 — "We Cooked It!" Reality Photo & Rating Stamp *(Proposed by all 3: `argon` #3, `kimi` #8, `astra` #7)*
- **Plain-English pitch:** *"When you actually cook a banked recipe together, stamp it 'Cooked!', rate it out of five hearts, and snap a real photo of your plate to sit right next to the AI's glossy daydream."*
- **Why it's fun:** Connects the sofa game to a real date night in the kitchen — comparing "AI Expectation vs. Kitchen Reality" turns the Recipe book into a personal memory book of meals you invented together.
- **Build cost:** **M**
- **How it layers on the core:** Optional metadata columns on `cookout_recipes` (`rating1`, `rating2`, `cooked_at`, `real_photo_attachment_id` referencing an ordinary photo attachment on the round). Never required to bank or browse recipes.

### ⭐ TOP 5 — The 11th Ingredient "Chef's Wildcard Cloche" *(Proposed by `argon` #5 & `kimi` #2)*
- **Plain-English pitch:** *"After all ten picks are in, dare to lift the silver cloche to throw one surprise eleventh curveball ingredient into the pot before the chef starts cooking."*
- **Why it's fun:** A quick, high-drama "press your luck" moment right after the 10-pick reveal when the basket looks a little *too* safe and sensible.
- **Build cost:** **S**
- **How it layers on the core:** Optional `wildcard_id` column on `cookout_rounds`, drawn server-side from an unseen `exotic`/`uncommon` family if tapped before `concepts` starts, and appended to the concept prompt's basket list.

---

### Ranked Twists 6–12

6. **Tonight's Kitchen Challenge / Handicap** *(`kimi` #4, `astra` #8)*
   - **Pitch:** *"Add one real-world rule — like 'One Pan Only', 'Ready in 25 Minutes', or 'No Oven' — and see if the chef can pull it off."*
   - **Why it's fun:** Makes a silly basket genuinely cookable on a busy weeknight.
   - **Cost:** **S** · **Layering:** Static challenge enum added to the concept and full-recipe prompts.

7. **Secret Star Ingredient** *(`astra` #3)*
   - **Pitch:** *"Each of you secretly stars one of your five picks — the chef has to make both star ingredients the hero of the dish."*
   - **Why it's fun:** Gives each player a personal stake in the final dishes, especially when the two stars clash (e.g. *kippers* + *white chocolate*).
   - **Cost:** **M** · **Layering:** Nullable `star1_id`/`star2_id` on `cookout_rounds`, passed into the concept prompt as mandatory hero components.

8. **"Fridge Raid" Starting Seed** *(`argon` #6)*
   - **Pitch:** *"Have chicken thighs or halloumi in the fridge that needs using up tonight? Pin one real ingredient from home as Pick #1 and draft the other nine around it."*
   - **Why it's fun:** Lets Cookout double as a real "what are we making with what's in the fridge?" dinner solver.
   - **Cost:** **S** · **Layering:** Optional `seedIngredientId` in `POST /cookout` that pre-fills Turn 1's choice from the static bank.

9. **Steal / Veto Token ("Hospital Pass")** *(`argon` #4, `kimi` #6)*
   - **Pitch:** *"Once per game, veto one option on your partner's table (or offer to trade your last pick with theirs) before the chef starts."*
   - **Why it's fun:** Pure sofa mischief when you spot your partner hovering over *Durian* or *Blue Cheese* in Open mode.
   - **Cost:** **M** · **Layering:** Optional per-player boolean flag (`veto1_used`, `veto2_used`) adding a pre-finish swap/redraw move.

10. **The Chaos Shelf** *(`astra` #6)*
    - **Pitch:** *"Feeling brave? Once per game, tap 'Chaos Shelf' on your turn to deal two guaranteed exotic curveballs."*
    - **Why it's fun:** Makes weird ingredients an intentional dare rather than an accidental draw.
    - **Cost:** **S** · **Layering:** Optional flag on `skip`/turn draw that weights `rarity = "exotic"` at 100% for that pair while keeping normal turns balanced.

11. **Leftovers Remix / Encore** *(`kimi` #7, `astra` #9)*
    - **Pitch:** *"Start a new Cookout round seeded with the ingredients yesterday's winning recipe left behind (or remix a favourite banked dish with one fresh draw)."*
    - **Why it's fun:** Gives omitted ingredients or favourite banked dishes a sequel round.
    - **Cost:** **M** · **Layering:** `POST /cookout` accepts an optional `fromRoundSeq` that seeds the first 1–2 turns into a brand-new anchor round without mutating the old one.

12. **Lucky Dip Coin Flip** *(`astra` #4)*
    - **Pitch:** *"Torn between two great ingredients on your turn? Flip the kitchen coin and let fate pick between the two on the table."*
    - **Why it's fun:** Zero-wait suspense when both options are tempting, without burning a skip.
    - **Cost:** **S** · **Layering:** Client or server coin flip that selects one of the two currently offered `options` and submits the normal `pick` move.

---

# 4. Remaining Disagreements

Across the three proposals, **there are no remaining architectural disagreements**: all three seats independently converged on the 2-skip-per-turn rule, 5 picks per player (10 total), server-redacted Blind mode with a full 10-ingredient reveal at the end, a 3-chain batched ComfyUI image job under the shared GPU limiter, and the 2-stage AI split (3 concepts first -> full recipe only on Bank).

The only two minor calibration points where the three proposals used slightly different constants—and the concrete evidence that settles each during implementation—are:

1. **Exact Concept B & C minimum picked-ingredient floor (`6/10` in `kimi`, `7/10` in `argon`, `8/10` in `astra`):**
   - **Merged default:** Concept A ("The Everything Dish") must use `>= 8/10` (aiming for `10/10`), Concepts B and C must each use `>= 7/10`, and the union across A, B, and C must cover all `10/10`.
   - **Evidence that settles it:** During Parcel 3 implementation, run a 20-basket benchmark fixture (including 5 deliberately clashing "awkward baskets" mixing sweet, savoury, and drinks) against `claude-sonnet-5-5`. If `>= 7/10` for B & C causes `> 5%` first-try rejection on clashing baskets, lower B & C's floor constant to `6/10` while keeping Concept A at `>= 8/10` (aiming for `10/10`) and union coverage at `10/10`.

2. **Exact Turn-1 start state (`picking` immediately in `argon` vs. `waiting` for `POST /join` before Turn 1 in `kimi`/`astra`):**
   - **Merged default:** Start in `picking` with Turn 1's pair already drawn for Slot 1 (so the starter can make their Turn 1 pick immediately without staring at a waiting screen), while exposing `POST /cookout/{seq}/join` so Slot 2 is explicitly bound before Turn 2's Blind Mode options are revealed.
   - **Evidence that settles it:** Two-browser E2E test (`server-cookout.spec.ts`) verifying both (a) Player 1 picking Turn 1 immediately after starting a round, and (b) Player 2 unable to read Turn 2's Blind Mode options until bound to Slot 2 via `/join`.
