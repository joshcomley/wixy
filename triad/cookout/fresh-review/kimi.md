# Cookout spec — Kimi fresh review (phase 4)

Scope: critical/high defects only, checked against `triad/cookout/ruling.md` and the current code. The v21
SQL executes in an in-memory SQLite database with a stub `messages` table. No critical findings; **9 high
findings**. The rulings themselves (WYR seat rule, three tables, eight staples, no second LLM checker, etc.)
are not relitigated here.

## H1 — The wire section never states the mandatory unlock/auth gate on Cookout routes

- **Severity:** High (private-chat route security contract is incomplete).
- **Section/line:** §4.2, especially lines 573–642.
- **Problem:** The route list never says that every Cookout route calls `require_server_token` before reading a
  body or returning game/recipe data. `?as=` and `sender` are only player labels; they are not authorization.
  The server-chat code's actual gate is `require_server_token` (`tokens.py`), and every existing Adventure
  mutation/read calls it first. A literal implementation of this spec could expose blind views and the Recipe
  book behind only the outer admin Access check, without the chat unlock.
- **Exact fix:** Add at the start of §4.2: “Every `/api/admin/server/cookout*` route, including
  `/cookout/bank`, calls `require_server_token` FIRST; only then does it validate `sender`/`?as=` with
  `_slot_of`. A missing/invalid/expired token or revoked grant gets the existing 401 `locked` response; no
  player label is an auth credential.” Add a parametrized 401 test for every route (create, view, join, pick,
  skip, abandon, bank, book and all retries), plus revoked-grant coverage.

## H2 — Blind views leak the partner's culinary role

- **Severity:** High (blind-mode information leak).
- **Section/line:** §1.3 lines 127–135 and the `current` wire shape at lines 592–598.
- **Problem:** Redaction clears only `options`, `offerIndex`, and `skipsRemaining`; `current.role` is always
  present. A non-active blind viewer therefore learns whether the partner is choosing from `base`, `protein`,
  `produce`, or `accent`, which is information about the hidden offer. It is also exposed to a non-player while
  waiting for Join.
- **Exact fix:** Make `current.role` nullable and set it to `null` whenever `blind && state == 'picking' &&
  viewer_slot != current.player`; expose it only to the active player. Keep public `turn`, `player`, and
  `waitingForJoin` if activity is desired. Add serializer and route tests asserting that role, option ids,
  names, categories, aliases, blurbs and offer history are absent from every non-active blind response,
  including mutation responses.

## H3 — The draw contains three fallbacks that violate the hard pair/everyday rulings

- **Severity:** High (core draw can produce ruled-out offers).
- **Section/line:** §2.3 steps 3–4, lines 293–305.
- **Problem:** (a) `cat_b != cat_a` is enforced only “when at least two categories … have legal families”,
  allowing a same-category pair although the ruling makes two categories mandatory. (b) Option 1 may fall back
  to any rarity when no everyday family remains, although at least one everyday option is mandatory. (c) Even
  without that fallback, choosing a family with an everyday entry and then uniformly from **all** its eligible
  entries can select an exotic/uncommon variant, so the stated guarantee is false.
- **Exact fix:** Remove all three relaxations. Build candidates only from pairs of distinct legal categories;
  for Option 1 choose an everyday family and then uniformly from that family's **everyday eligible entries**.
  If no legal pair with two distinct categories/families and at least one everyday entry exists, return `409
  exhausted` without charging a skip or changing the current pair. Strengthen the 500-round validator to assert
  every one of these invariants on every pair, not merely zero exhaustion.

## H4 — The deterministic contraband scan can be bypassed for staple-cap and omitted-item violations

- **Severity:** High (the ingredient manifest is not actually enforced in prose).
- **Section/line:** §3.2 lines 378–390.
- **Problem:** Two defects:
  1. The exclusions simultaneously say “the 8 cupboard staples” and list generic `butter`, `flour`, `milk`,
     `oil`, and `sugar` as stop-words. Consequently a candidate can mention all five unpicked non-seasoning
     staples in prose while declaring at most four in `stapleIds`; the cap never sees the undeclared use.
  2. “Not claimed as used” is not a deterministic lexical rule: a name can occur in a negation, comparison, or
     garnish instruction. As written, builders cannot tell whether any occurrence or only affirmative usage is
     rejected.
- **Exact fix:** Keep the deterministic approach but make it literal: exclude only picked items/families,
  water/salt/black-pepper, the concept's declared `stapleIds`, and genuinely non-food stop-words. Remove every
  staple food name from `stopWords`; an unpicked non-seasoning staple appearing in prose without being declared
  is a violation. For `omitted` items, prohibit **any** name/alias occurrence in `title`, `description`, or
  `steps` (and state that in the prompt); do not attempt to infer negation. Continue allowing the item in its
  own `omitted.reason`. Add tests for five undeclared staples, negated mentions, and an omitted item used in a
  step.

## H5 — Manual retry transitions do not reset the persisted job state they depend on

- **Severity:** High (advertised retries can immediately reuse an old run or be judged exhausted/expired).
- **Section/line:** §1 lines 42–57, §3.5 lines 489–493, and retry routes at lines 632–639.
- **Problem:** The spec says failed/unavailable concepts, pictures, and recipes are retryable, but never
  defines their retry writes. `tries` may already be 2 or 3, `deadline_at` may be past, and `run_id` may still
  identify the failed run. Those are exactly the fields used by §3.5 to decide whether work starts and which
  completion may land. A retry can therefore do nothing, resume the wrong run, or accept a stale result.
- **Exact fix:** Specify one store transaction per retry: require the permitted terminal state; set the target
  back to `pending`; clear `run_id` and `error`; set `started_at = now`, `tries = 1`, and a fresh deadline;
  and publish the new revision. Concept retry also clears `concepts_json` and resets image-job fields; recipe
  retry clears `recipe_json` and leaves `banked_at` null; picture retry preserves successful `pictures` and
  retries only missing slots. A repeated request while already `pending` remains a no-op. Add tests from
  `tries >= limit`, expired deadline, and an old run completing after the new epoch begins.

## H6 — Two-phone serialization is required by the game but neither stated nor tested completely

- **Severity:** High (the core turn/job state machine can double-apply if implemented from the document alone).
- **Section/line:** §1.4 lines 150–171 and the test list at lines 729–739.
- **Problem:** The spec describes idempotent replays but never explicitly requires all move decisions and draw
  writes to occur under the store's `BEGIN IMMEDIATE` write transaction, and its tests contain no competing
  two-store/two-phone cases. Idempotency handles a retry; it does not by itself prove that two different moves
  race safely or that the final pick enqueues exactly one job.
- **Exact fix:** Add to §1.4: every create/join/skip/pick/abandon/bank/retry decision runs in one
  `store._write_txn()` (`BEGIN IMMEDIATE`), with clock sampled after lock acquisition and notifier called only
  after commit; the first applicable move wins and the loser re-reads. Add tests using two independent store
  connections for pick/pick, skip/pick, join/join, new/new, bank/bank, retry/retry, and the final pick, plus
  delete/wipe while a job completes. Assert one state transition/event/job and no second draw.

## H7 — The new ComfyUI contract names a non-existent exception and a different latent node

- **Severity:** High (the specified image implementation conflicts with the code it must extend).
- **Section/line:** §3.3 lines 405–413.
- **Problem:** (a) The existing exception is `ImageGenerationError` (`wyr_images.py` lines 40–43), not
  `WyrImageError`. (b) The current Krea graph uses `EmptyLatentImage` (`wyr_images.py` lines 352–357), while
  the spec mandates `EmptySD3LatentImage`. The former breaks the Python interface; the latter risks every
  Cookout submission failing or changing the established latent contract.
- **Exact fix:** Specify `EmptyLatentImage` exactly as in the current graph, and make `generate_pair` raise the
  existing `ImageGenerationError` when either result is missing. Preserve all other current WYR node settings;
  only generalize the number of sampling chains. Add an explicit test that the wrapper keeps WYR's existing
  behavior and exception type.

## H8 — UI ownership/test paths do not exist, and the listed tests would not be discovered

- **Severity:** High (the UI change can miss the live stylesheet and its required tests can silently not run).
- **Section/line:** §6 lines 749–754 and Appendix A P4 at line 788.
- **Problem:** The live stylesheet is `admin-ui/src/server/chat.css`, not `admin-ui/src/styles/livechat.css`.
  Existing tests live under `admin-ui/tests/`, and `admin-ui/vitest.config.ts` includes only
  `tests/**/*.test.ts`; `admin-ui/src/server/__tests__/` is outside discovery and does not exist. Naming
  `gameTabs.test.ts` also misses the existing `serverGameTabs.test.ts` precedent.
- **Exact fix:** Change P4's stylesheet ownership to `admin-ui/src/server/chat.css`. Put the new tests under
  `admin-ui/tests/cookout/` (or the existing flat `serverCookout*.test.ts` convention) and name the shared-frame
  extension `admin-ui/tests/serverGameTabs.test.ts`. Update §6 and Appendix A accordingly and require
  `npm test -- --list` to show every new file.

## H9 — The cmd-retention paragraph materially understates what remains after delete/wipe

- **Severity:** High (the erasure documentation gives a false privacy expectation).
- **Section/line:** §3.5 lines 499–504; also the Inv 57 documentation requirement at lines 769–772.
- **Problem:** It says cmd's retained run “contains only static bank ingredient names/IDs”. In fact the hidden
  chat-spawn ledger/transcript also retains the selected **combination**, generated concepts, full recipes,
  omission reasons, and any repair feedback/contraband words. Those outputs are not static bank content, and
  this server's delete/wipe cannot remove them.
- **Exact fix:** Replace the sentence with an accurate limit: “cmd retains the food-only prompt AND response,
  including the selected basket combination, generated concepts/full recipes and repair feedback; no player
  name, email, message body, device id or other chat content is sent, and this server cannot erase cmd's copy.”
  Carry the same wording into Inv 57 and the runbook. Do not describe the retained material as merely static
  bank data.
