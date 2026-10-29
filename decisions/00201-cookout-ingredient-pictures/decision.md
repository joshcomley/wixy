# Symptom / ask (operator, workspace 00058, after his first real game of Cookout)
Playing Cookout, the ingredient cards were an emoji and a name: the operator could not tell what half the 3,500 ingredients
were, the pick screen scrolled on a phone, and the wait for the chef was dead time. He asked for an actual picture of every
ingredient, a plain "what it is" line, fun facts while the chef thinks, and a pick screen that fits a phone. The spec is
`spec/server-chat/09b-cookout-visual.md`; docs are livechat.md §24.2, contracts.md, runbook.md "Cookout ingredient
pictures", Inv 58.

# The need
About 3,494 pictures (3,491 bank ingredients plus the three free seasonings), two renditions each (512 px card, 160 px
thumb), roughly 120-170 MB. They must be the same for every player, available on the fleet's blue/green slots, on the
standalone Docker edition and on a fork, must not bloat git history, and must never depend on a third party at runtime.

# Decided
1. **Storage: a content-addressed picture pack OUTSIDE git, pinned by a small committed manifest.**
   `wixy_server/livechat/cookout_ingredient_images.json` maps each ingredient id to the sha256 of its card and thumb and pins
   ONE immutable uncompressed tar (`objects/<2 hex>/<sha256>.webp`) attached to a GitHub Release (`cookout-images-v<N>`) of the
   public upstream repo, by the tar's own sha256, byte size, object count and installed size (all mandatory, all bounded: 400
   MiB, 10,000 objects, 2 MiB per object, at most 5,000 items; a violation is an error, never a clamp). A server finds objects
   by hash in a fixed search path (`WIXY_COOKOUT_IMAGES_DIR`, then `<storage>/cookout-images/objects`, then
   `WIXY_COOKOUT_IMAGES_BAKED_DIR`) and serves only manifest shas at `/admin/cookout-img/{sha}.webp`.
2. **Delivery.** Fleet: the tooling's `install` writes the accepted objects into the shared storage objects dir under a
   pending pin BEFORE the manifest PR merges, so the new slot has every picture the moment it starts; both blue/green slots
   share the objects and each slot's own pin keeps exactly its manifest's files during an overlap. Any other non-Docker
   server self-heals: after pinning, a background task downloads the pack (admitted against the free-space floor, one
   download at a time, bounded to the declared byte size, sha256-verified, extracted member by member) and retries every six
   hours; until then the game shows emoji. Standalone Docker: the Dockerfile copies only `cookout_pack.py` and the manifest and
   fetches the pack at build time, baked into `/app/cookout-pack`, so it needs no network at runtime. CI proves the image
   really serves a baked picture (`deploy/standalone/ci/cookout_image_proof.sh`).
3. **Lifetime rules.** A cross-process lock, a registry of every manifest ever registered, slot pins with a 900 s lease
   refreshed every 300 s, pending pins that never expire, and a GC that keeps live-leased, pending and 72-hour-rollback
   objects, never touches an object under an hour old and fails closed. **GitHub Release assets are never deleted**: any
   older manifest, fork or bare server may need any pack ever shipped, and content addressing cannot recover bytes from a
   deleted URL.
4. **Read-time enrichment, no new JSON route.** `_snap_json` adds `what` and `image` to every ingredient snapshot when the view
   is serialised (`facts` only on picks after `picking`, staples gain `image`). The stored snapshot never changes (it freezes
   what was OFFERED; the picture is a presentation of that id and may improve later). Enrichment only decorates snapshots the
   redacted view already contains, so Inv 57's Blind guarantee is untouched.
5. **Not chat content (Inv 58).** Pictures and catalogue text are generated from ingredient names only, are not erased by delete
   or wipe, and are served only by manifest hash. The route sits under `/admin` (Cloudflare Access, like the admin bundles),
   not behind the chat unlock token, which keeps the "every `/api/admin/server/cookout*` route calls `require_server_token`
   first" rule free of exceptions.
6. **Photographic style.** One fixed server-owned prompt: a studio food photograph of a single ingredient, centred, on a
   plain seamless warm off-white background, soft daylight from the upper left, a faint shadow, true-to-life colour, and an
   explicit list of nothing else (no other foods, garnish, props, cutlery, board, hands, people, packaging, labels, text,
   logos). Only the catalogue's `visual` sentence varies. Photographic, not illustrated, because the dish pictures are
   photographs, the operator asked for "actual isolated images", and a photograph of a real ingredient is the most
   recognisable; one look so any pair of cards is a matched set. The card tile uses the same off-white (`#F5F2EC`) so the
   picture's edge disappears in light and dark themes. Liquids, pastes and powders go in a plain unlabelled vessel; prepared
   foods are shown as the food served plainly, never as packaging.
7. **Scheduling: one picture at a time, only when ComfyUI is idle.** The batch submits a picture only after ComfyUI's
   `/queue` has shown nothing running and nothing pending on three consecutive polls one second apart. A live game's dish
   picture or would-you-rather picture therefore waits behind at most one batch picture (~9-25 s) and every later batch
   picture waits behind it. No server code changes and the server's own image limiter is unaffected. A `<work>/PAUSE` file
   stops the batch between pictures. The unmodified `wyr_images.ComfyImageGenerator` (and its `wyr_` file prefix) is reused, so a
   batch killed mid-picture is cleaned up by the existing `sweep_leftovers`.
8. **Quality loop.** Attempts 1-4 (catalogue `visual`; new seed; `visual` rewritten by Haiku; new seed), then an Opus review of
   all four attempts that either accepts one the checker was too strict about or supplies a new `visual` for two final
   attempts; otherwise the ingredient is picture-less and shows its emoji. Review decisions are committed in
   `image_review.json` so a re-run never re-litigates them. Checking is batches of ten real pictures plus one decoy under
   neutral file names (so a checker cannot read the answer off a name), a strict verdict schema, a Sol tie-break for
   `unclear`, and a per-model vision proof before any model may check anything (refuse, never degrade).
9. **Calibration rule (the operator's, applied mechanically).** 100 pilot first-attempt pictures drawn purely at random with a
   recorded seed, 50 to Luna and 50 to Haiku; Sol and Opus judge all 100 blind, then each reviews the checker's verdict, then
   reconciles only where they still disagree. A checker qualifies if it has at most 2 errors over its 50 (every unresolved
   image counts as an error), zero `wrong_food` false accepts and catches every decoy. Haiku checks the full run if it
   qualifies, else Luna; if neither does the full-run checking pauses and the operator is asked. The rule was written before
   the run so the result cannot move the bar.
10. **Catalogue honesty.** `what` and `facts` are written by Haiku, every fact is checked by a second Haiku pass with web access
    (doubtful or false facts are dropped), a mechanical rule rejects health and nutrition claims and invented precision, and
    Sol audits a seeded sample of 150 facts against a 146-upheld bar. The loader and the offline validator share one set of
    per-entry rules so the two cannot drift.

# Rejected alternatives
- **Commit the WebPs to git.** About 150 MB on the first add, and every regeneration adds the changed files forever; every
  clone, CI checkout and her fork's upstream sync carries it. The operator said it must not bloat history.
- **Git LFS.** GitHub's free LFS storage and bandwidth are small and every CI checkout and fork sync draws on them;
  exceeding them is a paid data pack (a spend).
- **A CDN or third-party bucket at runtime.** Forbidden by the self-hosted-assets rule, and the standalone edition must not
  depend on fleet infrastructure.
- **Deleting old release assets / only the newest pack.** Breaks any older manifest, fork or self-healing server.
- **Storing the picture or `what` in the round's snapshot.** Would freeze a picture forever and put catalogue data into chat
  tables that delete and wipe must then handle; read-time lookup avoids both.
- **A separate catalogue JSON route.** One more request and one more cache to keep in step for no gain; Blind safety is free
  with enrichment of the already-redacted view.
- **Illustrated or per-ingredient-styled pictures.** Less recognisable and mismatched pairs.
- **Letting the batch share ComfyUI's queue freely.** A live game would wait behind an arbitrary run of batch pictures.

# What to watch for
- Publishing a new pack: never delete a release; run the history check (every manifest ever committed must still answer its
  URL with exactly its `bytes`); `install` BEFORE the manifest PR merges so the new slot has its pictures; `cancel` a pending
  pin you will not merge or its objects are never collected.
- Two manifests with the same `packVersion` but different content are different manifests (identified by the sha256 of the
  file); GC and the registry key on that digest.
- An object is served only if BOTH renditions of its ingredient exist, so a partial install shows emoji, not a half card.
- Lock timeouts: the app waits 5 s so a busy store never delays boot; the tooling waits 120 s. Nothing ever proceeds
  unlocked.
- The empty manifest (`pack: null`) and an empty catalogue are valid and are what the repo shipped before any run; CI skips
  the real-pack proof for it.
- Keep the picture prompt server-owned and the tooling offline: nothing from chat (names, baskets, votes) may ever reach a
  catalogue, picture or checker prompt (Inv 58).
- The pilot ran as a hub scheduled task in an Interactive session, not on the Grid (the hub's Grid workers take CI jobs
  only); the `images.py` docstring still says Grid.
- The history check in code only confirms each URL answers its byte count; the spec's extra "clean-environment fetch of the v1
  manifest from v2 onward" is not implemented in `images.py publish` and should be added when v2 is first published.
