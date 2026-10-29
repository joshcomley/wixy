# Cookout — Astra's independent proposal

Round 1 / PROPOSE. Seat: `astra`. This is a decided draft for panel comparison, not a claim that any of the proposed code exists. No other seat's proposal was read.

## A. Decided specification draft — `spec/server-chat/09-cookout.md`

### 0. Product and checked precedents

**Pick a ridiculous shopping basket together; discover three surprisingly plausible dinners; keep the ones you would actually cook.** Cookout is cooperative, with alternating individual decisions. Five picks **each** means one shared basket of ten ingredients, followed by **three concepts total**, not three recipes per person. This resolves the brief's earlier “those five ingredients” against its later five-each request without halving either person's contribution.

Start it from **Cookout** in the chat's ⋯ menu. The starter opens the Cookout pane; the other person gets the normal game offer. There are at most two bottom tabs: Chat and whichever game is open. Cookout does not end a WYR or Adventure round merely by replacing its tab. Every Cookout round has the existing shared mini chat. Recipe concepts have a picture above their description; quantities and instructions are generated only after **Bank this**. Each of the three can be banked independently.

The following are findings from this checkout, rather than assumptions from the brief:

| Source / identifier | Consequence for Cookout |
|---|---|
| `spec/server-chat/08-adventure-time.md` §§1–7; `livechat/store.py::_LATEST_SCHEMA_VERSION` | The current schema is **20**. Add v21, preserving existing migrations. Follow the anchor-message, state/view/job, pane, tests and docs structure. |
| `livechat/store.py::_SCHEMA_V20_ADVENTURE`, `_wipe`, `finish_adventure_pack` | Rounds and related private state cascade from an anchor; wipe explicitly clears them. Background completion is conditional, never an unconditional overwrite. |
| `livechat/wyr_game.py::wyr_view_json`, `_slot_of`; `store.py::_wyr_slot` | Hidden answers are filtered by the server, not hidden with CSS. WYR's typed-name fallback when an email is missing is **not sufficient** to promise Cookout's stronger “cannot read the partner's options” requirement. §1.3 addresses this explicitly. |
| `livechat/wyr_images.py::ComfyImageGenerator.generate_pair`, `_forget_run`, `sweep_leftovers`, `DEFAULT_IMAGE_MODEL` | The resident generator is ComfyUI, default `krea2-turbo-nvfp4`. Its existing public method generates **two**, not an arbitrary number of images. Extend it narrowly; do not pretend a three-image API already exists. |
| `livechat/wyr_game.py::generate_round_images`, `wyr_image_limiter`, `WyrDemand` | Reuse private attachment staging, the shared image limiter and demand priority over speculative WYR pool work. Cookout must not create another independent GPU queue. |
| `livechat/adventure_pack.py::CmdAdventureResearcher`, `AdventurePackRunner.resume/_start_run/_run`; `cmdchat.py::CmdChatClient.spawn_run/get_run/cancel_run` | Hidden subscription-backed cmd runs already exist. `spawn_run` deliberately does not retry an ambiguously completed HTTP submission. Reuse the transport, not its travel prompt or unrestricted restart assumptions. |
| `admin-ui/src/server/gameTabs.ts::createGameTabs`, `replaceOthers` | `GameKey` currently is `"wyr" | "adventure"`; adding `"cookout"` uses the actual one-game replacement behaviour. Some older comments/docs still illustrate multiple game tabs; executable code wins. |
| `admin-ui/src/server/itemChat.ts::createItemChat/createStrip/openPopup` | Use the shared strip and shared composer. There is no new Cookout chat implementation. |
| `admin-ui/src/server/thread.ts` menu construction, `gameLabelFor`, `openAdventureTrip`; `panel.ts` lock orchestration | The **menu is in `thread.ts`**, not `panel.ts` as the brief suggests. The latter remains the lock owner. Opening an old bank item must load its anchor/history, as Adventure does. |
| `adventure/{api,model,adventureGame,adventureCard,holidayBank}.ts`; `wyrGame.ts` | Follow defensive parsing, monotonic view revisions, session epochs, signed-picture renewal, full-height bank and game registration. |
| `adventure_destinations.json`; `tests/test_adventure_bank.py::test_committed_bank_is_valid_against_the_map` | Author a committed data bank; validate the actual committed bank offline in pytest, with malformed fixtures too. No runtime AI ingredient generation. |
| `docs/ai/livechat.md` §§19–20, 23; `docs/ai/invariants.md` Inv 40–43, 46–47, 54, 56 | No hidden content in broadcast summaries; no game-content persistence in the browser; deletion, wipe and locking must include the game. External cmd retention must be described honestly. |

Paths abbreviated `livechat/…` above are under `wixy_server/`.

### 1. Flow, turns, visibility and concurrency

#### 1.1 Start and round states

The start sheet has two controls: **Open / Blind** (Open default), and **Ingredients each: 3 / 5 / 7** (5 default). No persistent preference table is needed. The sheet explains “Two fresh pairs per turn if you don't like the first pair” and, in Blind, “Your baskets are revealed together after the last pick.” The choices are immutable after creation.

Round state and work state are deliberately separate:

```text
waiting --second player joins--> picking --last pick commits--> finished
waiting|picking --end round or explicitly replace--> abandoned

concept job: absent -> queued -> starting -> running -> ready|failed|unavailable
                                      failed|unavailable --Retry--> queued
image job:   created only with accepted concepts; independently ends ready|failed|unavailable
recipe job:  absent --Bank this on a concept--> queued -> ... -> ready|failed|unavailable
```

`finished` means the basket is complete, including while concepts are being prepared or have failed. It is not falsely reported as “recipes ready”. A new round never abandons a finished basket or cancels its requested recipes.

Creation claims player slot 1. A distinct player presses **Join** to claim slot 2; the start button is already the creator's consent to play. Joining allocates both players' fixed display names and chooses the first player with one server-side random coin toss, persisted once. Turns strictly alternate from that slot. Each player takes exactly N turns, so the default has ten turns. A player cannot pick or skip the partner's turn. A spectator can watch the appropriately redacted view and the shared chat but cannot join a full round or mutate its play.

There is no turn timer, automatic pick or timeout loss. Closing a tab, disconnecting or locking pauses the experience without ending the round. Either player can use **End round**, with one confirmation. Starting a new Cookout explicitly offers to end an unfinished Cookout; the request names the exact old round and revision. A competing start gets a conflict, rather than silently abandoning a round the client never saw. Old abandoned cards remain readable; their blind picks **remain hidden**. No AI job starts for an abandoned basket.

#### 1.2 Two skips **per turn**

“Up to two times … three goes before you have to pick” refers to the currently offered pair. Each turn begins at attempt 0 with two ingredients, offers **Neither — 2 refreshes left**, then attempt 1 with one refresh left, then attempt 2 with no refresh button. Picking advances the turn and resets the allowance to two. The maximum default game therefore exposes 60 ingredients, of which ten are selected. A round-wide allowance would punish the later player and does not fit “three goes” at each choice.

Every refresh discards **both** options and supplies two new options. It never changes player, role, or pick count. The unpicked member of an accepted pair is discarded too. The server commits the pair before returning it. Refreshing a page or replaying a GET never draws anything.

#### 1.3 Player binding: no name-switching loophole

Use a small **Cookout seat credential**, in addition to all existing Access and unlock checks. Do not use `sender`, `deviceId`, a requested slot number, or `?as=` as authority.

* Before creation/join, authenticated `POST /cookout/seat` with `{}` ensures a server-random 256-bit opaque cookie, returning 204. Repeating it with a well-formed existing cookie preserves that cookie. Cookie: `wx_cookout_seat`, HttpOnly, SameSite=Strict, Secure in production, host-only, `Path=/api/admin/server/cookout`, 30-day maximum age. The explicit local test/development configuration may use HTTP. No seat value appears in JSON, URLs, JavaScript storage or logs.
* A player row stores only `SHA-256(cookie)` and the verified `ServerAuth.email` when nonempty, plus a display name. The same cookie cannot fill both slots. Normalised display names must be distinct. If a row has an email, a request with that cookie under a different **or missing** email cannot occupy the row; there is no downgrade to typed-name matching.
* Once both slots have **distinct, nonempty verified emails**, that unique email also identifies its slot on another device. This is a server-derived rule, not a query parameter. Otherwise the seat cookie is required. Two people sharing an Access account can therefore still play Blind on separate browsers, without being able to switch slots by changing a name.
* On a shared account, losing the cookie loses that device's ability to resume its unrevealed seat. Do not provide a “choose whose seat you are” recovery bypass. The pair can end/restart the round. This is the narrow, honest cost of supporting a genuinely hidden pair without redesigning chat accounts.
* The cookie grants **no** chat access by itself. Every read and mutation still requires the current Access/unlock authorization; an expired grant or locked chat is refused as today. The cookie contains no game data and is only a binding credential. Wipe deletes every row that gives it meaning. No global player-account table or new PIN exists.

This is a game-integrity boundary between ordinary requests, not protection against someone who has access to the other person's browser or this trusted two-person chat's server. It does not rewrite WYR's existing identity model. The new cookie and recovery rule receive the security audit in §C.

#### 1.4 What each person sees

| Phase | Open mode | Blind mode |
|---|---|---|
| Waiting | Names/settings; Join | Same |
| Picking, your turn | Current pair, all accepted picks, previous public offer history | Current pair and **your own** offer/pick history; partner has count-only covered slots |
| Picking, partner's turn | Their actual pair, refresh count and accepted picks; controls disabled | “Their turn”, public progress and refresh count; `offer: null`; no option ids, names, categories, hints or discarded alternatives |
| Finished | Combined basket and all three concepts as they arrive | The final-pick transaction reveals **all selected ingredients together**; show a brief local uncover animation, then the same combined basket and concepts |
| Abandoned | Read-only visible basket/history | Your own history and count-only partner placeholders; no reveal-on-abandon loophole |

Blind completion reveals selected ingredients, not the partner's rejected alternatives. Publicly observable progress and the fact a refresh happened are intentional; blind mode hides ingredients, not activity. There is no extra two-player Reveal ceremony to delay cooking: joining explicitly accepts the final reveal.

One `cookout_view_json` serializer is the only exit for offers and picks. Filter **before serialization**, including mutation responses. `Message.cookout` and SSE contain only a public summary; never broadcast a personalised view. Return private GETs with `Cache-Control: no-store`; no shared ETag/body cache keyed only by round. The TS parser also refuses hidden partner fields on an unrevealed view. No offer details enter attachment metadata, errors, status badges, push text or logs. Mini-chat text remains normal shared chat; the game cannot stop someone deliberately typing a spoiler.

#### 1.5 Atomicity and replays

All mutation decisions run under the store's `BEGIN IMMEDIATE` write transaction; sample time **after** acquiring it. Validate membership, state, revision, current turn, exact offer id, remaining refresh budget, and membership of the selected ingredient in that stored pair. Choose the next pair within the same transaction. Append one `message_updated` event for a successful state change; publish the notifier only after commit. No transaction stays open during AI or GPU work.

Mutations carry a client-generated UUID `operationId` and `expectedRev`. Store an action receipt containing actor slot, action, canonical request hash and resulting revision, cascading with the round. Check a receipt **before** the revision check: replaying the same operation returns 200 and the **current, viewer-filtered view**, with no new draw, refresh charge, event or job. Reusing an id with a different action/payload is `409 idempotency_conflict`. An unrelated stale request is `409 stale_view`; the UI fetches the current view instead of retrying the intention against a new pair. A duplicate Bank from the other player is also a semantic no-op when that concept is already queued/running/ready.

Creation uses the existing message `clientId` dedupe plus a stored canonical creation hash. Replaying it must not abandon a newer round. A `clientId` already belonging to another message kind is a conflict, not that unrelated message returned as Cookout. Two phones picking, picking versus refreshing, joining, starting, retrying or banking race in one transaction: exactly one applicable transition wins. DB-backed receipts and conditional writes also hold across overlapping blue/green processes.

### 2. Ingredient bank, draw and staples

#### 2.1 Committed data

File: `wixy_server/livechat/cookout_ingredients.json`. Target **2,600 distinct culinary ingredients**, acceptance range 2,400–3,000 for launch. Everyday foods dominate the common tier; international and unusual edible ingredients provide variety. Include explicitly parsley, beef, cream, toast, sugar, broad spices, frozen/canned foods and sensible prepared ingredients such as tortillas and cooked rice. No brand padding, duplicated spelling variants, fake ingredients or thousands of trivial cut/colour combinations to hit the count. Meaningfully different forms can be separate entries with the same family.

Exact schema (unknown fields rejected):

```json
{
  "version": 1,
  "generated": "2026-10-28",
  "ingredients": [
    {
      "id": "toast",
      "name": "Toast",
      "aliases": ["Toasted bread"],
      "family": "bread",
      "category": "bread",
      "roles": ["base"],
      "familiarity": "everyday",
      "flavour": "either",
      "preparation": "ready",
      "note": "Already toasted bread; do not assume any spread."
    }
  ]
}
```

* `id`/`family`: ASCII `[a-z][a-z0-9]*(?:-[a-z0-9]+)*`, 1–64 characters. IDs are permanent and never reused; no semantic changes to an existing id. `name`: trimmed plain British-English text, 1–70 characters; `aliases`: 0–6 trimmed names of the same ingredient, each 1–70; `note`: 0–160 plain characters. No HTML, URLs, line breaks or control characters. Entries sorted by id.
* `category` enum: `vegetable|fruit|mushroom|grain|bread|pasta-noodle|pulse|meat|poultry|fish-seafood|egg|dairy|nut-seed|herb|spice|condiment|fat|sweetener|baking|prepared|drink`.
* `roles`: nonempty unique subset of `base|protein|produce|accent`. These are culinary roles, not a nutrition claim: potatoes can be base; beans protein; fruit produce; cream accent. `free` is a draw rule accepting any role, not a stored tag.
* `familiarity`: `everyday|occasional|adventurous`. `flavour`: `sweet|savoury|either`. `preparation`: `ready|cook|specified`; `specified` requires a nonempty note describing the purchased, food-grade form. Tags assist generation and validation, never guarantee dietary suitability.
* Families group alternatives that would otherwise feel like duplicate picks: toast/bread, tomato/cherry tomato, plain/wholemeal flour, fresh/dried parsley. Broad categories are **not** families: beef and chicken remain different families. Avoid transitive grouping that turns all fish or vegetables into one family.

A builder authors the data in bounded category batches, reviews normalised names/aliases and merges a single sorted file. No direct Anthropic call, no runtime shopping API, no copied proprietary recipe corpus. The static data validator, `tooling/cookout/validate_bank.py`, is stdlib-only and imported by `test_cookout_bank.py`, following the Adventure validator precedent. It checks schema, text limits, unique ids, normalised names/aliases, valid family references, role coverage, reasonable tier/category distributions, nonempty specified-form notes and all mandatory example ingredients. Normalised alias collisions must be resolved or explicitly encoded as one family without creating duplicate entries.

Check at least 100 distinct families eligible for each role and at least 30 everyday families in each; exercise maximum-refresh 3/5/7-pick fixtures with several simulated recent rounds. Include curated checks for edible commercial forms, no medicinal/non-food substances and no dangerous-to-prepare novelty entries. Schema validation cannot prove edibility or whether two names are synonyms: human/builder content review is a separate acceptance check. Do not claim count/schema checks establish culinary quality.

#### 2.2 Server-authoritative draw

Persist a shuffled **paired role schedule** when the second player joins. N=3 uses `[base, protein, produce]`; N=5 uses `[base, protein, produce, produce, accent]`; N=7 adds `[produce, free]` to the N=5 list. Shuffle the list once; each element supplies two successive turns, one per player. The coin-toss starter always takes the first turn of each pair. Thus both receive identical role opportunities and refresh allowances; at five each there are only two accent picks, so the draw cannot produce eight spices. The roles balance cooking structure without promising every basket is sensible.

For each pair, independently:

1. Eligible entries have the turn's role (or any role on `free`) and a family **never offered anywhere in this round**. This excludes selected, skipped and unchosen options on both sides. A pair always has two different families. An ingredient already offered cannot reappear even in another form.
2. Soft-exclude families offered in the three most recent other retained Cookout rounds. Derive this entirely from their offer rows. If a needed pool is too small, relax the oldest recent-round exclusion first; never relax this round's exclusions. A wipe/deletion naturally removes this memory. No everlasting “ingredients used” table and no ban on ingredients from banked recipes.
3. Draw one everyday option. Draw the second tier with weights everyday 50%, occasional 35%, adventurous 15%. If a tier has no candidate, renormalise across the available tiers; if everyday is empty, the first option also uses the remaining tiers. Within a tier choose an eligible category uniformly, then an eligible family uniformly, then one entry uniformly. This avoids a large spice or meat subsection dominating the game. Remove option one's family before drawing option two; randomise left/right with a fair coin.
4. Use `random.SystemRandom`/`secrets` in production; inject an RNG in tests. Store the complete offered pair snapshot and an unpredictable offer id. Do not send RNG state, a future deck, the global exclusion list or a guessable index into a secret sequence.
5. On refresh, keep the same role, exclude the discarded families immediately and draw again. If fewer than two eligible families remain, return `409 bank_exhausted` without charging a refresh or changing the existing pair. The committed bank checks make this exceptional; it is still a defined failure, not an infinite retry loop.

Persist the bank version/hash at round creation and snapshots of offered id, name, family, category and culinary tags. A deployment cannot change an already offered pair or a finished basket. Later turns may use the then-current validated, append-only bank; the creation hash is provenance, not a promise that it reconstructs every future random draw. Runtime does not need to ship the bank to the browser. Exact ten-ingredient baskets are not repeated intentionally, but there is no false promise of uniform sampling over all possible baskets: this is a deliberately balanced draw.

#### 2.3 Exact free staples

The complete free-staple vocabulary is **Water, Salt, Black pepper, Butter, Plain flour, Neutral cooking oil, Granulated sugar, White vinegar**. No stock, milk, cream, eggs, cheese, garlic, onions, herbs, soy sauce, wine, lemon or mango is implicitly available. No “optional garnish” loophole. A prepared selected ingredient can be used as purchased; selecting pesto does not separately make pine nuts, Parmesan or basil available elsewhere.

All staples except water may also be pickable bank entries. Selected staples count as selected ingredients if actually used. Water is never a pick: a universal cooking medium should not spend someone's turn. At most **four additional non-water staples** may be used per concept, excluding staples already selected. This is the meaning of “a few extras”. Show the extras explicitly on each concept and full recipe. The manifest maps free staples to permanent canonical ids, with distinct aliases resolved only on the server.

### 3. Concepts, pictures and banking

#### 3.1 The concept contract

The final pick creates the concepts job in the **same transaction** as `state = finished`. There is no AI call on individual picks, no AI selecting the offers and no AI reading the mini chat. The input is a sorted list of canonical **ingredient names** and their static culinary notes, plus the fixed staples vocabulary and fixed instructions. Sorting removes player attribution and pick order. Do not send names of people, emails, display names, device/seat identifiers, anchor/message ids, chat excerpts, blind/open mode, who skipped anything, or user-written prompts.

The pinned prompt in `cookout_ai.py::build_concepts_prompt` is:

> Invent three distinct, appetising dishes for two people using this basket. Try hard to use every selected ingredient in each dish. Each must use at least MIN_USED of the N selected ingredients; include every omission and a short culinary reason. At least MIN_SUBSTANTIAL selected ingredients must make a meaningful contribution as a base, main component or sauce, not a token garnish. Only the listed free staples may be added, at most four non-water staples not already selected. No unlisted ingredient, stock, sauce ingredient, garnish, optional addition or substitution is allowed. Prepared ingredients may be used as purchased; do not assume their constituents are separately available. Weird combinations are welcome; impossible or unsafe cooking instructions are not. Give three different dishes, not three names for the same one. Return only the specified JSON, in plain British English. Give concepts only: no quantities, method, timings, links, markdown or image URLs. Do not use tools.

Append `BASKET`, `CULINARY_NOTES`, `FREE_STAPLES`, `N`, `MIN_USED = ceil(0.8*N)`, `MIN_SUBSTANTIAL = ceil(0.6*N)` as canonical JSON data. For the default basket, every concept must use **at least 8 of 10**, with at least 6 substantial contributions. The target remains 10 of 10; the hard floor makes “most” testable rather than accepting a dish using three favourites. If a basket cannot produce three acceptable concepts, return a retryable failure; do not silently lower the threshold or add missing food.

Exact output shape; all fields required, unknown fields refused:

```text
{
  version: 1,
  concepts: [Concept, Concept, Concept]
}
Concept = {
  slot: 0 | 1 | 2,
  title: string[1..90],
  description: string[1..480],
  dishType: "bowl" | "traybake" | "stew" | "soup" | "salad" | "pie"
          | "pasta" | "rice" | "flatbread" | "sandwich" | "pancake"
          | "fritter" | "omelette" | "bake" | "dessert" | "platter",
  technique: "roast" | "bake" | "pan-fry" | "simmer" | "steam"
           | "grill" | "no-cook" | "mixed",
  uses: [{ ingredient: canonical_selected_name,
           role: "base" | "main" | "sauce" | "seasoning" | "garnish" }],
  omits: [{ ingredient: canonical_selected_name, reason: string[1..120] }],
  staples: [canonical_free_staple_name]
}
```

`uses` is unique and has MIN_USED..N members; `omits` is its exact complement in the basket, unique; no name belongs to both. `staples` lists only **additional** ingredients, excluding selected staples already in `uses`. A maximum of five entries includes water. Canonical name matching is exact after Unicode normalisation and casefolding; aliases are for authored bank checks and lexical auditing, not a licence for the model to introduce new products. The server resolves names to bank/staple ids when storing; the model never chooses identifiers. There must be slots 0, 1, 2 exactly once, distinct normalised titles, at least two dish types, and three distinct `(dishType, technique)` combinations.

Defensive parsing follows `adventure_pack.py::parse_pack` in accepting a fenced JSON answer, but validates the entire selected object **without silently dropping a broken concept or clipping an ingredient name**. Cap the response at 64 KiB UTF-8 and candidate JSON objects at 16; reject duplicate JSON keys, NaN/Infinity, booleans masquerading as numbers, invalid types, control characters and markup. Take the last top-level object; if it fails, do not resurrect an earlier partial answer. Store only canonical validated JSON, never raw reasoning or malformed output.

The ingredient restriction applies to prose as well as arrays. Run a deterministic scan for bank names/aliases outside the manifest (whole words, longest match first), then a separate, tool-free **manifest check** through cmd. Its food-only input is the basket/staples, proposed concepts and bounded lexical flags. The scan flags possible extra ingredients for semantic checking; it does not by itself reject a legitimate finished-dish name merely because the bank also contains a ready-made version of that dish. The checker distinguishes naming the output from adding a purchased ingredient. It returns exactly `{version:1, ok:boolean, violations:[{slot:0|1|2, code:"extra_ingredient"|"missing_use"|"token_use"|"duplicate_dish"|"unsafe_method", ingredient:string|null}]}`, at most 20 violations. Require `ok=true` and an empty list, in addition to the deterministic structural checks; malformed checker output is failure. Treat “serve with rice”, stock-based sauces and unselected mango as violations, including in descriptions. Do not “fix” an illegal ingredient by deleting its manifest entry while retaining its prose.

**Honest limit:** a whitelist of structured references is enforceable; understanding every possible food implied by free text is not a mathematical property of JSON validation. The independent check, adversarial fixtures and sampled culinary review address that residual risk. Do not advertise the dishes as medically checked, allergen-free or guaranteed safe. This qualification is for engineering acceptance, not an intrusive disclaimer in every game card.

One rejected candidate may be regenerated from the original food input plus bounded violation codes; never send raw response dumps or user content back as repair instructions. Validate and check the replacement exactly as strictly. No acceptable three-concept set after two candidates ends the job `failed`, with **Try again**. Concepts are published together atomically; the browser does not show one or two provisional dishes as the final three.

#### 3.2 Model, transport, time and recovery

Default fleet backend: `claude-sonnet-5-5`, effort `medium`, subscription bucket, through **`CmdChatClient` only**, following the concrete existing Adventure model choice. The checker uses the same model in a fresh independent run at low effort. No direct model API, cloud image service, browser search or plugin connection is introduced.

Use a hidden, unparented run (`spawned_by_session_id=""`, no tag, `build_space="primary"`) in an empty non-git `server/cookout-jobs/` directory. Start/get/cancel are the existing `cmdchat.py` calls. Extend the Adventure deny list with `WebSearch` and `WebFetch`; provisioning must confirm that the effective tool policy also excludes any enabled filesystem, shell, agent and connector tools. A “no tools” sentence alone is not a permission boundary. Do not place a job payload in a file in that directory.

* Provider timeout: **180 seconds** for a concept or full-recipe candidate, **120 seconds** for its manifest check. At most two candidates and two checks per user-requested job. A transport error is not an excuse for extra unbounded attempts. Poll every five seconds; reads may retry at the next poll, at most twelve consecutive read failures.
* Whole concepts/recipe job deadline: **900 seconds from enqueue**, persisted; includes capacity wait, spawns, checks and the single repair. A restart does not reset it. Deadline expiry cancels a known run and marks the job failed. The UI says “Thinking up three dishes…” / “Writing your recipe…” while pending, without a fabricated percentage or guaranteed ETA.
* At most two text runs in flight **per app process**, with Adventure and Cookout sharing one app-level cmd-run gate; serialize starts at least five seconds apart as the existing cmd transport precedent requires. The server parcel owns that wiring change. Persisted per-job leases prevent duplicate ownership of the same Cookout job across processes. During a blue/green overlap, different processes can temporarily run different jobs within their own limits; this is not a claim of a deployment-wide two-run semaphore. A stricter cross-process service-wide cap would be separate infrastructure work, not an undocumented property of `CapacityLimiter`.
* A job records `phase`, `candidate_json`, `run_id`, absolute deadline, claim token and lease. Claims and completions compare-and-set the same job epoch and claim token. Renew a 90-second lease every 20 seconds while waiting for cmd; work is outside DB transactions. A startup scan and one supervised 15-second sweep recover queued/expired jobs. Use `ContainedTaskGroup`, not a detached task whose exception disappears.
* With a recorded run id, a new owner resumes polling **that** run and phase. It may store the answer only if its claim still owns the current epoch. A worker that merely loses its lease must **not cancel** a run now owned by its successor. Delete/wipe or a superseded job epoch does make its former run unwanted; cancellation is best-effort and bounded.
* Record `starting` before the external POST. An interrupted/ambiguous submission with no recorded run id becomes `failed` with an internal `unknown_start` code, not automatic respawn. `CmdChatClient.spawn_run(connect_errors_only=True)` cannot provide exactly-once submission across a lost response. A deliberate Retry may spend another run; stale results cannot land, and an unknown orphan remains subject to cmd's own timeout. State this limit instead of claiming a local transaction makes an external POST atomic.
* The sweep finalises expired/dead jobs and publishes a revision even if an exception previously prevented failure reporting. Manual Retry creates a new epoch only for failed/unavailable work, and only when the relevant backend is configured. Identical/repeated requests while queued/running/ready do not start work again. Failed concepts retain the basket; failed recipes retain their concept; failed images retain all text.

**Standalone:** register the game and allow picking, reveal and browsing any existing local saved recipes. With no cmd-backed Cookout provider, the concept job becomes `unavailable` immediately: “Recipe ideas aren't available on this server.” No pretend canned result and no direct Anthropic fallback. No Comfy images in standalone. A text-capable fleet server without Comfy still produces and banks recipes. `create_app(cookout_ai=..., cookout_image_generator=..., cookout_timing=...)` supplies explicit fake seams; production defaults must respect edition/backend selection.

**Retention:** unlike Adventure's single static destination, the selected **combination** of ingredient names records part of this game. cmd retains those food-only prompts, candidate answers and checker runs, which this server's delete/wipe cannot erase. No identity or conversation is sent, but call time, basket and generated recipes can remain there. Document this as a new Cookout invariant/decision; do not misdescribe it as private transcription or inherit Adventure's “nothing beyond a static destination” wording. The user has requested AI processing; this proposal needs no additional permission loop, but the implementation's privacy documentation must be accurate.

#### 3.3 One generated picture per concept

Immediately after the three concepts commit, show their titles/descriptions and start a separate image job. Give every card a reserved picture area above the description; words and Bank controls never wait for pictures.

Add `ComfyImageGenerator.generate_many(prompts, out_dir, *, seeds)` accepting **1–3** prompts/seeds. Keep `generate_pair` as its backwards-compatible two-item wrapper. Build one graph with shared UNET/CLIP/VAE and independent chains `a`, `b`, `c`; return exactly the requested images or fail. Preserve the owned `wyr_` prefix so the existing prefix-aware cleanup covers new runs; do not mint a prefix the sweeper cannot recognise. Add explicit tests for three output nodes and for WYR's unchanged two-node behaviour.

The server, not the AI, builds each image prompt from the accepted title, description and manifest, plus: “A realistic photograph of the finished plated dish, natural kitchen light, close view, no people, text, packaging, extra food, unlisted garnish or side dishes.” Names of people and chat contents never reach Comfy. It is an illustration, not evidence of the recipe's result; a subtle “AI illustration” caption is sufficient.

Use the existing `wyr_image_limiter` and `WyrDemand` so live Cookout work outranks speculative pool filling. Do not use the WYR picture pool: a generated meal depends on this round's choices and is chat content. This limiter is currently in-process; the per-job DB lease prevents duplicate ownership of one batch across deployments, but do not falsely call the existing limiter a cross-process global GPU lock.

The image batch has a 600-second wall budget, covering the current 300-second generation budget plus bounded submission/download/cleanup. Renew the claim while the synchronous generator runs in its worker thread. Re-check round/job ownership before GPU work and before attachment commit. Stage under `server/cookout-tmp/<random>/`, then ordinary upload staging. Commit all three attachment records and the concept-to-attachment mapping together under the job's claim check. Attachment ordinals 0/1/2 correspond to concept slots. Ordinary media processing strips metadata and creates signed private thumb/full URLs. Count staged/attached bytes against the existing quota and free-space limits; the Gallery excludes Cookout images like WYR/Adventure.

Failures, quota shortage, unavailable Comfy or unsafe cleanup configuration finish the wait as text-only. No browser call to Comfy and no remote-image URL fallback. A successful batch may have individual photo-processing failures; render those cards text-only while retaining the other ready pictures. A bounded **Retry pictures** can regenerate a failed batch; it must journal/remove replaced uploads and attachments, never accumulate hidden copies. It is disabled when no generator is configured.

Every exit runs the existing `_forget_run` policy: delete this submission's history and output files, cancel abandoned work, clean unattached staging and release demand/limiter. Extend startup/periodic scratch cleanup to `cookout-tmp` with the same conservative 900-second stale threshold, respecting young files from an overlapping process. The generator's startup/ten-minute orphan sweep still covers its owned prefixes. Delete/wipe cancels known work and uses the normal erasure journal; a late completion cannot resurrect a deleted anchor. Comfy output unlinking has Inv 54's existing forensic limit; do not promise secure erasure of those transient external files.

#### 3.4 Bank this → a full recipe → Recipe book

Either player can bank any or all three accepted concepts, as soon as text is ready. No partner vote is required. The action records a save intent and starts one recipe job for that concept. The card changes to **Writing recipe…**; only an accepted full recipe makes it **Banked ✓**. It reuses the original concept image, including one that arrives later. A failure says “Couldn't finish this recipe — Try again”; it never silently banks a title with no method.

The recipe prompt receives only the accepted **food concept**, its exact used-ingredient manifest and permitted staples, with serves fixed to **2**. Its instructions require quantities, a workable method and timings, preserve the dish's identity, use every ingredient declared by the concept, and add no new food. The full recipe may add water if necessary; otherwise its additions must be a subset of that concept's extra staples. Neither unused picked ingredients nor an unselected garnish may quietly enter at this stage. The same deterministic and independent manifest checks apply, with one repair at most.

Exact output schema:

```text
{
  version: 1,
  title: string[1..90],                       // must equal the accepted concept title
  description: string[1..480],
  serves: 2,
  prepMinutes: integer[0..180],
  cookMinutes: integer[0..360],
  restMinutes: integer[0..360],
  totalMinutes: integer[1..720],
  ingredients: [{
    name: canonical_manifest_name,
    amount: finite_number(0..5000],
    unit: "g"|"ml"|"tsp"|"tbsp"|"pinch"|"piece",
    preparation: string[0..100]
  }],                                        // 1..24 unique entries
  steps: [{
    text: string[1..600],
    ingredients: [canonical_manifest_name],
    minutes: integer[0..360],
    ovenC: integer[50..300] | null
  }]                                         // 2..16 ordered steps
}
```

Require `totalMinutes = prepMinutes + cookMinutes + restMinutes` for this deliberately sequential recipe format; the model must resolve overlapping work into that simple schedule. `piece` amounts are integers; all amounts positive; reject nonfinite values/booleans. Ingredient names are unique and equal the concept's used picks plus the staples actually needed. Every listed ingredient appears in at least one step's references; every referenced ingredient is listed. Steps may have no ingredient references for preheating. Check the free prose too, including preparation text. No optional-ingredients field, alternative recipe, external links, HTML or dietary guarantees. Repeated full-recipe responses cannot change a previously banked recipe.

The **Recipe book** is a full-height screen under the ordinary chat header, like `holidayBank.ts`. Show banked recipes newest first with picture, title, total time and “Serves 2”; a small separate “Being saved” area can show this round's pending/failed save intents, labelled accurately. Tapping a banked entry opens the Cookout tab at that concept's full recipe, with the shared round mini chat. The ingredients list and numbered method scroll; the original concept remains available. No independent recipe-comment system.

Banking is a saved view of data owned by the original anchor, **not an external export**. Deleting the anchor removes its saved recipes and pictures; a wipe removes the entire book. Removing an individual mini-chat message follows the existing association cascade; deleting the anchor removes the associations but leaves those ordinary chat messages in the main thread, matching Inv 54. There is no separate book copy that survives erasure. Exporting, shopping lists and standalone recipe-account storage are later features, not hidden core work.

### 4. Server storage and wire

#### 4.1 Additive schema v21

Add `_SCHEMA_V21_COOKOUT`, run it after v20 and set `_LATEST_SCHEMA_VERSION = 21`; never rewrite v20. The schema below is the contract, with Python typed row models and canonical JSON validators supplying the cross-row/domain checks described above. All timestamps are UTC epoch seconds; revisions/epochs are positive integers; JavaScript-visible identifiers stay within the existing safe-integer bound.

```sql
CREATE TABLE IF NOT EXISTS cookout_rounds (
  anchor_message_seq INTEGER PRIMARY KEY REFERENCES messages(seq) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('waiting','picking','finished','abandoned')),
  blind INTEGER NOT NULL CHECK(blind IN (0,1)),
  picks_per_player INTEGER NOT NULL CHECK(picks_per_player IN (3,5,7)),
  first_slot INTEGER CHECK(first_slot IN (1,2)),
  next_turn INTEGER NOT NULL DEFAULT 0 CHECK(next_turn BETWEEN 0 AND 14),
  role_schedule_json TEXT NOT NULL DEFAULT '[]',
  bank_version INTEGER NOT NULL,
  bank_sha256 TEXT NOT NULL,
  create_request_hash TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1 CHECK(rev > 0),
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  CHECK(state != 'finished' OR next_turn = 2 * picks_per_player)
);
CREATE INDEX IF NOT EXISTS idx_cookout_rounds_state ON cookout_rounds(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cookout_one_open
  ON cookout_rounds((1)) WHERE state IN ('waiting','picking');

CREATE TABLE IF NOT EXISTS cookout_players (
  anchor_seq INTEGER NOT NULL REFERENCES cookout_rounds(anchor_message_seq) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK(slot IN (1,2)),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  email TEXT,
  seat_hash TEXT NOT NULL,
  PRIMARY KEY(anchor_seq,slot),
  UNIQUE(anchor_seq,name_key),
  UNIQUE(anchor_seq,seat_hash)
);

CREATE TABLE IF NOT EXISTS cookout_offers (
  anchor_seq INTEGER NOT NULL REFERENCES cookout_rounds(anchor_message_seq) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL CHECK(turn_index BETWEEN 0 AND 13),
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 2),
  player_slot INTEGER NOT NULL CHECK(player_slot IN (1,2)),
  offer_id TEXT NOT NULL UNIQUE,
  pair_json TEXT NOT NULL,
  chosen_id TEXT,
  PRIMARY KEY(anchor_seq,turn_index,attempt),
  FOREIGN KEY(anchor_seq,player_slot) REFERENCES cookout_players(anchor_seq,slot) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cookout_one_pick_per_turn
  ON cookout_offers(anchor_seq,turn_index) WHERE chosen_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cookout_concepts (
  anchor_seq INTEGER NOT NULL REFERENCES cookout_rounds(anchor_message_seq) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 2),
  concept_json TEXT NOT NULL,
  image_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  recipe_json TEXT,
  bank_requested_at REAL,
  banked_at REAL,
  PRIMARY KEY(anchor_seq,slot),
  CHECK(banked_at IS NULL OR recipe_json IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_cookout_book
  ON cookout_concepts(banked_at DESC,anchor_seq DESC,slot)
  WHERE banked_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS cookout_jobs (
  anchor_seq INTEGER NOT NULL REFERENCES cookout_rounds(anchor_message_seq) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('concepts','images','recipe')),
  slot INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','starting','running','ready','failed','unavailable')),
  phase TEXT NOT NULL CHECK(phase IN ('generate','verify')),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch > 0),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 2),
  input_hash TEXT NOT NULL,
  run_id TEXT,
  candidate_json TEXT,
  claim_token TEXT,
  lease_until REAL,
  phase_started_at REAL,
  deadline_at REAL NOT NULL,
  error_code TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  PRIMARY KEY(anchor_seq,kind,slot),
  CHECK((kind IN ('concepts','images') AND slot = -1)
     OR (kind = 'recipe' AND slot BETWEEN 0 AND 2))
);
CREATE INDEX IF NOT EXISTS idx_cookout_jobs_due ON cookout_jobs(state,lease_until);

CREATE TABLE IF NOT EXISTS cookout_actions (
  anchor_seq INTEGER NOT NULL REFERENCES cookout_rounds(anchor_message_seq) ON DELETE CASCADE,
  actor_slot INTEGER NOT NULL CHECK(actor_slot IN (1,2)),
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  applied_rev INTEGER NOT NULL,
  PRIMARY KEY(anchor_seq,actor_slot,operation_id),
  FOREIGN KEY(anchor_seq,actor_slot) REFERENCES cookout_players(anchor_seq,slot) ON DELETE CASCADE
);
```

`pair_json` stores exactly two immutable ingredient snapshots (§2); `chosen_id` must belong to that pair. The partial index permits only one accepted offer per turn. An active turn is `next_turn`, with its highest attempt. No round-wide chosen-list copy: derive accepted picks from these rows. The role schedule has exactly N allowed entries after joining, and player/turn indices must match the round's configured count. Freeze and validate these conditions in the store, not just the HTTP layer.

`concept_json` is the accepted concept with canonical ids and resolved display-name snapshots. `recipe_json` is the accepted full recipe with the same name/id resolution. For recipe jobs, a matching concept must exist before enqueue; for concepts/images `slot=-1` is a job key, never a recipe identifier exposed as a concept. The image job uses only `phase=generate`. During verification, `candidate_json` holds the locally validated food candidate, not the raw provider transcript; clear it on completion/final failure. Store safe error **codes**, not vendor exception text. A pending job's `input_hash` identifies the immutable basket/concept snapshot; completion checks it as well as epoch/claim.

Heartbeats and internal run-id recording do not spam `message_updated`; visible state/result changes bump the anchor's `rev` and append one event in the same transaction. Completing the concepts job creates all three concept rows and the image job atomically. Completing a recipe sets both `recipe_json` and `banked_at` atomically. Once banked, neither duplicate banking nor a stale worker edits it.

Extend these existing surfaces as part of the same server parcel:

* `models.py` message/row serializers and `_MESSAGE_SELECT`-style read joins: `Message.cookout` and `wyrRefKind="cookout"`, including correct type for anchors outside the current history page. Keep summaries public.
* `LiveChatStore.create_message(..., wyr_anchor_seq=...)` accepts a Cookout round as a generic item-chat anchor, alongside WYR/Adventure. Retain wire names `wyrSeq` and `wyrRef`; no cached-client-breaking rename.
* `_wipe` explicitly deletes Cookout actions, jobs, concepts, offers, players and rounds (child-first), while anchor FKs also ensure an old process's message delete/wipe removes all Cookout rows. All snapshot, receipt, job and book data are chat content. No dated side ledger survives deletion.
* Existing delete/wipe erasure journals and WAL scrub paths stay the authority. New media staging is registered for cleanup if a transaction loses its claim. On delete/wipe, capture known run ids before removing rows for best-effort cancellation; cancellation failure cannot block erasure or revive data.
* `finish_attachment` must bump the owning Cookout anchor revision/event so the signed-image view updates when processing finishes. Gallery queries exclude Cookout anchors. Reads obtain round, concepts and attachments in one read transaction for a consistent view.

#### 4.2 Routes and request envelopes

All paths below are under `/api/admin/server`. Every route, including seat/bootstrap, current-round and Recipe book, calls `require_server_token` behind the normal Access gate. No chat token in a query string. There is no Cookout-specific public route and no arbitrary sender-selected viewer.

Define `Move = {operationId: UUID, expectedRev: positive_safe_integer}`. Creation/join `sender` is a validated 1–32-character display label, using existing sender validation and `reactor_key` normalisation; it is not identity. JSON request bodies are bounded, reject unknown fields, and never echo submitted credential values in errors.

| Method / path | Body / query | Success |
|---|---|---|
| POST `/cookout/seat` | `{}` | 204; ensure the HttpOnly seat cookie (§1.3) |
| GET `/cookout/current` | none | `{seq: number|null, rev: number|null}` for the one unfinished round |
| POST `/cookout` | `{clientId, deviceId, sender, blind, picksPerPlayer, replace: {seq,rev}|null}` | 201 `{message, view}`; exact clientId replay 200. Replacement requires the exact existing open round/revision. |
| GET `/cookout/book` | `limit=1..50` default 30, optional opaque validated cursor | `{recipes:[BookEntry], saving:[SavingEntry], nextCursor:string|null}` |
| GET `/cookout/{seq}` | none | `CookoutView` filtered by authenticated seat |
| POST `/cookout/{seq}/join` | `Move + {sender}` | 200 view; same player's rejoin is a no-op; a second distinct player begins play |
| POST `/cookout/{seq}/pick` | `Move + {turnIndex, offerId, ingredientId}` | 200 view; last pick also enqueues concepts |
| POST `/cookout/{seq}/skip` | `Move + {turnIndex, offerId}` | 200 view with a new pair only for permitted viewers |
| POST `/cookout/{seq}/abandon` | `Move` | 200 view; finished rounds cannot be abandoned |
| POST `/cookout/{seq}/concepts/{slot}/bank` | `Move` | 202 view when newly queued; 200 when already requested/ready |
| POST `/cookout/{seq}/jobs/{kind}/{slot}/retry` | `Move` | 202 view for new epoch; same-op replay 200; validated kind/slot combinations only |

Register static `seat`, `current`, `book` routes before `/{seq}`. A book cursor is a validated encoding of `(banked_at, anchor_seq, slot)`, ordered newest time/seq then ascending slot; it is not an authorization token. List only banked records in `recipes`; `saving` is separately capped at 20 most recent requested-but-unbanked concepts, with its pending/failed status. Never lose a banked item because its anchor is absent from the current UI history page. Book entries include `{seq, slot, title, totalMinutes, serves:2, bankedAt, picture}`; saving entries `{seq, slot, title, job}`. Both are derived from the live anchor/concept rows and return signed URLs only.

Errors use the existing `{error, ...bounded metadata}` style:

* 401 `locked` / 403 Access denial retain existing meanings; `403 not_player` for unauthorized play/bank/retry, without naming the rightful email or credential.
* 404 `not_found` for missing/deleted round or missing concept; no automatic creation on a retry.
* 409 `round_open`, `round_full`, `seat_required`, `seat_conflict`, `wrong_turn`, `stale_view`, `stale_offer`, `skip_limit`, `bad_state`, `bank_exhausted`, `idempotency_conflict`, `unavailable` as applicable. Conflicts may return `rev`, never the competing private move. No increment or random draw on rejected requests.
* 422 `invalid` for body bounds, unknown fields or choosing an ingredient outside the identified offered pair. Do not distinguish guesses about hidden options with detailed errors; authenticate/authorize the player before offer validation.
* 429 `rate_limited` plus `Retry-After` for the existing authenticated mutation limiter, with an additional three-starts/retries-per-minute per seat limit on **new AI work**; no charge for idempotent replays. This is a load guard, not a replacement for DB idempotency.

#### 4.3 Exact public and personalised views

`Message.cookout` is `{state, rev, blind, picked, total, concepts: JobState|"none", bankedCount} | null`. No options, selected ids, job ids, actor credentials, recipe text or hidden fingerprints. The main stream uses existing `message_updated`, not a new stored event or live gesture channel. History, SSE, resync and mutation responses must agree on that summary.

```text
CookoutView = {
  seq, rev, serverNow,
  state: "waiting"|"picking"|"finished"|"abandoned",
  blind: boolean,
  picksPerPlayer: 3|5|7,
  revealed: boolean,                         // !blind OR state == finished
  you: 1|2|null,
  players: [{slot:1|2, name:string, picked:integer}],
  turn: {index:integer, of:integer, player:1|2, attempt:0|1|2}|null,
  offer: {id:string, role:Role,
          options:[IngredientView,IngredientView], skipsLeft:0|1|2}|null,
  picks: [{turnIndex:integer, player:1|2,
           ingredient:IngredientView|null}],
  history: [{turnIndex:integer, attempt:0|1|2, player:1|2,
             options:[IngredientView,IngredientView], chosenId:string|null}],
  conceptsJob: JobView,
  imagesJob: JobView,
  concepts: [ConceptView],                    // [] until the accepted triple exists
  actions: {join, pick, skip, abandon, retryConcepts, retryImages}: booleans
}
IngredientView = {id:string, name:string, category:Category}
Role = "base"|"protein"|"produce"|"accent"|"free"
JobState = "queued"|"starting"|"running"|"ready"|"failed"|"unavailable"
JobView = {state:JobState|"none", error:string|null, canRetry:boolean}
ConceptView = {
  slot:0|1|2, title, description, dishType, technique,
  used:[{ingredient:IngredientView, role:string}],
  omitted:[{ingredient:IngredientView, reason:string}],
  staples:[{id:string, name:string}],
  picture:{state:"pending"|"ready"|"failed"|"unavailable",
           thumbUrl:string|null, fullUrl:string|null},
  recipeJob:JobView, recipe:RecipeView|null, bankedAt:number|null,
  canBank:boolean
}
```

`RecipeView` is §3.4's validated schema with canonical ingredient ids added alongside each name and step references resolved to ids. `history` is all offers in Open mode; in Blind it is **the viewer's own offers only, even after completion**. Non-player viewers get no history in Blind. `picks` retains public turn/slot/count but uses `ingredient:null` wherever the view must hide it; a hidden pick's id is not present elsewhere. In Blind a nonacting viewer gets `offer:null`, including no offer id/role. Before both join, `turn`/`offer` are null; after play ends they are null too. `revealed` does not expose blind abandoned picks.

`picture.state` is pending while generation is queued/running or its attached photo is processing, ready only when both signed renditions are available, unavailable with no configured generator, otherwise failed. Store attachment ids, never expiring signed URLs. `JobView.error` comes from a short allowlisted UI message; no provider responses. Actions are conveniences derived from the same server rules, never authorization supplied back by the client.

### 5. Client: 360 px first, ordinary chat behaviour

Modules: `admin-ui/src/server/cookout/{api,model,cookoutGame,cookoutCard,recipeBook,recipeView}.ts`, plus narrow integration in `api/messages.ts`, `gameTabs.ts`, `thread.ts` and styles. No framework, CDN, new composer, client-side bank or separate global app state.

* **Menu:** Cookout — “Pick ingredients, discover dinner”; Recipe book — “Dishes you've saved”. Place after the existing games/banks. Opening the start sheet is not creating a round. The pane header is `[Cookout   Book   New   ×]`; settings are in the start sheet, avoiding a crowded phone toolbar.
* **During picking:** a clear “Your turn — pick 3 of 5” / “Alex's turn” line; two large vertically stacked ingredient buttons, at least 48 px high, with simple category symbols and readable names. Both fit above a visible refresh action without a horizontal swipe requirement. Open mode shows which pair the partner is considering; Blind shows two covered tiles with no hidden content in attributes, alt text or offscreen DOM. A compact basket area shows your/their progress, with selected chips or covered chips. Ingredient animations are optional decoration, under 300 ms and skipped for reduced motion.
* **Finished:** reveal the shared basket once locally; the event itself is already committed. The scroll area contains exactly three concept cards, each picture-first, title, description, “Uses 8/10”, expandable used/omitted/extra-staple chips, and Bank. No method hidden in initial HTML and no full-recipe request merely because a card was opened. A 16:9 reserved picture area avoids layout jumps. Text-only cards remain attractive and fully usable.
* **Full recipe:** its existing picture, title, serves/time, ingredient checklist and numbered method. Checklist ticks are ephemeral view state, reset on lock/close; no persistence feature sneaked into v1. Back returns to the three concepts; the bank's opening position selects the requested slot. Book lives under the chat header so panic and gestures stay reachable.
* **Shared frame:** extend `GameKey`, register `cookout` through `createGameTabs`; `open` for the starter/card/book tap, `offer` for a partner's new game. Preserve `replaceOthers`, dots, dismissal and Chat-only bar hiding. Switching tabs closes/reset panes as today and never abandons the server round.
* **Shared item chat:** `itemChat.createStrip({popupTitle:"Cookout chat"})` and its fixed 60 px strip above the ONE shared composer; sends use `gameTabs.chatTarget()` → `wyrSeq`; `gameLabelFor` recognises `wyrRefKind="cookout"`. All three recipes belong to the round's one mini chat. No copying `itemChat.ts` into Cookout.
* **Live data:** summary revisions trigger a viewer-authorized fetch, following `createAdventureModel`. Responses apply only within the current session/seat epoch and never replace a newer revision. Retrying a stale read uses the existing 2/5/15/30-second ladder, not a hot loop. A click may show a pending highlight, but never optimistically increments a turn or reveals a partner's pick. An uncertain mutation reuses its operation id. On 409, discard the old intention, fetch, and show the winning state.
* **Locking:** pending AI, pictures, waiting for the partner and reveal decoration do **not** suspend idle lock or count as activity. On lock/wipe/detach reset models, remove private DOM and images, close the book/popups, cancel timers/fetches, and invalidate continuation epochs. An HTTP response arriving after lock cannot remount content. Token renewal refetches signed image URLs. Escape remains the panic key; controls carry `data-srv-gesture-boundary`.
* **Accessibility:** real buttons and headings, keyboard-selectable options, `aria-live=polite` for turn/status changes, focus moves to the new turn heading after a successful pick, labels beyond colour alone, reduced-motion support and no automatic audio. At 360×640 and 200% text, the content area scrolls while the mini chat/composer/tab frame remains reachable. No control relies on hover, a fast tap or a gesture without a button alternative.

The main-chat card is deliberately compact: Cookout / Blind Cookout, two progress counts, a short job status, and Open. Once concepts are ready it can show the first available concept picture and “3 ideas · N banked”; it does not dump three recipes into the thread. Opening an old Recipe book entry uses the existing history-loading pattern before `exists(seq)` can close its tab. Book refreshes are debounced on relevant message updates/deletions, matching `holidayBank.ts`.

### 6. Tests and local proof

Use a fake cmd and fake Comfy transport for the normal edit → run → inspect loop. No live inference or GPU is needed to test state correctness. A small local browser harness with fixed round fixtures covers every screen before server integration, following the existing Adventure harness approach. The final acceptance includes a bounded real text/Comfy smoke run, clearly separate from offline test success.

**Python, with the repo's fixed `-n 4` cap:**

* `test_cookout_bank.py`: actual committed bank size/schema/mandatory examples, negative fixtures for duplicate aliases/families, control characters, fake tags and missing coverage; every staple maps correctly; no runtime/network dependency. A documented content-review sample includes ordinary, international, prepared and unusual ingredients.
* `test_livechat_cookout_draw.py`: fixed-seed reproducibility through the injected RNG; strict alternating schedule and equal role budgets at 3/5/7; distinct families in each pair and across **all offered** items; fresh refreshes; no reset on reads; tier/category/family selection on deliberately unequal fixtures; recent-round relaxation and deletion; exhaustion never changes the current pair or consumes a refresh. Use deterministic trials and generous predeclared distribution bounds, not a flaky random-statistics gate.
* `test_livechat_cookout.py`: a **real v20 database** upgrades additively to v21 with existing WYR/Adventure data intact; every state transition, player limit, strict turn, default/short/long round, all three attempts, final reveal, open-round replacement and non-abandonment of completed baskets. Duplicate creation/moves/join/bank/retry, payload-changing replays, races across two store instances, old-offer selection, pick-versus-refresh and last-pick exactly-one enqueue. Validate the unique open-round/pick indexes and transaction rollback on draw failure.
* `test_routes_livechat_cookout.py`: existing Access/unlock gates on **every** route; seat-cookie flags and hash-only storage; same-email two-browser play; different-email rebind; missing/different email cannot downgrade a bound seat; two browsers claiming one display name; same browser cannot take both slots. Wrong `sender`, `deviceId`, `?as=partner`, guessed slot/offer/ingredient, reordered duplicate requests and unknown fields cannot bypass ownership. Rate limits exclude replays. Correct 200/201/202 and bounded error envelopes.
* `test_livechat_cookout_privacy.py`: sentinel partner offers/picks absent from all pre-reveal HTTP bodies, mutations, history, SSE, logs and card summaries; the acting player receives only their own current pair in Blind; nonplayers see counts; only selected partner ingredients appear after completion; abandoned Blind never reveals. Serializer and route assertions, not merely hidden DOM checks. No cookie/email/run id in a view. Delete and wipe remove snapshots, candidates, concepts, banked recipes and receipts, with raw DB/WAL erasure assertions through existing scrub routes. Cascade via a connection that does not import the Cookout store. Item-chat messages survive anchor deletion with associations removed, as specified.
* `test_livechat_cookout_ai.py`: exact prompt vocabulary/input allowlist; names, emails, message bodies and selection order cannot enter the prompt. Three-concept schema, 8/10 floor, substantial-use roles, selected staples, omissions, free-staple count, prepared-ingredient rule, distinctness, malformed/oversized/duplicate-key JSON, unknown ingredients and an ingredient smuggled only into prose. Full recipe quantity/unit/time/reference checks; a recipe cannot silently change the concept. Checker failure/malformed output and one-repair limit. Fake cmd verifies caller, model/effort, hidden/unparented flags, timeout and tool restrictions.
* `test_livechat_cookout_jobs.py`: queued, starting, running, verification and each terminal status; capacity wait deadline, ordinary failure, timeout, unavailable edition/backend, retry epochs, known-run restart, unknown-start failure, persisted phase/candidate recovery, renewable leases, two processes attempting claim/finish, lost ownership without cancelling the successor, deletion while starting/running/finishing, failure-report exception recovered by sweep, shutdown and late result refusal. No job remains pending indefinitely and no full recipe appears before Bank.
* `test_livechat_cookout_images.py`: one graph with three exact prompts/seeds/outputs; unchanged pair wrapper; default Krea selection; shared demand/gate; no GPU after deletion/lost claim; directory mismatch fail-closed; every success/failure/cancel removes owned output/history/staging; orphan sweep preserves unrelated/young files and cleans the third chain. Atomic three-attachment mapping, quota failure, processing failure, signed URLs, Gallery exclusion, token renewal, deleted anchor and retry cleanup. Existing WYR image/pool suites must remain green.

**Vitest:** defensive API parsers and hidden-field refusal; no view/seat mixing; monotonic revisions and bounded refetch; stale request/session epoch discarded; turn and refresh controls in each state; blind placeholders with no secret attributes; exact three concepts without quantities/method; Bank pending/failed/ready; image/text-only states; Recipe book/old anchor loading; cookie bootstrap uses credentials with no JS-stored secret; shared tab replacement, item chat and game labels; reduced motion, keyboard flow, layout structure and lock teardown. Keep WYR/Adventure/gameTabs/itemChat regression tests unchanged except intentional union/fixture extensions.

**E2E `e2e/tests/server-cookout.spec.ts`:** two separate browser contexts, ordinary and same-email identity fixtures; create, join, default ten alternating picks, both refreshes and forced third pair, watcher view, blind network redaction and simultaneous final reveal; wrong-turn and stale-phone race; three delayed concepts then delayed pictures; bank one and then another, no full recipe before Bank, full recipe arrival and retry; Recipe book reopening an anchor older than loaded history; shared mini-chat send/pop-up; WYR → Cookout → Adventure tab replacement; 360 px portrait and 200% text; Escape/idle/route-away during pending work; delete/wipe while jobs finish; refresh/resume. Fake cmd/Comfy make these deterministic.

**Acceptance evidence, kept distinct:** (1) state/privacy/erase tests pass; (2) generation actually returns three accepted concepts for a small fixed set of awkward baskets; (3) a real local Comfy run produces three usable meal illustrations and leaves no owned history/output after completion; (4) two phones render and play correctly. Offline fakes prove contracts, not recipe quality or measured GPU latency. Record observed durations from the smoke run; do not turn WYR's two-image timings into a three-image performance promise.

### 7. Documentation and delivery requirements

The implementation updates, in the same change: the promoted `spec/server-chat/09-cookout.md`; `docs/ai/livechat.md` new Cookout section and generic game frame; `contracts.md` routes, exact envelopes, cookies, public summary and `wyrRefKind`; `invariants.md` a new **Inv 57 if still free** covering blind filtering, seat binding, erasure, book ownership and cmd retention; `glossary.md` round/job states and Bank semantics; `testing.md`; `runbook.md` backend/Comfy unavailable behaviour, job recovery and cleanup; `CLAUDE.md` schema/store and module pointers; one `decisions/` entry recording these choices and the verified menu/tab/generator differences. Use the existing doc-rules workflow before committing the public surface change.

Python is fully typed under strict mypy; TS follows the repo's strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes settings. Keep assets self-hosted. Build and commit the admin bundle and maps after ensuring LF source files; do not modify editor output without an editor change. All eventual commits touching this feature use exactly:

```text
Release-note: General bug fixes and improvements.
```

No authoring in the Slots deployment target. Prove a local candidate first, then the required senior security/concurrency/schema/background-work audit, followed by the single final PR/CI/merge sequence. A final-gate defect returns to the local loop. This proposal does not itself authorize or perform a deployment.

## B. Optional fun twists

All are independent additions for the operator to accept or decline. The core above works with none. S means a small extension within existing contracts; M means a new stored interaction or bounded AI variation; L means a substantial new mode. Costs include state/tests, not just a button.

| Idea and operator-facing pitch | Why it is fun | Cost | Fit and guardrails |
|---|---|---|---|
| **TOP 1 — One rescue swap.** “Love the idea, hate the beetroot? Swap one ingredient and let the chef try again.” | Turns an unlucky basket into a shared rescue decision and gives the three reveals a second act. | M | After concepts arrive, one player proposes one replacement from a fresh server-offered pair; the other accepts before regeneration. Once per round. Requires an immutable concept-generation axis in a later schema so earlier banked recipes stay attached to their original basket/image; no overwriting a saved recipe. The core does not prebuild this versioning. |
| **TOP 2 — Dinner vote.** “Pick the dish you would actually eat, then see if you agree.” | A satisfying shared verdict after the ingredient nonsense; disagreement starts the conversation. | S | Private per-player vote, reveal when both vote; a little “Dinner decided” badge if they match. Independent of Bank, which either can still use. Reuse Cookout's authenticated seats and filtered-view rules; do not fork WYR's UI. |
| **TOP 3 — Secret star ingredient.** “Secretly star one of your picks: the chef must make both stars shine.” | Each player has a personal stake in the final reveal; stars can clash hilariously. | M | Optional lobby switch. Each player marks one of their already selected ingredients before the basket closes; reveal stars with the basket. Both become required substantial uses in all concepts. Needs a bounded final-ready state if someone has not starred yet; absent stars cannot stall ordinary core games. No new food escapes the allowlist. |
| **Lucky dip.** “Can't decide? Let the kitchen coin pick one.” | A voluntary moment of suspense with no extra waiting or AI cost. | S | Acting player requests a server coin flip between their **current** two offered ingredients; same operation-id/offer guards. It neither changes skip budget nor grants a fresh pair. |
| **Dinner in disguise.** “Give the same basket three personalities: cosy, posh and picnic.” | The contrast makes opening the three cards feel like a reveal rather than three near-duplicates. | M | A fixed optional style preset in the start sheet; prompt/validation changes only, no extra ingredients. No user-written style text sent to cmd. If a style is infeasible, say so rather than break the basket contract. |
| **The chaos shelf.** “Once each, brave two ingredients from the strange shelf.” | The odd ingredient becomes a funny decision the player owns, instead of random punishment. | M | Explicit opt-in replaces one eligible turn's pair with an adventurous-tier pair. Keeps two refreshes, uniqueness and alternation. A preview explains that this makes dinner harder; ordinary draws remain balanced. |
| **Cooked it!** “Make one for real and put your photo beside the chef's daydream.” | Connects the silly game to an actual evening together and a growing book of successes. | M | A per-concept cooked marker and link to an ordinary photo in the existing mini chat. No public feed or external upload. Respect the linked photo's deletion and the original anchor's wipe semantics. |
| **Kitchen handicap.** “One pan, no oven, or fifteen-minute supper: can the chef pull it off?” | Gives a familiar basket a new challenge and makes a winner useful tonight. | M | Fixed optional equipment/time enums, validated in the full method. Keep it off by default; do not force an impossible quick recipe or quietly ignore a selected ingredient to hit the clock. |
| **Leftover encore.** “Make tomorrow's basket start with the ingredients today's chef left behind.” | An amusing continuity between rounds and a reason to notice omissions. | M | Creates a clearly labelled new round with agreed leftover seeds, then draws the remaining picks under a separate preset. New anchor, new chat; no immortal history linking after deletion. Not required for the initial three-concept game. |

I would build **One rescue swap**, then **Dinner vote**, after the core is proven. Secret star is the third recommendation for novelty, not a requirement for v1.

## C. Implementation plan and collision-free contracts

The design panel first merges a single frozen spec and JSON fixtures; the table below is a build plan, not a request to launch workers during this independent proposal round. **UI: Opus 5.5. Server parcels: Sonnet 5.5**, as required. Keep one owner for heavily shared files.

| Parcel / builder | Owned files and concrete output | Depends on / parallelism | Local completion proof |
|---|---|---|---|
| P0 — Contract freeze / integrator | Promoted spec, canonical request/view/concept/recipe fixtures, acceptance checklist and precise file ownership | First. No debate about state names or identity is deferred into parallel code. | Fixtures cover open, blind-own-turn, blind-other-turn, finished, failed, banked and unavailable. |
| P1 — Ingredient bank / data builder | `cookout_ingredients.json`, `cookout_bank.py`, `tooling/cookout/validate_bank.py`, bank/draw tests | Starts after P0, parallel with P2/P3/P4. Supplies a tiny typed fixture bank immediately. | Real bank validates offline; content sample reviewed; draw tests cover worst-case refreshes and fairness. |
| P2 — Server state, routes and integration / Sonnet 5.5 | **Sole owner** of `store.py`, `models.py`, `routes_livechat_cookout.py`, `cookout_game.py`, `cookout_identity.py`, `app.py`, shared server query/wipe/Gallery/message changes; state/route/privacy tests | Uses P1's frozen interface and fixture before full bank exists. Can run with fake AI/image adapters while P3 builds. | Two store instances race safely; actual v20 upgrade; HTTP blind filtering and erase tests; fully typed. |
| P3 — AI jobs and local pictures / Sonnet 5.5 | `cookout_ai.py`, `cookout_jobs.py`, `cookout_images.py`, narrow `wyr_images.py` extension; AI/job/image tests and the fake-cmd/fake-Comfy response extensions | Parallel after P0 against a store-port fake. Uses the existing `cmdchat.py` transport; any necessary transport patch belongs here. P2 consumes its exported runner/adapters. | Parser/checker adversarial cases; job lease/restart/unknown-start matrix; fake three-image cleanup; WYR image regression proof. |
| P4 — UI / **Opus 5.5** | `server/cookout/*`, **sole owner** of `thread.ts`, `gameTabs.ts`, frontend message/parser union changes, Cookout CSS, local harness and TS tests; committed built admin output | Starts from P0 fixtures, parallel with P1–P3. No need to wait for live AI or completed bank. | All pane states at 360 px; browser network redaction assertions with fake views; tab/chat/lock regression tests; strict typecheck/build. |
| P5 — Docs and integrated E2E / docs/test builder | `docs/ai/*`, `CLAUDE.md`, decision entry, `e2e/tests/server-cookout.spec.ts`; acceptance report | Draft docs/test flow from P0 while others build; final tests depend on P2/P3/P4. P3 owns fake server response files, so request fixtures there rather than editing them concurrently. | Two-context E2E, old-anchor book, blind same-email case, delete during work; matching docs and public envelopes. |
| P6 — Integrator / original driver | Merge parcels in an isolated source checkout, reconcile bundle drift, freeze candidate and obtain required review | P1–P5 complete locally. Shared-file fixes return to their owner; no “everyone patches app.py” phase. | Focused checks followed by required complete local checks; bounded real-service smoke; senior audit; one final PR/CI sequence. |

The interfaces to freeze in P0:

1. **Data → store:** immutable `Ingredient`/`IngredientSnapshot`, `CookoutBank.by_id`, `snapshot(id)` and pure `draw_pair(role, seen_families, recent_round_families, rng) -> tuple[IngredientSnapshot, IngredientSnapshot]`; errors explicit. The server store supplies the transaction-consistent exclusion sets and owns persistence. P1 never edits `store.py`.
2. **Store → jobs:** typed `CookoutJobKey(anchor_seq, kind, slot)`, job snapshot and claim receipt; methods `claim_cookout_job`, `renew_cookout_job`, `set_cookout_run`, `stage_cookout_candidate`, `finish_cookout_concepts`, `finish_cookout_recipe`, `attach_cookout_images`, `fail_cookout_job`, `cookout_due_jobs`. Every mutation carries expected epoch/claim/input hash. Completion methods own the corresponding round revision/event transaction. P3 provides a protocol and fake implementation in its own test files; P2 implements it on `LiveChatStore` without duplicated SQL ownership.
3. **Jobs → app:** `CookoutRunner.resume(background)`, `supervise(background)` and `wake(key)` are scheduling conveniences over durable rows; losing `wake` cannot lose a job. `CookoutAI.start/poll/cancel` wraps `CmdChatClient`; `CookoutImageJob` wraps the configured Comfy generator and shared image gate/demand. P2 alone wires lifespan, edition selection, shared cmd capacity and app-state seams. P3 sends typed integration requirements, not competing edits to `app.py`.
4. **Server → UI:** §4.2/§4.3 and checked-in JSON fixtures are the authority. P4 owns the TypeScript representations/parsers; P2 owns Python representations. No generated API dependency is required. Keys absent versus explicit null, public summaries, recipe slots and error codes are settled before either side codes.
5. **UI → shared chat:** `GameKey="cookout"`, `GameRegistration`, existing `ItemChat`, existing `wyrSeq`/`wyrRef`, new `wyrRefKind="cookout"`, and the generic old-anchor loader. P4 alone performs this integration; no server or docs builder rewrites the shared composer.
6. **Acceptance assets:** P3 supplies deterministic delayed/failing cmd/image fixtures; P5 consumes those through supported test seams. P4's harness uses the same wire examples. Check fixtures against both parsers so two incompatible “reasonable” implementations cannot pass isolated tests.

Build sequence: P0 → **P1, P2, P3, P4 in parallel; P5 drafts** → P2/P3 integration and real bank substitution → P4 against that stack → P5 integrated checks → P6. Server and UI builds each keep a fast local edit/test/harness loop. Do not spend audit or full CI on finding ordinary bugs. The final senior review must explicitly examine seat credential/rebinding/CSRF, hidden-field coverage, migration/old-process cascade, transaction races, lost external submissions, lease ownership, provider retention, tool policy and Comfy cleanup; this is more than a cosmetic UI feature.

## D. Pre-commitment before seeing peers

**I would drop these first if a peer has a better design:**

* The exact 80%/60% thresholds and tier weights. “Most” needs an enforced floor, but the best constants should survive awkward-basket trials; percentages are not sacred.
* The 3/5/7 settings beyond default five. If they add disproportionate UI or testing work, shipping five alone is a sensible first build, provided the agreed final spec says so rather than a builder silently removing it.
* My extra seat cookie **implementation**, if a peer demonstrates an existing verified credential that already binds both people, works with shared Access accounts and missing email, survives normal reconnects, and cannot be selected by changing a name. I will not defend new machinery for its own sake.
* The category/role taxonomy, three-concept presentation details and exact SQL decomposition. Fewer tables are welcome if receipts, secret offers, job ownership, consistent reads and erasure remain explicit and testable.
* The separate semantic checking run if a peer supplies a simpler equally credible way to police ingredient use in free prose, with adversarial evidence rather than a prompt-only assurance.

**I will defend these hardest:**

* **One shared basket, strict alternating turns, two refreshes per turn.** That is the clearest reading of the requested cooperative game; it gives both people equal choices and makes “three goes” predictable.
* **The server never sends the partner's hidden ingredients.** A typed-name switch, full state over SSE, a public offer id or a dormant DOM label defeats the actual request. The identity rule and serializer must be reviewed together.
* **Three concepts first, full recipe only on Bank.** Generating or displaying all methods up front changes the requested reveal and wastes work for dishes neither person wants.
* **No unselected food smuggled in as a staple, garnish or instruction.** An auditable manifest and a numerical “most” floor give the game its meaning. “The AI will probably behave” is not a contract.
* **Banked recipes stay owned by the anchor, and deletion wins every late job.** A convenient Recipe book cannot become a secret second store that outlives chat erasure.
* **Reuse the real shared tab/chat/media mechanisms.** The current one-game slot already implements replacement; duplicated game-chat code or a separate image service would create avoidable future drift.
* **Be accurate about external effects.** cmd retains recipe work; Comfy has transient external files; uncertain POSTs are not exactly-once. A good design gives those limits bounded behaviour rather than optimistic labels.

## E. Genuine open questions for the operator

**None block the core.** The draft settles the reasonable defaults: shared ten-ingredient basket, five each, Open by default, two refreshes per turn, reveal selected picks at the end, three concepts, exact free staples, two servings, either player may bank, and a private Recipe book erased with its round. The nine twists are choices for the later combined panel recommendation, not questions the operator must answer before implementation can start.

Proposal-only checks: Markdown section/fence/whitespace checks pass; the proposed SQL compiles in an in-memory SQLite database, and deleting a test anchor cascades through all six Cookout tables. These check the document's internal consistency, not a working game. This seat changed only this proposal; no Cookout runtime was implemented or run, and no commits, pushes or deployments were performed.
