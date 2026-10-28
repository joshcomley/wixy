# Cookout — panel ruling (orchestrator adjudication after round 2)

Panel: Gemini 4 Argon (High), Kimi K3.1 Pro (max), GPT-6 Astra XL (max). Inputs:
`round-1/{argon,kimi,astra}.md`, `round-2/{argon,kimi,astra}.md`.

**Swap hazard noted.** In round 2 Argon moved largely to Kimi's round-1 positions while Kimi moved
largely to Astra's round-1 positions, and Astra itself abandoned several of its own (coin toss, 3/5/7,
six tables). The round-2 tallies were therefore read for reasons, never counted. Where I side with a
minority I say so.

## Converged (all three, adopt as written in the round-2 merges)

- One shared ten-ingredient basket: **five picks each**, strict alternation, **creator takes turn 1**
  (Astra dropped its coin toss; Kimi's round-2 coin toss rested on deference to Astra's round-1 view
  that Astra itself has now abandoned).
- **Two skips per turn** — three pairs, must pick from the third; skips never pass the turn; unused
  skips do not carry.
- Blind mode: server-side redaction of the partner's options, picks and history (never CSS/DOM
  hiding); on the final pick the ten **selected** ingredients are revealed to both; the partner's
  skipped/unchosen pairs stay hidden forever; an abandoned blind round never reveals. `Message.cookout`
  (the broadcast summary) carries no ingredient data; personalised views are `Cache-Control: no-store`.
- Machine output uses exact bank/staple **ids**; the server resolves names; an illegal id rejects the
  whole candidate.
- **One cmd run produces all three concepts** (title, vibe, description, picked ids used, staple ids,
  omissions with reasons) via `cmdchat.py`, tools all disallowed, prompt carries ingredient records only
  (no names, no chat). One repair run on validation failure, with the violations fed back.
- Pictures: text first; then one ComfyUI graph with three sampling chains sharing one model load
  (`generate_many(1..3)` in `wyr_images.py`, `generate_pair` stays a wrapper so WYR is untouched);
  server-built deterministic prompt; existing image limiter/demand; ordinary private photo attachments
  on the anchor, excluded from Gallery; **partial success kept**, missing slots retryable; self-healing
  `images_started_at`/`images_tries`.
- **Bank this** = save intent → full-recipe cmd run → `banked` only when a valid full recipe is stored;
  each concept independently bankable by either player; failed saves retryable on the card. Full recipe:
  serves 2, quantity strings, prep/cook minutes (server computes total), steps referencing ids, tips;
  manifest frozen to the concept's ingredients (+ water).
- **Recipe book**: full-height screen (Holiday-bank pattern) listing completed banked recipes newest
  banked first; tap opens the round at that concept (loading old history). Everything dies with its
  anchor message and with wipe.
- Standalone edition: game playable, concepts/recipes `unavailable`, no images, no fallback.
- Second tab via `gameTabs.ts` (`GameKey` gains `"cookout"`; one game open at a time); shared
  `itemChat.ts` mini chat reusing the `wyrSeq`/`wyrRef` scalar contract with `wyrRefKind = "cookout"`;
  ⋯ menu lives in `thread.ts`.
- Fixed ownership parcels (data / server / AI+pictures / Opus UI / docs+e2e).
- Fun twists: the same top five from all three; none in core. Raised to the operator as decisions
  #2129–#2131 (12 twists; "trade credit" dropped — all three ranked it last).

## Rulings on the splits

1. **Seat identity — the existing WYR rule (`wyr_game._slot_of`: name key + verified email), NOT a new
   seat cookie.** Minority position (Argon) adopted. Astra/Kimi measured correctly that under a shared
   sign-in or a missing email someone typing the partner's name could read their blind picks. That is
   the same, already-accepted limit the would-you-rather game has for its hidden answers. Blind mode is
   a no-peeking party feature between two people who share a private chat, not a security boundary; a
   new HttpOnly credential would add a security-reviewed auth surface to a chat whose design keeps its
   credentials in JS memory only, for no requested benefit. Document the honest limit in the spec and in
   Inv 57.
2. **Join.** The round is created in `picking` with turn 1 drawn for the creator at once (no dead
   waiting screen). The second player binds with an explicit **Join** (any time; the pane shows Join to a
   non-player). Turn 2's pair is not drawn/exposed until player 2 is bound. A seat is never bound
   implicitly by a first move.
3. **Draw — Astra's combined rule:** per player a shuffled culinary-role schedule
   `[base, protein, produce, produce, accent]`, each role served on paired turns so both players get the
   same opportunities; within a role, the category least shown to that player; pair = two different
   categories and two different families; at least one `everyday` option per pair; rarity weights
   everyday 8 : uncommon 3 : exotic 1 for the other; no id repeats in a round; a selected family is never
   offered again; other offered families avoided when possible; no cross-round memory. ("Everything in
   there" is preserved: every category feeds some role.)
4. **Storage — three tables** (`cookout_rounds`, `cookout_turns`, `cookout_recipes`), Argon's shape, with
   these additions from Kimi/Astra: each offer stored as an immutable **snapshot**
   (`{id,name,category,emoji,blurb}`) so a later bank edit never rewrites history; job fields
   (`*_run_id`, `*_started_at`, `*_tries`, deadline) on the owning row, following the proven
   `adventure_pack` resume pattern (persist the run id immediately after spawn; on restart resume a known
   run id). No separate jobs/receipts/players tables. Concepts JSON lives on the round row; each bank is
   its own `cookout_recipes` row (no shared mutable blob between independent recipe jobs).
5. **No second LLM "manifest checker" run.** Minority position (Argon) adopted. Validation is
   deterministic: structural id whitelist + coverage rules + a **lexical contraband scan** of every prose
   field (title, description, steps, tips, quantity notes) against the bank's ingredient names and
   aliases, excluding picked items, their families, staples and a curated stop-list of generic culinary
   words (built and unit-tested from the bank itself). A hit rejects the candidate and triggers the one
   repair run with the offending words named. Reason: the bank *is* the dictionary of foods, so the scan
   is reproducible and testable, whereas a second model is non-deterministic and adds a full spawn
   (~1 minute) to every wait. Honest limit: a food missing from the bank can slip through prose.
6. **Staples — eight:** `water`, `salt`, `black-pepper`, `butter`, `plain-flour`, `cooking-oil`,
   `granulated-sugar`, `milk`. Water, salt and pepper are free and never offered as picks; the other five
   are also ordinary pickable bank entries (the operator named sugar as pickable). At most four
   non-seasoning staples per concept. Not staples: eggs (a protein that would let every basket become an
   omelette), garlic, onion, lemon, stock, soy, vinegar, cream, cheese. Reason: the operator's own list
   was "butter, salt, pepper, flour, a few things like that… nothing fancy".
7. **Coverage — Astra's rule:** every concept is asked to use all ten; each must use **≥ 7**; at least
   one must use **≥ 8**; the union of the three must cover all ten; omissions listed with reasons; the
   three concepts must differ in dish type/technique.
8. **ComfyUI prefix — reuse `wyr_`** (Kimi + Astra): the existing sweeper already owns it; a second
   prefix adds sweep risk for no user benefit. Each run still uses a fresh run id and cleans up
   (Inv 54).
9. **Idempotency:** `moveId` + exact `turn` + `offer` guards on skip/pick (Kimi's targeting), `clientId`
   on create, `moveId` on bank, state-idempotent retries. No global `expectedRev`.
10. **Abandonment:** starting a new Cookout abandons any open `picking` round (existing game precedent);
    the pane also has an **End game** action for the open round. A finished round is never abandoned.
11. **Menu:** one **Cookout** item that opens a small start sheet (Open / Blind), plus **Recipe book**.
12. **Bank size:** target ~3,000 genuine ingredients (validator 2,500–4,000), Kimi's compact taxonomy
    plus a role field for the draw, short blurb, family, rarity, category emoji; no dietary/allergen
    promises; validator checks role/category coverage and simulated maximum-skip draws.

## Next

Argon writes `spec/server-chat/09-cookout.md` from its round-2 Section A with these rulings applied;
Kimi and Astra then do a fresh review of that spec (critical/high defects only) before it is frozen and
parcelled.
