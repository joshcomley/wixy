# Cookout specification — fresh review, Astra

**Verdict: changes required — 6 HIGH findings; no CRITICAL findings.**

Reviewed `spec/server-chat/09-cookout.md` in full against `triad/cookout/ruling.md` in full and the code. The decided rulings are the acceptance criteria for this review.

Spec location: `D:/Servers/Cmd/Storage/clones/wixy__worktrees/00058__wixy_develop-cookout-cooking-game-with-ai-rec/spec/server-chat/09-cookout.md`.

Final checked spec SHA-256: `C5A34DB55501F55571BB147F309298966E75C59E241ED6ABB7FB8ECD12FA7713`; author-checkout HEAD: `989b501ccc2da30575e4f4483f7c0e2bb3c35410`. The spec changed during review by adding six blank lines in Appendix A; I checked the complete diff and confirmed all nonblank content is identical. References below reflect that revision. The relevant image/store/runner/model source files were hash-compared with my checkout and are identical. Code evidence below was checked directly; there was no live GPU or implementation test run.

## H1 — Downloaded Cookout images have no specified erasure owner

**Severity:** HIGH — private content can survive indefinitely outside the attachment cleanup paths.

**Location:** §3.3, lines 414–435, particularly line 427 (`server/cookout-tmp/`); §3.5 lines 499–502; §6 image/erasure tests.

**Problem:** The spec introduces `server/cookout-tmp/` and says the existing Comfy sweeper automatically cleans Cookout. That sweeper cleans Comfy's output/history, **not** the downloaded PNGs in the supplied `out_dir`. The local copies are additional private content, and successful staging copies them rather than making the attachment system own their original paths. No success/failure/cancellation cleanup or startup/periodic recovery for the new scratch root is specified.

This is a concrete coverage gap in the cited code:

- `wixy_server/livechat/wyr_images.py::generate_pair` writes downloaded files to `out_dir` at lines 459–461; its `finally` calls `_forget_run`, which cleans the configured Comfy output directory/history.
- `wixy_server/livechat/wyr_game.py::generate_round_images` separately removes its download work directory and unattached staging in `finally`. `clear_wyr_scratch` scans **`server/wyr-tmp`**, not `cookout-tmp`.
- `wixy_server/livechat/janitor.py::cleanup_unreferenced_storage_once` scans media, uploads and failed-media storage, not `cookout-tmp`. Anchor FKs and `_wipe` SQL cannot remove a PNG from that new root.

A job can complete, or its process can die, leaving a meal image/prompt metadata in the new root after the anchor and banked recipe have been erased. Reusing the `wyr_` **filename prefix** does not cover a different **directory**.

**Exact fix:** Specify an attempt-scoped random work directory below `cookout-tmp`, owned by the Cookout image runner. Its `finally` must remove every downloaded file/work directory and every staged upload not transferred by the successful attachment transaction, on success, failure, lost claim, deletion and cancellation. Add `clear_cookout_scratch` to startup **and the already-planned supervised sweep**, using the conservative 900-second age threshold so young work from a blue/green overlap is preserved. A startup-only sweep is insufficient: a young orphan skipped at startup must be reclaimed when it ages out without requiring another restart. Retain bounded Comfy cancellation/history/output cleanup as a separate obligation.

**Required tests:** success and partial failure leave no scratch copies; delete/wipe during generation cannot land an attachment and leaves no surviving scratch after cleanup; a killed-process orphan initially too young is removed by a later sweep; unrelated/young live work is preserved; rejected upload staging is journaled/removed.

## H2 — Picture recovery has no way to fence a superseded attempt

**Severity:** HIGH — an old worker can finish or fail a newer attempt and defeat the promised self-healing/partial preservation.

**Location:** §3.3 lines 423–435; §3.5 lines 489–493; Appendix A.2 lines 888–902 (`claim_cookout_pictures`, `store_cookout_pictures`, `fail_cookout_pictures`).

**Problem:** Claim updates `images_started_at`/`images_tries`, but returns only a status string. Neither store nor fail receives the identity of the claimed attempt. The generic `(pending AND run_id=?)` completion rule cannot protect images: their row has no image run-id field and these methods accept no expected claim.

Concrete race: attempt A starts; a replacement process or stale sweep claims B; A then exits late. `fail_cookout_pictures(anchor_seq, now=...)` cannot distinguish A from B and may mark B failed. Likewise A's `store_cookout_pictures` can merge its stale missing-slot snapshot while a newer attempt is active, potentially replacing/duplicating a successful slot or ending the newer wait. An in-process running set cannot protect separate blue/green processes. Existing Adventure's shape is a precedent for storage, not evidence that this stronger partial-retry contract is fenced.

**Exact fix:** Keep the ruled three tables. Add a monotonic `images_generation INTEGER NOT NULL DEFAULT 0` to `cookout_rounds`, incremented atomically when the initial attempt, a recovery claim or manual retry starts. Return the claimed generation from `claim_cookout_pictures`; pass `expected_generation` to **both** store and fail. Each write requires the live anchor, `state='finished'`, `concepts='ready'`, `images='pending'` and the exact generation. A losing write returns false, journals/removes its unattached staging and leaves the current attempt untouched. Never reset generation when resetting the bounded retry counter. Merge only still-missing/failed slots under that same transaction and preserve already-ready attachments.

**Required tests:** with two store instances, claim A then B; late A failure and late A success both do nothing to B; a manual retry also fences earlier completions; a stale partial result cannot replace a successful slot or leave extra unowned uploads. These checks belong in the explicit P2↔P3 signature contract before parallel build.

## H3 — The draw algorithm does not enforce the ruled everyday/category guarantees

**Severity:** HIGH — valid inputs produce a different game from ruling 3, or an avoidable draw failure.

**Location:** §2.3 lines 294–307; §2.1 validator lines 250–256; §6 bank tests lines 725–728.

**Problem:** Option 1 chooses a family which **contains** an everyday entry and then samples uniformly from **all eligible entries of that family**. It may therefore select an uncommon/exotic member. Its explicit fallback also allows a category with no everyday entry, while option 2 is independently weighted. The claimed everyday guarantee is false in both cases. Minimal fixture: category A/family F has one everyday and one exotic entry; category B/family G has one uncommon entry. The written selector can return exotic + uncommon.

The category rule also permits `cat_b == cat_a` when fewer than two eligible categories remain, despite the ruling requiring two different categories. Selecting categories before proving a distinct-family/everyday pair exists can strand the algorithm even when a valid pair exists elsewhere. Thirty everyday families **per role**, not per eligible category, does not repair these cases.

**Exact fix:** Treat distinct categories, distinct families and at least one everyday **entry** as hard pair eligibility constraints. Find feasible category/family pairings under those constraints before applying least-shown tie-breaking. Sample the guaranteed side strictly from everyday entries, then the other side with the ruled 8:3:1 tier weights. If the preferred category/family combination has no everyday completion, choose another feasible combination. Relax only the explicitly soft previously-offered-family preference. If no legal pair exists, return `409 exhausted` with no draw/skip/state mutation; never relax either hard category/everyday requirement. Keep the shuffled paired role schedule unchanged.

**Required tests:** mixed-rarity entries in one family; least-shown category without everyday entries but a valid alternative elsewhere; cross-category family collisions; one remaining eligible category; and explicit assertions on **every emitted pair** in all maximum-skip simulations, not merely a test that simulations did not throw.

## H4 — The lexical exclusions can bypass the staple cap and frozen recipe manifest

**Severity:** HIGH — deterministic validation can accept a known, undeclared food despite the stated ingredient contract.

**Location:** §3.2 lines 366–389; §3.4 lines 475–484; Appendix A.1 `find_contraband_ingredients`.

**Problem:** The prose scan globally excludes all ten basket ingredients/families, ambiguously excludes “the 8 cupboard staples”, and unconditionally stop-lists ingredient words including **milk, butter, flour, oil and sugar**. That makes the required candidate-specific checks ineffective unless a separate, overriding check is defined. The phrase “checking that … omitted [items] are not claimed as used” does not specify a deterministic mechanism after those words have already been removed from the dictionary.

A concrete failure requires no unknown food or difficult semantic inference: a concept declares the four unpicked extras butter, flour, oil and sugar, with no milk in its basket/manifest. Its full recipe says **“Stir in milk.”** while its ids/step references omit milk. Structural checks pass; `milk` is a mandatory known bank entry, yet the stop-word exclusion prevents a hit. The actual recipe adds a fifth non-seasoning staple and changes the frozen manifest. The documented honest limit—foods absent from the bank—does not describe this failure.

**Exact fix:** Keep the ruled main dictionary scan and define an additional deterministic **manifest-specific lexical pass** for omitted selected ingredients and undeclared non-seasoning staples. Apply it to every consumption field (`title`, `vibe`, `description`, quantity/note, method and tips) against the unfiltered relevant names/aliases; an unconditional `stopWords` match must not suppress this pass. That preserves the ruling's general family matching and generic culinary vocabulary while enforcing the existing cap/frozen-manifest rule. Remove ingredient-bearing examples such as milk/butter/flour/oil/sugar from unconditional exemptions in this manifest pass. Omission reasons may use the whole selected basket vocabulary so explaining an omission remains valid. State exactly which free-seasoning exception applies at each stage, consistently with the final recipe rule. This remains deterministic Python and uses the one ruled repair run—no second model is needed.

**Required tests:** undeclared known milk as a fifth extra; a known staple absent from the frozen recipe manifest; an omitted selected ingredient introduced in a tip/quantity/method; those same words allowed when properly declared; and genuine culinary generic words still accepted. The existing mango/bacon tests alone cannot catch an allowlist/stop-list bypass.

## H5 — The specified Comfy generalization changes the existing WYR graph and exception API

**Severity:** HIGH — the frozen instructions direct an unverified shared-generator change and refer to a nonexistent exception.

**Location:** §3.3 lines 405–413; §6 shared image regression requirements.

**Problem:** The spec mandates `EmptySD3LatentImage` and a wrapper raising `WyrImageError`, while claiming WYR is untouched. In the actual `wixy_server/livechat/wyr_images.py`, the working graph uses **`EmptyLatentImage`** (line 352), a **`ConditioningZeroOut`** negative branch (lines 347–365), and the public **`ImageGenerationError`** exception (line 40). `WyrImageError` is not defined. Existing `TestComfyClient` tests explicitly expect `ImageGenerationError` on incomplete/failed generation, including `test_livechat_wyr.py` around line 1148.

Replacing a latent node/model-conditioning graph is a different change from extending the existing two chains to three; the spec supplies no evidence for that replacement. A new exception name also contradicts the wrapper compatibility requirement and makes the frozen interface unimplementable as stated without an undocumented API change.

**Exact fix:** Generalize the **current graph verbatim** over 1–3 sampling chains: preserve `EmptyLatentImage`, `ConditioningZeroOut`, positive/negative/latent wiring, model config and 1024×1024 defaults. `generate_pair` must keep its current signature/tuple result and raise **`ImageGenerationError`** whenever either required result is absent. `generate_many` may retain partial Cookout results as ruled; the WYR wrapper remains strict. Keep the decided `wyr_` prefix and current cleanup protections.

**Required tests:** run the existing WYR image tests unchanged, assert two- and three-chain graph structure/conditioning/defaults, partial output behaviour for Cookout, and strict wrapper failure type. A real image smoke later validates performance; this review does not claim the replacement latent node has been tested live.

## H6 — The frozen UI paths exclude every new Vitest and leave the specified stylesheet unbundled

**Severity:** HIGH — implementation can report green frontend tests/build while the new UI tests never run and its CSS is absent.

**Location:** §6 lines 749–755; Appendix A P4 ownership, line 788.

**Problem:** All new Vitests are assigned to `admin-ui/src/server/__tests__/...`. Actual `admin-ui/vitest.config.ts:6` includes only **`tests/**/*.test.ts`**, so none of those tests will be collected by the normal `npm test` gate. This suppresses the planned Blind-view/parser/lifecycle verification rather than merely renaming a directory.

P4 is also assigned `admin-ui/src/styles/livechat.css`, which does not exist and is not in the CSS build graph. Actual `admin-ui/src/style.css:32` imports **`./server/chat.css`**, and `esbuild.config.mjs` builds from `src/style.css`. Creating the frozen new path without changing that graph contributes no styles to the committed bundle.

**Exact fix:** Change §6 and P4 ownership to the established paths: `admin-ui/tests/cookout/*.test.ts` for new game suites, the existing `admin-ui/tests/serverGameTabs.test.ts` for shared tab regressions, and **`admin-ui/src/server/chat.css`** for styles. Keep P4's exclusive ownership of those integration files and rebuilt admin assets. No test-runner or bundle-entry redesign is needed.

**Required verification:** the normal Vitest discovery/run lists the Cookout suites (including the privacy/lock cases), and the rebuilt admin CSS contains the Cookout selectors used by the 360 px browser fixture. Correct paths must be frozen before P4 starts.

---

Only this review file was written. The specification, ruling, implementation files and earlier proposals remain unchanged by this review; no commit was made.
