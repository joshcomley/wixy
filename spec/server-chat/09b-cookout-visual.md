# Server chat — Cookout round 2: ingredient pictures, catalogue and the picture-first table

Addendum to [`09-cookout.md`](09-cookout.md) (core) and [`09a-cookout-twists.md`](09a-cookout-twists.md)
(twists). Same authority: decided, implement faithfully. Where this file is silent the core and twists
specs stand unchanged. Out of scope: the chef-validation failure (`triad/cookout/briefs/r2-chef-fix.md`
owns `cookout_ai.py`, `cookout_bank.py` and `cookout_ingredients.json`; nothing here touches them).

## 0. The ask (operator, verbatim, after his first real game, 2026-10-29)

> "we need actual isolated images of every single ingredient. Let illustrate what it is that's checked
> by an AI to read each ingredient and check it, to look at the image and make sure it's correct. So I'd
> start with Haiku, putting the catalogue together. Haiku should be fine for checking the images as well.
> Do a spot check, though. Do 50 with Luna and 50 with Haiku. And see, set Sol and Opus to check each one
> and see if they got them right. Then, once that's done, choosing the ingredients should be a much
> cleaner UI experience. Right now it wasn't really clear who should do what. Things are scrolling at the
> bottom. It should be contained to fit. The UI should contain itself to fit within the phone screen
> because it will be mostly played on the phone. Obviously it should look good on desktop too, but it
> will be mostly played on the phone. And it should show you the pictures. It should say what they are
> and show you the pictures of the ingredients so you can choose. So it should be a much more visual
> experience to prepare your ingredients list. When the chef is thinking, it should show a carousel of
> the ingredients you've chosen and some fun facts about those ingredients. There should be a nice,
> light, simple intro screen. Light as in not too complicated. That just says, you're playing non-blind
> mode. You'll take turns to choose ingredients and see which ones you've chosen. Just so it explains a
> little bit. But yeah, the actual game screen itself should just be icons for the food. We do need the
> pictures in there, and it should be picture-centric when choosing which food, which of the two."

His first-play screenshot showed the finished basket as small emoji chips in a scrolling pane.

**Reading of "icons for the food" (decided).** "The actual game screen itself should just be icons
for the food. We do need the pictures in there" means *the game screen is pictures of the food, not
text and emoji chips*. It does not mean drawn icons. Every place an ingredient appears in the game
uses its picture (big on the pick cards, small thumbnails everywhere else). Emoji remain only as the
fallback when a picture is missing.

## 0.1 Models (cmd chat-spawn providers; codex is flat-rate, never `openai`/`openrouter`)

| Name | `provider` | `model` | Used for |
|---|---|---|---|
| Haiku | `claude` | `claude-haiku-5-5` | catalogue author pass, fact-check pass, image checker (full run, subject to §C.4) |
| Luna | `codex` | `gpt-6-luna` | calibration checker (50 images); fallback full-run checker (§C.4) |
| Sol | `codex` | `gpt-6.1-sol` | calibration judge; tie-break on `unclear` image verdicts; fact audit |
| Opus | `claude` | `claude-opus-5-5` | calibration judge; final review of persistent image failures |

All runs go through cmd's `POST http://127.0.0.1:9320/api/chat-spawn/runs` on `bucket: "subscription"`
(verified live on 2026-10-29 by `GET /api/chat-spawn/capabilities`: all four model ids are listed;
`provider`, `tool_profile` and `disallowed_tools` are accepted fields; profiles `judge`, `replay_probe`,
`scout`, `analyst`, `researcher` exist). Never the Anthropic API (repo rule).

## 0.2 The order of work (one line each)

1. **Catalogue** (§A): Haiku writes, per ingredient, a "what it is" line, a picture description and
   2–3 fun facts; a second Haiku pass fact-checks; Sol audits a sample. Committed JSON.
2. **Pilot pictures** (§B): 600 pictures, spread across all 15 categories, on hub's ComfyUI.
3. **Calibration** (§C.3): 100 random pilot pictures; Luna checks 50, Haiku checks 50; Sol and Opus
   each judge all 100 verdicts; a plain-English report to the operator, and a pre-stated rule picks
   the checker for the full run.
4. **Full run** (§B, §C): every remaining ingredient pictured and checked, failures regenerated,
   persistent failures reviewed by Opus, the rest listed.
5. **Pack** (§B.6): the accepted pictures become a versioned picture pack; a committed manifest pins it.
6. **Server + UI** (§D, §E) build in parallel with 1–5 against an empty manifest and ship before the
   pictures exist (every picture has an emoji fallback); the pictures switch on when the manifest lands.

---

## A. The ingredient catalogue (built by Haiku)

### A.1 What it holds

One entry per pickable bank ingredient (`cookout_ingredients.json` `ingredients[]`, today 3,491) **plus
the three free seasonings** (`water`, `salt`, `black-pepper`, which live only in `staples[]`), so the
staples footer can show pictures too: **3,494 entries**. Per entry:

| Field | Rule | Purpose |
|---|---|---|
| `what` | 10–72 chars, plain British English, one sentence, no ingredient name repeated at the start ("A …"/"Small …" style), no HTML/URL/emoji | the "what it is" line under the picture |
| `visual` | 30–260 chars | the subject description inserted into the fixed image prompt (§B.2) |
| `presentation` | enum `whole \| cut \| heap \| bunch \| bowl \| jar \| bottle \| glass \| plate \| portion` | how it is normally seen raw / as bought; drives the checker's expectations |
| `facts` | 2–3 strings, each 25–150 chars, distinct, no HTML/URL/emoji | the chef-thinking carousel |
| `nameKey` | first 16 hex of sha256 of `name + "\x1f" + aliases joined by "\x1f" + "\x1f" + category` | staleness check: if the bank entry is renamed or recategorised, the entry is stale and the validator fails |
| `source` | `{author, factCheck, at}`: model ids and an epoch-seconds number | provenance (never parsed back as a date) |

The `what` line is new and deliberately separate from the bank's existing `blurb` (which is a culinary
note such as "Smoky, coarse sausage with Cajun heat"). The operator asked that the game "say what they
are": `what` is written for someone who has never heard of the ingredient ("A large tropical sea
crustacean with sweet, lobster-like meat."). The UI shows `what`, falling back to `blurb` when an entry
is missing.

**Presentation rules Haiku must follow in `visual`** (in the author prompt, checked by the validator
where mechanical):
- One ingredient, how a shopper or cook would see it raw or as bought: a whole lemon, a fillet of
  salmon, a bunch of parsley, a small heap of cumin seeds, a block of cheese with one wedge cut.
- Liquids, pastes, powders and small loose items go in a **plain vessel**: "a small plain white
  ceramic bowl", "a plain unlabelled clear glass bottle", "a plain glass jar without a label", "a clear
  drinking glass". The validator requires `presentation ∈ {bowl, jar, bottle, glass}` when the bank
  category is `oils-fats-condiments`, `sauces-stocks-fermented` or `drinks-alcohol` **unless** `visual`
  names a whole natural form (e.g. a whole vanilla pod, a honeycomb piece) and `presentation` is
  `whole`/`cut`; any other combination is a validator error with the id.
- Prepared foods (tinned baked beans, ramen, toast) are shown **as the food, served plainly** ("baked
  beans in tomato sauce in a small plain white bowl"), never as a tin, pack or branded wrapper.
- Never in `visual`: brand names, text, labels, packaging, hands, people, cutlery, garnish, other foods,
  scenes, tables or cutting boards (a cut item lies directly on the background; there is deliberately
  no `board` presentation). The validator rejects the words `brand`, `logo`,
  `label` (except in "unlabelled"/"without a label"), `packet`, `tin of`, `can of`, `hand`, `person`,
  `fork`, `knife`, `spoon`, `garnish`, `with` followed by another bank ingredient's exact name.

### A.2 Fun facts: the honesty rule (decided: a second Haiku pass AND a rule AND an audit)

Rules in the author prompt (and a validator for the mechanical ones):
1. Only facts that are widely documented and that a food encyclopedia would state plainly: origin,
   history, how it grows or is made, how it is used around the world, the meaning of its name.
2. No health or nutrition claims, no medical words (validator rejects `cure`, `prevent`, `boost`,
   `immune`, `detox`, `cancer`, `heal`, `superfood`, `antioxidant`, `calorie`, `vitamin`, `protein-rich`).
3. No precise numbers unless the number is famous (validator rejects any fact with more than one
   numeral group; years are allowed).
4. No "the world's most/only/first/oldest…" superlatives unless iconic (the fact-check judges).
5. No invented anecdotes, no "legend says" stories presented as fact, nothing about living people,
   nothing about the players.

**Pass 2 — fact-check (Haiku, web allowed).** A separate run reads the facts (not the author's
reasoning) and marks each `true | doubtful | false` with a one-line reason, and is told to search the
web for any fact it is not certain of. `doubtful`/`false` facts are dropped. An entry left with fewer
than 2 facts goes back to the author pass with its rejected facts listed as "do not repeat"; at most
**2 author rounds** per entry. Still short after that → the entry is written with the facts it has
(minimum 1) and listed in the catalogue report; an entry with 0 surviving facts gets none and the
carousel shows only its name, picture and `what` line for it (validator: `facts` length 0 is allowed
only for ids listed in `tooling/cookout/visual/facts_waivers.json`, each with a reason).

**Acceptance audit (Sol).** After the full catalogue is built, Sol (`researcher` profile: web search
on, writes only in its own directory) checks a seeded-random sample of **150 facts** across all
categories. Bar: **at least 146 of 150 (97 %) upheld**. Below the bar, the categories with any failure
are re-run through pass 2 with the failures quoted as examples, and a fresh 150 is drawn. The audit
result goes in the catalogue report (`triad/cookout/r2/catalogue-report.md`).

### A.3 Batching through cmd chat-spawn runs

- **Shared runner (`tooling/cookout/visual/cmdruns.py`, parcel 1).** Async, built on
  `wixy_server.cmdchat.CmdChatClient`. `CmdChatClient.spawn_run` gains three **additive keyword-only**
  parameters `provider: str | None = None`, `tool_profile: str | None = None`,
  `naked: bool | None = None`; each is put in the body **only when not None**, so every existing caller
  sends byte-identical requests (tested). Pacing: at most **3 runs in flight per provider**, at least
  **5 s between spawns** (the existing Cookout gap), poll every 10 s, cancel on deadline.
- **Author pass:** Haiku, `effort: "medium"`, `tool_profile: "judge"` (no tools: everything it needs is
  inline), **20 entries per run**, `timeout_secs: 900`. The prompt carries, per entry, the bank `id`,
  `name`, `aliases`, `category` name, `role` and `blurb`; nothing else.
- **Fact-check pass:** Haiku, `effort: "high"`, no `tool_profile`, `disallowed_tools` =
  `["Bash","PowerShell","Edit","Write","MultiEdit","NotebookEdit","Agent","Task"]` (leaves
  WebSearch/WebFetch/Read), **20 entries (≤60 facts) per run**, `timeout_secs: 1200`.
- **Order:** batches interleave categories (round-robin over the 15) so any prefix of the work is a
  stratified slice — the pilot pictures (§B.4) can start once the first ~800 entries are accepted.
- **Run size estimate:** 175 author runs + 175 fact-check runs; at 3 in flight and ~3 min a run, about
  **3 hours per pass, ~6–7 hours** including repairs and the Sol audit.

**Author response schema (strict, the run's final message is exactly one JSON object):**

```json
{
  "items": [
    {
      "id": "andouille-sausage",
      "what": "A smoky, coarse pork sausage from Cajun cooking in Louisiana.",
      "visual": "one whole raw andouille sausage link, dark reddish-brown smoked casing, coarse texture visible, lying in a gentle curve",
      "presentation": "whole",
      "facts": [
        "Andouille came to Louisiana with French settlers and became a staple of Cajun cooking.",
        "It is a key ingredient in gumbo and jambalaya.",
        "The Louisiana style is heavily smoked, unlike the French andouille it is named after."
      ],
      "concern": null
    }
  ]
}
```

`concern` is an optional ≤160-char note when Haiku thinks a bank entry is not a real or sensible
ingredient; concerns are collected into the catalogue report and **not acted on here** (the bank is
owned elsewhere).

**Fact-check response schema:**

```json
{
  "items": [
    { "id": "andouille-sausage", "facts": [ { "index": 0, "verdict": "true", "reason": "Documented French origin and Cajun use." } ] }
  ]
}
```

**Parser/validator.** A response is accepted per item: the ids must be exactly the batch's ids (no
extras, no missing — a missing item is retried in the next batch), every field passes §A.1/§A.2, and
the whole object is the only content of the final message (fenced ```` ```json ```` tolerated, nothing
else). A batch whose JSON does not parse is retried once with the parser's exact error quoted; then its
ids are re-queued into new batches (max 3 attempts per id; then listed as failed in the report and the
run exits non-zero so the parcel cannot finish silently).

### A.4 Resumability and where things live

- **Committed output:** `wixy_server/livechat/cookout_catalogue.json`, written with `sort_keys=True`,
  `indent=1`, `ensure_ascii=False`, LF, trailing newline — one entry per id so a re-run diffs cleanly
  (~2 MB of text):
  ```json
  { "version": 1, "bankVersion": 1, "generated": 1793318400, "items": { "<id>": { "what": "…", "visual": "…", "presentation": "whole", "facts": ["…"], "nameKey": "…", "source": { "author": "claude-haiku-5-5", "factCheck": "claude-haiku-5-5", "at": 1793318400 } } } }
  ```
- **Journal (not committed):** `<work>/catalogue/journal.jsonl` where `<work>` is
  `%AIM_ROOT%\Servers\Wixy\Storage\cookout-images\work` on hub (overridable with `--work-dir`; data, not
  code, so the Servers-tree rule is respected). One line per state change
  `{batch, pass, ids, run_id, status, at}`; the `run_id` is written **before** polling, so a crashed
  tool resumes polling the same run instead of spawning a second. Accepted items are merged into the
  committed JSON after every batch (atomic write: temp file + replace). Re-running skips ids already
  accepted with a current `nameKey`.
- **Commands** (`tooling/cookout/visual/catalogue.py`): `author`, `factcheck`, `audit`, `validate`,
  `report`, `status`. `validate` is also run by pytest (§F).
- **Validator (`tooling/cookout/visual/validate_catalogue.py`)**: schema and length rules; every bank
  pickable id + the three seasonings present exactly once with a current `nameKey`; no unknown ids;
  `facts` distinct within an entry and not repeated verbatim across entries; the presentation/category
  rule; the forbidden-word lists; waivers only for listed ids. During the build, `--allow-partial`
  permits missing ids; the committed file at merge time must pass without it.

---

## B. Image generation (hub's resident ComfyUI)

### B.1 Engine and graph

- **Where:** hub's Devfleet-supervised `ComfyUi` child at `http://127.0.0.1:8199` (pinned to the
  RTX 5060 Ti, the card reserved for background work; voice stays on the 2070 SUPER). Not Cherry or
  Fir: the operator named hub's ComfyUI, and the model, graph and cleanup code already exist there.
- **Client:** `wixy_server.livechat.wyr_images.ComfyImageGenerator` **unchanged**, called as
  `generate_many([prompt], out_dir, seeds=[seed])` — one sampling chain, the existing Krea 2 Turbo
  NVFP4 graph (8 steps, cfg 1.0, euler/simple, 1024×1024). It keeps the `wyr_` file prefix, which is
  deliberate: if the batch process is killed mid-image, the live server's existing `sweep_leftovers`
  removes the orphaned file and history entry exactly as for a crashed game picture. The batch passes
  `output_dir` = the value of `WIXY_COMFY_OUTPUT_DIR` from `D:\Servers\Wixy\Storage\.env`.
- **Run as a Grid task on a hub worker** (`grid run --background`, node `hub`): hub has three
  registered Grid workers (measured 2026-10-29), and the task only drives ComfyUI and cmd over loopback,
  so it must run on hub. Never session 0.

### B.2 The fixed prompt and the house style (decided)

Photographic, not illustrated: the dish pictures are photographs, the operator asked for "actual
isolated images", and a photograph of a real ingredient is the most recognisable. One consistent studio
look so a pair of cards always looks like a matched set:

```text
Studio food photograph of a single ingredient: {visual}. Centred and fully in frame with a little space
around it, on a plain seamless warm off-white background, soft even daylight from the upper left, a
faint natural shadow beneath, true-to-life colour and texture, sharp focus throughout. Nothing else in
the picture: no other foods, no garnish, no props, no cutlery, no cutting board, no hands or people, no
packaging, no labels, no text, no logos, no watermark.
```

The server-owned template text is fixed (in `tooling/cookout/visual/prompts.py`); only `{visual}` comes
from the catalogue. The UI tile behind every picture uses the same warm off-white (`#F5F2EC`) so the
picture's edge disappears into the card in light and dark themes.

### B.3 Sizes and files

| Rendition | Size | Encoding | Where | Approx. size |
|---|---|---|---|---|
| master | 1024×1024 | WebP q92 (Pillow), metadata stripped | `<work>/masters/<id>/<attempt>.webp` (kept for re-rendition; superseded attempts deleted after acceptance) | ~0.8 GB total |
| `card` | 512×512 | WebP q82, method 6, Lanczos | pack | ~30–45 KB each |
| `thumb` | 160×160 | WebP q78, method 6, Lanczos | pack | ~4–6 KB each |

**Why 512 for the card:** on a 360–430 px-wide phone the two side-by-side pick cards are 150–190 CSS px
wide (§D.3); at 3× pixel density that is 450–570 device pixels, so 512 is sharp on phones and soft only
on a large desktop card (shown at most 300 CSS px, 1.7×). The 1024 master is kept so a larger rendition
later needs no regeneration. Masters are WebP q92, not PNG, because hub's D: drive is 91 % full
(176 GB free, measured 2026-10-29); PNG masters would be ~6 GB.

Whole pack ≈ 3,494 × (card + thumb) ≈ **120–170 MB**.

### B.4 Throughput, scheduling and never starving live games

- **Never starves live pictures (decided mechanism):** the batch submits **one picture at a time** and
  only when ComfyUI's `GET /queue` shows nothing running and nothing pending on **three consecutive
  polls one second apart**. A live game's dish pictures or a would-you-rather picture arriving while a
  batch picture is rendering therefore waits for **at most one batch picture (~9–25 s)**, and every
  later batch picture waits behind them. No server code changes; the server's in-process
  `wyr_image_limiter` is unaffected. A `<work>/PAUSE` file stops the batch between pictures; deleting it
  resumes.
- **Estimate:** the Hall topic 00072 benchmark measured 9–25 s per 1024² Krea picture on hub with the
  voice services resident. Renders ≈ 3,494 first attempts + ~15 % regenerations ≈ **4,000 renders ≈
  10–28 hours of GPU time**, i.e. one to two nights, longer while games are being played. The tool
  measures its own rate over the first 50 pictures and prints (and writes to `<work>/images/status.json`)
  a measured ETA; the parcel reports that number, not this estimate.
- **Order:** the pilot is 600 entries, 40 from each of the 15 categories (the smallest, `fungi`, has
  59), chosen at random with a recorded seed; then everything else, category-interleaved.
- **Resumability:** `<work>/images/journal.jsonl` records `{id, attempt, seed, promptHash, master,
  card, thumb, state, at}` for every state change (`queued → rendered → checked → accepted |
  regenerate | review`); a restart skips accepted ids and re-renders an attempt whose master is missing.
  Seeds are recorded so any attempt can be reproduced.

### B.5 Regeneration with bounded retries, then review

| Attempt | What changes |
|---|---|
| 1 | catalogue `visual`, random seed |
| 2 | same `visual`, new seed |
| 3 | `visual` rewritten by Haiku (one small run per batch of failures: given the name, `what`, the old `visual` and every checker reason so far, write a clearer `visual`; the new `visual` replaces the catalogue's and `source` records it) |
| 4 | the rewritten `visual`, new seed |

After attempt 4 fails, the id goes to the **review queue**: an Opus run (vision via its Read tool,
`replay_probe` profile) is shown all four attempts with every checker verdict and answers
`{"choose": 1..4 | null, "visual": "<new description>" | null, "reason": "…"}`. It may accept one
attempt the checker was too strict about (recorded as `acceptedBy: "opus-review"`), or give a new
`visual` for **two final attempts** (5 and 6, each checked normally). Still failing → the id is
**picture-less** (emoji fallback in the game) and listed by name in the final report. Decisions are
committed in `tooling/cookout/visual/image_review.json` (`{id: {decision, attempt, reason, at}}`), so
a re-run never re-litigates them. Expected size of the picture-less list: under 1 % (≈30); the report
states the real count.

### B.6 Storage (decided): a content-addressed picture pack outside git, pinned by a committed manifest

**Decision.** The pictures live **outside git** as content-addressed files; git holds only a small
**manifest** mapping each ingredient id to the sha256 of its two renditions; each finished set of
pictures is published as one immutable, versioned **pack** (a tar file) attached to a GitHub Release
of the public upstream repo, pinned in the manifest by its own sha256.

**Why (the alternatives, rejected):**
- *Commit the WebPs:* ~150 MB on first add, and every regeneration pass adds the changed files forever;
  every clone, CI checkout and her fork's sync carries it. Rejected — the operator said it must not
  bloat history.
- *Git LFS:* GitHub's free LFS quota (storage and monthly bandwidth) is small, and every CI checkout
  and fork sync draws on it; exceeding it is a paid data pack (a spend). Rejected.
- *Serve from a CDN or a third-party bucket at runtime:* forbidden (self-hosted assets only), and the
  standalone edition must not depend on fleet infrastructure. Rejected.
- *Release asset + manifest (chosen):* nothing large in git; one immutable file per version; the
  browser only ever loads pictures from the wixy server's own origin; the standalone Docker image bakes
  the pack in at build time pinned by sha256, exactly as the Dockerfile already pins the Node tarball;
  the upstream repo is public (her fork's `sync-upstream.yml` fetches it anonymously), so her image
  builds can download it with no token.

**The manifest — `wixy_server/livechat/cookout_ingredient_images.json` (committed):**

```json
{
  "packVersion": 1,
  "pack": {
    "url": "https://github.com/joshcomley/wixy/releases/download/cookout-images-v1/cookout-images-v1.tar",
    "sha256": "<64 hex>",
    "bytes": 154000000
  },
  "renditions": { "card": 512, "thumb": 160 },
  "items": {
    "andouille-sausage": { "card": "<sha256 hex>", "thumb": "<sha256 hex>", "attempt": 2, "acceptedBy": "claude-haiku-5-5" }
  }
}
```

The first commit of the manifest (before any pictures) is `{"packVersion": 0, "pack": null, "renditions":
{"card": 512, "thumb": 160}, "items": {}}` — valid, and every ingredient falls back to emoji.

**Pack format:** an uncompressed POSIX tar (WebP is already compressed) whose members are exactly
`objects/<first 2 hex>/<sha256>.webp`, regular files only — no directories needed, no links, no
absolute or `..` paths, no other names. Every member's sha256 equals its name; the set of members
equals the set of shas in `items` (cards ∪ thumbs). A full set per version, not a delta, so a single
download installs a version.

**Object store on a server:** `<objects dir>/<2 hex>/<sha256>.webp`. Search order (first hit wins):
1. `WIXY_COOKOUT_IMAGES_DIR` if set (tests and the e2e fixture server use it);
2. `<WIXY_STORAGE_ROOT>/cookout-images/objects` (fleet: `D:\Servers\Wixy\Storage\cookout-images\objects`);
3. `WIXY_COOKOUT_IMAGES_BAKED_DIR` if set — the Docker image sets it to `/app/cookout-pack/objects`
   (this is an image layout fact, not an edition setting, so baking it with `ENV` respects decisions/00051 #6).

**How each deployment gets the pictures:**
- **Fleet (hub, blue/green Slots).** Objects are content-addressed in `Storage\`, shared by both slots,
  so the old and new slot each find exactly the files their own manifest names during an overlap. The
  image tooling's `install` command writes the accepted objects straight into
  `Storage\cookout-images\objects` **before** the manifest PR merges, so the new slot has every picture
  the moment it starts.
- **Self-heal (any non-Docker server):** at startup a background task (never blocking startup) checks
  that every manifest object exists in the search path; if any is missing and `pack.url` is set, it
  downloads the pack once to `<storage>/cookout-images/incoming/`, verifies the tar's sha256 and every
  member, extracts into the storage objects dir with temp-file + rename per object, and deletes the
  tar. Failure is logged and retried every 6 hours; meanwhile missing pictures fall back to emoji.
- **Standalone Docker image.** `deploy/standalone/Dockerfile` copies the manifest and runs
  `python wixy_server/livechat/cookout_pack.py fetch --dest /app/cookout-pack` (the module is
  stdlib-only so it runs before `pip install`), placed **before** `COPY wixy_server/` so the ~150 MB
  layer stays cached until the manifest changes. A build arg `COOKOUT_PACK_URL` may override the URL
  (the sha256 still pins the content) for a mirror if the upstream ever goes private. The fetch fails
  the build on any mismatch; an empty manifest (`pack: null`) makes it a no-op.
- **Garbage collection.** Each server records its manifest at startup as
  `<storage>/cookout-images/manifests/<packVersion>.json` with an epoch-seconds `seenAt`. After a
  successful self-heal or `install`, objects referenced by no manifest seen in the last 14 days are
  deleted. Releases: the tooling deletes GitHub releases older than the newest two `cookout-images-v*`
  (rollback needs the previous one).
- **Publishing a version** (`images.py publish`, parcel 2): build the tar from accepted objects, compute
  its sha256, create release `cookout-images-v<N>` (title "Cookout ingredient pictures v<N>") with the
  tar attached — every `gh` call via PowerShell with the full `gh.exe` path (fleet rule) — download it
  back and verify the sha256 before writing the new manifest. Then `install`, then the manifest PR.

### B.7 Serving, caching and privacy

- **Route:** `GET /admin/cookout-img/{sha}.webp` — under `/admin`, so behind Cloudflare Access on the
  fleet exactly like the admin shell's own static bundles (`/admin/static`), and **not** behind the
  chat unlock token. Reason: these are public catalogue pictures (the same for every user, generated
  from the ingredient name alone), not chat content; the chat's unlock gate and signed media URLs exist
  for chat content. Keeping it off `/api/admin/server/cookout*` also keeps that prefix's rule ("every
  route calls `require_server_token` first") true without an exception.
- `sha` must match `^[0-9a-f]{64}$` **and** be in the loaded manifest (cards ∪ thumbs), else `404`
  (no probing of arbitrary files); a known sha whose file is missing is `404` too.
- Response: `FileResponse`, `Content-Type: image/webp`, `X-Content-Type-Options: nosniff`,
  `Cache-Control: private, max-age=31536000, immutable` (content-addressed, so it never changes;
  `private` keeps it out of shared caches), `ETag: "<sha>"`; `If-None-Match` → `304`.
- **Privacy (decided).** The pictures, catalogue lines and facts are engine catalogue data. They are
  **not** erased by message delete or chat wipe (there is nothing chat-specific in them), and no chat
  content, player name, basket or round data ever reaches any prompt in §A–§C (the tooling is offline
  and reads only the bank). Inv 57's Blind-mode guarantee is unaffected because a picture URL is only
  ever attached to an ingredient snapshot that the viewer's redacted view already contains (§E.1).

---

## C. Image checking

### C.1 The checker run

- **Input:** a per-batch directory `<work>/check/<batch-id>/` containing only the 512 card renditions
  (what players actually see), copied under **neutral names** `01.webp … 11.webp` — never the
  ingredient name, so the checker cannot read the answer off the file name. The run's `cwd` is that
  directory.
- **Profile:** `tool_profile: "replay_probe"` (Claude: only Read/Grep/Glob; Codex: read-only sandbox,
  no MCP, no web). The prompt tells the model to open each image with its file-viewing tool.
- **Batch:** 10 real images + **1 decoy** in a random position (§C.2). `effort: "medium"` for
  Haiku/Luna; `timeout_secs: 900`.
- **Prompt (fixed text; per image the line `Image 07: should show <name> — <what> (presentation:
  <presentation>)`):** judge whether each image is a faithful, recognisable picture of that ingredient
  as described, and whether it follows the style rules (one ingredient — several pieces of the same
  thing are fine — no other foods or garnish, no text, labels, logos or packaging, no hands or people,
  no props, not distorted). For ingredients that look like others (white powders, oils, similar
  leaves), "correct" means *consistent with* this ingredient, not uniquely identifiable from the picture.
  First describe what you see, then give the verdict.
- **Verdict schema (strict):**

  ```json
  {
    "items": [
      { "image": "07", "seen": "a curved dark red smoked sausage on a pale background", "verdict": "correct", "problems": [], "reason": "" },
      { "image": "08", "seen": "a bowl of white powder", "verdict": "unclear", "problems": ["other"], "reason": "Could be flour or icing sugar; nothing marks it as potato starch." }
    ]
  }
  ```

  `verdict ∈ correct | wrong | unclear`; `seen` 5–120 chars; `problems ⊆ {wrong_food, wrong_form,
  other_foods, text_or_logo, packaging, hands_or_people, props_or_scene, distorted, other}`; `correct`
  ⇒ `problems` empty and `reason` empty; `wrong`/`unclear` ⇒ `reason` 10–200 chars and `wrong` ⇒ at
  least one problem. Every image number present exactly once. Parse failure → one retry quoting the
  error; then the batch is re-split.
- **Outcomes:** `correct` → accepted. `wrong` → regenerate (§B.5). `unclear` → **tie-break by Sol**
  (same prompt, one image, flat-rate): Sol `correct` → accepted (`acceptedBy: "sol-tiebreak"`),
  otherwise regenerate. Reason for the tie-break: some ingredients are inherently ambiguous in a picture,
  and regenerating them four times would flood the review queue with pictures that were fine.

### C.2 Decoys: proof the checker actually looked

Each batch carries one decoy: an already-rendered image of an ingredient from a **different category**,
labelled with the name and `what` of an ingredient from yet another category (e.g. a lemon labelled
"Pork belly"). The truth for a decoy is always `wrong`. A batch whose decoy is marked `correct` is
discarded and re-run once with a fresh decoy; a second miss sends the batch's 10 images to a different
checker run and logs the event. The running decoy catch rate is in `status.json` and in every report.

**Vision proof before first use (per model, refuse-never-degrade).** Before a model checks anything,
the tool runs one proof batch of 4 images (2 obviously right, 2 obvious decoys). Anything but 4 right
answers → the tool stops with a clear message naming the model; it never falls back to a model that has
not passed. (Whether Codex's built-in image viewer works inside the read-only sandbox is unproven until
this proof runs; this is the guard.)

### C.3 The calibration spot check (exactly as the operator asked)

1. **Sample.** From the pilot's first-attempt images (before any regeneration), draw **100 at random**
   with a recorded seed (`secrets.randbits(32)`, written to the report), then split them at random into
   **50 for Luna** and **50 for Haiku**. Purely random, as he said; no stratification and no seeding
   with suspected failures. (If the 100 contain few wrong pictures, the report says so plainly and
   points to the decoy catch rate, which measures catching wrong pictures directly.)
2. **Checkers.** Luna (`codex`/`gpt-6-luna`, `effort: "medium"`) and Haiku (`claude`/`claude-haiku-5-5`,
   `effort: "medium"`) check their 50 with the §C.1 prompt and schema, 10 + 1 decoy per run. Decoys
   are extra and **not** part of the 100.
3. **Judges — stage 1, blind.** Sol (`codex`/`gpt-6.1-sol`, `effort: "high"`) and Opus
   (`claude`/`claude-opus-5-5`, `effort: "high"`) each independently give their **own** verdict on
   **all 100** images, with the identical §C.1 prompt and without seeing any checker's answer (so they
   are not anchored by it).
4. **Judges — stage 2, review.** Each judge is then shown, per image, the checker's verdict, problems
   and reason alongside its own stage-1 verdict, looks at the image again, and answers
   `{"image": "07", "checkerRight": true|false, "finalVerdict": "correct|wrong|unclear", "reason": "…"}`.
   This is the operator's "check each one and see if they got them right".
5. **Truth and scoring.** An image's *agreed truth* is the two judges' stage-2 `finalVerdict` when they
   agree; otherwise it is **contested** and listed. Scoring is on accept-vs-reject (`correct` vs
   `wrong`/`unclear`), with the three-way table shown as well. Per checker: accuracy against agreed
   truth; "checker right" rate per judge; **false accepts** (said correct, truth not) — the costly
   error, because a wrong picture would reach the game; **false rejects** (said not correct, truth
   correct) — cheap, it only costs a regeneration; decoys caught. Also judge-vs-judge agreement, so the
   reader can see how firm the "truth" is.
6. **Recommendation rule (stated before the run, applied mechanically):** Haiku checks the full run if,
   on its 50: **at most 2 errors against agreed truth**, **no false accept of a `wrong_food` picture**,
   and **every decoy caught**. Otherwise Luna checks the full run if Luna meets the same bar. If neither
   does, the full-run checking pauses and the operator is asked (via the `op-ask-question` skill, with
   the report linked) — the one place this spec stops for him. Picture generation continues meanwhile.
7. **Report for the operator, plain English** — `triad/cookout/r2/image-calibration.md` plus
   `image-calibration.html` (the 100 pictures inlined as 160 px thumbnails, ~0.6 MB, each with every
   verdict and reason; disagreements first). The Markdown opens with the answer in 2–3 sentences
   ("Haiku got 49 of 50 right, Luna 48 of 50; neither let a wrong food through; we are using Haiku for
   the rest"), then a small table, then each disagreement in one line with what each model said. No
   unexplained abbreviations. Recorded in cmd's Answers log against his message, and linked to him with
   the deployment's public file link.
8. **Files:** `<work>/calibration/{sample.json, checks-luna.jsonl, checks-haiku.jsonl,
   judge-sol-blind.jsonl, judge-opus-blind.jsonl, judge-sol-review.jsonl, judge-opus-review.jsonl,
   scores.json}`; the two report files above are committed.

### C.4 The full run

The chosen checker (§C.3.6) checks every image as it is rendered, 10 + 1 decoy per run, ~400 runs over
the whole run, in parallel with generation (checking never waits for the GPU and vice versa).

---

## D. UI redesign (built by Opus)

### D.1 Principles

- **Picture-first.** Wherever an ingredient appears, its picture is the main thing; the name is under it;
  emoji only as the fallback.
- **Fits the phone while picking.** During `state == "picking"` the pane never scrolls, at 360×640 and
  390×844 CSS px (and any portrait height ≥ 560 px). The page itself never scrolls in game mode (as now).
- **Obvious whose turn and what to do.** One sentence, big, at the top of the table.
- **Unchanged rules.** Blind redaction, moves, skips, twists and their server rules are untouched; this
  is presentation plus the read-only fields of §E.

### D.2 The intro screen (light)

Shown over the pane the first time **this device** opens **this round** while it is `picking` (key
`wx-srv-ck-intro:<seq>` in `localStorage`, every read and write in try/catch; if storage is unavailable,
an in-memory set for the page's life). Also reopenable from a `?` button in the title row. Dismissed by
**Let's cook** (primary) or tapping the backdrop. A short card, no scrolling, nothing else to read:

- **Open mode:** title "Cookout" · "You're playing non-blind mode." · "You take turns choosing
  ingredients — 5 each, 10 in the basket." · "Each turn, tap the one you want. Don't fancy either? Deal
  two new ones (up to twice)." · "You'll see each other's picks as you go." · "Then the chef invents
  three dishes from your basket."
- **Blind mode:** same, with "You're playing blind mode." and "Your picks are secret — the basket is
  revealed when all ten are in." in place of the "see each other's" line.
- **Twists (only if any is on):** one extra line, "Twists on:" then one short phrase each — e.g.
  "⭐ secret stars", "🛎️ a mystery 11th ingredient", "🎡 Cosy pub style", "🍳 One pan only",
  "🧊 starts with your fridge pick". In-game twist buttons (lucky dip, chaos shelf, sweep) are not
  listed; they explain themselves when tapped.
- The joining player gets the same intro the first time they open the round.

### D.3 The picking screen (phone first)

A CSS grid filling the pane's height; rows top to bottom:

| Row | Height (phone) | Content |
|---|---|---|
| Title | 44 px (existing) | 🍳 · Blind badge · `?` · Recipe book · End/New · gear (existing items) |
| Rules strip | 0 or 28 px | the existing twist chips, **one line**, horizontally scrollable, never wrapping |
| Turn banner | 52 px | **"Your turn — tap the one you want"** (20 px semibold) + subline "Pick 2 of 5 · 2 new pairs left"; or **"Cupcake is choosing…"**; or **"Waiting for Cupcake to join"** with the Join button for the joiner |
| Progress | 64 px | two rows, one per player: name (or "You") + 5 slots of 28 px — filled = the pick's `thumb` picture (round-cornered), Blind partner's = a 🔒 tile, empty = dashed ring, the next slot gently pulsing. Starters carry a tiny badge. Tap a filled thumb → a small popover with the name (and, for your own picks with secret stars on, "⭐ Star this") |
| **Stage (1fr)** | the rest | **two big picture cards side by side** with a small "or" between |
| Actions | 52 px | the skip button ("Deal two new ones (2 left)" / "Final pair") + a **🎲 Twists** button only when a drafting twist is available, which opens a small bottom sheet holding Lucky dip / Chaos shelf (and, for the watcher in Open mode, Sweep one) |
| Chat row | 64 px (existing reserved row, decisions/00194) | the floating message and chat button — never over a control |

Bottom safe area (`env(safe-area-inset-bottom)`) is added under the chat row.

**The card** (`button`, the whole card is the target): a square picture on the `#F5F2EC` tile, sized
`min(card width, stage height − 72 px)`; under it the **name** (15 px semibold, 2-line clamp) and the
**what** line (12.5 px, 2-line clamp, falls back to `blurb`). No category badge or emoji (the picture
says it). On phones each card is ~150–190 px wide; on desktop the pair is centred in at most 720 px and
pictures grow to at most 300 px.

**One tap picks (decided).** Tapping a card sends the pick immediately (no separate "Pick this" button
and no confirm step): it is the cleanest flow and there is no scrolling left to cause a stray tap. The
tapped card gets a pressed outline and a "Picking…" overlay; the other dims; both are disabled until
the answer. This changes how the game feels: a pick is one tap, not two.

**Watching (Open mode, partner's turn):** the same two cards, not tappable, slightly dimmed, banner
"Cupcake is choosing…". Sweep (veto) is in the 🎲 Twists sheet: choosing "Sweep one" makes the two
cards tappable for that one action, with the banner "Tap the one to sweep off Cupcake's table" and a
Cancel.

**Blind, partner's turn / waiting for Join:** the stage shows the existing cloche card (no ingredient
data exists in the view, so none can be in the DOM).

**Notes that used to stack above the cards** (role line, "swept off your table", chaos note) become
the banner's subline, so they never push the cards.

**Fitting rules:** the stage uses `container-type: size`; the picture's side is computed in CSS from the
container size; minimum picture 96 px. At portrait heights below 560 px (short phones, landscape) a
**compact mode** merges banner and progress into one 44 px row (10 thumbs of 24 px) and shrinks the
actions row to 44 px; the no-scroll guarantee holds down to 480 px tall. Below 480 px tall the stage
alone may scroll (stated limit, not tested as no-scroll).

**Removed while picking:** the basket tray (the progress thumbnails replace it) and the staples footer
(moved to the reveal, §D.5).

### D.4 Chef thinking: the carousel

While `concepts.state == "pending"` (after any gate is answered), the chef status keeps its line and
elapsed clock, and below it shows a **carousel of the ten chosen ingredients** (plus the cloche's 11th
when lifted): one slide at a time, each with the `card` picture, the name, the `what` line and its 2–3
fun facts (as a short list).

- Auto-advances every **7 s**, loops; pauses while a finger or pointer is on it and for 10 s after;
  dots underneath (tappable); left/right buttons on desktop; swipe on touch via CSS scroll-snap
  (`scroll-snap-type: x mandatory`, one slide wide) with an `IntersectionObserver` tracking the active
  slide. **Reduced motion:** no auto-advance and no animated scroll; buttons and swipe only.
- The carousel is sized to fit the viewport at the phone baselines (picture ~min(70 vw, 40 dvh)).
- It disappears when the dishes arrive (or on `failed`/`unavailable`, where the existing message and
  Try again show).
- Pictures: the current and next slide load eagerly, the rest `loading="lazy"`.

### D.5 Basket, reveal, dishes, recipe book, fridge search

- **Reveal / basket (finished):** the existing banner becomes a **5×2 grid of picture thumbnails**
  (thumbs at ~56 px on a 360 px phone, larger on desktop) with the name under each (11 px, 2-line
  clamp), grouped by player; Blind's "all ten flip open together" animation flips picture tiles. Under
  it, one line: "Plus cupboard staples:" with the seasoning/staple thumbs. Stars, starters and via
  badges keep their meaning as small corner badges.
- **Dish cards:** the "uses" chips become 28 px thumbnails with the name in a tooltip/`title` and
  visually hidden text; omitted ingredients show the thumb with a faded style.
- **Full recipe view:** each ingredient line whose `id` is in the round's basket gets a 24 px thumb.
- **Fridge raid search results and the chosen chip** show the `thumb` instead of the emoji.
- **Recipe book list** is unchanged (dish photos already).
- **Rescue swap chooser** (pick the regretted ingredient): picture tiles instead of chips.

### D.6 Accessibility, performance and the fallback

- Every `img` has `alt` = the ingredient name; pick cards are buttons with an accessible name
  "Pick <name>" and `aria-describedby` the what-line; the Blind 🔒 tile is "Secret pick". Focus order
  follows the visual order; 44 px minimum targets; contrast ≥ 4.5:1 for text.
- `width`/`height` attributes on every picture (no layout shift), `decoding="async"`.
- **Next pair:** it cannot be fetched before it exists — the server draws a pair at the moment of the
  move (09 §2.3, deliberately unchanged). Instead the pane **decodes before it swaps**: when a view with
  a new pair arrives, it creates the two `Image`s and calls `decode()`, swapping the cards in when both
  are ready or after 400 ms, whichever is first (then a shimmer until loaded). Cards are 30–45 KB, so on
  the fleet this is usually instant.
- On round open, the history's chosen thumbs are fetched once (small); the browser cache keeps them
  for a year (immutable URLs).
- **Fallback:** a snapshot with `image: null`, or an `<img>` that errors, renders the same-size tile
  with the category emoji centred on the tile colour — identical layout, so a missing picture never
  changes the screen's fit.

### D.7 Desktop

Pane content centred at max 720 px for picking (cards side by side, pictures up to 300 px), progress
and banner the same; the chef stage keeps its existing three-column dish grid; the carousel shows one
slide with its arrows.

---

## E. Wire changes

### E.1 Ingredient snapshots gain read-time fields (decided: enrich the view, no new JSON route)

Snapshots stored in `cookout_turns` stay immutable and unchanged on disk. When a view is serialised,
`_snap_json` (the single place every snapshot goes through, `cookout_game.py`) adds two fields looked up
**by id at read time** from the loaded catalogue and manifest:

```text
IngredientSnap = {id, name, category, emoji, blurb, what: string | null, image: {card: string, thumb: string} | null}
```

- `what` = catalogue `what`, or `null`.
- `image` = `{card: "/admin/cookout-img/<cardSha>.webp", thumb: "/admin/cookout-img/<thumbSha>.webp"}`
  when the manifest has the id **and** both objects are present in this server's search path (checked
  once at load and after a self-heal, kept in memory); otherwise `null`.
- **Facts** are added only to `PickSnap`s in `players[].picks` (and the wildcard's revealed snap) when
  `state != "picking"`: `facts: string[] | null`. They are not sent during picking (not needed, and it
  keeps the frequently polled view small: ~4 KB extra once the basket is full).
- `staples: [{id, name}]` entries gain `image` the same way.
- `GET /cookout/ingredients` (fridge search) and `GET /cookout/options` results gain `what`/`image`
  through the same function.
- **Why read-time, not stored:** the snapshot's job is to freeze what was *offered* (09 §2.3 point 5);
  the picture is a presentation of that id and should improve when a better picture ships. **Why not
  a separate catalogue route:** one fewer request and one fewer cache to keep in step, and Blind
  safety comes for free — enrichment only decorates snapshots the redacted view already contains, so it
  can never add a partner's ingredient (tested).
- `Message.cookout` (the broadcast summary) is unchanged: still counts and flags only.

### E.2 Server modules

- `cookout_catalogue.py` (loader, parcel 1): `load_cookout_catalogue()` / `_or_empty()`; strict schema
  shared with the validator.
- `cookout_pack.py` (manifest + pack, parcel 2): stdlib-only; manifest loader, object paths, tar
  verification/install, fetch, gc, and a CLI.
- `cookout_visuals.py` (parcel 3): `IngredientVisuals` joining catalogue + manifest + object search path
  into `snap_extras(id)` and `facts(id)`; `default_visuals()` lazily built once per process like
  `default_bank()`; the startup self-heal task; the `/admin/cookout-img/` route (registered in
  `app.py` before the `/admin/static` mount, in the same group).
- `settings.py`: `cookout_images_dir` (`WIXY_COOKOUT_IMAGES_DIR`) and `cookout_images_baked_dir`
  (`WIXY_COOKOUT_IMAGES_BAKED_DIR`), both optional paths.

### E.3 Client parsing and caching

`api.ts` parses the new fields defensively: `image.card`/`image.thumb` must match
`^/admin/cookout-img/[0-9a-f]{64}\.webp$` or the whole `image` becomes `null`; `what` ≤ 120 chars or
`null`; `facts` an array of ≤ 3 strings of ≤ 200 chars or `null`. A pre-round-2 server (no fields) parses
to `null`s and the UI shows the emoji fallback — the client works against either server. Picture caching
is the browser's (immutable URLs); the view stays `no-store` as today.

### E.4 Standalone edition

Pictures, `what` and facts work fully (baked pack; no AI needed at runtime). A self-built image from a
manifest with `pack: null` simply has emoji fallbacks.

---

## F. Tests and docs

### F.1 pytest (bare `pytest`; the `-n 4` cap stays)

- `test_cmdchat_spawn_run_provider.py` — `provider`/`tool_profile`/`naked` appear in the body only when
  given; existing body byte-identical without them.
- `test_cookout_catalogue_data.py` — the committed catalogue passes `validate_catalogue.py` (no
  `--allow-partial` once the catalogue PR merges; until then the test asserts the empty/partial file is
  well-formed). Imports the tooling validator the way `test_cookout_bank.py` imports `validate_bank.py`.
- `test_cookout_catalogue.py` — loader strictness on fixtures (bad lengths, unknown presentation,
  forbidden words, stale `nameKey`, facts waivers).
- `test_cookout_pack.py` — empty manifest valid; manifest strictness; tar install rejects a bad member
  sha, an extra member, a missing member, a directory/symlink/hardlink member, `..`/absolute names;
  install is atomic per object; fetch via a fake transport verifies the tar sha; gc keeps objects of
  manifests seen within 14 days and removes older.
- `test_cookout_visuals.py` — every snapshot in a view carries `what`/`image`; `image` is `null` when
  the object file is missing or the id is not in the manifest; facts only on picks when not `picking`;
  staples enriched; fridge search enriched; **Blind regression:** across every picking state of a Blind
  round, the partner's ingredient ids, names, and card/thumb shas appear nowhere in the viewer's view
  JSON.
- `test_cookout_image_route.py` — known sha → 200 `image/webp`, immutable cache headers, nosniff, ETag,
  304 on `If-None-Match`; unknown/malformed sha → 404; known sha with missing file → 404; works without
  an unlock token; search-path precedence (env dir, storage dir, baked dir).
- `test_cookout_visual_tooling.py` — with fakes, no network or GPU: author/fact-check/verdict parsers
  accept the schemas and reject every violation; batch journal resumes a persisted `run_id` instead of
  spawning; decoy placement and the discard-on-miss rule; the empty-queue gate submits only after three
  empty polls and never while `/queue` is busy (fake ComfyUI); attempt ladder 1–4 then review; the
  calibration sampler is deterministic for a seed and splits 50/50; scoring computes agreed truth,
  contested items, false accepts/rejects and applies the §C.3.6 rule; image file names in a check
  directory never contain the ingredient name.

### F.2 vitest (`admin-ui/tests/cookout/`)

- `apiVisual.test.ts` — the parsers of §E.3 (good, malformed URL, oversized facts, absent fields).
- `intro.test.ts` — shown once per round per device; Open/Blind/twist wording; storage throwing →
  in-memory; `?` reopens; dismiss paths.
- `pickTable.test.ts` — whole-card tap sends one pick and disables both; watcher cards not tappable;
  Twists sheet only when a drafting twist is available; sweep mode; Blind partner turn renders the
  cloche with no ingredient text or image URL in the DOM; progress thumbs and 🔒 tiles.
- `carousel.test.ts` — auto-advance with a fake clock, pause on pointer and resume, reduced motion
  disables auto-advance, dots and buttons, disappears when concepts arrive.
- `fallback.test.ts` — `image: null` and an `error` event both render the emoji tile at the same size.

### F.3 e2e (Playwright, `e2e/tests/server-cookout-visual.spec.ts`)

The fixture server sets `WIXY_COOKOUT_IMAGES_DIR` to a temp dir filled by
`cookout_pack.py placeholders --dest <dir>` (one tiny valid WebP per manifest sha; the runtime check is
presence, the sha check belongs to install/fetch), and a fixture manifest/catalogue covering the fixture
bank ids. At **360×640, 390×844 and 1280×800**, for Open and Blind, with no twists and with every
twist on:
- the intro shows, dismisses, and does not show again on reload;
- **no-scroll assertion** in every picking state (my turn; watching; Blind cloche; waiting for Join;
  veto note; chaos pair; final pair): `document.scrollingElement.scrollHeight <= innerHeight`, and for
  every element inside the pane `scrollHeight <= clientHeight + 1` where its computed `overflow-y` can
  scroll; both cards' bounding boxes lie fully inside the viewport, above the chat row, and do not
  overlap the actions row; the skip button is visible;
- a tap on a card picks it; the progress thumb appears; pictures actually load (natural width > 0);
- the chef carousel shows during a delayed fake concepts job and advances;
- the reveal grid shows ten pictures; a missing picture shows the emoji tile;
- Blind: the partner's names and image URLs are absent from the DOM until reveal.

### F.4 Docs to update in the same change (each parcel updates the ones for its files)

- `docs/ai/livechat.md` — new §24.2 "Cookout pictures, catalogue and the picture-first table".
- `docs/ai/contracts.md` — snapshot fields, `facts`, staples `image`, `/admin/cookout-img/{sha}.webp`.
- `docs/ai/invariants.md` — **Inv 58** (next free number): "Cookout ingredient pictures and catalogue
  text are engine catalogue data: generated from ingredient names only, never from chat content; not
  erased by delete or wipe; served only by content hash from the manifest; attached only to snapshots
  already in the viewer's redacted view."
- `docs/ai/runbook.md` — object store path, pack install/fetch/gc, the two env vars, how to regenerate
  pictures and publish a new pack, how a missing pack self-heals, the PAUSE file.
- `docs/ai/testing.md`, `docs/ai/architecture.md` (module map), `tooling/README.md`,
  `deploy/standalone/README.md` (the baked pack).
- `decisions/00201-cookout-ingredient-pictures/` — the storage decision and its rejected alternatives,
  the photographic style, the empty-queue scheduling, the calibration rule.
- `CLAUDE.md` — one line under "What's here" for the manifest + catalogue files.

---

## G. Appendix: parcels, ownership and frozen interfaces

Every commit: `Release-note: General bug fixes and improvements.` (rule R14a). PRs target
`cmd/workspace-00058`. Tooling under `tooling/` is outside the repo's mypy scope, but every new tooling
file is fully typed and each parcel runs `mypy --strict` on its own tooling files explicitly.

### G.1 Parcels

| # | Parcel | Builder | Owns exclusively |
|---|---|---|---|
| 1 | Catalogue tooling + data | Sonnet 5.5 | `wixy_server/cmdchat.py` (the additive `spawn_run` kwargs only), `tooling/cookout/visual/{__init__,cmdruns,catalogue,validate_catalogue}.py`, `tooling/cookout/visual/facts_waivers.json`, `wixy_server/livechat/cookout_catalogue.py`, `wixy_server/livechat/cookout_catalogue.json`, `triad/cookout/r2/catalogue-report.md`, tests `test_cmdchat_spawn_run_provider.py`, `test_cookout_catalogue.py`, `test_cookout_catalogue_data.py` |
| 2 | Image generation, checking, calibration | Sonnet 5.5 | `tooling/cookout/visual/{prompts,images,check,calibrate,review}.py`, `tooling/cookout/visual/image_review.json`, `wixy_server/livechat/cookout_pack.py`, `wixy_server/livechat/cookout_ingredient_images.json`, `triad/cookout/r2/image-calibration.{md,html}`, `triad/cookout/r2/images-report.md`, tests `test_cookout_pack.py`, `test_cookout_visual_tooling.py`; edits the `visual` field of `cookout_catalogue.json` only through `catalogue.py`'s API (attempt-3 rewrites) after parcel 1 has merged |
| 3 | Server serving + wire | Sonnet 5.5 | `wixy_server/livechat/cookout_visuals.py`, `_snap_json`/view enrichment in `wixy_server/livechat/cookout_game.py`, the enrichment calls in `wixy_server/routes_livechat_cookout.py`, the route registration in `wixy_server/app.py`, `wixy_server/settings.py` (two fields), `deploy/standalone/Dockerfile`, tests `test_cookout_visuals.py`, `test_cookout_image_route.py` |
| 4 | UI | **Opus 5.5** | `admin-ui/src/server/cookout/**` (incl. new `intro.ts`, `carousel.ts`, `pictures.ts`), the Cookout rules in `admin-ui/src/server/chat.css`, `admin-ui/tests/cookout/**`, the rebuilt `wixy_server/static/admin/` bundle |
| 5 | Docs + e2e | Sonnet 5.5 | everything in §F.4, `e2e/tests/server-cookout-visual.spec.ts`, the e2e fixture server/fixtures additions |

### G.2 Order and parallelism

- **Start together:** 1, 3 and 4 (3 and 4 build against an empty manifest and empty catalogue, plus
  fixtures; they can merge before any picture exists — every picture falls back to emoji and `what`
  falls back to `blurb`). 2 builds and unit-tests its tooling and `cookout_pack.py` at the same time.
- **2 waits on 1's data** only to *run*: the pilot starts once ~800 stratified entries are accepted
  (§A.3), calibration right after the pilot, the full run after the calibration rule picks the checker.
- **5** writes docs as 1–4 land; the e2e spec lands after 3 and 4 merge; the final manifest PR (from 2)
  closes the round.
- Expected wall-clock: catalogue ~7 h; pilot ~3 h; calibration ~1–2 h; full run one to two nights.

### G.3 Frozen interfaces

```python
# wixy_server/cmdchat.py (parcel 1) — additive, keyword-only; omitted from the body when None
async def spawn_run(
    self,
    *,
    caller: str,
    prompt: str,
    model: str,
    effort: str,
    cwd: str,
    timeout_secs: int,
    disallowed_tools: list[str],
    provider: str | None = None,
    tool_profile: str | None = None,
    naked: bool | None = None,
) -> ChatSpawnRun: ...


# wixy_server/livechat/cookout_catalogue.py (parcel 1)
Presentation = Literal[
    "whole", "cut", "heap", "bunch", "bowl", "jar", "bottle", "glass", "plate", "portion"
]
CATALOGUE_PATH: Path  # Path(__file__).with_name("cookout_catalogue.json")


@dataclass(frozen=True, slots=True)
class CatalogueEntry:
    id: str
    what: str
    visual: str
    presentation: Presentation
    facts: tuple[str, ...]
    name_key: str


class Catalogue:
    version: int

    def get(self, ingredient_id: str) -> CatalogueEntry | None: ...
    def __len__(self) -> int: ...


class CatalogueError(ValueError): ...


def load_cookout_catalogue(path: Path | None = None) -> Catalogue: ...  # raises CatalogueError
def load_cookout_catalogue_or_empty(
    path: Path | None = None,
) -> Catalogue: ...  # logs, never raises


# wixy_server/livechat/cookout_pack.py (parcel 2) — stdlib only, runnable as a script
MANIFEST_PATH: Path  # Path(__file__).with_name("cookout_ingredient_images.json")


@dataclass(frozen=True, slots=True)
class ImageRef:
    card: str  # sha256 hex
    thumb: str  # sha256 hex


@dataclass(frozen=True, slots=True)
class PackManifest:
    pack_version: int
    url: str | None
    sha256: str | None
    bytes: int | None
    items: Mapping[str, ImageRef]

    def shas(self) -> frozenset[str]: ...


class PackError(ValueError): ...


def load_manifest(path: Path | None = None) -> PackManifest: ...
def object_relpath(sha: str) -> PurePosixPath: ...  # "ab/ab…ef.webp"
def install_pack(
    tar_path: Path, objects_dir: Path, manifest: PackManifest
) -> int: ...  # objects written
def fetch_pack(
    manifest: PackManifest, dest_root: Path, *, url: str | None = None, timeout_s: float = 600.0
) -> int: ...  # downloads, verifies, installs
def gc_objects(objects_dir: Path, manifests_dir: Path, *, keep_days: float = 14.0) -> int: ...


# CLI: cookout_pack.py fetch --dest DIR [--url URL] | install --tar T --dest DIR | verify --dest DIR
#      | gc --dest DIR --manifests DIR | placeholders --dest DIR


# wixy_server/livechat/cookout_visuals.py (parcel 3)
class IngredientVisuals:
    def snap_extras(
        self, ingredient_id: str
    ) -> dict[str, object]: ...  # {"what": str|None, "image": {"card","thumb"}|None}
    def facts(self, ingredient_id: str) -> list[str] | None: ...
    def resolve_object(self, sha: str) -> Path | None: ...


def default_visuals() -> IngredientVisuals: ...


IMAGE_ROUTE_PREFIX = "/admin/cookout-img/"
```

```ts
// admin-ui/src/server/cookout/api.ts (parcel 3 freezes the wire; parcel 4 implements the parser)
export interface IngredientImage { readonly card: string; readonly thumb: string; }
export interface IngredientSnap {
  readonly id: string; readonly name: string; readonly category: string; readonly emoji: string; readonly blurb: string;
  readonly what: string | null;
  readonly image: IngredientImage | null;
}
export interface PickSnap extends IngredientSnap { readonly turn: number | null; readonly via: PickVia; readonly facts: readonly string[] | null; }
export interface Staple { readonly id: string; readonly name: string; readonly image: IngredientImage | null; }
```

### G.4 Acceptance (the round is done when all hold)

1. Catalogue: 3,494 entries validate; Sol audit ≥ 146/150.
2. Calibration report delivered in plain English, recorded in the Answers log, checker chosen by the
   stated rule (or the operator's answer).
3. Every entry has an accepted picture except a listed picture-less set (expected < 1 %), with the
   decoy catch rate and attempt counts in `images-report.md`.
4. Pack v1 released, sha-pinned in the manifest, installed on hub, baked into the standalone image
   (CI image-boot proof green).
5. All §F tests green; the no-scroll e2e passes at 360×640 and 390×844; the operator's next game shows
   pictures on the cards, the progress, the reveal, the carousel and the dishes.
