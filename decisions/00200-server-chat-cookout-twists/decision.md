# Ask (operator, workspace 00058)
After the core Cookout game (decision 00193) the operator accepted every one of the twelve "fun twists" the design panel
ranked highest (Triad round 2: Gemini 4 Argon, Kimi K3.1 Pro, GPT-6 Astra XL; ruling in `triad/cookout/ruling.md`):
rescue swap, dinner vote, chef's style wheel, We cooked it!, wildcard cloche, fridge raid, kitchen challenge, partner veto,
leftover encore, lucky dip, secret stars and chaos shelf. Spec: `spec/server-chat/09a-cookout-twists.md`; docs:
livechat.md §24.1, Inv 57 (extended), glossary, contracts, testing.

# Decided
- **Core unchanged when unused.** A round with no start-sheet twist and no twist button pressed is byte-for-byte the core:
  same states, same draws, same prompts (the prompt builders emit nothing for a twist that is off), new view fields at
  their "off" values. Start-sheet options default off behind a collapsed "Add twists (optional)" disclosure; the only
  twists that can hold the chef back are the two a player switched on at the start (cloche, stars), and only until
  answered.
- **No schema v22.** Schema v21 has never been deployed, so the twist columns, the `generation` key on `cookout_recipes`
  and the new `cookout_generations` table were folded into `_SCHEMA_V21_COOKOUT` in place; the single v20 -> v21 migration
  builds the final shape and the genuine-v20 fixture test asserts it. During a blue/green overlap the old v20 process has
  no Cookout tables or routes, and the foreign keys still erase or unlink Cookout rows if it deletes a message.
- **Server-decided randomness.** The style spin, lucky dip, chaos pair and wildcard are all drawn on the server
  (`secrets.SystemRandom`); the client only animates the answer, because a client-side spin would be theatre the server
  could not honour. Veto, chaos and lucky replace options *in place* (never a hidden skip) and each request names the table it
  saw, so a stale tap is `409 bad_state`. The "token used" flags are derived from the turns, not stored.
- **Secrets are hidden in both modes.** Stars and dinner votes stay hidden from the partner until their own reveal, which is
  one transition with the lock (a revealed secret that could still change would not be a commitment). Archived votes keep
  their secrecy forever: a one-sided archived vote is never serialised to anyone. The veto exists only in Open mode.
- **Starters are public and limited to two** (one fridge seed, one or two encore seeds, one when combined), so both players
  still draft the same number of turns; the role schedule is aligned to the first starter's role.
- **The chef gate has no timeout.** Both players are present by definition (Turn 10 needs Player 2) and each answer is a tap.
- **Generations, not edits.** A rescue swap archives the old dish set rather than mutating it. Concept ids `a|b|c` repeat per
  generation, so every current-generation action carries `generation`, background jobs capture `expected_generation` and
  present it to every claim and completion, and a never-pruned round-level Bank ledger recognises a replay across
  generations. The swapped-out ingredient is forbidden in every later generation, even as one of the five pickable cupboard
  staples. Unbanked archived dishes are view-only (banking an archived concept would need two live recipe targets).
- **Deterministic challenge checks, no second LLM.** `one-pan` (declared `cookware` of exactly one item plus a vessel-word
  scan), `no-oven`, `thirty-minutes`, `six-steps`. "No cooking at all" was rejected: baskets routinely contain raw meat and fish.
- **We cooked it! links, it does not upload.** The photo is an ordinary non-view-once mini-chat photo; the server stores the
  exact `attachmentId` the chooser showed (never re-selected) and unlinks when the message is deleted.
- **Server-chat discretion (R14a):** commits carry `Release-note: General bug fixes and improvements.`; no trailer names the
  chat or the game.

# Reality vs the spec
- Decision id: the spec names 00194; main had already used 00193-00198 when this landed, so this entry is 00200.
- The twists e2e (`server-cookout-twists.spec.ts`) found nothing in the merged X1-X4 code that contradicts 09a: the labels, selectors and flows of the client match §9. A late `ready` crossing the other side's failure in the call broker (a separate, call-feature fix) was found while chasing an e2e flake.

# What to watch for
- Any new place that serialises a vote, star or chaos pair must go through `cookout_view_json`'s redaction; never reveal on a
  predicate other than the ones in Inv 57, and never put a vote, rating, name or photo in a prompt.
- A new background write on a recipe or concepts row must present `expected_generation`; a new picture path must stay inside
  `images_generation`. Both fences exist because `a|b|c` are reused.
- Keep `stopWords` and the catalogue directives free of bank foods (a test enforces the directives): if a phrase trips the
  scan, reword the phrase, never weaken the scan.
- cmd keeps the extra twist text (directives, star and wildcard ids, swap baskets, repair feedback) in its hidden ledger, as
  for the core; this server cannot erase it.
- The catalogue grows without a table rebuild (no CHECK on `style` / `challenge`): validate against `cookout_twists.py`.
