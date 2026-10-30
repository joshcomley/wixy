# Glossary

Domain terms and status machines. The normative source for the content-model terms is
[`spec/02-content-model.md`](../../spec/02-content-model.md).

## Content model

- **Site repo** — `joshcomley/cottage-aesthetics-preview`; the single source of truth for
  everything the public sees (templates, content, theme, images). Distinct from the **engine
  repo** (this repo, `joshcomley/wixy`).
- **Three layers** — **Templates** (`pages/*.html`, `partials/*.html`), **Content**
  (`content/*.json`), **Theme** (`theme/theme.json`). Published output =
  `build(templates, content, theme)`.
- **Binding** — a `data-wx-*` attribute on a template element that binds it to a content
  value. Kinds: `data-wx` (innerHTML/rich-lite), `-img` (`{src,alt}`), `-href`, `-bg`
  (background-image), `-attr` (`attr:key`), `-list` (collection array) + `-list-item`,
  `-if` (conditional). See [contracts.md](contracts.md) §6 for the `BindingKind` set.
- **Key resolution** — a plain key (`hero.title`) → the page's `content/<slug>.json`;
  an `@`-prefixed key (`@phone`) → `content/_global.json`; a `.`-prefixed key (`.title`)
  → the current `data-wx-list` item. Dotted paths descend dicts only, never index arrays.
- **`@nav`** — the navigation list. **Builder-generated, never stored** (`builder/nav.py:
  build_nav` derives it from pages' `meta.inNav`/`meta.navOrder` + `_global.navExtra`, then
  injects it before validation so `data-wx-list="@nav"` resolves like any key).
- **Collection** — a `data-wx-list` container bound to an array; edited as a whole unit
  (the overlay stores the entire array under the list key). Seven load-bearing collections
  after migration (`spec/02` §6, = the 7 `COLLECTION_RULES` rows); each item validated against
  one of the **8** `builder/schemas/*.json` — the 8th, `footer-link`, is applied by a
  special-case in `validate`, not a rule row.
- **Rich-lite text** — the restricted HTML fragment allowed in `data-wx` values: tags
  `a/em/strong/br/span`, `class` only `js-book` on `a`/`span`, URL schemes http(s)/mailto/
  tel. Enforced by `builder/sanitize.py:sanitize_rich_lite` (over `nh3`) on every draft
  write and every render.
- **`meta` block** — the reserved per-page content object (`title`, `description`,
  `ogImage`, `navLabel`, `inNav`, `navOrder`) the builder consumes for `<head>` injection
  and nav derivation. No binding annotation needed.
- **slug** — a page identifier `[a-z0-9-]+`; `pages/<slug>.html` → `/<slug>` (the published
  URL, extensionless — decisions/00128 supersedes the original `/<slug>.html` shape; the
  on-disk template/output filename is still `<slug>.html`, unchanged; the home page's slug is
  **`index`** everywhere the model threads; `home` survives only in `<body data-page="home">`).
- **`theme.css`** — builder-emitted `:root{ --<color>:…; --shadow:…; --font-<role>:… }` from
  `theme/theme.json`; color keys are the CSS var names minus `--`. Linked before `site.css`.

## Draft / publish

- **Draft overlay** — the sparse per-key edit state at `draft/overlay.json`. Shape
  `{rev, baseSha, ops:{"<file>:<dotted.path>":{value,ts,by}}, pages:{added,deleted}}`. The
  visual editor never writes content files directly — it accumulates ops here.
- **op** (`DraftOp`) — one overlay edit: `{file, path, value}` or `{file, path, discard:true}`.
  `file ∈ <slug> | "_global" | "theme"`. Scalars overlay per key; collections overlay the
  whole array.
- **rev** — the overlay's monotonic revision. Every mutation bumps it; a PATCH carries the
  `expectedRev` it was based on; a stale one → **409** (optimistic concurrency).
- **baseSha** — opaque passthrough recording the overlay's base; merge is always computed
  against live `origin/main`, so this is informational.
- **Merged content** — `content = checkout ⊕ overlay` (`merged_content.py:merge_overlay`):
  overlay wins per key; un-drafted keys flow through from `origin/main` (so AI-lane upstream
  edits appear in the draft). Deletion is *not* applied here (takes effect at publish).
- **Preview mode vs publish mode** — the two builder render modes. **publish** removes falsy
  `data-wx-if` branches (byte-authoritative); **preview** keeps them (`data-wx-hidden="1"`)
  and still validates them. Preview injects the editor assets; publish does not.
- **live pointer** (`live.json`) — `{sha, version, buildDir}` naming the currently-served
  build. Written atomically; the **only** thing that changes the live site. Read fresh per
  request (no in-process cache).
- **build** — an immutable, content-addressed `builds/<sha>/` directory of static output.
- **Publish** — materialize the overlay into content/theme files → commit → push → build →
  verify → swap the live pointer → append a ledger entry → clear the overlay. See
  [publish-pipeline.md](publish-pipeline.md).
- **Restore** — flip the live pointer to a past version's build and set the overlay to the
  diff so the draft equals what's now live. No commit until the owner next publishes.
- **Ledger** — the append-only `publishes.jsonl` product-level history (one entry per
  publish/restore). `git log` + `wixy-publish-v<N>` tags are the forensic layer.
- **version** — the sequential ledger number (`next = max+1`, never reused, even by a
  restore that revisits an old sha). The first-serve bootstrap is version **0**
  (`bootstrap.py:BOOTSTRAP_VERSION`); real publishes are 1-based (the first human publish is v1).
- **Editor lane / AI (upstream) lane** — the two ways content changes: the owner's overlay
  edits (Editor lane) vs cmd agents' PR→main work (AI lane). Both merge into the draft; only
  Publish goes live.
- **Upstream watcher** — the 60s loop (`watcher.py`) keeping the Storage checkout
  fast-forwarded to `origin/main` so AI-lane merges surface in the draft.

## Deploy / fleet

- **Project registry** — `projects/*.json` in the engine repo (in-repo, code-reviewed). One
  per site; loaded at startup. Fields incl. `slug`, `repo`, `cmdProject`, `domain`,
  `indexable`, `media`. Deep dive of the `ca.json` shape in [runbook.md](runbook.md).
- **`cmdProject`** — the registry field naming the cmd clone directory used for the AI chat
  lane (`cottage-aesthetics-preview`). Selects *which* cmd project, never the cmd host.
- **cmd** — the fleet's self-hosted chat spawner (localhost `9320` portal + `9321`
  Cmd-Chats introspection). Every wixy AI conversation *is* a real cmd chat. See
  [ai-chat.md](ai-chat.md).
- **Slot / blue-green** — `Slots\blue` + `Slots\green` are two independent engine checkouts;
  `active.txt` points at the live one. Deploying = merge `main`; Slots builds the inactive
  slot, smoke-probes it, flips `active.txt`. **Never edit a slot** (Invariant 19).
- **Storage** — the runtime-state tree (`D:\Servers\Wixy\Storage\`) that survives slot
  swaps. The site-repo checkout under it is machine-managed runtime data, *not* an authoring
  clone (Invariant 19's exception).
- **CF Access** — Cloudflare Access; the only auth for `/admin*`. Wixy verifies the edge-
  issued JWT (`auth.py`); it issues nothing.
- **Slot anti-stale gate** — Slots' smoke probe requires `GET /api/version`'s
  `commit.sha_full` to match the just-deployed sha before flipping `active.txt`.

## Server chat

- **Decoy** — the real Server status panel shown before unlock; it contains no chat state or
  activity signal. One tap inside the panel reveals the separate unlock affordance.
- **Multi-tap** — two qualifying primary-button taps within 400 ms. In the unlocked chat it
  locks immediately. A `data-srv-gesture-boundary` control can finish an existing tap run but
  cannot start one; an unmatched boundary tap clears the partial run.
- **Unlock token** — a 12-hour, email-bound HMAC token minted after cmd verifies the PIN. It is
  held in browser memory, sent in `X-Wixy-Server-Token`, and never placed in persistent browser
  storage or a query string.
- **Lock cause** — a model event that returns the chat to the decoy: idle, panic, multi-tap,
  Escape, hidden document, route-away, unauthorized response, or token expiry. Lock detaches
  the chat DOM; file-picker and microphone-permission suspensions are the only hidden-document
  exceptions.
- **Attachment status** — `processing` while a queued upload is normalized; `ready` when its
  private renditions can be served; `failed` when processing cannot produce renditions.
- **Transcript status** — a voice note's opt-in transcript is absent (`null`) until someone taps
  Transcribe; then `pending` while the job runs, `done` (with the text) or `failed` (retryable). A
  `pending` row found at startup becomes `failed`. It is erased with its message (Inv 50).
- **Private mode (cmd)** — cmd's `POST /api/transcribe` with `private=1`: no audio or transcript is
  saved or logged. wixy sends a voice note to cmd only in this mode and only while
  `GET /api/transcribe/capabilities` answers `{"private": true}`.
- **Erasure pending** — `erasurePending: true` means a committed delete or wipe still has
  database-byte or filesystem cleanup to finish. The routes return 202; they return 204 only
  when no erasure work remains.
- **`deleted_storage` tombstone** — an internal per-attachment or per-upload cleanup record.
  It is not a deleted-message placeholder and never appears in chat history or events. A
  generation check preserves late requeues; completed records are pruned after seven days.
- **`pending_scrub`** — the schema-v6 singleton token that records outstanding SQLite WAL
  scrub work. Delete/wipe writes it in the same transaction as row removal; the worker
  compare-and-clears it after a successful scrub. Migration v6 imports legacy `scrub.pending`.
- **Wipe-sweep token** — the `pending_wipe_cleanup` token that keeps a full orphan-path sweep
  retryable after a wipe or failed startup scan. Full-tree scans run at startup and while this
  token is pending, not on every ordinary worker tick.
- **`ContainedTaskGroup`** — the app-lifetime wrapper for background work. `supervise` restarts
  long-running loops with backoff; `spawn` contains one-shot exceptions. Neither lets a task
  exception cancel sibling app work.

## Status machines

**Publish stages** (`publisher.py:PublishStage`, on `PublishJob.stage`):
```
pulling → merging → committing → building → verifying → swapping → done
   └──────────────── (any stage) ────────────────────────────────→ failed
```
`PublishJob.is_running = stage not in ("done","failed")`. `PublishError.stage` only ever
carries `pulling`/`merging`/`committing` (build/verify raise `BuildError`; swap doesn't
fail-raise). Only **swapping** changes the live site — any failure before it leaves live +
ledger + draft untouched.

**Ledger source kind** (`ledger.py:PublishSource`): `editor` | `upstream` | `mixed` |
`bootstrap`. Computed by `_publish_source_kind` from whether the publish carried draft ops
and/or upstream commits; `bootstrap` is authored only by the first-serve path.

**Chat conversation status** — `app.state.chat_runtime` maps convId →
`chats.py:ChatRuntimeEntry(status, failure_reason?, failure_message?)` (transient, never
persisted), where `status` is the `chats.py:ChatStatus` Literal `pending` → `ready` | `failed`.
(Distinct from `cmdchat.py:ChatStatus` — a *different* type: the cmd-client live status
`{activity, process_kind, handover_state}` returned by `get_status`.) A conversation absent
from the runtime map reads as `ready` (decisions/00032). On failure, `failure_reason ∈ workspace_failed |
cli_failed | timeout | unreachable` — `unreachable` (cmd down) is a distinct UI state from a
real provisioning failure (decisions/00031).

**Checkout state** (`checkout.py:ensure_checkout`, implicit): `.git` absent → full
`git clone` (never shallow — restore needs arbitrary history); `.git` present → `git fetch` +
`git merge --ff-only`. A non-fast-forward local state is a hard `CheckoutError`, never forced
(Invariant 8).

- **Device grant** — the credential behind "Keep this device unlocked" (Inv 48): a random secret held
  by ONE device, stored on the server only as a hash, created only with the PIN, bound to the CF
  Access identity, revocable, expiring after 30 days unused. It mints an ordinary unlock token; it is
  never itself one.
- **Paused grant** — a grant set aside after a deliberate lock or a checkbox-caused lock
  (`wx-srv-grant-paused = "1"`) until the PIN is entered again. Set the INSTANT a background switch
  begins a shield (not when the shield later resolves), so a page reloaded, closed or discarded
  mid-shield is still found paused on the next mount.
- **Shield** — what a background switch does when the two lock checkboxes differ: the decoy goes up
  and the chat detaches at once, but the in-memory session is kept for up to half a second after the
  page returns so the cause can be worked out; only a known cause whose box is unticked restores it.
  A SECOND switch inside one shielded absence taints it (`shieldTainted`) — the evidence window is
  anchored to the first hide, so a later switch's cause is unreadable against it — and forces the
  eventual return to stay locked regardless of what the evidence says.
- **Causal evidence** — the Architect's ruling on what "an event was seen" means (§8, decisions/00161):
  a screen-lock event counts as the CAUSE of a hide only if its dispatch time falls inside
  `[hideAt-1000ms, hideAt+2000ms]`; one delivered only once the page resumes (a batched event, seen
  anywhere later in the absence) is evidence the device CAN report locks, but not evidence of why
  THIS hide happened, and never restores or locks the current shield on its own.
- **Proven device** — a device that has delivered a CAUSAL screen-lock event during a hidden interval
  (`wx-srv-screenlock-proven`). Only such a device may read "no event, causal or batched" as "a tab
  switch". The proof is cleared on mount whenever there is no detector left able to have earned it
  (permission revoked, or no Idle Detection API at all).

## Adventure Time (the globe holiday game, workspace 00056, Inv 56)

- **Game-chat anchor** — the message a game's mini chat hangs off. The wire names `wyrSeq` (request)
  and `wyrRef` (message) are historical: they mean the game-chat anchor of ANY game — a
  would-you-rather round or an Adventure Time round — and `wyrRefKind` (`"wyr"` or `"adventure"`)
  says which. Renaming them would break cached clients mid-deploy.
- **Round state** (`adv_rounds.state`, `AdventureState`) — `spin_lng` (waiting for the sideways spin)
  -> `spin_lat` (waiting for the up/down spin, which lands) -> `country` (the country roulette is
  flickering; Stop picks one) -> `destination` (the roulette over that country's top places; Stop
  picks one — skipped when only one place is left) -> `chosen` (a place waiting for a decision) ->
  `banked` ("Let's go there") or `rejected` ("No"). `abandoned` = a newer adventure started before
  this one reached `chosen`. A `chosen` round is never abandoned.
- **Pack state** (`adv_rounds.pack`, `AdventurePackState`) — the researched holiday pack: `none`
  (before `chosen`) -> `pending` (the research is running) -> `ready` | `failed`; `unavailable` = no
  researcher is configured (the standalone edition) or cmd could not be reached to start one.
  `failed` (or `unavailable` once a researcher exists) -> retry -> `pending`. Bank and Reject work in
  every pack state.
- **Landing / candidates** — where the up/down spin ended (`point`), the nearest land if that was
  sea (`land`), the point the camera zooms to (`centre`, 30 % inland), and the 1-10 map units lit
  by the country roulette (`candidates`). Computed by the client, validated and stored once by the
  server.
- **Roulette** — the shared flicker: the server stores a `seed` and a `rouletteAt` start time; both
  screens derive the lit item from server time (four a second). Stop posts the id the presser saw
  lit; a Stop before `rouletteAt` (less 1 s) is `too_early`.
- **Never-again list** (`adv_rejected`) — destination ids the pair turned down. Survives deleting the
  round's message; a wipe clears it. **Bank minus rejected minus banked** = what a draw may land on.
- **Advised unit** — a map unit under a UK FCDO "advise against all travel" to the WHOLE country
  (`advice` in the bank). Left out of draws unless the shared preference
  (`adv_settings.include_advised`, off by default, operator decision #2113) switches them in.
- **Holiday pack** — the food / places to stay / culture / sights / things to do / practical
  write-up of a chosen place, researched live through a hidden cmd chat-spawn run
  (`adventure_pack.py`), sanitised and stored on the round.
- **Images state** (`adv_rounds.images`, `AdventureImagesState`) — the pack's PICTURE job: `none`
  (the text pack is not in yet, or this server fetches no pictures) -> `pending` (set in the same
  write that stores a `ready` pack; the server is finding and fetching pictures) -> `done` | `failed`.
  The wire's `pack.images` is `"pending"` or `"done"` only. Pictures are ordinary photo attachments on
  the anchor message plus a slot map (`adv_rounds.pictures`: slot -> attachment ordinal, credit, source
  page, caption); a slot is `hero:<n>` or `<section key>:<item index>`.
- **Dishes section** (`dishes`, "Local food to try") — the pack's first section: 4-6 signature local dishes and drinks (the dish itself, not a restaurant; `food` is "Where to eat"). A dish's photo must pass two checks (`livechat/adventure_dishes.py`): its title names the dish and its categories/description mention food.
- **Safe fetch** (`livechat/safe_fetch.py`) — the one SSRF-safe GET behind every picture and page fetch
  (public addresses only, vetted at connect time, bounded, polite); see Inv 56.
- **Live trail** — the dragger's finger trail, relayed id-less as `adventure_live` SSE frames and
  never stored.

## Cookout (the two-player cooking game, workspace 00058, Inv 57)

- **Round** (`cookout_rounds`) — one game, anchored to a text-less message. `state` is `picking` (turns 1..10, five
  picks each, strictly alternating, slot 1 on odd turns), `finished` (all ten picked) or `abandoned` (a newer Cookout
  started, or **End game** — never from `finished`). `blind` is chosen at the start and never changes.
- **Slot / seat** — slot 1 is the starter; slot 2 is bound only by an explicit **Join**. Identity is the
  would-you-rather rule (`slot_of`: the name key, plus the Access email when both sides have one), so Blind mode is a
  no-peeking feature, not a security boundary (Inv 57).
- **Turn, offer, skip** — a turn is one player choosing one ingredient. An **offer** is a pair of ingredients the
  server dealt (`offerIndex` 0, 1 or 2); **Skip** ("Neither") deals a fresh pair for the same turn, at most twice
  (`skipsRemaining`), and the third pair must be picked from (`skip_exhausted`). A skip never passes the turn.
- **Role** — the culinary part a turn draws for: `base`, `protein`, `produce` (twice) or `accent`, in a per-round
  shuffled order, each served to both players on paired turns. Blind mode hides it from the non-active player too.
- **Basket** — the ten picked ingredients. **Staples** — the eight cupboard items (`water`, `salt`, `black-pepper`
  free; `butter`, `plain-flour`, `cooking-oil`, `granulated-sugar`, `milk` also pickable) a dish may add, at most four
  unpicked non-seasoning ones. **Family** — a group of close variants (the three onions) of which only one is ever
  picked in a round. **Rarity** — `everyday`, `uncommon`, `exotic` (draw weights 8 : 3 : 1; every pair has an
  everyday side).
- **Revealed** — Open rounds always; a Blind round exactly when `finished`. It shows the ten picks to both, never the
  partner's skipped or unchosen pairs, and never happens for an `abandoned` round.
- **Concepts state** (`cookout_rounds.concepts`) — `none` (not finished) → `pending` ("Chef is inventing 3
  dishes…") → `ready` (the three **dishes**, ids `a|b|c`, each with a title, vibe, dish type, technique, description,
  the picked ingredients it uses, the staples it adds and the omitted ones with reasons) | `failed` (retryable) |
  `unavailable` (no AI runner, e.g. the standalone edition).
- **Images state** (`cookout_rounds.images`) — the dishes' PICTURES: `none` (no ComfyUI) → `pending` → `done` (all
  three) | `failed` (a slot is missing; the ones drawn are kept and **Retry picture** draws only the rest).
  `images_generation` fences each attempt; the pictures are private photo attachments on the anchor.
- **Recipe state** (`cookout_recipes.state`, per dish) — no row = not asked; `pending` ("Writing recipe…") →
  `banked` ("Banked ✓", appears in the Recipe book) | `failed` | `unavailable`. A dish is `banked` only when a valid
  full recipe is stored. **Bank this** is the tap that asks.
- **Recipe book** — the full-height screen listing every `banked` recipe newest first; derived, not stored
  separately, so deleting a round's message removes its recipes.
- **Contraband scan** — the deterministic check of every word of an AI answer against the bank's ingredient names
  and aliases, rejecting any food that is not a used pick, a declared staple or a stop word; one repair run, then
  `failed`. **Frozen manifest** — the fixed list of ingredient and staple ids a dish's recipe may use (plus water,
  salt and pepper).
- **`moveId`** — the client-made id (8-64 chars) of one skip, pick or bank; replaying it is a no-op 200.

### Cookout twists (workspace 00058, spec 09a, Inv 57)

- **Twist** — one of twelve optional extras on a Cookout round. *Start-sheet twists* (style, challenge, cloche, stars, fridge
  raid) are fixed at creation; *in-game twists* (lucky dip, chaos shelf, veto, dinner vote, rescue swap, We cooked it!) are
  buttons the players may ignore; *encore* is a new-round entry point. A round with no twist is the core game exactly.
- **Style / Challenge** — the Chef's style (eight fixed ids, or `spin` resolved by the server) and the Kitchen challenge
  (`one-pan`, `no-oven`, `thirty-minutes`, `six-steps`), both static enums in `cookout_twists.py`. The challenge is
  validated by deterministic Python; the style only shapes the prompt and the picture phrase.
- **Starter** — a bank ingredient placed into the basket at creation (fridge raid, or an encore seed) as a seeded turn. At most
  two per round; public in both modes; counts towards the player's five.
- **Lucky dip / Chaos shelf / Veto** — server-decided drafting twists on the live pair. Dip: a coin picks for you. Chaos
  (once per player): both options become exotic. Veto (once per player, **Open mode only**): the partner sweeps one option
  off your table. They replace in place, so `offerIndex` and `skipsRemaining` do not change. Used tokens are derived from the
  turns (`chaos_offer`, `veto_offer`), never stored on the round.
- **Wildcard states** (`cookout_rounds.wildcard`) — `off` → (cloche armed) `armed` → at the tenth pick `offered` → `lifted`
  (an 11th ingredient was drawn) or `declined`.
- **Gate** — the pause between the Big Reveal and the chef: with the cloche armed or stars on, a finished round keeps
  `concepts = none` until the cloche is answered and both stars are set (`view.gate.waitingFor`). It has no timeout.
- **Star / stars_locked** — each player secretly stars one of their own picks; the chef must make both the heroes. Reveal and
  lock are one transition, once both are set on a finished round.
- **Dinner vote** — each player secretly taps the dish they would eat tonight; both are revealed and locked together; a
  match is "Tonight's dinner!". Never banks anything.
- **Game mode** (`cookout_rounds.mode`, schema v22) — `classic` (default) or `toastie` (Toasted sandwich: a bread on turn 1, a filling on turn 2,
  fillings drawn from the mode's candidate pool by `family`). Data in `cookout_modes.json`; enabled per server by `WIXY_COOKOUT_MODES`.
  An unknown mode id is read-only (409 `bad_state`, abandon allowed). Bank entries carry `kind` on each ingredient snap (null for Classic).
  Not to be confused with **Open / Blind play** (`blind`), the older way of playing, independent of the game mode; the code and
  docs say "play style" / "Open/Blind play" for that, and "mode" only for the game mode.
- **Pick kind** (`PickSnap.kind`, `mode.kinds[]`, `current.role`) — what one turn offers. Classic: one of the four bank roles.
  Toasted sandwich: `bread`, `cheese`, `main`, `produce` or `finish`. Each kind has a `label`, a banner `prompt` (<= 22 chars), a
  candidate pool, a `facet` and whether the chaos shelf works on it.
- **Facet** (`category` | `family`) — the axis that keeps a pair varied. `category` is the core rule; `family` is for a kind whose whole
  pool shares one category (every bread is `grains-bakery`, every cheese `dairy-eggs`), so the pair must come from two different
  families and the least-shown tie-break counts families.
- **Bread** — the one `bread`-kind pick of a Toasted sandwich, made by the starter on turn 1 from a curated list of 52. It is the
  mode's **anchor** (`mode.anchorKind`): every chef idea uses it, the reveal shows it in its own first row, and each dish card says
  "On <bread>" from the basket's own snapshot, never from the chef's prose.
- **Filling** — every other Toasted sandwich pick (turns 2-8): a cheese, a main filling, veg or fruit, and the finishing touch.
- **Build** (`concept.build`, `{id,label}`) — how a toasted sandwich is made: `pressed`, `skillet`, `grill-toasted`, `oven-baked`,
  `dipped`, `crunchy-crusted` or `jaffle`. Mode data maps it to a `technique`, a prompt phrase and a picture phrase; every idea has a
  different one, and a dish card shows it as a pill in place of dish type / technique.
- **Signal** (`Parsed.signals`) — a non-fatal chef-prose note (e.g. `open sandwich`, `bruschetta`) for a person to read in the trial
  report; it never rejects or repairs an answer.
- **Generation** (`cookout_rounds.generation`) — which set of three dishes is on the table. Starts at 1; a completed **rescue
  swap** (states `none` → `proposed` → `done`, once per round) archives the old set into `cookout_generations` (read-only,
  the "Earlier dishes") and starts generation 2. Concept ids `a|b|c` repeat per generation, so Bank, vote and the retries
  carry `generation`. Banked recipes stay tied to the generation they were made in.
- **Forbidden ids** — the swapped-out ingredient: forbidden in every later generation, even as a declared cupboard staple.
- **We cooked it!** — a banked recipe marked cooked (`cooked_at`, `cooked_by`), with a 1-5 rating per player and an optional
  link to a real mini-chat photo, beside the AI's picture.
- **Encore** — a new round seeded from a finished one: *leftovers* (the ingredients a dish left out) or *remix* (a banked dish's
  own ingredients). Stores only a nulling link to its source.
