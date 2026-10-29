# Cookout — design panel brief (round 1, PROPOSE)

Workspace 00058 (wixy). Panel: Gemini 4 Argon, Kimi K3.1 Pro, GPT-6 Astra XL — chosen by the
operator. You are **one of three independent experts**. Do not try to guess, wait for, or defer to
the others: independence is the whole value. A later MERGE round will hand you all three proposals.

## The ask (operator, verbatim — the authority)

> I'd like a new game added to Wixie Chat. It's going to be a cooking game. We need a list of, like,
> whatever the most common ingredients are, but there's going to be a few thousand because, you know,
> you're going to go from everything from parsley to beef to all sorts of different spices to cream
> and whatever.
>
> And what the game will do is it will take turns with each person in the chat and it will give a
> choice between two ingredients so it will present me with two ingredients and I'll pick one and
> then it will present the other person with two ingredients they'll pick one and we'll both see what
> the other person is presented with and what they've picked as well. There should be a blind mode
> where you can't see what the other person is picking.
>
> Then at the end, let's say you've picked five ingredients each then it goes to AI to concoct a
> recipe from those five ingredients with a picture at the top of the cooked meal. It won't produce
> the recipe immediately; it'll just have a description and the picture. Then you can ask it to bank
> it if you want and it'll generate a recipe for it and instructions, and then bank it.
>
> But you should also be able to skip ingredients so you'll have the two options: if you say no,
> neither of those two options, and you'll get two options, two new options. And you can do that up
> to two times. So essentially, you're going to have three goes before you have to pick from one or
> the other.
>
> Everything in there. Toast, sugar, anything.
>
> Actually, have it come up with three different recipes using those ingredients. It doesn't have to
> use all the ingredients, but it should use most of them, and it should really try to use all the
> ingredients. And it's allowed to use a few extra staples that everyone has, like salt, pepper, but
> nothing fancy that other people don't have. You can't just suddenly throw mango in there if mango
> wasn't selected. That's not a staple that people keep around. So butter, salt, pepper, flour, a few
> things like that.
>
> [The panel] should be encouraged to dream up some fun ways to spice it up, if you pardon the pun,
> because it's a fun, silly game at the moment, but I'm sure there are ways to add twists to it.
> Maybe once you get your recipes, you could substitute one ingredient and regenerate the three, that
> sort of thing. Come up with some ideas. So they'll design it, how it's going to work, how it's
> going to be fun, any new ideas, and between them also put together an implementation plan.
>
> This is going to be called Cookout. Should work just like other games, available in the drop-down
> triple-dot menu, and will appear as the second tab, replacing any other game that's currently in
> the second tab. AI should generate images. We have a resident image generator on Hub. We'll use
> that, a local one.

## Context you must read in your checkout (this repo; you have a full copy)

The chat is the private two-person "Server chat" inside the wixy admin (Python FastAPI server +
strict-TS no-framework admin UI). Two games already exist and Cookout must be the third, built the
same way. Read, in this order:

1. `CLAUDE.md` (repo rules: strict typing, committed bundles, discreet release notes, never call the
   Anthropic API — all AI goes through cmd via `wixy_server/cmdchat.py`).
2. `spec/server-chat/08-adventure-time.md` — the most recent game spec. **Your design should be
   written to the same standard and shape** (flow/state machine, data, schema, wire, AI job, client
   pane, tests, docs).
3. `docs/ai/livechat.md` — the would-you-rather section (~line 1880–1960) and Adventure Time (§23);
   `docs/ai/invariants.md` Inv 54 and Inv 56.
4. Server precedents: `wixy_server/livechat/wyr_game.py`, `wyr_images.py` (**ComfyUI on hub =
   "the resident image generator"**, `ComfyImageGenerator`, Krea 2 Turbo, cleans up its own output —
   Inv 54; standalone edition = no images), `adventure_game.py`, `adventure_pack.py` (AI research via a
   hidden cmd chat-spawn run through `cmdchat.py`; prompt names only the place, never people or
   messages; defensive JSON parsing; restart-resume; retry), `store.py` (`_LATEST_SCHEMA_VERSION = 20`;
   rounds keyed by an anchor message, cascade on delete, explicit wipe).
5. Client precedents: `admin-ui/src/server/gameTabs.ts` (GameKey union; ONE game open at a time — the
   second tab is whichever game is open, so "replacing the second tab" is largely registering a new
   GameKey), `itemChat.ts` (shared per-item mini chat every game must reuse), `wyrGame.ts`,
   `admin-ui/src/server/adventure/*`, `panel.ts` (the ⋯ menu).
6. Data-bank precedents: `wixy_server/livechat/adventure_destinations.json` and its validator test.

## What to produce

One markdown file, written in your own checkout at `triad/cookout/round-1/<seat>.md` where `<seat>`
is `argon`, `kimi` or `astra`. It must contain:

### A. The core game design — a decided spec draft (`spec/server-chat/09-cookout.md` shape)

Everything the operator asked for, precisely, and implementable without further questions:

- Flow and state machine (round states, turn order, who goes first, picks per player — default 5 —
  skip budget (your reading of "up to two times… three goes": per turn or per game? argue it), what
  both players see, **blind mode** (when chosen, what is hidden from whom, whether and how it is
  revealed at the end), concurrency (two phones racing), abandonment, idempotent replays.
- How the two options per turn are drawn from the bank: randomness, avoiding repeats/duplicates
  within a round and across the pair, category balance (so it isn't eight spices), fairness, and how
  a skip draws fresh options. Server-authoritative (a client must not be able to see or pick an
  option it was not offered — and in blind mode must not be able to read the partner's).
- **The ingredient bank**: a few thousand everyday-to-exotic ingredients ("toast, sugar, anything").
  Exact JSON schema (ids, display name, category, any tags your draw or AI needs), size target, how it
  is generated and validated (no Anthropic API — a builder agent authors it as data and a validator
  test checks it), and **the staples list** the AI may add freely (salt, pepper, butter, flour, oil,
  water… — propose the exact list and whether staples can also appear as pickable ingredients).
- The AI recipe job: when it starts, the exact prompt contract (ingredient names only — no names of
  people, no chat content), output JSON schema for **three recipe concepts** (title, description, which
  picked ingredients each uses — "most, really try for all", staples used), validation/rejection
  rules (e.g. a concept using a non-staple, non-picked ingredient is invalid), model/effort, timeouts,
  failure + retry, standalone edition behaviour.
- Pictures: one per concept from ComfyUI (prompt built from the concept), timing relative to the
  text, failure → text-only, cleanup (Inv 54).
- **Bank**: the "bank it" action generates the full recipe (ingredients with quantities, method
  steps, timings, serves) — schema, job lifecycle — and where banked recipes are browsed (a recipe
  book screen like Adventure's Holiday bank?).
- Schema v21 (additive SQL), wire (routes + view JSON + errors), main-chat card, the pane layout
  (phone first, 360 px), ⋯ menu entries, tab behaviour, the per-item mini chat, live updates.
- Tests and docs lists, as in the Adventure spec §6–§7.

### B. Fun twists — dream big, it's a silly fun game

At least 6 ideas (the operator's example: after the recipes arrive, substitute one ingredient and
regenerate the three). For EACH: a one-line pitch in plain English the operator will read, why it is
fun, what it costs to build (S/M/L), and whether it fits cleanly on top of the core. **The core must
not depend on any twist** — each is an optional add-on the operator will accept or decline. Mark
your top 3.

### C. Implementation plan

Parcels sized for one builder each (data bank; server schema + state machine + routes + tests; AI
jobs + pictures; UI; docs/e2e), their dependencies and which can run in parallel, and the interface
contracts between them (so parallel builders don't collide). The UI parcel will be implemented by
Opus 5.5; server parcels by Sonnet 5.5.

### D. Pre-commitment (required, before you see anyone else's work)

Which of your own decisions you would drop first if a peer has something better, and which you will
defend hardest, and why.

### E. Open questions for the operator

Only genuine ones your design cannot settle sensibly itself.

## Rules

- **The brief is not evidence.** If a fact above does not match the code, say so and prefer the code.
- Read the code; cite files/functions you rely on. No hand-waving ("store it somewhere").
- Do not edit any repo file except your own `triad/cookout/round-1/<seat>.md`. Do not commit/push.
- When finished, send ONE short message to the orchestrator with the ABSOLUTE path of your file:
  `curl -s -X POST http://127.0.0.1:9321/sessions/fdf44e88-19e8-4279-8753-6549ec687527/send -H "Content-Type: application/json" -d "{\"text\": \"[[im]] kind=handoff re=cookout-triad-r1 tldr: <seat> proposal done: <absolute path>\"}"`
  then end your turn. Your final chat message should also state that path.
