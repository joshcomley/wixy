# Independent Astra review — Cookout modes (09c)

Reviewed the complete `spec/server-chat/09c-cookout-modes.md` at `38b1b91e`, after fetching and merging `origin/cmd/workspace-00058`, against the branch's bank/draw engine, deployed-v21 store, game logic, routes, AI, pictures, admin UI, specs 09/09a/09b, and the chef-fix brief.

**Findings: 2 high, 0 critical.** Evidence below includes read-only Python probes and a SQLite database held entirely in memory. No implementation changes were made.

## H1 — HIGH: the claimed v21 refusal is false; overlap can persist an invalid toastie round

**Location:** 09c §5.6, lines 552–560; related §5.1, lines 488–497, and §8.2 migration tests.

**Problem:** The specification permits the overlap on the assertion that an old process always finds no candidates and returns `409 exhausted` without writing. `produce` is already a valid Classic role. Moreover, v21 interprets the new per-turn schedule using the old paired index, `(turn - 1) // 2`. The added column and schema version do not prevent old code from operating: `store.py:1492` accepts a database at a higher version, and the v21 round decoder at `store.py:1159` ignores `mode`.

**Failure scenario and reproduction:** A new process creates a toastie round with this permitted schedule:

```text
bread, produce, produce, cheese, cheese, main, main, finish
```

It reaches turn 3 normally. The turn-3 pick reaches the old process during overlap. In an in-memory database migrated by the actual v21 code and then given the specified v22 column/version, calling the unmodified `LiveChatStore._cx_commit_pick` committed the pick and inserted turn 4 with `enoki-mushroom` and `asparagus`. Both are `produce`; turn 4 must be `cheese`.

The relevant path is `store.py:4224` (record choice), `store.py:4238` (draw the next turn), and `store.py:3738` (resolve its role using the old paired schedule). The transaction succeeds, so rollback on exhaustion provides no protection. The new process subsequently reads the persisted wrong pair. No completed round or pending chef job is needed to trigger this. Finished rounds also expose other old write paths: for example, a seeded bread's rescue swap uses its bank role (`base`) in `cookout_game.py:462`, allowing replacements outside the bread pool.

**Exact fix:** Replace §5.6's tolerated-overlap assumption with an explicit activation barrier. Deploy the additive v22 migration and mode-aware code with creation of non-Classic rounds disabled server-side; keep the toastie tile unavailable too. Enable toastie creation only after every v21 HTTP process and recovery/picture worker has drained and stopped. Prevent rollback to a v21 binary while non-Classic rows exist, or first ship a compatibility release that refuses all non-Classic mutations and excludes those rows from every background claim. Require those refusal/skip guards for unknown modes in future releases as well. Add an overlap regression using the schedule above and actual v21 write logic: before activation no toastie can be created, and after activation no v21 writer/runner can access it. Preserve the additive migration; changing the already-deployed v21 schema is not the fix.

## H2 — HIGH: the new mandatory prose gates repeat the production failure on valid toasties

**Location:** 09c §3.4, lines 396–399 and 410–415; §8.3, lines 727–731; inherited chef-fix acceptance requirement at §8.4.

**Problem:** This adds two fatal free-text checks beyond the chef-fix's high-precision food scan. Neither establishes that a recipe uses the wrong bread or is the wrong dish. The chef-fix brief changes contraband matching and repair attempts; it does not make these new checks safe.

**Failure scenarios and reproduced evidence:**

- With the correct bread ID in every concept, the actual `bank.mentions` returns **false** for `mentions("White bread toastie", "sliced-white-bread")`, `mentions("Ciabatta toastie", "ciabatta-roll")`, and `mentions("Brioche toastie", "brioche-burger-bun")`. These are normal names for the selected breads. A description that explains the filling without repeating the full catalogue name also fails. The helper at `cookout_bank.py:504` recognises exact names/aliases or a bare family entity; it does not accept every reasonable shortened reference to a selected bread. The new rule applies this brittleness to every concept in every toastie round, even without stars enabled.
- `food_free_tokens("A closed sliced white bread toastie, never an open sandwich.")` retains the contiguous words `open sandwich`. The mandated blacklist therefore rejects an explicit statement that the dish meets the rule. Likewise, `A closed ciabatta roll toastie with bruschetta-inspired tomato filling.` retains `bruschetta` and fails despite describing a closed sandwich. The current helper removes food spans; it does not interpret negation or distinguish inspiration from dish identity.

Either condition invalidates the whole three-concept answer and spends a repair attempt on valid food. More retries do not correct the acceptance contract, and §8.3 currently requires blanket phrase rejection instead of protecting these valid cases.

**Exact fix:** Keep the bread ID mandatory in every `pickedIngredientIds`, forbid it in `omitted`, and retain build, coverage, staple, forbidden-ID and genuine unpicked-food validation. Keep naming the bread and making a closed sandwich as prompt instructions, but remove both the mandatory `bank.mentions` failure and the unconditional `notDishWords` failure from acceptance. Resolve and display the canonical bread name from the validated bread ID, rather than requiring the model to reproduce its catalogue spelling. Treat ambiguous dish-word matches as trial-review signals, not fatal validation errors; document the semantic limit in §7. Replace the blanket phrase-rejection tests with acceptance regressions for the examples above, and retain rejection tests for a missing/wrong bread ID, omitted bread, invalid build and actual unpicked foods. Include these cases in the toastie trial so a high aggregate pass rate cannot hide the same class of false rejection that broke Classic in production.
