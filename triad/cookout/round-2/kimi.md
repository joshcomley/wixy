# Cookout — Kimi round-2 MERGE

This merger takes Astra's stronger identity, durable-job, and snapshot architecture as the backbone, but not
its whole proposal. It changes the concept wire to canonical ingredient ids, keeps the strict eight-item
staples contract, uses one concept-generation run plus a separate food-only checker, and preserves the
existing `wyr_` Comfy cleanup prefix rather than inventing a second cleanup namespace. No seat's proposal is
treated as authoritative because of authorship or vote count.

## 1. Merge ledger

| Decision | What this merger takes | What changes / what is rejected, and why |
|---|---|---|
| Skip budget | **Two skips per turn**, three pairs total; the third is forced. All three reached this reading. | Reject a round-wide budget and reject putting the question back to the operator. “Three goes before you have to pick” is a property of each offered choice. A skip never passes the turn and unused skips do not carry. |
| Picks per player | **Exactly five each**, ten total. | Reject Astra's 3/5/7 setting for the core. Five is the operator's decided game; extra house-rule UI and test permutations are unrequested scope. |
| Join and turn order | A waiting round, explicit Join by the second player, then **one persisted server coin toss** chooses the first slot; turns strictly alternate. | Reject creator-always-first as an unnecessary advantage and reject Argon's implicit player-2 binding on its first move. Explicit joining makes the waiting state, identity, and initial draw atomic. |
| Player identity | **Astra's seat-cookie design**, strengthened into the only blind-seat authority alongside verified email where that is unique. | Reject relying on WYR's typed-name fallback for Cookout. The code confirms that missing email falls back to a name, which cannot satisfy a strong “cannot read the partner's options” rule on a shared account. The cookie grants no chat access and every request still needs the normal unlock token. |
| Blind mode | Before completion: own offers/picks only; partner gets counts and turn/attempt activity, never ingredient data. Final pick reveals **all selected ingredients together**, not rejected alternatives. Abandoned blind rounds never reveal. | Reject CSS/DOM hiding, public offer ids, hidden fields in SSE, and revealing the full offer history at the end. I take Astra's useful activity signal (attempt count) rather than Kimi's more opaque waiting panel: it contains no food information. |
| Abandonment | Explicit End round, and replacement only against the exact open `{seq,rev}`; one partial unique open-round index. | Reject silently abandoning whichever open round a delayed New request happens to find. Finished baskets and their jobs are never abandoned by a new game. |
| Draw structure | **Astra's shuffled paired role schedule**: at five picks `[base, protein, produce, produce, accent]`, each role for two successive turns, one per player. | Reject balancing only by offered/picked category counts. Roles give each player the same culinary opportunities and structurally prevent an all-spice basket while leaving the actual ingredients random. |
| Draw exclusions and fairness | Different families within a pair and across every offer in the round; soft-exclude families from the last three retained finished rounds, relaxing oldest first; one everyday option and a 50/35/15 tier-weighted second; uniform category → family → entry selection. | Reject repeating near-identical forms and reject a permanent played table. Recent memory is derived from offer rows so delete/wipe forgets it. Current-round family exclusion is never relaxed. |
| Bank schema and size | Astra's richer static records and immutable offer snapshots; target **2,600–3,200** entries, validator accepts 2,400–4,000. | Reject id-only offer storage and trivial cut/colour padding. A bank update must not rewrite an already offered pair or an old basket. The 21-category enum, roles, familiarity, preparation, aliases and notes are retained; no dietary promises are added. |
| Staples | **Water, salt, black pepper, butter, plain flour, neutral cooking oil, granulated sugar, white vinegar**; at most four additional non-water staples per concept. | Reject Argon's 16-item pantry (garlic/onion/stock/soy/etc. are precisely how “a few staples” becomes a second ingredient bank) and Kimi's wider 11-item list. All except water are pickable; selected staples count as picks and do not consume the extra-staple cap. |
| AI job shape | **One generation run for all three concepts**, followed by one fresh, independent, tool-free **manifest-check run**; at most two candidates and two checks per requested job. Full recipe is a separate on-demand generate+check. | Reject three independent concept runs and reject trusting a JSON array alone to catch “serve with mango” in prose. The checker is not asked to invent food and its output is never stored as recipe content. |
| Concept coverage | Every concept targets 10/10, hard floor **8/10**, with at least **6 substantial contributions** (base/main/sauce). Omissions are explicit with culinary reasons. | Reject Argon's prompt-7/validator-6 mismatch and Kimi's forced all-ten concept A. Astra's floor makes “most” testable without demanding a token-garnish everything dish. |
| Concept validation and wire | Canonical **ingredient ids**, exact complements, three distinct `(dishType,technique)` pairs and at least two dish types; strict whole-candidate rejection; deterministic lexical flags plus semantic manifest check. | Reject silently filtering invalid ids, clipping an ingredient into another meaning, accepting a subset of the three, or using display-name fuzzy matching as the machine contract. The checker addresses free prose but is honestly not a mathematical proof of food safety or semantic completeness. |
| Pictures | Text first; one local Comfy graph with three chains; shared model load and the existing in-process image limiter/demand priority; ordinary private attachments. | Reject waiting for pictures before showing concepts, three parallel GPU jobs, model-authored image prompts, and any third-party image URL. Keep 1024×1024 Krea 2 Turbo behavior rather than Argon's unverified port/size claims. |
| Comfy cleanup prefix | **Reuse the owned `wyr_` prefix** with a fresh run id for Cookout; add `generate_many(1..3)` and keep `generate_pair` as a wrapper. | Reject Kimi's new `cookout_` prefix. The existing sweeper recognises only `wyr_`; reusing it is the smaller fail-closed change. It is an ownership namespace, not a user-facing game label. |
| Bank-it semantics | Bank click records a save intent and starts the full-recipe job; **only a valid completed recipe is Banked ✓**. Each concept can be banked independently. | Reject Argon's immediate appearance as banked before a method exists. Pending/failed save intents are clearly labelled, never mixed into the completed book. |
| Full recipe | Fixed serves 2, typed quantities/times, exact concept manifest (water alone may be added if needed), every ingredient referenced by a step, immutable once banked; same generation+checker discipline. | Reject silently adding unused picks/new staples, changing the dish title, free-form alternative recipes, or overwriting an already banked recipe on a late retry. |
| Recipe book | Full-height, anchor-owned book with signed picture, title, time, serves and cursor pagination; a separate capped “Being saved” area. Tap opens the original round/concept, loading old history first. | Reject an external recipe store or an unpaginated dump. Deleting the anchor removes the recipe and image from the book; wipe empties it. |
| Schema v21 | Astra's six-table decomposition: rounds, players, offers, concepts, jobs, actions; REAL epoch timestamps and immutable snapshots. | Reject a large JSON blob on one round row and reject storing formatted timestamps. The jobs table is what makes phases, deadlines, leases and unknown starts recoverable rather than speculative. |
| Mutation idempotency | `operationId + expectedRev`, durable action receipts checked before revision, canonical request hashes, and one `message_updated` per visible change. | Reject Argon's same-ingredient/skip-index replay heuristics and Kimi's per-turn move ids as incomplete for join, replace, bank and job retry. Payload-changing reuse is `409 idempotency_conflict`; an unrelated stale request never acts on a new pair. |
| Wire | Seat-derived identity, no `?as=`; `Cache-Control: no-store` on personalised views; `/seat`, `/current`, `/book`, exact replace, abandon, pick/skip/bank/retry routes. | Reject exposing private offer ids to a nonacting blind viewer or a personalised body in broadcast history/SSE. `Message.cookout` stays a public summary. |
| Jobs and recovery | Persisted enqueue deadline, phase and candidate, claim token + renewable lease, supervised 15-second sweep, known-run resume, and **`unknown_start` fails instead of blindly respawning**. | Reject treating a lost spawn response as safe to repeat or assuming an in-process `CapacityLimiter` is a deployment-wide lock. A process losing its lease does not cancel its successor's run. |
| Standalone | Picking/reveal and existing saved content still work; new concepts/recipes become `unavailable`; no images and no canned fallback. | Reject a direct-API or fake-recipe fallback. This matches the existing Adventure edition posture. |
| UI | Astra's start sheet with Open/Blind only, compact pane chrome, stacked accessible ingredient/concept cards, picture-first concepts, shared mini chat and full-height book. | Reject a persistent settings table and a phone carousel that hides the other two concepts. No full method is fetched or embedded before Bank. |
| Parcels | Astra's P0–P6 collision-free ownership plan with frozen fixtures and one integrator. | Keep UI on Opus 5.5 and server parcels on Sonnet 5.5. One owner per shared file; `app.py` is not a merge free-for-all. |

## 2. Code evidence and provenance labels

These are the code facts on which the merged design depends. **MEASURED-BLIND** means I checked the code in
round 1 before seeing the other proposals; **MEASURED-KNOWING** means I rechecked it in this round with a
peer's claim already in mind. No unchecked peer fact (**CITED**) is load-bearing here.

| Label | Verified fact and consequence |
|---|---|
| **MEASURED-BLIND** | `store.py::_LATEST_SCHEMA_VERSION = 20`; v20 Adventure rows use anchor cascade and REAL epoch fields, and `_wipe` explicitly deletes game tables. Cookout is additive v21 with child-first wipe. |
| **MEASURED-BLIND** | `store.py::_write_txn` executes `BEGIN IMMEDIATE`, then commits/rolls back; `_adv_update` bumps `rev` and inserts `message_updated`. Cookout mutations follow that actual mechanism, not an assumed ORM. |
| **MEASURED-BLIND** | `wyr_game.py::wyr_view_json` is the single filtered-answer exit and `_slot_of` uses name+email; `store.py::_wyr_slot` explicitly falls back to name when either email is unknown. This is why Cookout needs a stronger seat binding. |
| **MEASURED-KNOWING** | `tokens.py::ServerAuth` carries `email`, `exp`, and optional `grant_id`, not a durable browser-seat id. The unlock token is documented as JS-memory-only and arrives in `X-Wixy-Server-Token`. A repo search found no `set_cookie`, `delete_cookie`, or `wx_cookout_seat` in `wixy_server`; the proposed cookie is genuinely new, not an existing primitive being renamed. |
| **MEASURED-KNOWING** | `require_server_token` validates the custom-header token on every call and rechecks a live grant when bound. The cookie therefore cannot replace unlock/Access checks; the custom header also keeps Cookout mutations out of cross-origin “simple request” form. |
| **MEASURED-BLIND** | `ComfyImageGenerator` currently exposes `generate_pair`, defaults to `krea2-turbo-nvfp4`, uses `FILE_PREFIX = "wyr_"`, builds 1024×1024 outputs, and deletes its own history/output/cancelled work. There is no existing three-image API or `cookout_` sweep. |
| **MEASURED-BLIND** | `wyr_game.py::wyr_image_limiter` is a single-flight `CapacityLimiter(1)` in app state and `WyrDemand` makes the speculative pool yield. It is an in-process gate, not a cross-process fleet GPU semaphore. |
| **MEASURED-BLIND** | `adventure_pack.py` demonstrates hidden cmd runs, defensive JSON, bounded polling, CAS completion and startup resume. `cmdchat.py` supplies `spawn_run/get_run/cancel_run`; the default research model/effort there is Sonnet 5.5/medium. |
| **MEASURED-KNOWING** | `cmdchat.py::_request(connect_errors_only=True)` retries only connect refusal/timeout, where the request provably never arrived; `spawn_run` uses it. A lost response is therefore not safe to respawn automatically and becomes `unknown_start`. |
| **MEASURED-BLIND** | `gameTabs.ts` currently has `GameKey = "wyr" | "adventure"` and `replaceOthers` enforces one open game. `itemChat.ts` supplies the shared strip/pop-up/composer. The ⋯ menu and `gameLabelFor` are in `thread.ts`, not `panel.ts`. |
| **MEASURED-BLIND** | `models.py::message_json` carries public `wyr`/`adventure` summaries and `wyrRefKind`; `store.py` resolves generic game-chat anchors through `wyr_chat`. Cookout extends these rather than inventing another chat. |
| **MEASURED-BLIND** | `app.py` constructs Comfy only outside standalone and constructs the Adventure researcher only for a fleet cmd backend. Existing saved Cookout content can remain readable when new job backends are unavailable. |
| **MEASURED-BLIND** | The livechat docs identify the fleet Comfy child at loopback 8199 and `wyr_images.py` treats its base URL/output directory as configuration. Argon's hardcoded 8190 is not used in this merger. |

---

## 3. Merged design — A. `spec/server-chat/09-cookout.md` draft

### 3.1 Product flow

Cookout is a cooperative two-player ingredient draft. The start sheet offers **Open** (default) or **Blind**;
there is no persistent settings table. Creation binds player 1's seat and opens a `waiting` anchor. The second
player explicitly Joins, binding player 2. The server persists a fair coin toss for `first_slot` and a shuffled
role schedule, then draws turn 0's pair. Players alternate one pick each until both have five. Each turn has at
most two refreshes, each replacing both options.

On the final pick the basket is complete. Blind mode reveals the ten selected ingredients, and one AI job
invents three concepts. Their titles/descriptions publish together; three local food illustrations follow.
Either player can Bank any or all concepts. Banking starts a full-recipe job; only a validated full recipe
becomes banked and enters the Recipe book.

### 3.2 State, turns, visibility and abandonment

```text
waiting --second player joins--> picking --tenth pick commits--> finished
waiting|picking --explicit End or exact-revision replacement--> abandoned

concept job: absent -> queued -> starting -> running -> ready|failed|unavailable
                                      failed|unavailable --Retry--> queued
image job:   created only with accepted concepts; independently terminal
recipe job:  absent --Bank this on a concept--> queued -> ... -> ready|failed|unavailable
```

`finished` means only that the basket is complete, including while concepts are pending/failed. There is no
turn timer, auto-pick or disconnect loss. Closing, locking or leaving the tab pauses the local experience only.
An unfinished round can be Ended by either player with one confirmation. Starting New while one is open
requires `replace: {seq,rev}` for that exact round; a stale start conflicts instead of abandoning something
unseen. A new round never abandons a finished basket or cancels its requested recipes.

Blind rules:

- Before completion, a player sees their own full offer/pick history and their current pair. For their partner
  they see covered pick slots, pick count, current player and attempt number. No partner ingredient id, name,
  category, role, note, offer id, discarded alternative or hidden fingerprint is serialized.
- Open mode shows both histories, current pair and all accepted picks.
- The final-pick transaction reveals every selected ingredient to both. Rejected alternatives stay private to
  whoever received them, even after completion. No extra Reveal ceremony delays the concept job.
- Abandoning a blind round does not reveal it. Nonplayers see public status/counts only and cannot mutate.
- One `cookout_view_json` filters before serialization, including every mutation response. Personalised views
  carry `Cache-Control: no-store`. Broadcast history and SSE carry only the public summary. Mini-chat text is
  ordinary shared chat; the game cannot prevent someone deliberately typing a spoiler.

### 3.3 Seat identity

Use a narrow Cookout seat credential; do not trust `sender`, `deviceId`, `?as=`, or a requested slot.

1. `POST /cookout/seat {}` requires normal Access+unlock and ensures `wx_cookout_seat`, a server-random
   256-bit opaque value. Cookie: HttpOnly, SameSite=Strict, Secure in production, host-only,
   `Path=/api/admin/server/cookout`, 30-day max-age. A well-formed existing cookie is preserved. The explicit
   local dev configuration may use HTTP. It never appears in JSON, URLs, JS storage or logs.
2. A player row stores only SHA-256(cookie), verified `ServerAuth.email` when nonempty, and the display name.
   One cookie cannot occupy both slots; normalized display names must be distinct.
3. If a row has a nonempty email, a request carrying its cookie under a different **or missing** email cannot
   occupy that row; there is no downgrade to typed-name matching.
4. Once the two rows have distinct nonempty verified emails, the unique email identifies its slot on another
   device without the cookie. Otherwise the cookie is required. Two people sharing an Access account can thus
   play blind on separate browsers without a name-switching bypass.
5. On a shared account, losing the cookie loses that device's unrevealed-seat recovery; there is no “choose a
   seat” bypass. End/restart the round. This is the honest cost of strong blind identity without redesigning
   chat accounts.
6. The cookie grants no chat access. Every read/mutation still calls `require_server_token`; locking, grant
   revocation and Access expiry behave exactly as today. Locking does not delete the seat, so the same browser
   can resume after unlock. Wipe/delete erases the rows that give the hash meaning. No account table or PIN is
   introduced.

The final security review must explicitly test cookie flags, CSRF, rebinding, shared-email play and lost-cookie
behavior. This is a game-integrity boundary, not protection against someone controlling the other browser or
server.

### 3.4 Atomicity and idempotent moves

Every mutation decision runs in one `BEGIN IMMEDIATE` transaction, with time sampled after lock acquisition.
The store validates player membership, state, expected revision, turn, exact offer, remaining refresh budget,
and selected id membership in that pair. The next pair is drawn and stored in the same transaction. No AI/GPU
call happens inside a DB transaction.

Every mutation carries UUID `operationId` and positive-safe-integer `expectedRev`. `cookout_actions` stores
`(anchor, actor slot, operation id, action, canonical request hash, resulting rev)` and cascades with the round.
Check the receipt **before** the revision check:

- Same id+canonical payload returns `200` with the current viewer-filtered view, no draw/event/job.
- Same id with different action/payload is `409 idempotency_conflict`.
- An unrelated stale request is `409 stale_view`/`stale_offer`; the client re-reads and discards the old intent.
- Duplicate Bank while queued/running/ready is a semantic no-op even from the other player.

Creation uses message `clientId` dedupe plus a canonical creation hash. Check it before applying `replace`, so a
replayed creation cannot abandon a newer round. A clientId belonging to another message kind is a conflict,
not an unrelated message returned as Cookout. Two phones, two store processes, pick-vs-refresh and last-pick
job enqueue are all serialized by the DB. Visible changes alone bump `rev` and append one `message_updated`;
job heartbeats/run-id bookkeeping do not spam views.

### 3.5 Ingredient bank

`wixy_server/livechat/cookout_ingredients.json` contains a target 2,600–3,200 meaningful food ingredients,
including parsley, beef, cream, toast, sugar, spices, frozen/canned and prepared foods. No brand padding,
spelling variants, fake ingredients or trivial colour/cut duplication. A builder authors bounded category
batches; no runtime AI, proprietary corpus or shopping API is used.

Exact schema (unknown fields rejected):

```json
{
  "version": 1,
  "generated": "YYYY-MM-DD",
  "staples": [
    {"id": "water", "name": "Water", "pickable": false},
    {"id": "salt", "name": "Salt", "pickable": true}
  ],
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

- `id`/`family`: permanent lowercase ASCII kebab-case, 1–64 chars, never reused or semantically repurposed.
- `name`: trimmed British-English plain text, 1–70 chars; `aliases`: 0–6 alternative names of the SAME item;
  `note`: 0–160 plain chars. No markup, URLs, newlines or controls. Entries sorted by id.
- `category`: `vegetable|fruit|mushroom|grain|bread|pasta-noodle|pulse|meat|poultry|fish-seafood|egg|dairy|`
  `nut-seed|herb|spice|condiment|fat|sweetener|baking|prepared|drink` (the `|` line break is notation, not a
  22nd category).
- `roles`: nonempty unique subset of `base|protein|produce|accent`, culinary structure rather than nutrition.
- `familiarity`: `everyday|occasional|adventurous`; `flavour`: `sweet|savoury|either`;
  `preparation`: `ready|cook|specified`; `specified` needs a note describing the purchased food-grade form.
- `staples` is the exact eight-id manifest below. Every pickable staple also has one ordinary ingredient entry;
  water does not. Selected staples therefore retain the same canonical ids.

`tooling/cookout/validate_bank.py` is stdlib-only and offline; `test_cookout_bank.py` checks the real file and
negative fixtures. Acceptance is 2,400–4,000 entries, all schema/text/enum rules, normalized name/alias
uniqueness, at least 100 eligible families per role and 30 everyday families per role, mandatory examples,
specified-form notes and sensible tier/category distributions. Maximum-refresh fixtures prove enough eligible
families. Human/builder content review separately checks edibility, commercial forms and synonym quality;
schema validation alone cannot prove those.

### 3.6 Server-authoritative draw

At Join, persist a shuffled `[base, protein, produce, produce, accent]` schedule and the coin-toss first slot.
Each role supplies two successive turns, one per player, so both receive the same opportunities and refresh
allowances. Do not send the future schedule/deck to either client.

For each offered pair:

1. Eligible entries have the turn role and a family never offered anywhere in this round (picked, skipped or
   unchosen). Thus every pair and the whole round have distinct families; red onion cannot follow white onion.
2. Soft-exclude families offered in the three most recent other retained finished rounds, derived entirely
   from offer rows. Relax the oldest recent-round exclusion first if needed; never relax current-round rules.
3. Draw option one from `everyday`. Draw option two with weights everyday 50%, occasional 35%, adventurous
   15%, renormalising empty tiers. Within a tier choose an eligible category uniformly, then family uniformly,
   then entry uniformly. Remove option one's family before option two and randomise left/right fairly.
4. Use `SystemRandom`/`secrets` in production and an injected RNG in tests. Store the complete immutable pair
   snapshot and an unpredictable `offer_id`. Never expose RNG state, future choices or the global exclusion set.
5. A refresh keeps the same role, immediately excludes the discarded families and draws again. Fewer than two
   eligible families is `409 bank_exhausted` with no refresh charge or state change.

Snapshots include id/name/aliases/family/category/roles/familiarity/flavour/preparation/note. `bank_version`
and `bank_sha256` at creation are provenance, not a promise to reconstruct later random draws. Later turns use
the then-current validated append-only bank; existing offers and finished baskets do not change.

### 3.7 Exact staples contract

The complete free-staple vocabulary is:

```text
water, salt, black-pepper, butter, plain-flour, neutral-oil, granulated-sugar, white-vinegar
```

No stock, milk, cream, eggs, cheese, garlic, onion, herbs, soy sauce, wine, lemon, olive oil, baking powder or
mango is implicitly available. No optional-garnish loophole. A selected prepared ingredient can be used as
purchased, but its constituents do not become separately available.

All except water are pickable bank entries. A selected staple counts as a selected ingredient and is excluded
from the concept's “additional staples” list. Each concept may add at most **four additional non-water
staples** plus water (at most five entries). Show additions explicitly on concepts and recipes.

### 3.8 Concept generation and validation

The final pick creates the concept job in the same transaction. Input is a sorted list of selected immutable
snapshots and the fixed staples manifest; sorting removes attribution and pick order. No names, emails,
seat/device ids, anchor ids, chat text, blind/open mode or user-written prompt leaves the server.

The prompt instructs: invent three genuinely different, appetising dishes for two; try hard for all ten in
each; use at least 8/10 with at least six base/main/sauce contributions; explain every omission; add no food
outside the manifest and at most four extra non-water staples; prepared foods do not unlock constituents; no
quantities/method/timings/links/markdown/image URLs/tools. Weird is welcome, unsafe is not.

Exact output (all fields required, unknown fields rejected):

```text
{version: 1, concepts: [Concept, Concept, Concept]}
Concept = {
  slot: 0|1|2,
  title: string[1..90],
  description: string[1..480],
  dishType: "bowl"|"traybake"|"stew"|"soup"|"salad"|"pie"|"pasta"|"rice"
           |"flatbread"|"sandwich"|"pancake"|"fritter"|"omelette"|"bake"
           |"dessert"|"platter",
  technique: "roast"|"bake"|"pan-fry"|"simmer"|"steam"|"grill"|"no-cook"|"mixed",
  uses: [{ingredientId: canonical_selected_id,
          contribution: "base"|"main"|"sauce"|"seasoning"|"garnish"}],
  omits: [{ingredientId: canonical_selected_id, reason: string[1..120]}],
  stapleIds: [canonical_additional_staple_id]
}
```

Validation requires exactly slots 0/1/2 once; distinct normalized titles; at least two dish types and three
distinct `(dishType,technique)` pairs; unique uses with 8–10 entries and ≥6 substantial contributions; omits
as the exact basket complement; no id in both; additional staples only, disjoint from selected ids and within
the cap. The parser caps response size at 64 KiB and candidate objects at 16, rejects duplicate JSON keys,
NaN/Infinity, wrong types, controls and markup, takes the last top-level object only, and never resurrects an
earlier partial answer or silently repairs the food manifest. Store canonical validated JSON, not raw output.

The ingredient rule also applies to prose. A deterministic longest-first whole-word scan of bank names/aliases
produces bounded lexical flags; then a fresh tool-free cmd **manifest checker** receives only the basket,
staples, candidate and those flags. It distinguishes naming the finished dish from adding a purchased food and
returns only:

```text
{version:1, ok:boolean,
 violations:[{slot:0|1|2,
              code:"extra_ingredient"|"missing_use"|"token_use"|"duplicate_dish"|"unsafe_method",
              ingredient:string|null}]}
```

Require `ok=true` and zero violations. “Serve with rice”, stock-based sauces and unselected mango are
violations. A rejected candidate may be regenerated once from the original food input plus bounded violation
codes, never raw response dumps. The replacement gets the full same checks. Two unacceptable candidates end
the job failed; thresholds are not silently lowered. The independent check reduces free-text smuggling but is
not a proof of semantic correctness, allergen safety or culinary quality.

### 3.9 AI transport, deadlines and recovery

Fleet generation uses `claude-sonnet-5-5`, effort `medium`; the independent checker uses the same model at low
effort. All calls go through `CmdChatClient` in hidden unparented subscription runs in empty non-git
`server/cookout-jobs/`; no direct model API, web search, connector or plugin. Deny all file/shell/agent tools
plus WebSearch/WebFetch and verify the effective policy. Callers are `wixy-cookout-concepts`,
`wixy-cookout-concept-check`, `wixy-cookout-recipe`, and `wixy-cookout-recipe-check`.

- Provider timeout 180 s per concept/recipe candidate and 120 s per check; poll every 5 s with at most 12
  consecutive read failures. At most two candidates and two checks per user-requested job.
- Whole text-job deadline **900 s from enqueue**, persisted and including capacity wait/repair. Images have a
  600 s wall budget. Expiry cancels a known run and fails the job; restart does not reset the deadline.
- At most two text runs per app process across Adventure+Cookout through one shared app-level gate, starts ≥5 s
  apart. This is deliberately not advertised as a cross-process global cap.
- `cookout_jobs` records phase, candidate, run id, absolute deadline, claim token and lease. Claims/completions
  compare-and-set epoch+claim+input hash. Renew a 90 s lease every 20 s; a startup scan and supervised 15 s
  sweep recover queued/expired work through `ContainedTaskGroup`.
- A new owner with a recorded run id resumes that run and phase. Losing a lease does NOT cancel a run now
  owned by someone else. Delete/wipe or superseding an epoch makes its old run unwanted and best-effort cancels.
- Record `starting` before the external POST. An ambiguous submission with no run id becomes failed with
  `unknown_start`, never an automatic second spawn. A deliberate user Retry creates a new epoch. A known
  connect-refusal can fail `unavailable`; neither path pretends exactly-once external submission.
- Repeated requests while queued/running/ready start nothing. Failures retain basket/concept/text. Add a
  Cookout-specific three-new-AI-starts/retries-per-minute per-seat load guard; idempotent replays are free.

Standalone: picking/reveal and browsing existing saved content work; new concepts/recipes become
`unavailable`; no images and no canned or direct-API fallback. A fleet server without Comfy still produces
and banks text recipes.

**Retention:** cmd retains food-only prompts, candidate answers and checker runs, including the selected
combination, which this server's delete/wipe cannot reach. No identity or conversation is sent, but call time,
basket and recipes may remain there. Inv 57 must say this plainly rather than copying Adventure's narrower
“one static destination” wording.

### 3.10 Pictures

Concept text and Bank controls publish first. Each card reserves a picture area above its description. The
server, not the model, builds each prompt from the accepted title/description/manifest plus: “A realistic
photograph of the finished plated dish, natural kitchen light, close view, no people, text, packaging, extra
food, unlisted garnish or side dishes.” It is labelled subtly as an AI illustration.

Add `ComfyImageGenerator.generate_many(prompts, out_dir, *, seeds)` for 1–3 prompts, with `generate_pair` as
its two-item wrapper. One graph shares UNET/CLIP/VAE and has independent a/b/c chains. Use fresh `wyr_<uuid>`
prefixes so the existing prefix-aware cleanup covers every Cookout run; do not introduce an unrecognised
namespace. Keep default Krea 2 Turbo behavior and existing WYR tests.

Use `wyr_image_limiter` and `WyrDemand`, never the WYR picture pool. Re-check job ownership before GPU and
before attachment commit. Stage in `server/cookout-tmp/<random>/`, then commit three ordinary attachments and
the slot map atomically under the job claim. Ordinals 0/1/2 match concept slots. Normal media processing strips
metadata and creates signed private thumb/full URLs; quota/free-space rules apply and Gallery excludes the
anchor.

Generation returns exactly the requested images or fails. A later individual media-processing failure leaves
only that card text-only. Any unavailable/failed batch preserves all text. Retry pictures regenerates only the
required batch and journals/removes replaced uploads/attachments, never accumulating hidden copies. Every exit
uses `_forget_run`, cleans unattached staging and releases demand/limiter. Startup/periodic scratch cleanup
uses the same conservative 900 s threshold; Comfy output/history sweeps cover the third chain. Delete/wipe
wins every late completion.

### 3.11 Bank and full recipe

Either player may bank any/all concepts as soon as text is ready. The action stores `bank_requested_at` and a
recipe job; the card says **Writing recipe…**. Only successful completion sets `recipe_json` and `banked_at`
atomically. The original concept image is reused whenever it arrives.

The recipe prompt receives only the accepted concept and exact manifest, serves fixed to 2. It must preserve
the title/identity, use every declared ingredient, and add no food. Water may be added if needed; every other
addition was already in the concept's extra staples. Unused picks cannot re-enter. Generate+check follows the
same one-repair limit.

Exact output:

```text
{version:1,
 title:string[1..90],                         // exactly the concept title
 description:string[1..480],
 serves:2,
 prepMinutes:integer[0..180], cookMinutes:integer[0..360], restMinutes:integer[0..360],
 totalMinutes:integer[1..720],
 ingredients:[{ingredientId:canonical_manifest_id,
               amount:finite_number(0..5000],
               unit:"g"|"ml"|"tsp"|"tbsp"|"pinch"|"piece",
               preparation:string[0..100]}],  // 1..24 unique entries
 steps:[{text:string[1..600], ingredients:[canonical_manifest_id],
         minutes:integer[0..360], ovenC:integer[50..300]|null}] // 2..16
}
```

Require `totalMinutes = prep+cook+rest`; positive amounts, integer piece counts, no booleans/nonfinite values.
The ingredient id set equals the concept manifest plus optional water. Every listed ingredient appears in at
least one step and every step reference is listed. Validate free prose/preparation too. No optional extras,
alternative recipes, external links, HTML or dietary guarantees. A late/repeated response cannot mutate a
banked recipe.

The **Recipe book** is a full-height screen like `holidayBank.ts`: completed banked recipes newest first with
picture, title, total time and “Serves 2”, cursor-paginated. A separate capped “Being saved” area shows recent
pending/failed intents accurately. Tapping opens the original Cookout round at that concept, loading its old
anchor first; the full recipe and the round's one shared mini chat appear there. There is no separate recipe
comment system or external export. Delete removes the book entry and pictures; wipe removes the book.

### 3.12 Additive schema v21

```sql
CREATE TABLE IF NOT EXISTS cookout_rounds (
  anchor_message_seq INTEGER PRIMARY KEY REFERENCES messages(seq) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('waiting','picking','finished','abandoned')),
  blind INTEGER NOT NULL CHECK(blind IN (0,1)),
  picks_per_player INTEGER NOT NULL DEFAULT 5 CHECK(picks_per_player = 5),
  first_slot INTEGER CHECK(first_slot IN (1,2)),
  next_turn INTEGER NOT NULL DEFAULT 0 CHECK(next_turn BETWEEN 0 AND 10),
  role_schedule_json TEXT NOT NULL DEFAULT '[]',
  bank_version INTEGER NOT NULL,
  bank_sha256 TEXT NOT NULL,
  create_request_hash TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1 CHECK(rev > 0),
  created_at REAL NOT NULL, updated_at REAL NOT NULL,
  CHECK(state != 'finished' OR next_turn = 10)
);
CREATE INDEX IF NOT EXISTS idx_cookout_rounds_state ON cookout_rounds(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cookout_one_open
  ON cookout_rounds((1)) WHERE state IN ('waiting','picking');

CREATE TABLE IF NOT EXISTS cookout_players (
  anchor_seq INTEGER NOT NULL REFERENCES cookout_rounds(anchor_message_seq) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK(slot IN (1,2)),
  name TEXT NOT NULL, name_key TEXT NOT NULL,
  email TEXT, seat_hash TEXT NOT NULL,
  PRIMARY KEY(anchor_seq,slot),
  UNIQUE(anchor_seq,name_key), UNIQUE(anchor_seq,seat_hash)
);

CREATE TABLE IF NOT EXISTS cookout_offers (
  anchor_seq INTEGER NOT NULL REFERENCES cookout_rounds(anchor_message_seq) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL CHECK(turn_index BETWEEN 0 AND 9),
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
  recipe_json TEXT, bank_requested_at REAL, banked_at REAL,
  PRIMARY KEY(anchor_seq,slot),
  CHECK(banked_at IS NULL OR recipe_json IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_cookout_book
  ON cookout_concepts(banked_at DESC,anchor_seq DESC,slot) WHERE banked_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS cookout_jobs (
  anchor_seq INTEGER NOT NULL REFERENCES cookout_rounds(anchor_message_seq) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('concepts','images','recipe')),
  slot INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','starting','running','ready','failed','unavailable')),
  phase TEXT NOT NULL CHECK(phase IN ('generate','verify')),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch > 0),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 2),
  input_hash TEXT NOT NULL,
  run_id TEXT, candidate_json TEXT,
  claim_token TEXT, lease_until REAL, phase_started_at REAL, deadline_at REAL NOT NULL,
  error_code TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
  PRIMARY KEY(anchor_seq,kind,slot),
  CHECK((kind IN ('concepts','images') AND slot = -1)
     OR (kind = 'recipe' AND slot BETWEEN 0 AND 2))
);
CREATE INDEX IF NOT EXISTS idx_cookout_jobs_due ON cookout_jobs(state,lease_until);

CREATE TABLE IF NOT EXISTS cookout_actions (
  anchor_seq INTEGER NOT NULL REFERENCES cookout_rounds(anchor_message_seq) ON DELETE CASCADE,
  actor_slot INTEGER NOT NULL CHECK(actor_slot IN (1,2)),
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL, request_hash TEXT NOT NULL, applied_rev INTEGER NOT NULL,
  PRIMARY KEY(anchor_seq,actor_slot,operation_id),
  FOREIGN KEY(anchor_seq,actor_slot) REFERENCES cookout_players(anchor_seq,slot) ON DELETE CASCADE
);
```

`pair_json` holds exactly two snapshots; `chosen_id` must belong to that pair. Accepted picks are derived from
offer rows, not copied into a second basket. The role schedule has exactly five entries and turn/player parity
matches `first_slot`. Store checks these domain invariants, not just HTTP shapes.

Completing concepts creates all three concept rows and the image job atomically. Completing a recipe sets its
JSON and bank time atomically. `candidate_json` holds only locally validated food candidates during verify,
never raw provider transcripts, and clears on terminal states. Errors are safe allowlisted codes.

Wipe explicitly deletes actions, jobs, concepts, offers, players and rounds child-first; anchor FKs also ensure
an older process's delete/wipe removes them. Known run ids are captured first for best-effort cancellation
without blocking erasure. `finish_attachment` bumps the owning Cookout anchor revision/event and Gallery
excludes Cookout anchors. Reads assemble round/concepts/attachments in one read transaction.

### 3.13 Routes and views

All routes are under `/api/admin/server`, require normal token auth and bounded strict JSON, and static routes
are declared before `/{seq}`. `Move = {operationId: UUID, expectedRev: positive_safe_integer}`.

| Route | Body / success |
|---|---|
| `POST /cookout/seat` | `{}` → 204; ensure the seat cookie. |
| `GET /cookout/current` | `{seq,rev}` of the one unfinished round, or nulls. |
| `POST /cookout` | `{clientId,deviceId,sender,blind,replace:{seq,rev}|null}` → 201 `{message,view}`; exact replay 200. |
| `GET /cookout/book?limit=1..50&cursor=…` | `{recipes:[BookEntry],saving:[SavingEntry],nextCursor}`. |
| `GET /cookout/{seq}` | `Cache-Control: no-store`; seat-filtered `CookoutView`. |
| `POST /cookout/{seq}/join` | `Move+{sender}` → 200 view; second distinct player starts play. |
| `POST /cookout/{seq}/pick` | `Move+{turnIndex,offerId,ingredientId}` → 200 view; final pick enqueues concepts. |
| `POST /cookout/{seq}/skip` | `Move+{turnIndex,offerId}` → 200 newly committed pair for permitted viewers. |
| `POST /cookout/{seq}/abandon` | `Move` → 200 view; finished cannot be abandoned. |
| `POST /cookout/{seq}/concepts/{slot}/bank` | `Move` → 202 new save intent, 200 replay/existing. |
| `POST /cookout/{seq}/jobs/{kind}/{slot}/retry` | `Move` → 202 new epoch; kind/slot combinations validated. |

Book cursor is a validated encoding of `(banked_at,anchor_seq,slot)`, not an authorization token. `recipes`
contains only completed banked items; `saving` is separately capped at 20 recent pending/failed intents. Both
are derived from live anchor rows and signed per request. Errors retain existing 401/403 semantics; player
failures are `403 not_player`, missing rows `404 not_found`, state conflicts `409 round_open|round_full|`
`seat_required|seat_conflict|wrong_turn|stale_view|stale_offer|skip_limit|bad_state|bank_exhausted|`
`idempotency_conflict|unavailable`, malformed/unchosen input `422 invalid`, and new-AI load guard `429
rate_limited` with Retry-After. Hidden-option guesses get no detailed oracle: authorize before offer validation.

`Message.cookout = {state,rev,blind,picked,total,concepts:JobState|"none",bankedCount} | null`; no ingredients,
job ids, credentials or recipe text. `wyrRefKind` gains `"cookout"`, and historical `wyrSeq`/`wyrRef` stay.

```text
CookoutView = {
  seq, rev, serverNow, state, blind, picksPerPlayer:5, revealed, you:1|2|null,
  players:[{slot,name,picked}],
  turn:{index,of:10,player,attempt:0|1|2}|null,
  offer:{id,role,options:[IngredientView,IngredientView],skipsLeft:0|1|2}|null,
  picks:[{turnIndex,player,ingredient:IngredientView|null}],
  history:[{turnIndex,attempt,player,options:[IngredientView,IngredientView],chosenId}],
  conceptsJob:JobView, imagesJob:JobView, concepts:[ConceptView],
  actions:{join,pick,skip,abandon,retryConcepts,retryImages}
}
IngredientView = {id,name,category,note}
ConceptView = {
  slot,title,description,dishType,technique,
  used:[{ingredient:IngredientView,contribution}],
  omitted:[{ingredient:IngredientView,reason}], staples:[{id,name}],
  picture:{state:"pending"|"ready"|"failed"|"unavailable",thumbUrl,fullUrl},
  recipeJob:JobView,recipe:RecipeView|null,bankedAt,canBank
}
JobView = {state:"queued"|"starting"|"running"|"ready"|"failed"|"unavailable"|"none",
           error:string|null,canRetry:boolean}
```

Open history includes all offers. Blind history contains own offers only, even after completion; nonplayers get
none. Hidden picks retain public turn/slot but `ingredient:null`. A blind nonacting viewer gets `offer:null`
(including no offer id/role) while `turn.attempt` supplies activity. Before Join/after play both turn and offer
are null. `revealed` never exposes abandoned blind picks. Client parsers reject hidden partner fields as a
second lock. RecipeView is the validated recipe with ids and signed media only.

### 3.14 Client

Modules: `admin-ui/src/server/cookout/{api,model,cookoutGame,cookoutCard,recipeBook,recipeView}.ts`, plus
narrow integration in `api/messages.ts`, `gameTabs.ts`, `thread.ts` and `chat.css`.

- Menu: **Cookout — Pick ingredients, discover dinner** and **Recipe book — Dishes you've saved**. Start sheet
  has Open/Blind and Start; it does not create until Start. Pane header `[Cookout  Book  New  ×]`.
- Picking: clear turn line, two vertically stacked ≥48 px ingredient buttons with name/category/note, visible
  refresh action and no required horizontal swipe. Blind shows covered tiles with no secrets in attributes,
  alt text or offscreen DOM. A compact two-player basket shows chips or covered slots.
- Finished: one local reveal, then exactly three picture-first cards with title/description, “Uses N/10”,
  expandable used/omitted/staple chips and Bank. No method in initial HTML or full-recipe request on open.
  Picture area is reserved to avoid layout jumps; text-only cards remain complete.
- Full recipe: original picture, serves/time, ingredient checklist and numbered method. Checklist ticks are
  ephemeral and reset on lock/close. Back returns to concepts; a book tap selects the requested slot.
- Shared frame: `GameKey="cookout"` and normal register/open/offer/replaceOthers. Switching tabs never abandons
  the server round. Use `itemChat.createStrip({popupTitle:"Cookout chat"})`, `gameTabs.chatTarget()` →
  `wyrSeq`, and `gameLabelFor` recognises Cookout. All three concepts share the round's one mini chat.
- Live model: summary revisions trigger a seat-authorized fetch, monotonic rev/session epochs, existing
  2/5/15/30 s read ladder. No optimistic turn increments or reveal. An uncertain mutation reuses operationId;
  on 409 discard the intention and apply the winner. Token renewal re-reads signed image URLs.
- Lock/wipe/detach: no idle-lock suspension for pending jobs; invalidate continuations, cancel local work,
  remove private DOM/images and close book/popups. A late response cannot remount content. Escape remains
  panic; every control carries `data-srv-gesture-boundary`.
- Accessibility: real buttons/headings, polite live regions, focus to the new turn heading, labels beyond
  colour, reduced motion, no automatic audio. At 360×640 and 200% text the content scrolls while mini chat,
  composer and tabs remain reachable. No hover-only or gesture-only action.
- Main card is compact: Cookout/Blind, two progress counts, short job state and Open; ready may show the first
  available concept image and “3 ideas · N banked”. The book uses the old-anchor loader before tab `exists`.

### 3.15 Tests and local proof

Use fake cmd/Comfy for the fast loop; no live inference/GPU is needed for state correctness.

- **Bank/draw pytest:** real bank schema/count/mandatory examples; negative aliases/families/tags/forms;
  fixed-RNG schedule and equal role budgets; distinct families over all 60 possible offers; fresh refreshes;
  no draw on GET; unequal fixture category/family selection; recent-round relaxation and deletion; exhaustion
  is atomic; curated human content-review checklist is separate from schema success.
- **State/route/privacy pytest:** real v20→v21 migration preserving WYR/Adventure; join/first-slot/strict
  turns; three attempts/final reveal; exact replace and completed-basket preservation; operation replay,
  payload-changing reuse, two-store races, stale offer, last-pick exactly-once enqueue; every Access/unlock
  route; cookie flags/hash storage; same-email two-browser play, unique-email rebind, missing/different email
  refusal, same-browser double slot refusal; sentinel partner food absent from pre-reveal bodies, mutations,
  history, SSE, logs and cards; abandoned blind stays hidden; no-store; delete/wipe raw DB/WAL/scrub behavior;
  old-process cascade and mini-chat association behavior.
- **AI/job pytest:** exact food-only prompt allowlist and no attribution/order; concept 8/10 and substantial
  floors, omissions, staples cap, distinctness, malformed/oversized/duplicate-key JSON, extra ingredient only
  in prose; full-recipe amount/unit/time/reference checks; checker failure and one-repair limit; queue/start/
  run/verify/terminal matrix, persisted deadline, unknown start, lease renew/loss, known-run resume, two-process
  claims, no cancelling a successor, delete while working, failure-report recovery by sweep, no indefinite
  pending and no recipe before Bank. Fake cmd verifies caller/model/effort/hidden flags/timeouts/tool policy.
- **Image pytest:** one three-chain graph with exact prompts/seeds/outputs and unchanged pair wrapper; default
  Krea; shared gate/demand; no GPU after delete/lost claim; output-dir mismatch fail-closed; all success/
  failure/cancel paths delete owned history/output/staging including the third chain; atomic attachments,
  quota, processing failure, signed URLs, Gallery, token renewal and retry cleanup. Existing WYR image/pool
  suites stay green.
- **Vitest:** defensive parsers/hidden-field refusal, view/seat epochs, monotonic revisions, stale-request
  handling, every turn/control state, blind placeholders with no secret attributes, exactly three concepts
  without methods, Bank states, image/text states, book/old-anchor loading, shared tabs/chat/labels, reduced
  motion, keyboard and lock teardown. Existing WYR/Adventure suites remain.
- **E2E `server-cookout.spec.ts`:** two browser contexts, open and blind same-email play; create/join/ten
  alternating picks/two refreshes/forced third; wrong-turn/stale race; final reveal; delayed concepts then
  pictures; independent banking with no recipe before Bank; retry; old-anchor book; mini chat; tab replacement;
  360 px and 200% text; Escape/idle/route-away during jobs; delete/wipe while jobs finish; refresh/resume.
- **Acceptance evidence kept distinct:** offline state/privacy/erase proof; real generation accepted for a
  small fixed set of awkward baskets with checker/smuggling outcomes; one real local Comfy three-image smoke
  with no owned leftovers and measured duration; two real phones. Do not turn WYR's pair timings into an
  unmeasured Cookout latency promise.

### 3.16 Documentation and delivery

Update in the same change: promoted `spec/server-chat/09-cookout.md`; `docs/ai/livechat.md` new Cookout
section; `contracts.md` routes/cookies/views/errors; `invariants.md` **Inv 57 if still free** covering seat
binding, blind filtering, erasure/book ownership, Comfy cleanup and cmd retention; `glossary.md`;
`testing.md`; `runbook.md` backend/image outage and recovery; root `CLAUDE.md` store table; one `decisions/`
entry. Strict mypy/TS, self-hosted assets, LF committed rebuilt admin bundle/maps. Every commit uses exactly
`Release-note: General bug fixes and improvements.` Prove locally before the required senior security/
concurrency/schema/background audit and the one final PR/CI sequence.

---

## 4. Merged design — C. Implementation plan

| Parcel / builder | Owned output | Dependencies and proof |
|---|---|---|
| **P0 — contract freeze / integrator** | Promoted spec, canonical bank fixture and request/view/concept/recipe JSON, acceptance checklist, file ownership | First. Fixtures cover open, blind-own-turn, blind-other-turn, finished, abandoned-blind, failed, banked and unavailable. No identity/state/wire question is deferred into parallel code. |
| **P1 — ingredient bank / data builder** | `cookout_ingredients.json`, `cookout_bank.py`, `tooling/cookout/validate_bank.py`, bank/draw tests | Starts after P0 alongside P2–P4. Delivers the tiny typed fixture immediately, then the real bank. Pure `draw_pair(role,seen,recent,rng)` and `snapshot(id)`; never edits `store.py`. |
| **P2 — server state/routes/integration / Sonnet 5.5** | Sole owner of `store.py`, `models.py`, `cookout_game.py`, `cookout_identity.py`, `routes_livechat_cookout.py`, `app.py`, shared server query/wipe/Gallery/message changes and tests | Uses P1's fixture with fake job adapters. Owns real migration, two-store races, HTTP privacy/erase and shared cmd capacity/lifespan wiring. |
| **P3 — AI jobs and pictures / Sonnet 5.5** | `cookout_ai.py`, `cookout_jobs.py`, `cookout_images.py`, narrow `wyr_images.py` extension, AI/job/image tests and fake cmd/Comfy responses | Runs in parallel against a store-port fake. Owns any necessary `cmdchat.py` fix. Exports `CookoutRunner.resume/supervise/wake` and AI/image adapters; sends integration requirements rather than editing `app.py`. |
| **P4 — UI / Opus 5.5** | `admin-ui/src/server/cookout/*`, sole owner of `thread.ts`, `gameTabs.ts`, frontend parser unions, Cookout CSS, local harness/TS tests, committed built output | Starts from P0 fixtures in parallel. Proves every pane at 360 px/200% text, network redaction with fake views, shared tab/chat/lock regressions and strict build. |
| **P5 — docs and integrated E2E / builder** | `docs/ai/*`, `CLAUDE.md`, decision entry, `e2e/tests/server-cookout.spec.ts`, acceptance report | Drafts from P0; integrated tests depend on P2/P3/P4. Consumes P3's supported fake seams rather than editing its response files. |
| **P6 — integrator / original driver** | Merge parcels, reconcile bundle drift, freeze candidate, senior audit and final delivery | After P1–P5 local proof. Shared-file defects return to their owner; one integrator handles final cross-parcel reconciliation. |

Frozen interfaces:

1. **Data → store:** immutable `Ingredient`/`IngredientSnapshot`, `CookoutBank.by_id`, `snapshot(id)`, and
   pure `draw_pair(role,seen_families,recent_round_families,rng) -> pair`; explicit exhaustion. Store owns the
   transaction-consistent exclusion sets and persistence.
2. **Store → jobs:** `CookoutJobKey(anchor,kind,slot)`, typed job snapshot/claim receipt;
   `claim/renew/set_run/stage_candidate/finish_concepts/finish_recipe/attach_images/fail/due_jobs`, all with
   expected epoch+claim+input hash. Completion owns its round revision/event transaction.
3. **Jobs → app:** `CookoutRunner.resume(background)`, `supervise(background)`, `wake(key)` over durable rows;
   losing wake cannot lose work. `CookoutAI.start/poll/cancel` wraps `CmdChatClient`; image adapter wraps the
   configured generator and shared gate/demand. P2 alone wires app/lifespan/shared cmd capacity.
4. **Server ↔ UI:** §3.13 plus checked-in fixtures. Keys absent vs null, public summary, recipe slots, cookie
   behavior and errors are settled before coding. Both parsers must accept the same fixtures.
5. **UI → shared chat:** `GameKey="cookout"`, normal `GameRegistration`, existing ItemChat, `wyrSeq`/`wyrRef`,
   `wyrRefKind="cookout"`, generic old-anchor loader. P4 alone performs this integration.
6. **Acceptance assets:** P3 supplies deterministic delayed/failing cmd/image fixtures; P5 consumes them. P4's
   harness uses the same wire examples.

Sequence: **P0 → P1/P2/P3/P4 in parallel with P5 drafting → integration and real-bank substitution → P5
integrated checks → P6**. Final senior review explicitly covers seat credential/rebinding/CSRF, hidden-field
coverage, migration/old-process cascade, races, unknown external submissions, leases, provider retention,
tool policy and Comfy cleanup.

## 5. Merged design — E. Genuine operator questions

**None blocking the core.** Five picks each, two refreshes per turn, Open by default, final selected-basket
reveal, eight free staples, serves two, independent banking and an anchor-owned private Recipe book are settled
by this spec. The twists below are optional recommendations, not prerequisites or disguised questions.

---

## 6. Merged fun-twist list (B), ranked

All are independent add-ons; the core works with none. Costs include state and tests, not just a button.

1. **⭐ TOP 1 — One rescue swap:** “Hate the beetroot now the ideas are here? Swap one ingredient and let the
   chef try all three again.” **Why fun:** a shared rescue and a second dramatic reveal. **Cost: M.** After
   concepts arrive, one player proposes one of two fresh replacements and the other accepts; once per round.
   A later immutable basket/concept revision preserves already banked recipes and their original images.
2. **⭐ TOP 2 — Dinner vote:** “Pick the dish you would actually eat, then see if you agree.” **Why fun:** a
   satisfying shared verdict and instant conversation when tastes differ. **Cost: S.** Private votes reveal
   together and a match gets a “Dinner decided” badge; it does not auto-bank or remove independent Bank.
3. **⭐ TOP 3 — Cooked it!:** “Make one for real and put your photo beside the chef's daydream.” **Why fun:**
   expectation-versus-reality turns the book into a scrapbook of real evenings. **Cost: M.** Per-recipe cooked
   marker, two ratings/tasting notes and a linked ordinary mini-chat photo; deletion/wipe rules still apply.
4. **⭐ TOP 4 — Chef's vibe wheel:** “Give the same basket a personality: cosy, posh, street food or brunch.”
   **Why fun:** identical ingredients produce wildly different plates and jokes. **Cost: S–M.** A fixed static
   style preset in the start sheet changes only the concept prompt/validation; no free-form style text and no
   new ingredients.
5. **⭐ TOP 5 — Wildcard cloche:** “After ten picks, dare to lift the cloche for a mandatory eleventh
   ingredient.” **Why fun:** a press-your-luck moment just when the basket feels safe. **Cost: S.** An optional
   accepted step adds one adventurous-tier pick that concept C must feature; declining starts ordinary concepts.
6. **Kitchen handicap:** “One pan, no oven, or a fifteen-minute supper: can the chef pull it off?” **Why fun:**
   a familiar basket becomes a useful shared challenge. **Cost: M.** Fixed time/equipment enums are validated
   in the method; never silently drop ingredients to meet the clock.
7. **Lucky dip:** “Can't choose between these two? Let the kitchen coin pick.” **Why fun:** instant suspense
   with no AI wait. **Cost: S.** Server coin flip between the current offered ids under the same operation and
   offer guards; it does not grant a refresh or change the skip budget.
8. **Fridge raid seed:** “Start with one ingredient you actually have tonight, then draft around it.” **Why
   fun:** fantasy Cookout becomes a practical answer to “what do I do with these chicken thighs?” **Cost:
   S–M.** A bank-backed autocomplete seeds one pick at creation; all remaining turns use the normal draw.
9. **Secret star ingredient:** “Secretly star one of your picks; the chef must make both stars shine.” **Why
   fun:** each player has a personal stake in the reveal and the stars can clash. **Cost: M.** Each marks one
   already selected ingredient before the basket closes; stars become substantial required uses in every
   concept. An explicit ready state prevents an unstarred player stalling the ordinary core.
10. **The chaos shelf:** “Once each, brave two ingredients from the strange shelf.” **Why fun:** the odd choice
    becomes something you owned rather than random punishment. **Cost: M.** Opt-in replacement of one turn's
    pair with two adventurous-tier options; normal refreshes, uniqueness and alternation remain.
11. **Partner mischief token:** “Once per open game, veto one card or steal your partner's latest pick.”
    **Why fun:** anchovies and durian become instant banter. **Cost: M.** Open mode only; one clearly labelled
    token per player, either replacing one current option or proposing a latest-pick swap before concepts. It
    never silently changes a committed basket.
12. **Leftover encore:** “Make tomorrow's basket start with the ingredients today's chef left behind.” **Why
    fun:** omissions become a storyline and a reason to try a second round. **Cost: M.** Creates a new anchor
    with agreed leftover seeds and normal remaining draws; no immortal link survives deletion, and the original
    banked recipe is immutable.

## 7. Remaining disagreements / evidence that would settle them

There is no remaining disagreement that should block implementation or needs an operator ruling. Two tuning
questions deserve evidence during acceptance rather than more panel opinion:

- **Does the independent manifest checker earn its extra latency?** Measure accepted/rejected awkward baskets,
  seeded prose-smuggling cases, false-positive rate and p50/p95 generate+check duration. I would keep it unless
  measured false positives make valid games unreliable; structural id validation is not negotiable either way.
- **Are the role schedule and tier weights enjoyable with the real bank?** Inspect simulated maximum-refresh
  baskets plus a small human play sample for repetition, incoherent role assignments and over/under-exotic draws.
  Tune category membership/weights from that evidence without weakening family uniqueness or equal player roles.

The strict seat boundary, two refreshes per turn, five picks each, selected-only final reveal, eight-staple
allowlist, text-before-pictures, Bank-only full recipes and anchor-owned erasure are not left open.
