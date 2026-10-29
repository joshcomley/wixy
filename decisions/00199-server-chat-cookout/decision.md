# Ask (operator, workspace 00058)
A third cooperative two-player game in the chat's ⋯ menu, "Cookout": the two take turns picking
ingredients into one shared basket (five picks each, ten in all). Each turn shows two contrasting
ingredients from a massive static bank ("everything in there": parsley, beef, cream, toast, sugar,
herbs, spices, prepared foods); the player picks one or skips both up to twice ("essentially three
goes before you have to pick"). Open and Blind modes (in Blind neither sees the other's offers or
picks until all ten are done). Then an AI invents three recipe concepts that try hard to use all ten
(and must use most) plus only "butter, salt, pepper, flour, a few things like that… nothing fancy" —
never sneaking in unpicked foods — each with a picture of the finished dish; "Bank this" writes the
full recipe and keeps it in a shared Recipe book. Every round has the shared mini chat. Specs and
panel: `spec/server-chat/09-cookout.md`, `triad/cookout/ruling.md` (panel: Gemini 4 Argon, Kimi K3.1
Pro, GPT-6 Astra XL; two rounds, then an orchestrator ruling on the splits; Kimi and Astra then did a
fresh review of the spec). Docs: livechat.md §24, Inv 57.

# Decided (the ruling's calls, and the minority positions adopted)
- **Seat identity is the existing would-you-rather rule, not a new seat cookie** (minority position:
  Argon's). Astra and Kimi measured correctly that under a shared Access sign-in or a missing email,
  someone who types the partner's name can read the partner's blind state. That is the same,
  already-accepted limit Inv 54 has for hidden answers; a new HttpOnly credential would add a
  security-reviewed auth surface to a chat whose design keeps credentials in JS memory only, for a
  no-peeking party feature nobody asked to harden. The limit is documented, not hidden (Inv 57).
- **Explicit Join; turn 1 is dealt at creation.** No dead lobby screen: the creator picks at once.
  Slot 2 is bound only by `POST /join`; turn 2's pair is not dealt until then. A seat is never bound
  by a first move.
- **No second LLM "manifest checker" run** (minority position: Argon's). Validation is deterministic
  Python: an id whitelist, coverage rules, and a lexical contraband scan of every prose field
  against the bank's own ingredient names and aliases. The bank *is* the dictionary of foods, so the
  scan is reproducible and unit-testable, whereas a second model is non-deterministic and adds a full
  spawn (about a minute) to every wait. One repair run is fed the exact violations. Honest limit: a
  food that is not in the bank can slip through prose.
- **Longest span first, then judge.** The scan tokenises once and recognises the longest whole-token
  span matching any bank name/alias before applying allowed/forbidden rules; a span consumes its
  tokens. Without it, "peanut butter" (a pick) would be read as the undeclared staple "butter", and
  "coconut milk" as "milk". A span protects only its own interior words at that position, so "peanut
  butter with extra butter" still fails. Pass 2 (omitted items, undeclared non-seasoning staples) is
  never softened by stop words or family exemptions.
- **Three tables, not six.** `cookout_rounds`, `cookout_turns`, `cookout_recipes` (Argon's shape),
  with: each offer stored as an immutable snapshot so a later bank edit never rewrites history; job
  fields (`*_run_id`, `*_started_at`, `*_tries`, deadline) on the owning row, following the proven
  `adventure_pack` resume pattern (persist the run id immediately after the spawn; on restart resume
  a known run id); concepts JSON on the round row but each bank as its own recipe row (no shared
  mutable blob between independent recipe jobs). No separate jobs / receipts / players tables. The
  Recipe book is derived from `state = 'banked'`.
- **Eight staples.** `water`, `salt`, `black-pepper` (free, never offered) and `butter`, `plain-flour`,
  `cooking-oil`, `granulated-sugar`, `milk` (also ordinary pickable bank entries — the operator named
  sugar as pickable), at most four unpicked non-seasoning staples per concept. NOT staples: eggs (a
  protein that would let every basket become an omelette), garlic, onion, lemon, stock, soy, vinegar,
  cream, cheese. The operator's own list was "butter, salt, pepper, flour, a few things like that…
  nothing fancy". `stopWords` must never contain a staple food name (the validator enforces it), or
  "butter" would be exempt from the scan.
- **Coverage (Astra's rule).** Every concept is asked to use all ten; each must use ≥ 7, at least one
  ≥ 8, the union of the three covers all ten, omissions are listed with reasons, and the three differ
  in dish type/technique (three distinct `(dishType, technique)` pairs, ≥ 2 dish types).
- **The draw (Astra's combined rule).** A per-round shuffled schedule `[base, protein, produce,
  produce, accent]`, each role served on paired turns so both players get the same opportunities; the
  least-shown category per player; two different categories and families per pair; at least one
  `everyday` option; weights everyday 8 : uncommon 3 : exotic 1 for the other; no id repeats; a picked
  family is never offered again; no cross-round memory.
- **Blind redaction is server-side Python, and the reveal predicate is `state == 'finished'`.** Not
  CSS/DOM hiding; not `!= 'picking'`, which would reveal an abandoned round to anyone who pressed End
  game. `Message.cookout` carries no ingredient data; every view is `Cache-Control: no-store`.
  `current.role` is redacted too (it hints at what is on offer).
- **One cmd run produces all three concepts** (so the three differ on purpose), prompt carries food
  records only, sorted by id (pick order and attribution stripped), tools all disallowed. Pictures:
  text first, then one ComfyUI graph with three sampling chains sharing one model load
  (`generate_many(1..3)`; `generate_pair` stays a wrapper so would-you-rather is untouched); a
  server-built deterministic prompt; the existing image limiter and demand counter; partial success
  kept and the missing slots retryable; `images_generation` fences each attempt.
- **ComfyUI prefix: reuse `wyr_`** (Kimi + Astra). The existing sweeper owns it; a second prefix adds
  sweep risk for no user benefit. Each run still uses a fresh run id and cleans up (Inv 54).
- **Bank this = save intent → full-recipe run → `banked` only when a valid full recipe is stored**,
  per concept, by either player, retryable on the card; serves 2, quantity strings, prep/cook minutes
  (the server computes the total), steps referencing ids, tips; the manifest is frozen to the
  concept's ingredients plus water, salt and pepper.
- **Menu:** one Cookout item that opens a small start sheet (Open / Blind), plus Recipe book. Starting
  a new Cookout abandons an open `picking` round; **End game** does the same on purpose; a `finished`
  round is never abandoned.
- **Bank size:** about 3,000 genuine ingredients (validator 2,500–4,000; the committed bank has
  3,491), Kimi's compact taxonomy plus a `role` field for the draw, family, rarity, category emoji and
  a short blurb; no dietary/allergen promises; the validator checks role/category coverage and 500
  simulated maximum-skip rounds.
- **The fun twists** (the same top five from all three panellists; none in core) were raised to the
  operator as decisions #2129–#2131; "trade credit" was dropped (all three ranked it last).
- **Server-chat discretion (R14a):** commits for this work carry `Release-note: General bug fixes and
  improvements.`; no trailer names the chat or the game.

# Reality vs the spec (recorded per the spec's own rule)
- The committed bank has 3,491 ingredients and 32 stop words; the spec's JSON example listed 16 stop
  words as an illustration.
- The wire `IngredientSnap` omits the stored `family` (a draw-only detail kept on the stored
  snapshot); the spec's TS contract lists `{id, name, category, emoji, blurb}`.
- `build_cookout_runner` in `cookout_ai.py` is the seam `create_app(cookout_runner=…)` receives; with
  none injected the app uses `NullCookoutRunner` (playable, dishes/recipes `unavailable`).

# What to watch for
- **The seat limit is real**: Blind mode must never be sold as a security boundary. If a stronger
  guarantee is ever wanted, it needs a proper credential design, not a tweak to `slot_of`.
- **Keep `stopWords` free of staple names** and re-run the validator after any bank edit; a new bank
  food that is also a common word ("mince", "stock") changes what the scan rejects. Bank ids are
  append-only and never reused; a banked recipe's text is stored, but its ingredient names are
  resolved from the bank at read time.
- **The contraband scan cannot see a food the bank does not contain.** Widening the bank widens the
  scan; do not treat a clean scan as proof of a clean recipe.
- **Every picture write must stay fenced by `images_generation`**; a new picture path that skips the
  claim/expected-generation pair brings back stale overwrites and orphaned scratch.
- **Never reveal on `!= 'picking'`**, never add ingredient data to `Message.cookout` or an SSE event,
  and never put a name, email or chat text in a prompt — Inv 57 and the tests that pin it.
- **cmd keeps a food-only copy** of the basket, concepts and recipes (as with Inv 56); this server
  cannot erase it.
- A lost client write is repaired by `moveId`: a client that retries a skip/pick after a dropped
  response gets a 200, not a second draw; keep `moveId` stable across retries.
