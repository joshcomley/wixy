# Server chat — Cookout twists (addendum to `09-cookout.md`)

Workspace 00058. Decided addendum: implement faithfully on top of the shipped core
(`spec/server-chat/09-cookout.md`; its schema v21 is not yet deployed, so the twist schema is folded into it, §2). The operator accepted all twelve twists the panel
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

**Core skip gains `optionIds` (orchestrator ruling after the X4 review).** Because veto and chaos
change the live pair WITHOUT changing `offer`, the core `POST /cookout/{seq}/skip` body becomes
`{sender, moveId, turn, offer, optionIds?: [id, id]}`. When present, `optionIds` must equal the live
pair (order-free) or the skip is `409 bad_state`; the client always sends it. It stays optional on the
wire only so a cached pre-twist client keeps working; a skip without it is judged on `turn`/`offer`
alone, exactly as before. Test: veto (or chaos) then a skip naming the pre-veto pair → 409, no draw.

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
- **Reveal and lock are ONE transition.** Define
  `stars_locked = state == 'finished' and star1_id is not None and star2_id is not None`. The moment
  that predicate becomes true (the Turn-10 pick when both were starred during the draft, or the
  second star submitted at the gate) both stars are revealed **and** committed in the same
  transaction — independent of the cloche, which may still be unanswered. Reason: a revealed secret
  that can still be changed is not a secret commitment (review finding: reveal and lock must never be
  different moments).
- `POST /cookout/{seq}/star {sender, ingredientId}` sets or changes the caller's star. It is
  state-idempotent (the same id again → `200`, no event — including after the lock). Allowed while
  `picking` (once you have at least one pick) and on a `finished` round while `stars_locked` is false
  and `concepts == 'none'`. Whenever `stars_locked` is true — even while concepts are still `'none'`
  behind an unanswered cloche — or once concepts have left `'none'`, a **different** star is
  `409 bad_state`. `abandoned` → `409 bad_state`. An id that is not one of the caller's own picks →
  `422 invalid`. The ☆/★ toggles render disabled once `stars.revealed` is true.
- **Secrecy (both modes):** the viewer always sees their own star. The partner's star is revealed
  exactly when `stars_locked` becomes true (`stars.revealed`). Before that the partner sees only
  `partnerChosen: bool` (needed for "waiting for Cupcake to star one"). In Open mode picks are visible
  but stars are not; an abandoned round never reveals stars. Clearing the cloche afterwards starts
  exactly one concepts job with the locked ids.
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
     `start_concepts(background, seq, generation=<new generation>)`.
  4. Bank move ids of the dropped rows stay in the round-level `bank_move_ids` ledger (§2.1), so a
     replay of any earlier Bank never becomes a new generation-2 job (§1.10).
- **Cancel / keep these dishes** — `POST /cookout/{seq}/swap/cancel {sender}`; either player while
  `proposed` → back to `'none'` (`swap_pair`, `swap_by`, `swap_out_id` cleared; `swap_seen` kept so a
  new proposal never re-deals the same items). The swap is not used up by a cancel. Already `'none'`
  → `200` no-op; `'done'` → `409 bad_state`.
- **While proposed:** no new recipe job may start against dishes about to be archived. Both
  `bank_cookout_concept` **and** `retry_cookout_recipe` check `swap_state == 'proposed'` inside their
  own write transaction and refuse with `CookoutBadStateError` (`409 bad_state`) before touching the
  recipe row; the route starts no runner on that refusal. The **Bank this** and recipe **Try again**
  buttons render disabled with "Finish or cancel the swap first". (Without the retry guard a failed
  recipe retried during a proposal would become `pending`, start a job and hold the swap hostage with
  `409 recipe_pending`.) Votes, cooked marks, ratings and photos stay allowed.
- **The swapped-out ingredient is forbidden in every later generation.** It is not merely "unpicked":
  if it is one of the five pickable staples (butter, plain flour, cooking oil, granulated sugar,
  milk) the core rules would otherwise let the chef declare it straight back as a cupboard staple.
  The AI read carries it as `forbidden_ids` (§5.2) and §5.3 removes it from the prompt's staples,
  rejects it in every manifest and runs an explicit forbidden-id lexical check that no staple, family
  or omission allowance can override. The exclusion applies to generation 2 only; archived recipes
  stay readable as they were.
- **After the swap:** the generation-1 dishes appear in an **Earlier dishes** section: their cards,
  pictures, vote result and recipe states. Banked ones open their full recipe and keep T4. Unbanked
  ones are view-only (no Bank). Reason: banking an archived concept would need recipe jobs against a
  non-current concept set (two live job targets per round); the brief keeps only banked recipes
  tied to their version. Missing archived pictures cannot be retried (same reason).
- **Blind mode:** a swap happens after the reveal, so the target, the pair and the choice are visible
  to both players.

### 1.7 Dinner vote (T2)

- On a `finished` round with `concepts == 'ready'` (current generation), each player secretly taps
  one concept: `POST /cookout/{seq}/vote {sender, generation, conceptId}` (`generation` = the
  generation of the dish the player saw; a non-current generation → `409 bad_state`, §1.10).
  State-idempotent; a player may change
  their vote until **both** have voted. When the second vote lands, both are revealed and locked (a
  different later vote → `409 bad_state`; the same → `200`).
- **Secrecy (both modes):** before the reveal a viewer sees only their own vote and
  `partnerVoted: bool`. After: both votes and `match` (the concept id when equal, else `null`). A match
  shows **"🎯 Tonight's dinner!"** on that card; a mismatch shows both voters' badges.
- A vote never banks anything and never starts a job. A completed swap archives the votes with
  generation 1 and clears them for generation 2.
- **Archived votes keep their secrecy forever.** The reveal predicate is applied independently to
  every archived generation: its `votes` and `match` are non-null **only when both archived votes are
  non-null**. A one-sided archived vote (a swap completed before the second player voted) can never
  reach its reveal moment, so it is returned as `votes: null, match: null` to **every** viewer (the
  voter included, for one simple rule) and is never serialised; `dinnerPick` is false unless both
  archived votes exist and match.

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
- `POST /cookout/{seq}/recipes/{generation}/{conceptId}/photo {sender, messageSeq: int | null,
  attachmentId: string | null}` — either player links **the exact photo the chooser showed**: the
  request carries the `messageSeq` **and** the `attachmentId` that `GET /cookout/{seq}/photos`
  returned. In the write transaction the server validates that exact attachment: it exists, belongs
  to that message, is `kind = 'photo'` and `status = 'ready'`; the message exists, is in `wyr_chat`
  with `anchor_seq = seq`, and is not view-once (`view_once_s IS NULL`; Inv 52 — a view-once
  attachment is never linkable). It then stores exactly that id (`photo_message_seq`,
  `photo_attachment_id`). The server **never re-selects** an attachment (no "lowest ordinal" at link
  time: readiness can change between the chooser's GET and this POST, e.g. an earlier photo on the
  same message finishing processing). Any failed check — stale, deleted, not ready, wrong message,
  wrong round, view-once — is an explicit `409 bad_state`, and the client re-opens the chooser.
  **Unlinking** sends `messageSeq: null, attachmentId: null` (both null; exactly one null →
  `422 invalid`). Requires cooked (`409 bad_state`).
- **No new upload path.** "Add our photo" opens the round's mini-chat pop-up composer; the photo is
  sent as an ordinary mini-chat message (so it lives in the chat, the main thread and the Gallery like
  any photo), then linked. `GET /cookout/{seq}/photos` lists the round's linkable mini-chat photos,
  **one entry per message**, showing that message's lowest-ordinal ready photo **at the time of the
  GET**, with its `attachmentId`. The POST sends that `attachmentId` back, so the thumbnail tapped is
  always the attachment stored (a multi-photo message offers one choice; a failed-first/ready-second
  message offers and links the ready one).
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
| Swap and pending recipe | Propose/choose refused (`409 recipe_pending`); Bank **and recipe retry** refused while proposed. |
| Swap of a pickable staple | Allowed; the removed staple is then forbidden in generation 2 even as a declared cupboard staple (§5.3). |
| Swap after one vote | The single vote is archived but never revealed to anyone (§1.7). |
| Stars + unanswered cloche | Stars reveal and lock as soon as both are set on a finished round; the cloche can still be answered afterwards. |
| Swap of a starter | Allowed (a starter is a basket ingredient). |
| Encore + fridge raid | Fridge seed is Turn 1, exactly one encore seed is Turn 2. |
| Encore source in an archived generation | Allowed (`generation` names it); leftovers need not be banked, remix must be banked in that generation. |
| Stars + wildcard gate | Both gates must clear, in any order; concepts start on the last answer, with the already-locked stars. |
| Stars + lucky/chaos/veto picks | Any of your own picks may be starred, however it was chosen. |
| Style + challenge | Both directives in the prompt; only the challenge is validated; the picture uses the style's presentation phrase. |
| Challenge + wildcard/stars | All rules apply together; the coverage rules (§5.3) still hold. |
| Cooked + swap | T4 works on banked recipes of every generation. |
| Vote + Bank | Independent; neither triggers the other. |

### 1.10 Generation identity: requests and background jobs

Concept ids `a`/`b`/`c` are reused by generation 2, so "whatever generation is current when the write
runs" is never a stale-request guard. Two fences, both decided:

- **Two different generation contracts.**
  - **Current-generation actions:** Bank (`/concepts/{conceptId}/bank`), vote, concepts retry,
    pictures retry and recipe retry act on the dishes on the table now. They carry
    `generation: int` (the view's `generation`). Inside the write transaction: `generation` ≠ the
    round's current generation → `409 bad_state` (no write, no event, no job) — except a recorded
    Bank replay (below), which is recognised first.
  - **T4 "We cooked it!" actions (any generation):** mark/unmark cooked, rate, and link/unlink photo
    name `(generation, conceptId)` in the path and resolve exactly that `(anchor, generation,
    concept_id)` **banked** recipe of **any** generation. They check the caller is a bound player of
    the round and apply the T4 prerequisites (banked; cooked for rating and photo), but **never**
    require the named generation to equal the current one — editing a banked generation-1 recipe
    after a swap is the point. Every T4 SQL predicate keeps the explicit generation; it is never
    redirected to the current generation. A named row that does not exist or is not banked →
    `409 bad_state`.
  For the current-generation actions: A request **without** `generation` (a core-era client) is accepted only while the
  round is still at generation 1; on a generation-2 round a missing `generation` is `409 bad_state` —
  it can never select a generation-2 target. The updated client always sends it.
- **Bank replays are recognised across all generations.** `cookout_rounds.bank_move_ids` is a
  round-level ledger of `{"id": moveId, "generation": n, "conceptId": "a"|"b"|"c"}` written by every
  bank that creates a row and never pruned (it survives the swap's deletion of failed/unavailable
  generation-1 rows). `bank_cookout_concept` checks the ledger **first, by `moveId` alone**: a recorded
  move is a `200` replay with the current view, no row change, no event and no job, whatever
  generation it named. Only an unrecorded move proceeds to the generation check and the core rules.
- **Background jobs carry a captured generation (`expected_generation`).** A concepts or recipe job
  captures the round's `generation` when it starts (passed by the route through
  `start_concepts(..., generation)` / `start_recipe(..., generation, concept_id)`, or read with the
  pending row by the startup/sweep recovery, §5.2) and presents it to **every** claim and completion
  write: `set_cookout_concepts_run`, `finish_cookout_concepts`, `set_cookout_recipe_run`,
  `finish_cookout_recipe` add `AND generation = :expected_generation` to their compare-and-set
  (recipe writes target the captured generation's row, never a subquery for the current one). The same
  captured value is used on the polling, repair, unavailable, failure and crash (`_fail_after_crash`)
  paths, in `still_waiting`, and in the runner's in-process `_running` key
  (`("c", anchor, generation, "")`, `("r", anchor, generation, concept_id)`). A spawn whose
  `set_*_run` claim returns `False` is **cancelled** (`cancel_run`) and abandoned. So a slow
  generation-1 spawn returning after a swap can neither claim, finish nor fail generation 2's job
  (review finding: an unchanged setter accepted exactly that late claim). The image job keeps its own
  separate `images_generation` attempt fence.

---

## 2. Schema — folded into the undeployed v21 (`store.py`)

**Orchestrator ruling:** schema v21 has **never been deployed** — production runs schema v20 and the
whole Cookout feature (core + twists) ships in one release. There is therefore **no v22 and no
v21→v22 migration**: the X2 server builder edits the existing, undeployed `_SCHEMA_V21_COOKOUT`
definitions in place so the single v20→v21 migration produces the final shape directly.
`_LATEST_SCHEMA_VERSION` stays `21`. `cookout_recipes` is keyed with `generation` from the start, so
there is **no table rebuild**. The genuine-v20 migration fixture test (a real v20 database migrated to
v21) must still pass and must assert the final shape below.

**Blue/green overlap:** during a slot swap the *old* process is v20 code. It has no Cookout tables or
routes at all, so it can neither advance a round nor run a Cookout job; its migration check reads
`user_version = 21 >= 20` and leaves the schema alone. If it deletes a message, the `ON DELETE
CASCADE` / `SET NULL` foreign keys below still erase or unlink the Cookout rows (SQLite enforces
them, not Cookout code). No overlap honest limit remains.

Enumerated catalogue values (`style`, `challenge`) carry **no** CHECK, so the catalogue can grow
without a table rebuild; code validates them against `cookout_twists.py`. State machines keep CHECKs.

### 2.1 `cookout_rounds` — the final v21 definition

The core columns are unchanged; the twist columns are added to the same `CREATE TABLE`:

```sql
CREATE TABLE IF NOT EXISTS cookout_rounds(
  anchor_message_seq INTEGER PRIMARY KEY REFERENCES messages(seq) ON DELETE CASCADE,
  -- ...every core column exactly as in 09-cookout.md §4.1...
  style TEXT,
  style_spun INTEGER NOT NULL DEFAULT 0 CHECK(style_spun IN (0, 1)),
  challenge TEXT,
  wildcard TEXT NOT NULL DEFAULT 'off'
    CHECK(wildcard IN ('off','armed','offered','lifted','declined')),
  wildcard_snap TEXT,
  wildcard_move_id TEXT,
  stars INTEGER NOT NULL DEFAULT 0 CHECK(stars IN (0, 1)),
  star1_id TEXT,
  star2_id TEXT,
  vote1 TEXT CHECK(vote1 IS NULL OR vote1 IN ('a','b','c')),
  vote2 TEXT CHECK(vote2 IS NULL OR vote2 IN ('a','b','c')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1),
  bank_move_ids TEXT NOT NULL DEFAULT '[]',
  swap_state TEXT NOT NULL DEFAULT 'none' CHECK(swap_state IN ('none','proposed','done')),
  swap_by INTEGER CHECK(swap_by IS NULL OR swap_by IN (1, 2)),
  swap_out_id TEXT,
  swap_pair TEXT,
  swap_seen TEXT NOT NULL DEFAULT '[]',
  swap_in TEXT,
  swap_move_ids TEXT NOT NULL DEFAULT '[]',
  encore_kind TEXT CHECK(encore_kind IS NULL OR encore_kind IN ('leftovers','remix')),
  encore_from_seq INTEGER REFERENCES cookout_rounds(anchor_message_seq) ON DELETE SET NULL,
  encore_generation INTEGER,
  encore_concept_id TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
```

- `wildcard_snap`, `swap_pair`, `swap_seen`, `swap_in` hold immutable ingredient snapshots
  (`{id, name, category, emoji, family, blurb}`), like `cookout_turns.offers`.
- `bank_move_ids` is the never-pruned Bank replay ledger (§1.10).
- `swap_move_ids` holds `{"id": moveId, "slot": 1|2, "kind": "propose"|"choose"}` objects.
- Fridge raid needs no round column (it is the Turn-1 `seed_source = 'fridge'`).
- The self-reference sets the encore link to NULL when the source round goes (anchor delete cascades
  the source row).

### 2.2 `cookout_turns` — the final v21 definition

```sql
CREATE TABLE IF NOT EXISTS cookout_turns(
  -- ...every core column exactly as in 09-cookout.md §4.1...
  seed TEXT,
  seed_source TEXT CHECK(seed_source IS NULL OR seed_source IN ('fridge','encore')),
  replaced TEXT NOT NULL DEFAULT '[]',
  chaos_offer INTEGER CHECK(chaos_offer IS NULL OR chaos_offer BETWEEN 0 AND 2),
  veto_offer INTEGER CHECK(veto_offer IS NULL OR veto_offer BETWEEN 0 AND 2),
  lucky INTEGER NOT NULL DEFAULT 0 CHECK(lucky IN (0, 1)),
  twist_move_ids TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(anchor_message_seq, turn));
```

- Seeded turn: `seed` = snapshot, `offers = '[]'`, `choice_id = seed id`.
- `replaced` = list of `{"offer": n, "position": 0|1, "snap": {...}, "by": "veto"|"chaos"}`.
- `twist_move_ids` = list of `{"id": moveId, "slot": 1|2, "kind": "chaos"|"veto"}` (the veto's slot
  is the partner's, so replay checks match on `(id, slot)`). Lucky dip uses `pick_move_id`.

### 2.3 `cookout_recipes` — keyed with `generation` from the start, plus T4 columns

```sql
CREATE TABLE IF NOT EXISTS cookout_recipes(
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
CREATE INDEX IF NOT EXISTS idx_cookout_recipes_banked
  ON cookout_recipes(state, banked_at DESC, anchor_message_seq DESC);
CREATE INDEX IF NOT EXISTS idx_cookout_recipes_photo ON cookout_recipes(photo_message_seq);
```

- Generation 2 may bank concept `a` again while generation 1's banked `a` stays: the key says so.
- Every recipe statement names the generation **explicitly**: Bank and recipe retry
  (`bank_cookout_concept`, `retry_cookout_recipe`) use the request's generation after checking it is
  current (§1.10, with the recorded-Bank replay exception); the T4 writes (`mark_cookout_cooked`,
  `rate_cookout_recipe`, `link_cookout_photo`) use the request's generation **as named, of any
  generation, without a current-generation check** (`WHERE anchor_message_seq = ? AND generation = ?
  AND concept_id = ? AND state = 'banked'`); job-driven writes (`set_cookout_recipe_run`,
  `finish_cookout_recipe`) use the job's captured `expected_generation`. No statement picks "the
  current generation" by subquery on behalf of a caller that did not name one.
- `get_cookout_round()['recipes']` is the current generation only.

### 2.4 `cookout_generations` — new table in v21 (superseded dish sets)

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
- Only superseded generations are stored; the current one lives on `cookout_rounds`.
- `vote1`/`vote2` are stored raw but serialised only under the archived-vote reveal rule (§1.7).

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
  encore_concept_id = NULL, encore_kind = NULL` and bump its `rev` + `message_updated`. The FK actions
  are the backstop for a delete issued by the overlapping v20 process.
- Generation-2 dish pictures attach to the anchor with `ordinal = (generation - 1) * 3 + index(slot)`
  (generation 1 keeps `0..2`). `list_gallery` already excludes every Cookout anchor's attachments; a
  linked T4 photo is an ordinary mini-chat photo and stays in the Gallery like any other.
- `cookout_view_data` loads the anchor's attachments when the current `pictures` or any archived
  generation's `pictures` is non-empty, and the attachments of every linked T4 photo message.

### 2.6 Model rows (`models.py`)

- `CookoutRoundRow` gains: `style: str | None`, `style_spun: bool`, `challenge: str | None`,
  `wildcard: CookoutWildcardState`, `wildcard_snap: dict[str, str] | None`,
  `wildcard_move_id: str | None`, `stars: bool`, `star1_id: str | None`, `star2_id: str | None`,
  `vote1: str | None`, `vote2: str | None`, `generation: int`,
  `bank_move_ids: tuple[dict[str, object], ...]`, `swap_state: CookoutSwapState`,
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
- `POST /cookout/{seq}/vote {sender, generation, conceptId}` → view.
- **Generation on the core chef-stage routes (§1.10):** `POST /cookout/{seq}/concepts/{conceptId}/bank
  {sender, moveId, generation?}`, `POST /cookout/{seq}/concepts/retry {sender, generation?}`,
  `POST /cookout/{seq}/pictures/retry {sender, generation?}` and
  `POST /cookout/{seq}/concepts/{conceptId}/recipe/retry {sender, generation?}` gain an optional
  `generation: int` (the updated client always sends it). Mismatch with the round's current
  generation, or absent on a generation-2 round → `409 bad_state` with no write, event or job. A Bank
  whose `moveId` is already in `bank_move_ids` → `200` replay, no job, before any other check.
  Recipe retry while a swap is proposed → `409 bad_state`, no job.
- `POST /cookout/{seq}/swap/propose {sender, moveId, ingredientId}` → view.
- `POST /cookout/{seq}/swap/choose {sender, moveId, ingredientId}` → view (starts concepts).
- `POST /cookout/{seq}/swap/cancel {sender}` → view.
- `POST /cookout/{seq}/recipes/{generation}/{conceptId}/cooked {sender, cooked: bool}` → view.
- `POST /cookout/{seq}/recipes/{generation}/{conceptId}/rating {sender, rating: int | null}` → view.
- `POST /cookout/{seq}/recipes/{generation}/{conceptId}/photo {sender, messageSeq: int | null,
  attachmentId: string | null}` → view (exact attachment validated and stored, never re-selected;
  stale/invalid → `409 bad_state`; both null = unlink; exactly one null → `422 invalid`).
- `GET /cookout/{seq}/photos?as=<sender>` →
  `{photos: [{messageSeq, attachmentId, sender, createdAt, picture: Picture}]}` — **one entry per
  message**: each non-view-once message in this round's mini chat that has at least one ready photo,
  represented by its **lowest-ordinal ready** photo at the time of the GET (the client posts that
  `attachmentId` back to link it), newest first, ≤ 50. Players only (`409 not_player` otherwise).

Idempotency: `lucky` shares `pick_move_id`; `chaos`/`veto` use `twist_move_ids` matched on
`(moveId, actor slot)`; `wildcard` uses `wildcard_move_id` (a replay → `200`; a different move after
the cloche was answered → `200` when it asked for the same outcome, else `409 bad_state`); swap moves
use `swap_move_ids`; Bank uses the round-level `bank_move_ids` ledger across all generations; `star`, `vote`, `cooked`, `rating`, `photo`, `swap/cancel` are state-idempotent
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
           revealed: bool, partner: string | null },   // revealed == locked (§1.5)
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
- `stars.revealed` = `stars_locked` (§1.5: finished and both set — reveal and lock are one
  transition); `stars.partner` is non-null only then; `stars.mine` only for a bound viewer.
- `vote` is `null` unless `concepts == 'ready'`; `votes`/`match` only once both voted; `vote.you` is
  the viewer's own; a non-player sees only `revealed` and, once revealed, the result.
- `generations[].vote.votes` / `.match` are non-null **only when both archived votes are non-null**;
  an incomplete archived vote is `{votes: null, match: null}` for every viewer and the raw single slot
  is never serialised (§1.7).
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
null`, `dinnerPick: bool` (true only when both of that generation's votes exist and match on this concept),
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
- `mentions(text, ingredient_id) -> bool` (stars and the swap's forbidden-id check): `True` when the
  longest-first span recognition of `text` (the same `_spans`) yields that ingredient's entity, the
  bare family word of its family, or — for a pickable staple id — the staple entity / bare short form
  (`butter`, `flour`, `oil`, `sugar`, `milk`) mapped to that id. No stop-word, family-exemption or
  declared-staple allowance applies.
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
`wildcard_id` (the lifted wildcard id, or `None` when off/declined or swapped out),
`forbidden_ids` (sorted list: `[swap_out_id]` when the current generation was created by a completed
swap, else `[]`; scoped to the current generation, so archived recipes are untouched), `style`,
`challenge`, `generation`. `recipes` is the current generation only.

The recovery reads also carry the generation, so a resumed job captures it with the row:
`cookout_pending_concepts() -> list[tuple[int, int, str | None]]` (`(anchor, generation, run_id)`) and
`cookout_pending_recipes() -> list[tuple[int, int, str, str | None]]`
(`(anchor, generation, concept_id, run_id)`).

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
- **Forbidden ids (a completed swap):** `basket_payload` omits every `forbidden_ids` entry from
  `"staples"` (so a swapped-out pickable staple is no longer on offer as a cupboard staple), and when
  non-empty adds `"forbidden": [ids]` to the `"twists"` object with the concepts-prompt line
  `NEVER use or mention these removed ingredients anywhere, not even as a cupboard staple: <names>.`
  Only validated bank ids/names are added (privacy unchanged).
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
  - forbidden ids: a `forbidden_ids` entry in `pickedIngredientIds`, `stapleIds` or `omitted` is a
    violation, and an explicit forbidden-id lexical check runs over **every** prose field (`title`,
    `vibe`, `description`, `challengeNote` and `omitted[].reason`): `bank.mentions(text, forbidden_id)`
    must be false. This check is independent of both lexical passes and cannot be overridden by a
    declared staple, a family exemption or the omitted-reason allowance;
  - the stored concept keeps `challengeNote` / `totalMinutes` when present.
  Violation messages name the rule exactly ("concept b must name star 'smoked-kippers' in its title or
  description") so the one repair run can fix it.
- **The changed manifest:** the lexical scans take the effective basket as "the picks". The wildcard
  and a swapped-in item are ordinary basket members (allowed when used, Pass-2-forbidden when
  omitted). The **swapped-out** ingredient is never part of the manifest: it is excluded from the
  offered staples and caught by the forbidden-id check above, which — unlike Pass 1 — also catches a
  removed pickable staple (`butter`, `plain-flour`, `cooking-oil`, `granulated-sugar`, `milk`) that
  the core rules would otherwise allow as a declared staple. It is never treated as omitted, so it
  cannot be named even in `omitted[].reason`.
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
  validated (honest limit, §7). The stored recipe keeps `cookware` when present. With
  `forbidden_ids`: a forbidden id in `ingredients[]` is rejected, `concept_manifest` never lists it as
  a staple, and the same forbidden-id lexical check runs over every `quantity`, `note`, step text,
  tip and `cookware` entry.
- **Runner wiring:** `_concepts_job` reads `basket_ids`, requires `len(set(ids)) in (10, 11)` and
  builds `ConceptTwists(star_ids, wildcard_id, style, challenge, forbidden_ids)` from the row;
  `_recipe_job` builds `RecipeTwists(star_ids, style, challenge, forbidden_ids)`.
- **Generation fence in the runner (§1.10):** `start_concepts(background, anchor_seq, generation)`
  and `start_recipe(background, anchor_seq, generation, concept_id)` receive the captured generation
  (recovery takes it from the pending tuples, §5.2). The job aborts at once if the first row read is
  not that generation; passes `expected_generation` to every `set_*_run` / `finish_*` call on the
  success, repair, unavailable, failure and crash paths; checks it in `still_waiting`; keys `_running`
  by `(kind, anchor, generation, concept_id)`; and calls `cancel_run` on any run whose claim
  (`set_*_run`) returns `False`. Model, effort, callers, tool bans, timeouts, pacing and the one-repair
  rule are unchanged. Validation stays fully deterministic — no second model.

```python
@dataclass(frozen=True, slots=True)
class ConceptTwists:
    star_ids: frozenset[str] = frozenset()
    wildcard_id: str | None = None
    style: str | None = None
    challenge: str | None = None
    forbidden_ids: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class RecipeTwists:
    star_ids: frozenset[str] = frozenset()
    style: str | None = None
    challenge: str | None = None
    forbidden_ids: frozenset[str] = frozenset()
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
  starter, wildcard/swap states), `docs/ai/testing.md`, `CLAUDE.md` store table (schema v21, the one
  Cookout schema: `cookout_generations`, `cookout_recipes` keyed by generation, and the twist
  columns), and
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
- **pytest `test_livechat_cookout_twists.py`** (server parcel): the existing **genuine-v20 migration
  fixture** (`test_livechat_cookout.py`) still passes and now asserts the final v21 shape (every twist
  column with its default/CHECK, `cookout_recipes` primary key `(anchor_message_seq, generation,
  concept_id)`, `cookout_generations`, both recipe indexes, all FK actions; re-opening is a no-op); a
  message deleted through raw SQL (as the overlapping v20 process would) cascades/unlinks every Cookout
  row; parametrized `401 locked` across every new route; core-unchanged regression (a twist-free
  round's views and store calls identical to the core behaviour); each twist's happy path, every error
  code, replay idempotency per move kind;
  Blind redaction (partner stars, votes, chaos flags, chaos pairs, `via` tags, history never in a
  non-entitled response, including mutation responses; abandoned blind round reveals nothing new);
  gate ordering (stars then cloche, cloche then stars, stars set during picking → no gate);
  **stars lock = reveal**, in Open and Blind: both stars chosen before Turn 10 with the cloche on, and
  the second star chosen after Turn 10 with the cloche still unanswered — the stars reveal together at
  that transition, every different later star is `409 bad_state` (same-id replay `200`), and answering
  the cloche starts exactly one concepts job carrying the locked ids;
  **generation identity**: a generation-1 vote, Bank and each retry held until generation 2 is ready
  is `409 bad_state` (also with `generation` omitted) and changes no generation-2 vote, recipe, event
  or job count; a completed generation-1 Bank replayed after generation 2 is ready (same `moveId`,
  including one whose failed row the swap dropped) is a `200` no-job replay; a genuinely new
  generation-2 Bank succeeds; generation-free requests still work on a generation-1 round;
  **job fencing** with two workers: a generation-1 concepts spawn and a recipe spawn delayed across
  completion, swap and generation-2 startup — neither its success, repair, unavailable nor failure
  callback may claim, finish or fail the generation-2 job, and the losing spawn is cancelled;
  **swap freezes**: `propose → recipe retry` leaves no pending row and starts no job; a
  two-connection retry/choose race never leaves a pending recipe in an archived generation;
  **archived votes**: a swap after only one vote — the partner's and a non-player's responses (and the
  vitest DOM) contain no voted concept id; a both-voted archive reveals its result;
  **photos**: the two static cases (a message with two ready photos; failed-first/ready-second) —
  the chooser entry's `attachmentId` equals the stored `photo_attachment_id`; and the race case
  **GET → earlier photo finishes → POST** (processing-first/ready-second: GET offers the ready second
  photo, then the first photo's `finish_attachment` commits, then POST with the second photo's id) —
  the second photo is linked exactly, never the newly ready first; a POST with a stale id (deleted,
  not ready, other message, other round, view-once) is `409 bad_state` and links nothing; both-null
  unlinks; exactly one null is `422`;
  **T4 on any generation**: after a swap, with generation 2 also holding a banked `a`, mark, unmark,
  rate, link and unlink the generation-1 `a` through the store and the routes — each succeeds on the
  generation-1 row and leaves every generation-2 recipe column, the generation-2 view slot and its
  events untouched; T4 naming a generation/concept that is not banked is `409 bad_state`;
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
  smuggling a food, swapped-out item mentioned anywhere (including `omitted[].reason`); for **each**
  of `butter`, `plain-flour`, `cooking-oil`, `granulated-sugar`, `milk` swapped out: absent from the
  prompt's staples, rejected when declared in `stapleIds`, listed in `pickedIngredientIds`/`omitted`,
  named by name, alias or bare short form in any concept field or `omitted[].reason`, or used in any
  recipe `ingredients[]`/quantity/note/step/tip/cookware — while generation-1 recipes stay readable;
  runner: `expected_generation` passed on every claim/finish path, `_running` keyed by generation,
  losing claims cancelled;
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
  confirm, photo chooser — one entry per message); generation sent on vote/Bank/retries; Bank and
recipe Try again disabled while a swap is proposed; star toggles disabled once revealed; recipe book (cooked badge, ratings, real photo, Remix/Leftovers buttons);
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
- **Generation identity in the client:** every vote, Bank and concepts/pictures/recipe retry sends
  the `generation` of the view the button was rendered from (never re-read at send time), so a
  delayed tap after a swap is refused instead of landing on a different dish. Bank and recipe
  **Try again** are disabled while a swap is proposed; star toggles are disabled once
  `stars.revealed`; the cooked-photo chooser shows one entry per message and posts back that entry's
  `messageSeq` **and** `attachmentId`; on `409 bad_state` it shows "That photo changed - pick again"
  and re-opens the chooser with a fresh GET. T4 controls on Earlier dishes call the T4 routes with
  that recipe's own generation (1), never the current one.
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
| **X2 — Store (undeployed v21 edited in place), game, routes** | Sonnet 5.5 | `wixy_server/livechat/store.py`, `wixy_server/livechat/models.py`, `wixy_server/livechat/cookout_game.py`, `wixy_server/routes_livechat_cookout.py`, `wixy_server/app.py`, `wixy_server/tests/test_livechat_cookout.py`, `wixy_server/tests/test_routes_livechat_cookout.py`, `wixy_server/tests/test_livechat_cookout_twists.py` (new) | A.1 bank and §3.3 catalogue (fakes until X1 lands) |
| **X3 — AI & pictures** | Sonnet 5.5 | `wixy_server/livechat/cookout_ai.py`, `wixy_server/livechat/cookout_images.py`, `wixy_server/tests/fake_cmd.py`, `wixy_server/tests/test_livechat_cookout_ai.py`, `wixy_server/tests/test_livechat_cookout_images.py` | A.1 (`mentions`, `food_free_tokens`), §3.3, A.2 read keys, the changed claim/completion signatures and runner protocol (A.2) — X3 is **not** interface-unchanged |
| **X4 — Admin UI** | **Opus 5.5** | `admin-ui/src/server/cookout/*` (incl. new `cookedSheet.ts`, `fridgeSearch.ts`), `admin-ui/src/server/{thread.ts, chat.css, api/messages.ts, itemChat.ts}`, `admin-ui/tests/cookout/*`, rebuilt `wixy_server/static/admin/*` | A.3 wire (builds against JSON fixtures) |
| **X5 — Docs & e2e** | Sonnet 5.5 | `e2e/tests/server-cookout-twists.spec.ts`, `docs/ai/{livechat,contracts,invariants,glossary,testing}.md`, `CLAUDE.md` store table, `decisions/00194-server-chat-cookout-twists/` | Drafts in parallel; runs e2e after X1–X4 integrate |

Order: X1 first (small, unblocks the others' real-bank tests); X2, X3 and X4 in parallel against the
frozen interfaces; X5 last for e2e. X2 edits the existing undeployed `_SCHEMA_V21_COOKOUT` (no v22,
no new migration step; the genuine-v20 fixture test must still pass). The runner protocol
(`CookoutRunner`) and the AI-facing store methods **change** (generation fence, §1.10, A.2); X2 and
X3 build against the frozen signatures below.

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
    generation: int,
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
    attachment_id: str | None,
    now: float | None = None,
) -> Moved: ...


# T4 exception: mark_cookout_cooked, rate_cookout_recipe and link_cookout_photo resolve the named
# (anchor, generation, concept_id) BANKED recipe of ANY generation - they never require `generation`
# to equal the round's current generation, and every T4 SQL predicate keeps that explicit generation.
# link_cookout_photo validates exactly `attachment_id` (a ready photo on that ordinary, non-view-once
# message in this round's mini chat) and stores exactly it, never re-selecting; stale or invalid ->
# CookoutBadStateError; both None = unlink; exactly one None -> CookoutInvalidError.
def cookout_round_photos(self, *, anchor_seq: int) -> list[tuple[MessageRow, AttachmentRow]]: ...
```

New store exceptions: `CookoutTokenUsedError` → `409 token_used`, `CookoutRecipePendingError` →
`409 recipe_pending`.

**Changed core signatures (replace core Appendix A.2; generation identity, §1.10).** Route-driven
methods take the generation the caller saw (`None` = a core-era request, accepted only on a
generation-1 round); job-driven methods take the job's captured `expected_generation` and add
`AND generation = ?` to their compare-and-set:

```python
# route-driven (X2 routes -> X2 store)
def bank_cookout_concept(
    self,
    *,
    anchor_seq: int,
    sender: str,
    email: str | None,
    concept_id: str,
    move_id: str,
    generation: int | None,
    runner_available: bool,
    now: float | None = None,
) -> Moved: ...  # checks bank_move_ids first; refuses while swap_state == 'proposed'
def retry_cookout_concepts(
    self, anchor_seq: int, *, generation: int | None, now: float | None = None
) -> bool: ...
def retry_cookout_pictures(
    self, anchor_seq: int, *, generation: int | None, now: float | None = None
) -> bool: ...
def retry_cookout_recipe(
    self,
    anchor_seq: int,
    concept_id: str,
    *,
    generation: int | None,
    now: float | None = None,
) -> bool: ...  # raises CookoutBadStateError while swap_state == 'proposed'


# job-driven (X3 runner -> X2 store)
def set_cookout_concepts_run(
    self,
    anchor_seq: int,
    run_id: str,
    *,
    expected_run_id: str | None = None,
    expected_generation: int,
) -> bool: ...
def finish_cookout_concepts(
    self,
    anchor_seq: int,
    run_id: str | None,
    state: Literal["ready", "failed", "unavailable"],
    *,
    expected_generation: int,
    concepts_json: str | None = None,
    error: str | None = None,
    pictures_pending: bool = False,
) -> bool: ...
def cookout_pending_concepts(self) -> list[tuple[int, int, str | None]]: ...
def set_cookout_recipe_run(
    self,
    anchor_seq: int,
    concept_id: str,
    run_id: str,
    *,
    expected_run_id: str | None = None,
    expected_generation: int,
) -> bool: ...
def finish_cookout_recipe(
    self,
    anchor_seq: int,
    concept_id: str,
    run_id: str | None,
    state: Literal["banked", "failed", "unavailable"],
    *,
    expected_generation: int,
    recipe_json: str | None = None,
    error: str | None = None,
) -> bool: ...
def cookout_pending_recipes(self) -> list[tuple[int, int, str, str | None]]: ...


# runner protocol (X3 implements, X2 routes call)
class CookoutRunner(Protocol):
    @property
    def available(self) -> bool: ...
    @property
    def images_available(self) -> bool: ...
    def start_concepts(
        self, background: ContainedTaskGroup, anchor_seq: int, generation: int
    ) -> None: ...
    def start_pictures(self, background: ContainedTaskGroup, anchor_seq: int) -> None: ...
    def start_recipe(
        self, background: ContainedTaskGroup, anchor_seq: int, generation: int, concept_id: str
    ) -> None: ...
    async def resume(self, background: ContainedTaskGroup) -> None: ...
    def supervise(self, background: ContainedTaskGroup) -> None: ...
```

The picture methods keep their signatures (their `images_generation` fence already covers them).
Every other core method keeps its signature; behaviour changes only as stated (gate-aware Turn 10,
stale-vs-invalid pick, generalised Player-2 wait, ordinal offset, explicit-generation recipe SQL).
`NullCookoutRunner` and the test fakes adopt the new protocol.

**X2 ↔ X3 read contract:** `get_cookout_round()` adds `basket_ids: list[str]`, `picked_ids` (alias),
`star_ids: list[str]`, `wildcard_id: str | None`, `forbidden_ids: list[str]`, `style: str | None`,
`challenge: str | None`, `generation: int` (§5.2); `recipes` is current-generation only.

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
interface VoteInput { readonly sender: string; readonly generation: number; readonly conceptId: ConceptId }
// bankCookoutConcept / retryCookoutConcepts / retryCookoutPictures / retryCookoutRecipe inputs gain
// `readonly generation: number` (always sent from the view's generation)
interface LinkPhotoInput { readonly sender: string; readonly messageSeq: number | null;
                           readonly attachmentId: string | null }   // both null = unlink
interface RoundPhoto { readonly messageSeq: number; readonly attachmentId: string; readonly sender: string;
                       readonly createdAt: number; readonly picture: Picture }
```

New `api.ts` calls: `getCookoutOptions`, `searchIngredients(q)`, `luckyCookout`, `chaosCookout`,
`vetoCookout`, `starCookout`, `wildcardCookout`, `voteCookout`, `proposeSwap`, `chooseSwap`,
`cancelSwap`, `markCooked`, `rateRecipe`, `linkRecipePhoto`, `getRoundPhotos` — each returning the
existing `CookoutOutcome` (view or failure) except the two GET catalogues and photos.
