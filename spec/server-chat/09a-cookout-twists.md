# Server chat — Cookout twists (addendum to `09-cookout.md`)

Workspace 00058. Decided addendum: implement faithfully on top of the shipped core
(`spec/server-chat/09-cookout.md`, schema v21). The operator accepted all twelve twists the panel
proposed (Triad round 2, `triad/cookout/round-2/{argon,kimi,astra}.md` section B; ruling
`triad/cookout/ruling.md`). Where this file is silent the core spec governs. Where reality
contradicts a cited fact, prefer reality and record it in `decisions/00194-server-chat-cookout-twists/`
(take max+1 if that id is taken when you land).

## 0. The twelve twists (operator pitch wording) and the governing rules

| # | Twist | Operator pitch | Kind |
|---|---|---|---|
| T1 | Rescue swap | "after the three dishes appear, swap out ONE ingredient you regret and the chef makes three new dishes." | in-game action (chef stage) |
| T2 | Dinner vote | "you each secretly tap the one you'd actually eat tonight, then both are revealed." | in-game action (chef stage) |
| T3 | Chef's style wheel | "pick or spin a style such as cosy pub, street food, posh tasting menu or breakfast for dinner" | start-sheet option |
| T4 | We cooked it! | "mark a banked recipe cooked, each give it a rating, and add your own photo next to the AI's picture." | in-game action (banked recipe) |
| T5 | Wildcard cloche | "after all ten picks, dare to lift a lid that adds one surprise eleventh ingredient neither of you chose." | start-sheet option + gate |
| T6 | Fridge raid | "start the game with one ingredient you actually have at home tonight, and draft the rest around it." | start-sheet option |
| T7 | Kitchen challenge | "a rule like one pan only, no oven, or ready in thirty minutes, and the chef has to stick to it." | start-sheet option |
| T8 | Partner veto | "once per game (open mode only), sweep one option off your partner's table before they pick." | in-game action (drafting) |
| T9 | Leftover encore | "start a new game seeded with the ingredients a previous recipe left out, or remix a favourite banked dish." | new-round entry point |
| T10 | Lucky dip | "on your turn, let a kitchen coin pick between the two ingredients for you." | in-game action (drafting) |
| T11 | Secret star | "you each secretly star one of your own picks, and the chef must make both stars the heroes of every dish." | start-sheet option + gate |
| T12 | Chaos shelf | "once each per game, swap your normal two options for two guaranteed weird and exotic ones." | in-game action (drafting) |

Governing rules for every twist (each is a decided requirement, not a preference):

1. **Core unchanged when unused.** A round started with no start-sheet twist and in which nobody
   presses a twist button behaves byte-for-byte like the core spec: same states, same draws, same
   prompts (the prompt builders emit no twist text at all), same view fields (new fields take their
   "off" values), same tests green.
2. **Optional and off by default.** Start-sheet options (T3, T5, T6, T7, T11) default off and sit
   behind a collapsed **"Add twists (optional)"** disclosure so the core sheet stays as compact as
   today. In-game actions (T1, T2, T4, T8, T10, T12) and the encore entry point (T9) are buttons the
   players may simply ignore; they never block the core flow. The only twists that can hold the chef
   back are the two a player explicitly switched on at the start (T5's cloche and T11's stars), and
   only until a player answers them (§1.4).
3. **Blind mode never leaks partner data.** All redaction stays in Python (`cookout_view_json`).
   Secret-by-design twists (T2 votes, T11 stars) stay hidden from the partner in **both** modes until
   their own reveal moment. Nothing new is added to `Message.cookout` except counts and flags (§4.4).
4. **Server-authoritative and idempotent.** Every mutation calls `require_server_token` first, runs
   in one `_write_txn()` with `time.time()` sampled after the lock, publishes only after commit,
   answers with the caller's filtered view and `Cache-Control: no-store`. Moves carry `moveId`
   (8–64 chars) or are state-idempotent, exactly as the core.
5. **Prompts stay food-only.** The only new prompt content is ingredient ids/records and server-owned
   constant text chosen by a fixed enum id. No client string ever reaches a prompt.
6. **Everything is anchor-owned chat content (Inv 57).** New rows cascade with the anchor, are
   deleted by `_wipe`, and no formatted timestamp is stored (epoch-second `REAL` only).

---

## 1. Behaviour and states

### 1.1 Start-sheet options (T3, T5, T6, T7, T11) — fixed at creation

`POST /api/admin/server/cookout` gains optional fields (§4.2). All are **immutable for the round**
once created. Reason: both players see the same rules from the first pick, a setting can never be a
covert lever one player pulls mid-game, and the prompts stay a pure function of the round. To change
them, press **New** (the start sheet comes back preselected with the current round's settings).

- **Chef's style (T3):** `style` is `null` (default), one of the eight fixed style ids in §3.1, or
  `"spin"`. `"spin"` is resolved **by the server** with `secrets.SystemRandom().choice(STYLE_IDS)` at
  creation and stored as the concrete id with `style_spun = 1` (the client then plays a one-time
  wheel animation that lands on the server's answer; a client-side spin would be theatre the server
  could not honour). The style is public (both modes): it is a setting, not partner data.
- **Kitchen challenge (T7):** `challenge` is `null` (default) or one of the four fixed ids in §3.2.
  Public. Style and challenge combine freely (both directives go into the prompt; only the
  challenge is validated).
- **Wildcard cloche (T5):** `wildcard: true` arms the cloche (`cookout_rounds.wildcard = 'armed'`).
  It is offered only after the tenth pick (§1.4). Public.
- **Secret stars (T11):** `stars: true` enables starring (§1.5). Public that the twist is on; the
  stars themselves are secret.
- **Fridge raid (T6):** `fridgeSeedId` names one bank ingredient found with the bank search route
  (§4.2 `GET /cookout/ingredients`). It becomes the creator's Turn 1 pick, a public **starter** (§1.3).
- **Chef needed:** style, challenge, wildcard and stars exist only to change what the chef makes. When
  the runner is unavailable (`runner.available == False`, e.g. the standalone edition) the server
  rejects any of them with `422 invalid` ("needs the chef") and `GET /cookout/options` reports
  `chef: false` so the sheet hides them. Fridge raid and every drafting twist remain available.

### 1.2 Drafting twists (T8 veto, T10 lucky dip, T12 chaos shelf)

All three act on **the pair currently on the table**: the live turn's `offers[offerIndex]` where
`offerIndex = len(offers) - 1`, with `choice_id IS NULL`. Every request names the move it saw:
`{turn, offer}` plus the two option ids (`optionIds`) or the target option (`ingredientId`); a request
whose `turn`/`offer`/option ids no longer match the table is `409 bad_state` (stale), a replay of a
recorded `moveId` is `200` with the current view and no event.

**Replacement in place, never a hidden skip.** Veto and chaos replace option(s) *inside* the live
offer, so `offerIndex` and `skipsRemaining` are unchanged and no skip is charged or refunded. Every
replaced snapshot is kept in `cookout_turns.replaced` (§2.2) so it still counts as offered for the
draw's exclusions (`seen_ids`, `offered_families`, and the active player's category counts) and is
shown in the turn's history.

- **Lucky dip (T10):** the **active player** asks the server to choose. The server flips
  `secrets.SystemRandom().random() < 0.5` between the two live options at commit time and commits it
  exactly as `pick` would (same turn advance, same Turn-10 behaviour), setting `cookout_turns.lucky = 1`
  and `pick_move_id = moveId`. Available on any offer index, any number of times (it *is* a pick; the
  pitch puts no limit on it). Works in Open and Blind. `optionIds` must equal the live pair (order-free)
  so a veto that changed the table first makes the dip stale instead of silently choosing between
  options the player never saw.
- **Chaos shelf (T12):** the **active player**, **once per player per round**, replaces both live
  options with an exotic pair (§5.1 `draw_pair(..., rarity_mode="exotic")`). Allowed on any offer
  index, including the final pair (then they must pick one of the two exotic options: that is the
  dare). After chaos the player may still skip if skips remain (the next pair is a normal draw).
  The used token is derived, not stored on the round: player `p` has used chaos when any of `p`'s
  turns has `chaos_offer IS NOT NULL`. No feasible exotic pair → `409 exhausted`, token not spent,
  table unchanged. Works in Blind: only the active player ever sees the chaos pair.
- **Partner veto (T8):** **Open mode only.** The **non-active bound player**, **once per player per
  round**, sweeps one live option off the active player's table. The swept option is replaced by a
  single fresh option (§5.1 `draw_replacement`) that keeps the pair legal: same role, a different
  category and family from the option that stays, at least one `everyday` in the pair (if the
  remaining option is not `everyday` the replacement must be), all hard exclusions. If the live pair
  is a chaos pair the replacement is drawn exotic (the dare stays a dare). Token derived: player `p`
  has used veto when any turn of `p`'s partner has `veto_offer IS NOT NULL`. A turn can carry at most
  one veto (the partner holds one token). Blind mode → `409 bad_state` (the partner cannot see the
  table, so the button never renders). No feasible replacement → `409 exhausted`, token not spent.
- **Races (serialised by `BEGIN IMMEDIATE`):** a pick of the swept option after the veto commits is
  `409 bad_state` (the core currently answers `422 invalid` for "not one of the two offered"; when the
  id is in that turn's `replaced` list it must answer `409 bad_state`, because it was legal when the
  player saw it). A pick of the option that stayed is valid. A veto after the pick commits is
  `409 bad_state`. Lucky dip and chaos after a veto are stale only if their `optionIds` no longer
  match.
- **Starters are not offers.** Seeded turns (§1.3) have no pair; none of these actions apply to them.

### 1.3 Starters: fridge raid (T6) and leftover encore (T9)

A **starter** is a bank ingredient placed into the basket at creation instead of being drafted.
Starters fill the first turns in order (Turn 1 = Player 1, Turn 2 = Player 2), count towards that
player's five picks, and are **public in both modes from the start** (they were not drafted under
blind conditions, and "what's in our fridge tonight" is a shared fact). They are stored as seeded
`cookout_turns` rows (`seed` snapshot, `offers = []`, `choice_id = seed id`, `pick_move_id = NULL`).

- **At most two starters per round.** Fridge raid contributes one; an encore contributes one or two,
  but only one when combined with fridge raid. Reason: two starters fill exactly the first role pair
  (one per player), so both players still draft the same number of turns; three would hand one
  player two free picks.
- **Fridge raid:** `fridgeSeedId` must be a bank ingredient id (`422 invalid` otherwise). It is
  Turn 1 (creator).
- **Encore:** `encore = {fromSeq, generation, conceptId, kind, seedIds}` names a concept of a finished
  round with ready concepts, in the current or an archived generation (§1.6).
  - `kind = "leftovers"`: every `seedIds` entry must be in that concept's `omitted` list ("the
    ingredients a previous recipe left out"). A concept that omitted nothing offers no leftovers
    encore. The concept need not be banked (any ready concept card offers it).
  - `kind = "remix"`: the concept's recipe must be **banked** in that generation ("remix a favourite
    banked dish") and every `seedIds` entry must be in its `pickedIngredientIds` (or be the round's
    wildcard if the concept used it).
  - `seedIds`: 1–2 distinct ids (exactly 1 if a fridge seed is also given), with distinct families
    from each other and from the fridge seed (the core's picked-family rule). The source snapshot is
    copied from the source round (never re-read from the bank) so the new round owns immutable data;
    the bank entry must still exist (it supplies the role; the bank is append-only, so it always
    does).
  - Validation runs **inside** the create transaction, after the `clientId` replay check, so a replay
    succeeds even if the source has since been deleted. Source missing, not finished, concept absent,
    recipe not banked (remix) or seed outside the allowed set → `422 invalid`.
  - The new round stores only a link (`encore_from_seq` with `ON DELETE SET NULL`, plus
    `encore_generation`, `encore_concept_id`, `encore_kind`); the source title is resolved at read
    time and disappears with the source (§6). The source round is never mutated.
- **Order when both:** fridge seed on Turn 1, encore seed on Turn 2.
- **Role schedule with starters:** the server calls `shuffle_role_schedule(first_role=role of the
  Turn-1 starter)` (§5.1) so the first role pair matches the first starter. With one starter, Player 2's
  Turn 2 is drafted in the same role, preserving the core's equal-opportunity schedule. With two
  starters, the first pair is consumed by them; turns 3–10 follow the schedule (the second starter's
  role may differ from the pair role — accepted, recorded in the decision entry).
- **Turn flow with starters (generalises the core rule):** *a turn belonging to Player 2 is never
  drawn until Player 2 is bound.* After creation the server draws the first non-seeded turn
  immediately if it is Player 1's (two starters → Turn 3 is drawn at once), otherwise waits for Join
  (one starter → the round waits at Turn 2 with `waitingForJoin = true`, exactly the core's
  "Turn 1 picked before Join" state). `pick` draws `turn + 1` unless it is Player 2's turn and Slot 2
  is unbound; `join` draws the next turn when the last row is picked and the next turn is Player 2's.
- **Draw inputs include starters:** a starter's id joins `seen_ids` and its family joins
  `picked_families` and `offered_families`; it does not count towards any player's category counts
  (it was never shown as an option).

### 1.4 The chef gate (T5 cloche, T11 stars)

The core starts Stage 1 in the same transaction as the Turn-10 pick. With the cloche armed or stars
enabled, Turn 10 still sets `state = 'finished'` (the Big Reveal happens at once) but the concepts job
starts only when the **gate** is clear:

```text
gate_open(round) =
    round.state == 'finished' and round.concepts == 'none' and (
        round.wildcard in ('armed', 'offered')            # cloche not yet answered
        or (round.stars and (round.star1_id is None or round.star2_id is None))
    )
```

- At the Turn-10 commit: `wildcard 'armed' → 'offered'`; then the shared helper
  `_cx_maybe_start_concepts(conn, round_, runner_available, now)` runs: if the gate is clear it applies
  the core's Turn-10 assignments (`concepts = 'pending'` + timers, or `'unavailable'`), else it leaves
  `concepts = 'none'`. Every action that can clear the gate (star, wildcard) calls the same helper in
  its own transaction, and its route starts `runner.start_concepts` when the returned round is
  `finished` + `pending` and the move changed something (the core's `pick` pattern). The 60 s sweep
  already resumes any `pending` round whose start was lost.
- The gate has no timeout. Reason: both players are present by definition (Turn 10 needs Player 2),
  each answer is one tap, and an unanswered gate harms nothing — it simply waits, like an unfinished
  draft. The pane shows who it is waiting for.
- `concepts.state` stays `"none"` while gated; the view adds `gate.waitingFor` (§4.3).

### 1.5 Secret stars (T11)

- Enabled per round at creation. Each bound player stars **one ingredient from their own five turns**
  (starters on their turns included; the wildcard is no one's pick and cannot be starred).
- `POST /cookout/{seq}/star {sender, ingredientId}` sets or changes the caller's star. It is
  state-idempotent (the same id again → `200`, no event). Allowed while `picking` (once you have at
  least one pick) and on a `finished` round while `concepts == 'none'`. Once concepts leave `'none'`
  (gate cleared) the stars are **locked**: a change is `409 bad_state`. `abandoned` → `409 bad_state`.
  An id that is not one of the caller's own picks → `422 invalid`.
- **Secrecy (both modes):** the viewer always sees their own star. The partner's star is revealed only
  when `starsRevealed = state == 'finished' and star1_id and star2_id are both set` (i.e. the moment
  the stars lock). Before that the partner sees only `partnerChosen: bool` (needed for "waiting for
  Cupcake to star one"). In Open mode picks are visible but stars are not; an abandoned round never
  reveals stars.
- **Chef rule (§5.3):** both stars must appear in every concept's `pickedIngredientIds` and be named
  in each concept's `title` or `description`; recipes must use them (already required) and the prompt
  asks for them to be the heroes. Stars cannot be rescue-swapped (§1.6).

### 1.6 Rescue swap (T1) and generations

**Once per round**, after the three dishes appear, one player sends one basket ingredient back and the
partner chooses its replacement; the chef then makes three new dishes. Banked recipes and their
pictures stay tied to the dishes they were made from.

- **Generation:** `cookout_rounds.generation` starts at `1`. A completed swap archives the current
  generation (its basket, concepts, picture map and votes) into a `cookout_generations` row and moves
  the round to `generation = 2` with a fresh Stage 1. Archived generations are read-only.
- **Propose** — `POST /cookout/{seq}/swap/propose {sender, moveId, ingredientId}`; either player.
  Requires `state == 'finished'`, `concepts == 'ready'`, `swap_state == 'none'` (a completed swap
  leaves `'done'`, so only one swap per round), no `cookout_recipes` row of the current generation in
  `pending` (`409 recipe_pending` — a recipe being written must finish first, so its concept is never
  archived mid-job), `ingredientId` in the current effective basket (§2.4) and not a star
  (`422 invalid`: a starred ingredient is a player's personal stake). The server draws a replacement
  pair with the normal draw (§5.1 `draw_pair`, role = the target's role: its turn role for a drafted
  pick, the bank role for a starter or the wildcard; exclusions = every id ever seen in the round
  including replaced, wildcard and earlier swap pairs; picked families = the current basket's families
  plus the target's own family, so its cousin never comes back; category counts = the partner's).
  Stores `swap_state = 'proposed'`, `swap_by`, `swap_out_id`, `swap_pair`, appends the pair to
  `swap_seen`. No feasible pair → `409 exhausted`.
- **Choose** — `POST /cookout/{seq}/swap/choose {sender, moveId, ingredientId}`; only the **other**
  player (the proposer gets `409 not_your_turn`). Choosing **is** the consent. Requires
  `swap_state == 'proposed'`, `ingredientId` in `swap_pair` (else `409 bad_state`), no pending recipe
  (`409 recipe_pending`). In one transaction (`choose_cookout_swap`):
  1. `INSERT INTO cookout_generations` the current generation: `basket` (effective basket ids before
     the swap), `concepts_json`, `pictures`, `vote1`, `vote2`, `superseded_at = now`.
  2. `DELETE FROM cookout_recipes WHERE anchor = ? AND generation = <current> AND state IN
     ('failed','unavailable')` (unfinished saves of the old dishes are dropped; `banked` rows stay
     tied to generation 1).
  3. `UPDATE cookout_rounds SET generation = generation + 1, swap_state = 'done', swap_in = <chosen
     snapshot>, swap_pair = NULL, vote1 = NULL, vote2 = NULL`, Stage 1 reset exactly like
     `retry_cookout_concepts` (`concepts = 'pending'` or `'unavailable'`, run/json/error cleared,
     timers reset) and the picture reset (`images = 'none'`, `pictures = NULL`, picture timers
     cleared, `images_generation = images_generation + 1` — the fence that defeats any late picture
     write of the old dishes, §5.4); bump `rev`, one `message_updated`. The route starts
     `start_concepts`.
- **Cancel / keep these dishes** — `POST /cookout/{seq}/swap/cancel {sender}`; either player while
  `proposed` → back to `'none'` (`swap_pair`, `swap_by`, `swap_out_id` cleared; `swap_seen` kept so a
  new proposal never re-deals the same items). The swap is not used up by a cancel. Already `'none'`
  → `200` no-op; `'done'` → `409 bad_state`.
- **While proposed:** Bank this is refused (`409 bad_state`; the buttons render disabled with "Finish
  or cancel the swap first") so no new recipe job can start against dishes about to be archived.
  Votes, cooked marks, ratings and photos stay allowed.
- **After the swap:** the generation-1 dishes appear in an **Earlier dishes** section: their cards,
  pictures, vote result and recipe states. Banked ones open their full recipe and keep T4. Unbanked
  ones are view-only (no Bank). Reason: banking an archived concept would need recipe jobs against a
  non-current concept set (two live job targets per round); the brief keeps only banked recipes
  tied to their version. Missing archived pictures cannot be retried (same reason).
- **Blind mode:** a swap happens after the reveal, so the target, the pair and the choice are visible
  to both players.

### 1.7 Dinner vote (T2)

- On a `finished` round with `concepts == 'ready'` (current generation), each player secretly taps
  one concept: `POST /cookout/{seq}/vote {sender, conceptId}`. State-idempotent; a player may change
  their vote until **both** have voted. When the second vote lands, both are revealed and locked (a
  different later vote → `409 bad_state`; the same → `200`).
- **Secrecy (both modes):** before the reveal a viewer sees only their own vote and
  `partnerVoted: bool`. After: both votes and `match` (the concept id when equal, else `null`). A match
  shows **"🎯 Tonight's dinner!"** on that card; a mismatch shows both voters' badges.
- A vote never banks anything and never starts a job. A completed swap archives the votes with
  generation 1 and clears them for generation 2.

### 1.8 We cooked it! (T4)

Applies to any **banked** recipe of any generation of the round.

- `POST /cookout/{seq}/recipes/{generation}/{conceptId}/cooked {sender, cooked: bool}` — either
  player. `true` stamps `cooked_at = now`, `cooked_by = sender` (idempotent when already cooked).
  `false` clears `cooked_at`, `cooked_by`, both ratings and the photo link (the client confirms first:
  "Unmark as cooked? Your ratings and photo link will be removed."). Not banked → `409 bad_state`.
- `POST /cookout/{seq}/recipes/{generation}/{conceptId}/rating {sender, rating: 1..5 | null}` —
  sets **the caller's own** slot rating (`rating1` for Slot 1, `rating2` for Slot 2); requires
  cooked (`409 bad_state`). Ratings are visible to both players at once (it is a memory book, not a
  blind game).
- `POST /cookout/{seq}/recipes/{generation}/{conceptId}/photo {sender, messageSeq: int | null}` —
  either player links (or with `null` unlinks) **an ordinary photo message from this round's mini
  chat**: the message must exist, be in `wyr_chat` with `anchor_seq = seq`, not be view-once
  (`view_once_s IS NULL`; Inv 52 — a view-once attachment is never linkable), and carry at least one
  `photo` attachment; the lowest-ordinal photo is linked (`photo_message_seq`, `photo_attachment_id`).
  Requires cooked. Otherwise `422 invalid`.
- **No new upload path.** "Add our photo" opens the round's mini-chat pop-up composer; the photo is
  sent as an ordinary mini-chat message (so it lives in the chat, the main thread and the Gallery like
  any photo), then linked. `GET /cookout/{seq}/photos` lists the round's linkable mini-chat photos.
- **Deletion:** deleting the linked message removes the link (FK `ON DELETE SET NULL` as the backstop
  for older processes; the new `_delete_message` path also clears `photo_attachment_id` and bumps the
  round's `rev` with a `message_updated` for the anchor so both screens drop the photo). The view
  shows a photo only when `photo_message_seq` is non-null and the attachment still exists on that
  message, is a `photo` and is `ready`.

### 1.9 Interactions between twists (all decided)

| Combination | Rule |
|---|---|
| Veto, lucky dip and chaos on one turn | All may happen; each guards on the table it saw. Veto then chaos: chaos replaces both current options (both appended to `replaced` as `chaos`). Chaos then veto: the replacement is exotic. Lucky dip after either chooses between the current two only if its `optionIds` match. |
| Chaos and skip | Chaos never charges or refunds a skip; skipping a chaos pair costs a skip and deals a normal pair. |
| Swap after wildcard | The wildcard may be swapped (it is in the basket). The replacement takes the wildcard's place (basket stays eleven), uses the wildcard's bank role, and is an ordinary item: the "wildcard in two dishes" rule no longer applies (`wildcard_id` becomes `null` in the AI read). |
| Swap and stars | Starred ingredients cannot be swapped; stars carry into generation 2 and the hero rule applies again. |
| Swap and style/challenge | Generation 2 uses the same round style and challenge. |
| Swap and dinner vote | Votes archive with generation 1; generation 2 starts unvoted. |
| Swap and pending recipe | Propose/choose refused (`409 recipe_pending`); Bank refused while proposed. |
| Swap of a starter | Allowed (a starter is a basket ingredient). |
| Encore + fridge raid | Fridge seed is Turn 1, exactly one encore seed is Turn 2. |
| Encore source in an archived generation | Allowed (`generation` names it); leftovers need not be banked, remix must be banked in that generation. |
| Stars + wildcard gate | Both gates must clear, in any order; concepts start on the last answer. |
| Stars + lucky/chaos/veto picks | Any of your own picks may be starred, however it was chosen. |
| Style + challenge | Both directives in the prompt; only the challenge is validated; the picture uses the style's presentation phrase. |
| Challenge + wildcard/stars | All rules apply together; the coverage rules (§5.3) still hold. |
| Cooked + swap | T4 works on banked recipes of every generation. |
| Vote + Bank | Independent; neither triggers the other. |

---

## 2. Schema v22 (`store.py`; additive from v21, which is deployed and never edited)

Bump `_LATEST_SCHEMA_VERSION = 22` and add `_SCHEMA_V22_COOKOUT_TWISTS`, applied in `_migrate` after
v21 (`if current < 22: ... PRAGMA user_version = 22`). Enumerated catalogue values (`style`,
`challenge`) carry **no** CHECK, so the catalogue can grow without a table rebuild; code validates them
against `cookout_twists.py`. State machines keep CHECKs.

### 2.1 `cookout_rounds` — new columns

```sql
ALTER TABLE cookout_rounds ADD COLUMN style TEXT;
ALTER TABLE cookout_rounds ADD COLUMN style_spun INTEGER NOT NULL DEFAULT 0 CHECK(style_spun IN (0, 1));
ALTER TABLE cookout_rounds ADD COLUMN challenge TEXT;
ALTER TABLE cookout_rounds ADD COLUMN wildcard TEXT NOT NULL DEFAULT 'off'
  CHECK(wildcard IN ('off','armed','offered','lifted','declined'));
ALTER TABLE cookout_rounds ADD COLUMN wildcard_snap TEXT;
ALTER TABLE cookout_rounds ADD COLUMN wildcard_move_id TEXT;
ALTER TABLE cookout_rounds ADD COLUMN stars INTEGER NOT NULL DEFAULT 0 CHECK(stars IN (0, 1));
ALTER TABLE cookout_rounds ADD COLUMN star1_id TEXT;
ALTER TABLE cookout_rounds ADD COLUMN star2_id TEXT;
ALTER TABLE cookout_rounds ADD COLUMN vote1 TEXT CHECK(vote1 IS NULL OR vote1 IN ('a','b','c'));
ALTER TABLE cookout_rounds ADD COLUMN vote2 TEXT CHECK(vote2 IS NULL OR vote2 IN ('a','b','c'));
ALTER TABLE cookout_rounds ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1);
ALTER TABLE cookout_rounds ADD COLUMN swap_state TEXT NOT NULL DEFAULT 'none'
  CHECK(swap_state IN ('none','proposed','done'));
ALTER TABLE cookout_rounds ADD COLUMN swap_by INTEGER CHECK(swap_by IS NULL OR swap_by IN (1, 2));
ALTER TABLE cookout_rounds ADD COLUMN swap_out_id TEXT;
ALTER TABLE cookout_rounds ADD COLUMN swap_pair TEXT;
ALTER TABLE cookout_rounds ADD COLUMN swap_seen TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cookout_rounds ADD COLUMN swap_in TEXT;
ALTER TABLE cookout_rounds ADD COLUMN swap_move_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cookout_rounds ADD COLUMN encore_kind TEXT
  CHECK(encore_kind IS NULL OR encore_kind IN ('leftovers','remix'));
ALTER TABLE cookout_rounds ADD COLUMN encore_from_seq INTEGER
  REFERENCES cookout_rounds(anchor_message_seq) ON DELETE SET NULL;
ALTER TABLE cookout_rounds ADD COLUMN encore_generation INTEGER;
ALTER TABLE cookout_rounds ADD COLUMN encore_concept_id TEXT;
```

- `wildcard_snap`, `swap_pair`, `swap_seen`, `swap_in` hold immutable ingredient snapshots
  (`{id, name, category, emoji, family, blurb}`), like `cookout_turns.offers`.
- `swap_move_ids` holds `{"id": moveId, "slot": 1|2, "kind": "propose"|"choose"}` objects.
- Fridge raid needs no round column (it is the Turn-1 `seed_source = 'fridge'`).
- SQLite permits `ADD COLUMN ... REFERENCES` because the default is NULL. The self-reference sets the
  link to NULL when the source round goes (anchor delete cascades the source row).

### 2.2 `cookout_turns` — new columns

```sql
ALTER TABLE cookout_turns ADD COLUMN seed TEXT;
ALTER TABLE cookout_turns ADD COLUMN seed_source TEXT
  CHECK(seed_source IS NULL OR seed_source IN ('fridge','encore'));
ALTER TABLE cookout_turns ADD COLUMN replaced TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cookout_turns ADD COLUMN chaos_offer INTEGER
  CHECK(chaos_offer IS NULL OR chaos_offer BETWEEN 0 AND 2);
ALTER TABLE cookout_turns ADD COLUMN veto_offer INTEGER
  CHECK(veto_offer IS NULL OR veto_offer BETWEEN 0 AND 2);
ALTER TABLE cookout_turns ADD COLUMN lucky INTEGER NOT NULL DEFAULT 0 CHECK(lucky IN (0, 1));
ALTER TABLE cookout_turns ADD COLUMN twist_move_ids TEXT NOT NULL DEFAULT '[]';
```

- Seeded turn: `seed` = snapshot, `offers = '[]'`, `choice_id = seed id`.
- `replaced` = list of `{"offer": n, "position": 0|1, "snap": {...}, "by": "veto"|"chaos"}`.
- `twist_move_ids` = list of `{"id": moveId, "slot": 1|2, "kind": "chaos"|"veto"}` (the veto's slot
  is the partner's, so replay checks match on `(id, slot)`). Lucky dip uses `pick_move_id`.

### 2.3 `cookout_recipes` — rebuilt with `generation` in the key, plus T4 columns

The primary key must become `(anchor_message_seq, generation, concept_id)` (generation 2 may bank
concept `a` again while generation 1's banked `a` stays). SQLite cannot alter a primary key, so v22
rebuilds this one table (precedent: the v2 `events` rebuild). Nothing references `cookout_recipes`,
so the drop is safe with `foreign_keys = ON`.

```sql
CREATE TABLE cookout_recipes_v22(
  anchor_message_seq INTEGER NOT NULL
    REFERENCES cookout_rounds(anchor_message_seq) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1),
  concept_id TEXT NOT NULL CHECK(concept_id IN ('a','b','c')),
  state TEXT NOT NULL CHECK(state IN ('pending','banked','failed','unavailable')),
  run_id TEXT, recipe_json TEXT, error TEXT,
  requested_by TEXT NOT NULL, bank_move_id TEXT,
  started_at REAL, tries INTEGER NOT NULL DEFAULT 0, deadline_at REAL,
  banked_at REAL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
  cooked_at REAL, cooked_by TEXT,
  rating1 INTEGER CHECK(rating1 IS NULL OR rating1 BETWEEN 1 AND 5),
  rating2 INTEGER CHECK(rating2 IS NULL OR rating2 BETWEEN 1 AND 5),
  photo_message_seq INTEGER REFERENCES messages(seq) ON DELETE SET NULL,
  photo_attachment_id TEXT,
  PRIMARY KEY(anchor_message_seq, generation, concept_id));
INSERT INTO cookout_recipes_v22 (anchor_message_seq, generation, concept_id, state, run_id,
  recipe_json, error, requested_by, bank_move_id, started_at, tries, deadline_at, banked_at,
  created_at, updated_at)
  SELECT anchor_message_seq, 1, concept_id, state, run_id, recipe_json, error, requested_by,
    bank_move_id, started_at, tries, deadline_at, banked_at, created_at, updated_at
  FROM cookout_recipes;
DROP TABLE cookout_recipes;
ALTER TABLE cookout_recipes_v22 RENAME TO cookout_recipes;
CREATE INDEX IF NOT EXISTS idx_cookout_recipes_banked
  ON cookout_recipes(state, banked_at DESC, anchor_message_seq DESC);
CREATE INDEX IF NOT EXISTS idx_cookout_recipes_photo ON cookout_recipes(photo_message_seq);
```

- Every store statement that addresses a recipe by `(anchor, concept_id)` — `bank_cookout_concept`,
  `set_cookout_recipe_run`, `finish_cookout_recipe`, `retry_cookout_recipe`, `cookout_recipe_state`,
  `get_cookout_round()['recipes']` — adds `AND generation = (SELECT generation FROM cookout_rounds
  WHERE anchor_message_seq = ?)` (the current generation). Their **signatures do not change**, so the
  AI runner is untouched. A `pending` row is always current-generation (a swap is refused while one
  exists), so this is belt and braces, never a behaviour change.
- **Blue/green honest limit:** an older v21 process still running during the slot-swap overlap inserts
  recipes without naming `generation` (default `1`) and reads by `(anchor, concept_id)`. Only a round
  already swapped by the new process could be mis-filed, and only for the seconds the old slot still
  serves; recorded in the decision entry.

### 2.4 `cookout_generations` — new table (superseded dish sets)

```sql
CREATE TABLE IF NOT EXISTS cookout_generations(
  anchor_message_seq INTEGER NOT NULL
    REFERENCES cookout_rounds(anchor_message_seq) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  basket TEXT NOT NULL,
  concepts_json TEXT NOT NULL,
  pictures TEXT,
  vote1 TEXT CHECK(vote1 IS NULL OR vote1 IN ('a','b','c')),
  vote2 TEXT CHECK(vote2 IS NULL OR vote2 IN ('a','b','c')),
  superseded_at REAL NOT NULL,
  PRIMARY KEY(anchor_message_seq, generation));
```

- `basket` = JSON list of the ingredient ids that generation cooked from (10 or 11), resolved through
  the round's own snapshots (turn offers, seeds, wildcard, swap snapshots).
- Only superseded generations are stored; the current one lives on `cookout_rounds` as today.

**Effective basket** (pure helper `basket_snaps(round_, turns)` in `cookout_game.py`, used by the view,
the AI read and the swap): the ten turn choices in turn order (the seed snapshot for a seeded turn),
with `swap_out_id` replaced by `swap_in` when `swap_state == 'done'`, then the wildcard snapshot
appended when `wildcard == 'lifted'` (itself replaced if it was the swap target).

### 2.5 Wipe, delete and Gallery

- `_wipe` deletes, in order: `cookout_recipes`, `cookout_generations`, `cookout_turns`,
  `cookout_rounds` (then messages, as today).
- `_delete_message(seq)` additionally, in the same transaction and before the message delete:
  for every `cookout_recipes` row with `photo_message_seq = seq` set `photo_message_seq = NULL,
  photo_attachment_id = NULL` and bump that round's `rev` + `message_updated`; for every round with
  `encore_from_seq = seq` set `encore_from_seq = NULL, encore_generation = NULL,
  encore_concept_id = NULL, encore_kind = NULL` and bump its `rev` + `message_updated`. The FK
  actions are the backstop for an older process.
- Generation-2 dish pictures attach to the anchor with `ordinal = (generation - 1) * 3 + index(slot)`
  (generation 1 keeps `0..2`). `list_gallery` already excludes every Cookout anchor's attachments; a
  linked T4 photo is an ordinary mini-chat photo and stays in the Gallery like any other.
- `cookout_view_data` loads the anchor's attachments when the current `pictures` or any archived
  generation's `pictures` is non-empty, and the attachments of every linked T4 photo message.

### 2.6 Model rows (`models.py`)

- `CookoutRoundRow` gains: `style: str | None`, `style_spun: bool`, `challenge: str | None`,
  `wildcard: CookoutWildcardState`, `wildcard_snap: dict[str, str] | None`,
  `wildcard_move_id: str | None`, `stars: bool`, `star1_id: str | None`, `star2_id: str | None`,
  `vote1: str | None`, `vote2: str | None`, `generation: int`, `swap_state: CookoutSwapState`,
  `swap_by: int | None`, `swap_out_id: str | None`, `swap_pair: tuple[dict[str, str], dict[str, str]]
  | None`, `swap_seen: tuple[dict[str, str], ...]`, `swap_in: dict[str, str] | None`,
  `swap_move_ids: tuple[dict[str, object], ...]`, `encore_kind: Literal["leftovers", "remix"] | None`,
  `encore_from_seq: int | None`, `encore_generation: int | None`, `encore_concept_id: str | None`.
- `CookoutTurnRow` gains: `seed: dict[str, str] | None`, `seed_source: Literal["fridge", "encore"] |
  None`, `replaced: tuple[dict[str, object], ...]`, `chaos_offer: int | None`, `veto_offer: int | None`,
  `lucky: bool`, `twist_move_ids: tuple[dict[str, object], ...]`.
- `CookoutRecipeRow` gains: `generation: int`, `cooked_at: float | None`, `cooked_by: str | None`,
  `rating1: int | None`, `rating2: int | None`, `photo_message_seq: int | None`,
  `photo_attachment_id: str | None`.
- New `CookoutGenerationRow(generation: int, basket: tuple[str, ...], concepts_json: str, pictures:
  dict[str, str], vote1: str | None, vote2: str | None, superseded_at: float)`.
- `CookoutViewData` gains `generations: tuple[CookoutGenerationRow, ...]` and
  `photo_attachments: tuple[AttachmentRow, ...]`.
- `CookoutSummary` gains `generation: int`, `waiting: tuple[Literal["stars", "wildcard"], ...]`,
  `swap: CookoutSwapState`, `dinner_decided: bool`, `cooked_count: int` (§4.4).

---

## 3. Fixed catalogues (`wixy_server/livechat/cookout_twists.py`, new, pure data)

The ONLY text a twist adds to a prompt. A test asserts every `concept_directive`, `recipe_directive`
and `picture_phrase` contains **no** bank food (`find_contraband_ingredients(text,
allowed_ingredient_ids=set(), allowed_staple_ids=set())` returns `[]` after stop words), so a style
can never smuggle a food into the chef's mind; if a phrase trips the scan, reword the phrase (never
weaken the scan).

### 3.1 Styles (T3)

| id | label | emoji | blurb |
|---|---|---|---|
| `cosy-pub` | Cosy pub | 🍺 | Hearty plates by the fire |
| `street-food` | Street food | 🌯 | Bold, messy market-stall food |
| `posh-tasting` | Posh tasting menu | 🥂 | Tiny, fancy, very serious plates |
| `breakfast-for-dinner` | Breakfast for dinner | 🥞 | Morning comfort at night |
| `date-night-bistro` | Date-night bistro | 🕯️ | Candlelit and a little indulgent |
| `takeaway-at-home` | Takeaway at home | 🥡 | Your Friday-night favourite, homemade |
| `picnic` | Picnic | 🧺 | Packs up and travels well |
| `campfire` | Campfire cookout | 🔥 | Smoky, rustic, outdoorsy |

### 3.2 Kitchen challenges (T7)

| id | label | emoji | deterministic rule (§5.3) |
|---|---|---|---|
| `one-pan` | One pan only | 🍳 | recipe `cookware` has exactly 1 item; no other cooking-vessel word in recipe prose |
| `no-oven` | No oven | 🚫 | concept `technique ∉ {roast, bake}`, `dishType ∉ {traybake, pie, bake}`; no oven word in concept or recipe prose; no `cookware` item mentions an oven |
| `thirty-minutes` | Ready in 30 minutes | ⏱️ | concept `totalMinutes` 5–30; recipe `prepMinutes + cookMinutes ≤ 30` |
| `six-steps` | Six steps or fewer | 📝 | recipe `steps` 2–6 |

"No cooking at all" was rejected as a challenge: baskets routinely contain raw meat and fish, and a
rule that forbids cooking them would make the chef either fail or write an unsafe recipe.

### 3.3 Frozen module

```python
StyleId = Literal[
    "cosy-pub",
    "street-food",
    "posh-tasting",
    "breakfast-for-dinner",
    "date-night-bistro",
    "takeaway-at-home",
    "picnic",
    "campfire",
]
ChallengeId = Literal["one-pan", "no-oven", "thirty-minutes", "six-steps"]


@dataclass(frozen=True, slots=True)
class Style:
    id: StyleId
    label: str
    emoji: str
    blurb: str
    concept_directive: str
    picture_phrase: str


@dataclass(frozen=True, slots=True)
class Challenge:
    id: ChallengeId
    label: str
    emoji: str
    blurb: str
    concept_directive: str
    recipe_directive: str


STYLES: tuple[Style, ...] = (
    Style(
        "cosy-pub",
        "Cosy pub",
        "🍺",
        "Hearty plates by the fire",
        "Cook it like a cosy country pub: hearty, generous, comforting plates you would order by a log fire.",
        "served in a cosy country pub on a worn wooden table, warm lamplight",
    ),
    Style(
        "street-food",
        "Street food",
        "🌯",
        "Bold, messy market-stall food",
        "Cook it like late-night street food from a market stall: bold, messy, handheld or served in a paper tray.",
        "served street-food style in a paper tray at a night market, neon evening light",
    ),
    Style(
        "posh-tasting",
        "Posh tasting menu",
        "🥂",
        "Tiny, fancy, very serious plates",
        "Cook it as a posh restaurant tasting menu: refined techniques, careful plating and small, elegant portions with a sense of theatre.",
        "precise fine-dining plating on a large white plate, soft restaurant lighting",
    ),
    Style(
        "breakfast-for-dinner",
        "Breakfast for dinner",
        "🥞",
        "Morning comfort at night",
        "Cook it as breakfast for dinner: the comforting shapes of a morning meal, served as a satisfying evening supper.",
        "served as a cosy breakfast-for-dinner meal on a kitchen table, warm evening light",
    ),
    Style(
        "date-night-bistro",
        "Date-night bistro",
        "🕯️",
        "Candlelit and a little indulgent",
        "Cook it like a candlelit neighbourhood bistro on a romantic evening: classic, confident and a little indulgent.",
        "served on a small bistro table by candlelight, intimate warm light",
    ),
    Style(
        "takeaway-at-home",
        "Takeaway at home",
        "🥡",
        "Your Friday-night favourite, homemade",
        "Cook it as a homemade version of a Friday-night takeaway: punchy, saucy and made to be eaten from the sofa.",
        "served in takeaway-style boxes on a low lounge table, cosy evening light",
    ),
    Style(
        "picnic",
        "Picnic",
        "🧺",
        "Packs up and travels well",
        "Cook it for a picnic: dishes that travel well, taste good at room temperature and can be shared from a blanket.",
        "served picnic-style on a checked blanket outdoors, bright natural daylight",
    ),
    Style(
        "campfire",
        "Campfire cookout",
        "🔥",
        "Smoky, rustic, outdoorsy",
        "Cook it like a campfire cookout: rustic and smoky, cooked over live fire or in one sturdy pot, eaten outdoors at dusk.",
        "served rustic-style in a cast-iron pan beside a campfire, glowing dusk light",
    ),
)
CHALLENGES: tuple[Challenge, ...] = (
    Challenge(
        "one-pan",
        "One pan only",
        "🍳",
        "Everything in a single pan",
        "KITCHEN CHALLENGE - one pan only: every dish must be cooked start to finish in a single pan, pot or tray. Bowls for preparation are fine.",
        "KITCHEN CHALLENGE - one pan only: list exactly one cooking vessel in cookware and never use or mention a second one.",
    ),
    Challenge(
        "no-oven",
        "No oven",
        "🚫",
        "Hob, grill or no heat at all",
        "KITCHEN CHALLENGE - no oven: nothing may be roasted or baked in an oven; use the hob, a grill or no heat at all.",
        "KITCHEN CHALLENGE - no oven: never use, preheat or mention an oven, and never roast or bake.",
    ),
    Challenge(
        "thirty-minutes",
        "Ready in 30 minutes",
        "⏱️",
        "First chop to table in half an hour",
        "KITCHEN CHALLENGE - ready in thirty minutes: each dish must go from first chop to table in 30 minutes or less, preparation included.",
        "KITCHEN CHALLENGE - ready in thirty minutes: prepMinutes plus cookMinutes must be 30 or less.",
    ),
    Challenge(
        "six-steps",
        "Six steps or fewer",
        "📝",
        "A short, simple method",
        "KITCHEN CHALLENGE - six steps or fewer: the full method must fit in at most six short steps.",
        "KITCHEN CHALLENGE - six steps or fewer: write at most six steps.",
    ),
)
STYLE_IDS: tuple[StyleId, ...] = tuple(s.id for s in STYLES)
CHALLENGE_IDS: tuple[ChallengeId, ...] = tuple(c.id for c in CHALLENGES)
NO_OVEN_WORDS: frozenset[str] = frozenset(
    {"oven", "ovens", "preheat", "preheated", "roast", "roasted", "roasting"}
    | {"bake", "baked", "baking", "traybake"}
)
COOKING_VESSEL_WORDS: tuple[tuple[str, ...], ...] = (
    ("frying", "pan"),
    ("saucepan",),
    ("skillet",),
    ("wok",),
    ("pot",),
    ("casserole",),
    ("roasting", "tin"),
    ("baking", "tray"),
    ("tray",),
    ("griddle",),
    ("oven",),
)


def style_by_id(style_id: str) -> Style | None: ...
def challenge_by_id(challenge_id: str) -> Challenge | None: ...
def spin_style(rng: random.Random | None = None) -> StyleId: ...
```

Word lists are matched on **food-free tokens** (§5.1 `food_free_tokens`), so a recognised food span
such as "baking powder" or "pot barley" is never read as a technique or vessel word.

---

## 4. Wire (`/api/admin/server/cookout*`)

Every route: `require_server_token` FIRST (also before returning `422` for a malformed body, matching
the core routes), then sender/`?as=` validation and `slot_of`; every response carrying a view is
filtered for the caller and sent `Cache-Control: no-store`. Literal paths (`/cookout/options`,
`/cookout/ingredients`, `/cookout/bank`) are declared before `/cookout/{seq}`.

### 4.1 New errors

`409 token_used` (chaos or veto already spent by the caller), `409 recipe_pending` (a swap while a
current-generation recipe is being written). All others reuse the core set: `404 not_found`,
`409 bad_state`, `409 not_your_turn`, `409 not_player`, `409 skip_exhausted`, `409 exhausted`,
`422 invalid`, `503 game_unavailable`.

### 4.2 Routes

- `GET /cookout/options` →
  `{styles: [{id, label, emoji, blurb}], challenges: [{id, label, emoji, blurb}], chef: bool,
  pictures: bool}` (`chef = runner.available`, `pictures = runner.images_available`). Directive and
  picture text never leave the server.
- `GET /cookout/ingredients?q=<2..40 chars>` → `{ingredients: [IngredientSnap]}` (≤ 20, bank
  entries only, §5.1 `search`). Shorter/longer `q` → `422 invalid`; empty bank → `503`.
- `POST /cookout` body (all new fields optional; `extra="forbid"` stays):

  ```text
  { clientId, deviceId, sender, blind?: bool,
    style?: StyleId | "spin" | null,
    challenge?: ChallengeId | null,
    wildcard?: bool, stars?: bool,
    fridgeSeedId?: string | null,
    encore?: { fromSeq: int, generation: int, conceptId: "a"|"b"|"c",
               kind: "leftovers" | "remix", seedIds: string[] } | null }
  ```

  Unknown enum → `422 invalid`; chef-only option without a runner → `422 invalid`; seed rules §1.3.
  Answer unchanged: `201 {message}` / `200` on a `clientId` replay.
- `POST /cookout/{seq}/lucky {sender, moveId, turn, offer, optionIds: [id, id]}` → view.
- `POST /cookout/{seq}/chaos {sender, moveId, turn, offer, optionIds: [id, id]}` → view
  (`409 token_used`, `409 exhausted`).
- `POST /cookout/{seq}/veto {sender, moveId, turn, offer, ingredientId}` → view
  (`409 bad_state` in Blind or for the active player; `409 token_used`; `409 exhausted`).
- `POST /cookout/{seq}/star {sender, ingredientId}` → view (may start concepts).
- `POST /cookout/{seq}/wildcard {sender, moveId, lift: bool}` → view (may start concepts;
  `409 exhausted` when no wildcard can be drawn — the cloche stays offered and Decline still works).
- `POST /cookout/{seq}/vote {sender, conceptId}` → view.
- `POST /cookout/{seq}/swap/propose {sender, moveId, ingredientId}` → view.
- `POST /cookout/{seq}/swap/choose {sender, moveId, ingredientId}` → view (starts concepts).
- `POST /cookout/{seq}/swap/cancel {sender}` → view.
- `POST /cookout/{seq}/recipes/{generation}/{conceptId}/cooked {sender, cooked: bool}` → view.
- `POST /cookout/{seq}/recipes/{generation}/{conceptId}/rating {sender, rating: int | null}` → view.
- `POST /cookout/{seq}/recipes/{generation}/{conceptId}/photo {sender, messageSeq: int | null}` → view.
- `GET /cookout/{seq}/photos?as=<sender>` →
  `{photos: [{messageSeq, sender, createdAt, picture: Picture}]}` — ready photo attachments on
  non-view-once messages in this round's mini chat, newest first, ≤ 50. Players only
  (`409 not_player` otherwise).

Idempotency: `lucky` shares `pick_move_id`; `chaos`/`veto` use `twist_move_ids` matched on
`(moveId, actor slot)`; `wildcard` uses `wildcard_move_id` (a replay → `200`; a different move after
the cloche was answered → `200` when it asked for the same outcome, else `409 bad_state`); swap moves
use `swap_move_ids`; `star`, `vote`, `cooked`, `rating`, `photo`, `swap/cancel` are state-idempotent
(setting the current value again → `200`, no event). Every real change bumps `rev` and appends one
`message_updated` for the anchor.

### 4.3 `CookoutView` additions (all additive; parsers stay defensive)

```text
{
  ...core fields...,
  setup: {
    style: { id, label, emoji } | null, styleSpun: bool,
    challenge: { id, label, emoji } | null,
    wildcard: bool, stars: bool, fridgeRaid: bool,
    encore: { kind: "leftovers" | "remix", fromSeq: int | null, fromTitle: string | null } | null
  },
  generation: 1 | 2,
  starters: [PickSnap],                       // public in both modes
  players: [{ ...core, picks: [PickSnap] | null,
              chaosUsed: bool | null, vetoUsed: bool | null }],
  you: { slot, chaosUsed: bool, vetoUsed: bool } | null,
  current: { ...core,
             chaosPair: bool | null,          // the pair on the table came from the chaos shelf
             vetoed: { snap: IngredientSnap } | null,
             canChaos: bool | null, canLucky: bool | null, canVeto: bool | null } | null,
  history: [{ ...core, seed: IngredientSnap | null,
              replaced: [{ offer, snap: IngredientSnap, by: "veto" | "chaos" }],
              chaosOffer: int | null, lucky: bool }],
  basket: [PickSnap] | null,                  // effective basket once revealed (incl. wildcard)
  gate: { waitingFor: ("stars" | "wildcard")[] },
  wildcard: { state: "off"|"armed"|"offered"|"lifted"|"declined", ingredient: IngredientSnap | null },
  stars: { enabled: bool, mine: string | null, partnerChosen: bool,
           revealed: bool, partner: string | null } ,
  vote: { you: ConceptId | null, partnerVoted: bool, revealed: bool,
          votes: { "1": ConceptId, "2": ConceptId } | null, match: ConceptId | null } | null,
  swap: { state: "none" | "proposed" | "done", available: bool, by: 1 | 2 | null,
          out: IngredientSnap | null, pair: [IngredientSnap, IngredientSnap] | null,
          in: IngredientSnap | null },
  concepts: { ...core, data: [ { ...core Concept, challengeNote: string | null,
                                 totalMinutes: int | null } ] | null },
  recipes: { a|b|c: RecipeSlot },             // current generation
  generations: [ { generation, basket: [IngredientSnap], concepts: [Concept],
                   pictures: { a|b|c: Picture | null },
                   vote: { votes: {...} | null, match: ConceptId | null },
                   recipes: { a|b|c: RecipeSlot } } ]
}
PickSnap   = IngredientSnap & { turn: 1..10 | null, via: "pick" | "lucky" | "chaos" | "seed" | "wildcard" | "swap" }
RecipeSlot = { ...core, generation: int,
               cooked: { cookedAt: number, cookedBy: string,
                         ratings: { "1": 1..5 | null, "2": 1..5 | null },
                         photo: Picture | null, photoMessageSeq: int | null } | null,
               data: FullRecipe & { cookware?: string[] } | null }
```

Redaction (in `cookout_view_json`, before serialisation):

- `starters` is always complete. `players[partner].picks` stays `null` in Blind while not revealed
  (the core rule; starters are visible through `starters`).
- `players[i].chaosUsed`: own slot always; partner's in Open always, in Blind only once `revealed`
  (else `null`). `vetoUsed` is always visible (veto exists only in Open mode).
- `current.chaosPair`, `current.vetoed`, `current.canChaos`, `current.canLucky`: only when the core's
  `shown` predicate holds for the active player (Blind: only the active player; else `null`).
  `current.canVeto`: computed for the viewer only — `true` iff Open mode, viewer is the bound
  non-active player, the viewer's veto is unused and a live unpicked row exists; `null` in Blind.
- `history` keeps the core rule (Blind: own turns only, forever); the new per-turn fields ride along.
- `PickSnap.via` for a partner pick is visible only when the pick itself is visible.
- `basket` is `null` until `revealed`; in Open mode it is filled while picking too (all picks visible).
- `stars.partner` is non-null only when `revealed` per §1.5; `stars.mine` only for a bound viewer.
- `vote` is `null` unless `concepts == 'ready'`; `votes`/`match` only once both voted; `vote.you` is
  the viewer's own; a non-player sees only `revealed` and, once revealed, the result.
- `swap.available` = finished, concepts ready, `swap_state == 'none'`, viewer is a player, no
  pending current recipe.
- `setup.encore.fromTitle` = the source concept's title when `encore_from_seq` is non-null and the
  concept still resolves; else `null`.
- An `abandoned` round never reveals anything new (stars, partner chaos flags, basket).

### 4.4 `Message.cookout` (broadcast summary) additions

`{state, blind, pickedCount, concepts, bankedCount, rev, generation, waiting: ("stars"|"wildcard")[],
swap: "none"|"proposed"|"done", dinnerDecided: bool, cookedCount: int}` — counts and flags only:
`dinnerDecided` is true only after both votes are revealed and match; it carries no concept id,
ingredient, star, vote or recipe text.

### 4.5 Recipe book (`GET /cookout/bank`) additions

Each entry gains `generation`, `cooked: {cookedAt, ratings: [{name, rating}], photo: Picture|null} |
null`, `dinnerPick: bool` (that generation's revealed votes matched on this concept),
`style: {id, label, emoji} | null`, `challenge: {id, label, emoji} | null`,
`ingredients: [IngredientSnap]` (the concept's used basket items) and `leftovers: [IngredientSnap]`
(its `omitted` items) — the latter two feed the Remix / Leftovers encore buttons. Archived-generation
entries resolve their concept and picture from `cookout_generations`. Ordering unchanged.

---

## 5. Engine, AI and pictures

### 5.1 Draw engine (`cookout_bank.py`)

- `draw_pair(..., rarity_mode: Literal["normal", "exotic"] = "normal")`. `"normal"` is the core
  algorithm unchanged. `"exotic"` (chaos shelf): candidates restricted to `rarity == "exotic"` in the
  role; hard exclusions as normal (`seen_ids` including replaced/seed/wildcard/swap snapshots,
  `picked_families`); two distinct categories and families; **both** options exotic (the "at least one
  everyday" rule is replaced by "both exotic"); soft `offered_families` preference then relaxed;
  least-shown category for option 1, least-shown valid partner category for option 2, uniform family
  then entry; 50/50 order swap. No feasible pair → `CookoutExhaustedError`.
- `draw_replacement(*, role, keep_id, seen_ids, picked_families, offered_families,
  player_offered_categories, rarity_mode="normal", rng=None) -> Ingredient` (veto): one option for
  `role` with `category != keep.category`, `family != keep.family`, hard exclusions; `"normal"`: if
  `keep` is not `everyday` the replacement must be `everyday`, otherwise tiers `8 : 3 : 1`;
  `"exotic"`: exotic only. Least-shown category tie-break, then uniform family, entry.
- `draw_wildcard(*, seen_ids, picked_families, offered_families, basket_categories, rng=None) ->
  Ingredient` (cloche): any role; excludes the five pickable staples (`NON_SEASONING_STAPLES`) and
  everything seen; tiers `uncommon : exotic = 1 : 1` (among those available; never `everyday` — it is
  a dare); soft preferences, relaxed in order: a category not in `basket_categories`, then a family
  not in `offered_families`; uniform family then entry.
- `search(query, *, limit=20) -> tuple[Ingredient, ...]` (fridge raid): fold + tokenise the query;
  an ingredient matches when every query token is a prefix of some token of its `name` or one of its
  `aliases`; ranking: exact folded name, name-prefix, alias match, then rarity
  `everyday < uncommon < exotic`, then name; at most `limit`.
- `mentions(text, ingredient_id) -> bool` (stars): `True` when the longest-first span recognition of
  `text` (the same `_spans`) yields that ingredient's entity, or the bare family word of its family.
- `food_free_tokens(text) -> tuple[str, ...]` (challenges): the folded tokens of `text` left after
  removing every recognised food span.
- `shuffle_role_schedule(rng=None, *, first_role: RoleKey | None = None)`: when `first_role` is given,
  shuffle as today then swap the first occurrence of `first_role` into index 0.
- **Validator (`tooling/cookout/validate_bank.py`):** add, per role, ≥ 3 categories with exotic
  entries and ≥ 40 exotic families (today: base 4/51, protein 5/116, produce 7/72, accent 10/147);
  500 simulated rounds where each player uses chaos on a random turn and each turn's first offer is
  vetoed once, asserting on every emitted pair/replacement: role, `cat_a != cat_b`, `fam_a != fam_b`,
  normal pairs hold ≥ 1 everyday, chaos pairs are both exotic, no id or picked family repeats; plus a
  wildcard draw after each simulated round asserting non-everyday, not a pickable staple, unseen id,
  unpicked family.

### 5.2 AI reads (`get_cookout_round`) — what the runner sees

`get_cookout_round(anchor_seq)` keeps every existing key and adds: `basket_ids` (effective basket of
the **current** generation, §2.4; `[]` until the gate clears), `picked_ids` (now an alias of
`basket_ids`, so its length is 10 or 11), `star_ids` (sorted list; `[]` when stars are off),
`wildcard_id` (the lifted wildcard id, or `None` when off/declined or swapped out), `style`,
`challenge`, `generation`. `recipes` is the current generation only.

### 5.3 Prompts and deterministic validation (`cookout_ai.py`)

- **Basket payload:** `basket_payload(bank, basket_ids, *, twists=None)` emits the core
  `{"ingredients", "staples"}` (records sorted by id, 10 or 11) and, **only when a twist is active**, a
  `"twists"` object: `{"stars": [ids sorted], "wildcard": id, "style": id, "challenge": id}` (each key
  only when set). Sorting strips who starred what; the fake cmd reads the same marker line.
- **Concepts prompt:** with no twist the text is exactly today's. Otherwise the builder replaces
  "ten" with the basket size where it counts ingredients and appends, in this order, only the lines
  that apply:
  - `STYLE: <Style.concept_directive>`
  - `<Challenge.concept_directive>` plus: `Each concept also has "challengeNote": string (1-140 chars)
    saying how it keeps the rule.` and for `thirty-minutes`: `and "totalMinutes": integer (5-30).`
  - Stars: `Two STAR ingredients (ids <a>, <b>) must be used in EVERY concept and be its hero: name
    each star in that concept's title or description.`
  - Wildcard: `The WILDCARD ingredient (id <w>) was a surprise neither friend chose: use it in at least
    two of the three concepts.`
- **`parse_concepts(response_text, *, bank, picked_ids, twists=ConceptTwists())`** — the core checks
  with the basket of size `N = len(picked_ids)` (10 or 11): ids ⊆ basket, `omitted` = exact complement
  against the basket, each concept ≥ `7`, best ≥ `8`, union = all `N`, distinct pairs, staples cap,
  both lexical passes. Additionally, only when set:
  - stars: each star id ∈ every concept's `pickedIngredientIds`, and `bank.mentions(title, star)` or
    `bank.mentions(description, star)` for every concept;
  - wildcard: `wildcard_id` ∈ `pickedIngredientIds` of ≥ 2 concepts;
  - challenge: `challengeNote` present (1–140) and scanned as a consumption field in both lexical
    passes; `thirty-minutes` → `totalMinutes` int 5–30; `no-oven` → `technique ∉ {roast, bake}`,
    `dishType ∉ {traybake, pie, bake}`, and no `NO_OVEN_WORDS` among `food_free_tokens` of
    `title`/`vibe`/`description`/`challengeNote`;
  - the stored concept keeps `challengeNote` / `totalMinutes` when present.
  Violation messages name the rule exactly ("concept b must name star 'smoked-kippers' in its title or
  description") so the one repair run can fix it.
- **The changed manifest:** the lexical scans take the effective basket as "the picks". The wildcard
  and a swapped-in item are ordinary basket members (allowed when used, Pass-2-forbidden when
  omitted). The **swapped-out** ingredient is just an unpicked bank food (Pass 1 rejects any mention;
  it is never treated as omitted, so it cannot even be named in `omitted[].reason`).
- **Recipe prompt:** `build_recipe_prompt(concept, manifest, *, twists=RecipeTwists())` adds, only
  when set: `STYLE: <concept_directive>`, `<Challenge.recipe_directive>` with the schema addition
  `"cookware": [string (1-40 chars)] (1-4 cooking vessels and tools)`, the concept's `totalMinutes`
  for `thirty-minutes`, and `Make <star names> the heroes: generous, central quantities.`
- **`parse_recipe(response_text, *, bank, concept, twists=RecipeTwists())`** — core checks, plus only
  when a challenge is set: `cookware` 1–4 strings of 1–40 chars, each scanned as a consumption field;
  `one-pan` → exactly 1 `cookware` item and no `COOKING_VESSEL_WORDS` span in `food_free_tokens` of any
  step/tip/note that is not part of the declared cookware item's own tokens; `no-oven` → no
  `NO_OVEN_WORDS` in `food_free_tokens` of any step/tip/note/quantity/cookware; `thirty-minutes` →
  `prepMinutes + cookMinutes ≤ 30`; `six-steps` → `2 ≤ len(steps) ≤ 6`. Stars need no extra recipe
  check (the manifest already forces every used item into a step); "substantial" is prompted, not
  validated (honest limit, §7). The stored recipe keeps `cookware` when present.
- **Runner wiring:** `_concepts_job` reads `basket_ids`, requires `len(set(ids)) in (10, 11)` and
  builds `ConceptTwists(star_ids, wildcard_id, style, challenge)` from the row; `_recipe_job` builds
  `RecipeTwists(star_ids, style, challenge)`. Model, effort, callers, tool bans, timeouts, pacing and
  the one-repair rule are unchanged. Validation stays fully deterministic — no second model.

```python
@dataclass(frozen=True, slots=True)
class ConceptTwists:
    star_ids: frozenset[str] = frozenset()
    wildcard_id: str | None = None
    style: str | None = None
    challenge: str | None = None


@dataclass(frozen=True, slots=True)
class RecipeTwists:
    star_ids: frozenset[str] = frozenset()
    style: str | None = None
    challenge: str | None = None
```

### 5.4 Pictures (`cookout_images.py`)

- `build_image_prompt(title, ingredient_names, *, style: str | None = None)`: with a style, the core
  phrase "Rustic home-cooked presentation, natural kitchen light, simple ceramic plate" is replaced by
  that style's `picture_phrase`; everything else (including every "no people / no text" clause) is
  unchanged. `concept_prompts` reads `round_row["style"]`. A lifted wildcard or swapped-in item is
  named whenever the concept uses it (it is in `pickedIngredientIds`).
- After a swap, generation 2's pictures run through the **existing** fencing unchanged: the swap
  increments `images_generation` and sets `images = 'none'`, so a late generation-1 attempt fails
  `store_cookout_pictures`' compare-and-set and journals its staged uploads; generation 2's concepts
  becoming `ready` starts a fresh `pending` wait with another increment. `store_cookout_pictures`
  computes `ordinal = (generation - 1) * 3 + index(slot)` from the row it already reads (signature
  unchanged).

---

## 6. Privacy, standalone, docs

- **Prompts:** still carry only food records (ids, names, categories, blurbs) plus server constants
  selected by enum id. Votes, ratings, cooked marks, photos, player names, which player starred or
  swapped what, and encore links never reach cmd. `cmd` retains the extra twist text (style/challenge
  directives, star/wildcard ids, swap baskets and repair feedback) in its hidden ledger exactly as
  Inv 57 already states for the core; this server cannot erase that copy.
- **Erasure:** all new columns/rows live on anchor-owned tables (cascade + `_wipe`). A linked T4 photo
  is an ordinary message: deleting it unlinks; deleting the round's anchor deletes the recipe row (the
  photo message itself stays in the chat, like any mini-chat message). An encore keeps only a nulling
  link to its source; the source's title is never copied.
- **Standalone edition:** the draft twists (fridge raid, lucky dip, chaos shelf, partner veto) work;
  style, challenge, wildcard and stars are refused at creation and hidden; vote, rescue swap, We cooked
  it! and encore need ready concepts or banked recipes, which standalone never produces, so their
  buttons never appear.
- **Docs to update in the same change:** `docs/ai/livechat.md` (Cookout section: twists, generations,
  gate, starters), `docs/ai/contracts.md` (new routes, body fields, view/summary/book fields, errors
  `token_used`/`recipe_pending`), `docs/ai/invariants.md` (extend **Inv 57**: stars and votes hidden
  from the partner in both modes until their reveal; chaos/veto/lucky are server-side; veto is Open
  only; starters are public; banked recipes and pictures stay tied to their generation; T4 photos are
  links to ordinary non-view-once mini-chat photos and unlink on delete; encore links null on source
  delete; prompts carry only fixed enum text beyond food), `docs/ai/glossary.md` (generation, gate,
  starter, wildcard/swap states), `docs/ai/testing.md`, `CLAUDE.md` store table (schema v22:
  `cookout_generations`, the `cookout_recipes` rebuild and new columns), and
  `decisions/00194-server-chat-cookout-twists/`. Commits carry
  `Release-note: General bug fixes and improvements.` (R14a).

---

## 7. Honest limits

- Star "heroism" is checked by name in title/description and by presence in every concept and recipe
  step; how generous the quantity is cannot be verified deterministically.
- `one-pan` relies on the recipe's declared `cookware` plus a fixed vessel-word scan; a vessel word not
  in the list could slip through.
- The bank-dictionary food scan still cannot catch a food missing from the bank (core limit).
- Blind-mode secrecy for stars and votes inherits the core's shared-sign-in name limit (Inv 57).
- During a blue/green overlap an older process may file a recipe under generation 1 on an
  already-swapped round (§2.3).

---

## 8. Tests (all must exist and pass)

- **pytest `test_cookout_bank.py`** (bank parcel): exotic `draw_pair` invariants and exhaustion;
  `draw_replacement` (everyday rule, exotic mode, exhaustion); `draw_wildcard` (non-everyday, no
  pickable staple, unseen, unpicked family, category preference); `search` (folding, accents,
  multi-token prefix, ranking, limit, staples present, nothing outside the bank); `mentions` (name,
  alias, plural, family word, longest-span consumption); `food_free_tokens` ("baking powder" consumed);
  `shuffle_role_schedule(first_role=...)` for every role; the extended validator simulation.
  **`test_cookout_twists_catalogue.py`**: ids unique, labels ≤ 30 chars, every directive and picture
  phrase food-free, `spin_style` uniform over ids with a seeded RNG.
- **pytest `test_livechat_cookout_twists.py`** (server parcel): v21→v22 migration from a real v21 DB
  holding rounds, turns and recipes (recipes copied as generation 1, new PK enforced, indexes present,
  FKs of the rebuilt table active, re-running the migration a no-op); parametrized `401 locked` across
  every new route; core-unchanged regression (a twist-free round's views and store calls identical to
  v21 behaviour); each twist's happy path, every error code, replay idempotency per move kind;
  Blind redaction (partner stars, votes, chaos flags, chaos pairs, `via` tags, history never in a
  non-entitled response, including mutation responses; abandoned blind round reveals nothing new);
  gate ordering (stars then cloche, cloche then stars, stars set during picking → no gate);
  starters (one and two, with fridge + encore; Turn-2 wait; Turn-3 drawn at once; role schedule
  head; draw exclusions; encore validation inside the txn after a `clientId` replay; deleted source);
  races with two store connections: veto/pick (swept → `409 bad_state`, stayed → success),
  veto/lucky (`optionIds` stale), chaos/veto, lucky/pick replay, star/turn-10 pick (exactly one
  concepts start), wildcard lift/decline, vote/vote reveal, swap choose/cancel, swap choose/bank,
  swap choose/late picture store (fenced), cooked/unmark; swap archive (generation row contents,
  failed/unavailable gen-1 recipes dropped, banked kept, picture ordinals 3–5 for gen 2, Earlier dishes
  view, Recipe book entries for both generations); T4 (rating per slot, view-once rejected, photo
  from another round rejected, message delete unlinks and bumps rev, anchor delete cascades);
  `_wipe` clears `cookout_generations`; `Message.cookout` new fields carry no ingredient/recipe text.
- **pytest `test_livechat_cookout_ai.py` / `test_livechat_cookout_images.py`** (AI parcel): twist-free
  prompts byte-identical to today; each twist's prompt lines appear only when set and carry only
  catalogue text and ids; `parse_concepts` with 11 items, stars (missing from a concept, unnamed,
  named by alias/family), wildcard in < 2 concepts, each challenge rule pass/fail, `challengeNote`
  smuggling a food, swapped-out item mentioned anywhere (including `omitted[].reason`);
  `parse_recipe` cookware rules, `one-pan` second vessel, `no-oven` words versus "baking powder",
  thirty-minute total, six steps; repair feedback names the rule; the fake cmd answers valid output
  for every twist combination; image prompt per style; ordinal offset; fencing across a swap.
- **vitest** (`admin-ui/tests/cookout/*.test.ts`): parsers for every new field (defensive against
  missing/garbage); start sheet (twists collapsed by default, chef-only options hidden when
  `chef: false`, spin, fridge search debounce and selection, encore preset and seed limit); pane
  (lucky/chaos/veto buttons and their disabled states, coin animation skipped under reduced motion,
  starters pills, stars toggles and gate banner, cloche card, vote buttons and reveal, swap flow for
  proposer and partner, Earlier dishes section); Blind DOM leak tests (no partner star, vote or chaos
  pair string anywhere in the DOM before reveal); cooked sheet (hearts, own-only editing, unmark
  confirm, photo chooser); recipe book (cooked badge, ratings, real photo, Remix/Leftovers buttons);
  card status lines; CSS selectors present in the rebuilt bundle.
- **e2e `e2e/tests/server-cookout-twists.spec.ts`**: two contexts. Open game with spin style,
  `one-pan`, stars, cloche and a fridge seed found by search; Player 1 uses chaos, Player 2 vetoes one
  of Player 1's options, Player 2 lucky-dips; both star; lift the cloche; fake concepts (11 items);
  both vote (match badge); bank one dish; rescue swap proposed by Player 1 and chosen by Player 2;
  generation-2 dishes and Earlier dishes visible, the banked gen-1 recipe still opens; mark it cooked,
  two ratings, link a mini-chat photo; Recipe book shows it; start a leftovers encore from a concept
  (starters visible to both). A Blind game asserting Player 1's DOM never holds Player 2's star, vote
  or chaos pair before their reveals. Every screen checked at 360 px.

---

## 9. Client (`admin-ui/src/server/cookout/`)

- **Start sheet:** unchanged top (mode). Below, a collapsed **"Add twists (optional)"** disclosure:
  *Chef's style* (chip grid: None, 🎡 Spin, eight styles), *Kitchen challenge* (None + four chips),
  toggles *🛎️ Wildcard cloche — "lift a lid for a surprise 11th ingredient"* and *⭐ Secret stars —
  "each star one of your picks; the chef makes them the heroes"*, and *🧊 Fridge raid* (a search field
  against `GET /cookout/ingredients`, 250 ms debounce, one selected chip with ✕). Chef-only rows are
  hidden when `options.chef` is false. Opened from an encore button, the sheet shows an **Encore**
  banner listing the candidate starters (checkboxes, max 2, max 1 with a fridge seed). `New` preselects
  the current round's setup. `GET /cookout/options` is fetched once per unlock and cleared on
  lock/wipe.
- **Pane, drafting:** the header shows style/challenge chips (and a one-time wheel landing animation
  when `styleSpun`, remembered in memory per round). Starter pills read "Starter" with 🧊 (fridge) or
  🔁 (encore). Under the two cards, beside the skip button: **🪙 Lucky dip** and **🌋 Chaos shelf
  (once)**. In Open mode the partner sees **🧹 Sweep it (once)** on each of the active player's cards;
  the active player sees a banner "Cupcake swept *X* off your table". A coin-flip animation (≈1.2 s,
  skipped under `prefers-reduced-motion`) plays after a lucky-dip response; the server already chose.
- **Stars:** with stars on, the viewer's own basket pills carry a ☆/★ toggle; at the gate a banner
  "Star one of your five picks — the chef will make it a hero" (or "Waiting for Cupcake to star one").
  Revealed stars show ★ on both pills.
- **Cloche gate:** a card "🛎️ Lift the cloche? One surprise 11th ingredient" with **Lift it!** and
  **No thanks — start cooking**; lifting plays a lid-lift reveal of the returned ingredient.
- **Chef stage:** each concept card gains **🍽️ I'd eat this tonight** (own vote, changeable until
  revealed), a vote banner, and on reveal voter badges plus **🎯 Tonight's dinner!** on a match; the
  `challengeNote` and `totalMinutes` show as a small rule badge. A **🔄 Rescue swap (once)** button
  opens a basket chooser (stars disabled) → confirm; the partner sees "Cupcake wants to send back *X*.
  Choose a replacement:" with the two options and **Keep these dishes**; the proposer sees a waiting
  state with **Cancel**. After the swap, a "Swapped *X* → *Y*" banner and a collapsible **Earlier
  dishes** section (read-only cards; banked ones open their recipe). A concept card's ⋯ offers
  **Encore with the leftovers** when it omitted something.
- **Banked recipe view:** **👩‍🍳 We cooked it!** → two heart rows (own editable, partner read-only),
  side-by-side "Chef's daydream" / "Our plate" pictures, **Add our photo** (chooser over
  `GET /cookout/{seq}/photos` plus "Send a new photo to this game's chat", which opens the mini-chat
  pop-up composer), and an overflow **Unmark as cooked** with confirmation. `cookware` shows as
  "You'll need: …".
- **Recipe book:** cooked badge, both ratings, real-photo thumbnail beside the AI one, a *Cooked / Not
  cooked yet* filter, and **Remix** / **Leftovers encore** buttons opening the start sheet preset.
- **Main-chat card:** extra status lines "Lift the cloche?", "Waiting for secret stars", "Swapping an
  ingredient…", "🎯 Dinner decided", "✓ Cooked".
- Every new control carries `data-srv-gesture-boundary`; Escape stays the panic key; 360 px first,
  no horizontal scroll, the pane's existing scroll container holds the new sections.

---

## Appendix A. Parcel plan and frozen interfaces

Exclusive file ownership (one owner per file; nobody edits another parcel's files):

| Parcel | Builder | Exclusive files | Depends on |
|---|---|---|---|
| **X1 — Bank, draw engine & twist catalogue** | Sonnet 5.5 | `wixy_server/livechat/cookout_bank.py`, `wixy_server/livechat/cookout_twists.py` (new), `tooling/cookout/validate_bank.py`, `wixy_server/tests/test_cookout_bank.py`, `wixy_server/tests/test_cookout_twists_catalogue.py` (new) | Nothing (A.1 and §3.3 frozen verbatim) |
| **X2 — Store v22, game, routes** | Sonnet 5.5 | `wixy_server/livechat/store.py`, `wixy_server/livechat/models.py`, `wixy_server/livechat/cookout_game.py`, `wixy_server/routes_livechat_cookout.py`, `wixy_server/app.py`, `wixy_server/tests/test_livechat_cookout.py`, `wixy_server/tests/test_routes_livechat_cookout.py`, `wixy_server/tests/test_livechat_cookout_twists.py` (new) | A.1 bank and §3.3 catalogue (fakes until X1 lands) |
| **X3 — AI & pictures** | Sonnet 5.5 | `wixy_server/livechat/cookout_ai.py`, `wixy_server/livechat/cookout_images.py`, `wixy_server/tests/fake_cmd.py`, `wixy_server/tests/test_livechat_cookout_ai.py`, `wixy_server/tests/test_livechat_cookout_images.py` | A.1 (`mentions`, `food_free_tokens`), §3.3, A.2 read keys |
| **X4 — Admin UI** | **Opus 5.5** | `admin-ui/src/server/cookout/*` (incl. new `cookedSheet.ts`, `fridgeSearch.ts`), `admin-ui/src/server/{thread.ts, chat.css, api/messages.ts, itemChat.ts}`, `admin-ui/tests/cookout/*`, rebuilt `wixy_server/static/admin/*` | A.3 wire (builds against JSON fixtures) |
| **X5 — Docs & e2e** | Sonnet 5.5 | `e2e/tests/server-cookout-twists.spec.ts`, `docs/ai/{livechat,contracts,invariants,glossary,testing}.md`, `CLAUDE.md` store table, `decisions/00194-server-chat-cookout-twists/` | Drafts in parallel; runs e2e after X1–X4 integrate |

Order: X1 first (small, unblocks the others' real-bank tests); X2, X3 and X4 in parallel against the
frozen interfaces; X5 last for e2e. The runner protocol (`CookoutRunner`) is unchanged.

### A.1 Frozen Python interface — X1 (`cookout_bank.py`, additions)

```python
RarityMode = Literal["normal", "exotic"]


class CookoutBank:
    def shuffle_role_schedule(
        self, rng: random.Random | None = None, *, first_role: RoleKey | None = None
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
        rarity_mode: RarityMode = "normal",
    ) -> tuple[Ingredient, Ingredient]: ...
    def draw_replacement(
        self,
        *,
        role: RoleKey,
        keep_id: str,
        seen_ids: AbstractSet[str],
        picked_families: AbstractSet[str],
        offered_families: AbstractSet[str],
        player_offered_categories: Sequence[str],
        rarity_mode: RarityMode = "normal",
        rng: random.Random | None = None,
    ) -> Ingredient: ...
    def draw_wildcard(
        self,
        *,
        seen_ids: AbstractSet[str],
        picked_families: AbstractSet[str],
        offered_families: AbstractSet[str],
        basket_categories: AbstractSet[str],
        rng: random.Random | None = None,
    ) -> Ingredient: ...
    def search(self, query: str, *, limit: int = 20) -> tuple[Ingredient, ...]: ...
    def mentions(self, text: str, ingredient_id: str) -> bool: ...
    def food_free_tokens(self, text: str) -> tuple[str, ...]: ...
```

All draw methods raise `CookoutExhaustedError` when nothing feasible exists. `cookout_game.BankLike`
(X2) widens to the same signatures.

### A.2 Frozen Python interface — X2 store (`store.py`, additions)

```python
@dataclass(frozen=True, slots=True)
class EncoreSpec:
    from_seq: int
    generation: int
    concept_id: str
    kind: Literal["leftovers", "remix"]
    seed_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class CookoutSetup:  # lives in cookout_game.py
    style: str | None = None
    style_spun: bool = False
    challenge: str | None = None
    wildcard: bool = False
    stars: bool = False
    fridge_seed_id: str | None = None
    encore: EncoreSpec | None = None


Moved = tuple[CookoutRoundRow, bool]  # (round after the move, whether anything changed)


def create_cookout_round(
    self,
    *,
    client_id: str,
    sender: str,
    device_id: str,
    by_email: str | None,
    blind: bool,
    bank: CookoutBankLike,
    setup: CookoutSetup = CookoutSetup(),
    rng: random.Random | None = None,
    now: float | None = None,
) -> tuple[MessageRow, bool]: ...
def lucky_cookout(
    self,
    *,
    anchor_seq: int,
    sender: str,
    email: str | None,
    move_id: str,
    turn: int,
    offer: int,
    option_ids: tuple[str, str],
    bank: CookoutBankLike,
    runner_available: bool,
    rng: random.Random | None = None,
    now: float | None = None,
) -> Moved: ...
def chaos_cookout(
    self,
    *,
    anchor_seq: int,
    sender: str,
    email: str | None,
    move_id: str,
    turn: int,
    offer: int,
    option_ids: tuple[str, str],
    bank: CookoutBankLike,
    rng: random.Random | None = None,
    now: float | None = None,
) -> Moved: ...
def veto_cookout(
    self,
    *,
    anchor_seq: int,
    sender: str,
    email: str | None,
    move_id: str,
    turn: int,
    offer: int,
    ingredient_id: str,
    bank: CookoutBankLike,
    rng: random.Random | None = None,
    now: float | None = None,
) -> Moved: ...
def star_cookout(
    self,
    *,
    anchor_seq: int,
    sender: str,
    email: str | None,
    ingredient_id: str,
    runner_available: bool,
    now: float | None = None,
) -> Moved: ...
def wildcard_cookout(
    self,
    *,
    anchor_seq: int,
    sender: str,
    email: str | None,
    move_id: str,
    lift: bool,
    bank: CookoutBankLike,
    runner_available: bool,
    rng: random.Random | None = None,
    now: float | None = None,
) -> Moved: ...
def vote_cookout(
    self,
    *,
    anchor_seq: int,
    sender: str,
    email: str | None,
    concept_id: str,
    now: float | None = None,
) -> Moved: ...
def propose_cookout_swap(
    self,
    *,
    anchor_seq: int,
    sender: str,
    email: str | None,
    move_id: str,
    ingredient_id: str,
    bank: CookoutBankLike,
    rng: random.Random | None = None,
    now: float | None = None,
) -> Moved: ...
def choose_cookout_swap(
    self,
    *,
    anchor_seq: int,
    sender: str,
    email: str | None,
    move_id: str,
    ingredient_id: str,
    runner_available: bool,
    now: float | None = None,
) -> Moved: ...
def cancel_cookout_swap(
    self, *, anchor_seq: int, sender: str, email: str | None, now: float | None = None
) -> Moved: ...
def mark_cookout_cooked(
    self,
    *,
    anchor_seq: int,
    sender: str,
    email: str | None,
    generation: int,
    concept_id: str,
    cooked: bool,
    now: float | None = None,
) -> Moved: ...
def rate_cookout_recipe(
    self,
    *,
    anchor_seq: int,
    sender: str,
    email: str | None,
    generation: int,
    concept_id: str,
    rating: int | None,
    now: float | None = None,
) -> Moved: ...
def link_cookout_photo(
    self,
    *,
    anchor_seq: int,
    sender: str,
    email: str | None,
    generation: int,
    concept_id: str,
    message_seq: int | None,
    now: float | None = None,
) -> Moved: ...
def cookout_round_photos(self, *, anchor_seq: int) -> list[tuple[MessageRow, AttachmentRow]]: ...
```

New store exceptions: `CookoutTokenUsedError` → `409 token_used`, `CookoutRecipePendingError` →
`409 recipe_pending`. Existing method signatures (core Appendix A.2) are unchanged; their behaviour
changes only as stated (current-generation scoping, gate-aware Turn 10, stale-vs-invalid pick,
generalised Player-2 wait, ordinal offset).

**X2 ↔ X3 read contract:** `get_cookout_round()` adds `basket_ids: list[str]`, `picked_ids` (alias),
`star_ids: list[str]`, `wildcard_id: str | None`, `style: str | None`, `challenge: str | None`,
`generation: int` (§5.2); `recipes` is current-generation only.

### A.3 Frozen wire — X2 ↔ X4

The exact shapes in §4.2–§4.5. TypeScript additions in `api.ts`:

```text
type StyleId = "cosy-pub" | "street-food" | "posh-tasting" | "breakfast-for-dinner"
             | "date-night-bistro" | "takeaway-at-home" | "picnic" | "campfire";
type ChallengeId = "one-pan" | "no-oven" | "thirty-minutes" | "six-steps";
type WildcardState = "off" | "armed" | "offered" | "lifted" | "declined";
type SwapState = "none" | "proposed" | "done";
type PickVia = "pick" | "lucky" | "chaos" | "seed" | "wildcard" | "swap";
interface CatalogueEntry { readonly id: string; readonly label: string; readonly emoji: string; readonly blurb: string }
interface CookoutOptions { readonly styles: readonly CatalogueEntry[]; readonly challenges: readonly CatalogueEntry[];
                           readonly chef: boolean; readonly pictures: boolean }
interface CreateCookoutInput { clientId; deviceId; sender; blind?; style?: StyleId | "spin" | null;
                               challenge?: ChallengeId | null; wildcard?: boolean; stars?: boolean;
                               fridgeSeedId?: string | null;
                               encore?: { fromSeq: number; generation: number; conceptId: ConceptId;
                                          kind: "leftovers" | "remix"; seedIds: readonly string[] } | null }
interface TwistMoveInput extends MoveInput { readonly optionIds: readonly [string, string] }   // lucky, chaos
interface VetoInput extends MoveInput { readonly ingredientId: string }
```

New `api.ts` calls: `getCookoutOptions`, `searchIngredients(q)`, `luckyCookout`, `chaosCookout`,
`vetoCookout`, `starCookout`, `wildcardCookout`, `voteCookout`, `proposeSwap`, `chooseSwap`,
`cancelSwap`, `markCooked`, `rateRecipe`, `linkRecipePhoto`, `getRoundPhotos` — each returning the
existing `CookoutOutcome` (view or failure) except the two GET catalogues and photos.
