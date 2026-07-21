# Subsystem: publish pipeline, restore & versions

The write side of the server: how a draft becomes a live, immutable build; how restore rolls
back; how the ledger records history. Read side is
[serving-and-overlay.md](serving-and-overlay.md). Spec:
[`spec/04-server.md`](../../spec/04-server.md) §5–6. Numbered guarantees:
[invariants.md](invariants.md) 7, 11, 16, 17, 18.

## Publish (`publisher.py:run_publish`)

`POST /api/admin/publish {message, expectedRev}` runs as **one serialized job** (an asyncio
lock + the `locks/publish.lock` file; a concurrent request → 409 with the running job id).
It runs off the event loop (`anyio.to_thread`), mutating `job.stage` at each transition. The
HTTP call is **synchronous**: `start_publish` stores the job at `app.state.publish_job`, awaits
`run_publish` to completion, and returns the terminal `{version, sha}`; `GET
/api/admin/publish/stream` tails that same app-wide `publish_job` concurrently for progress
(see [contracts.md](contracts.md) §4).
Stages (`PublishStage`): `pulling → merging → committing → building → verifying → swapping →
done | failed`.

**Preflight** (before any lock): `current_sha(paths.repo)` → `default_base_sha`;
`load_overlay(...)`; if `overlay.rev != expected_rev` → `RevConflictError` immediately (→409,
job never "started"). Then create `locks/publish.lock` (removed in `finally`).

1. **pulling** — `load_live_pointer` → `previous_pointer`; `ensure_checkout`
   (CheckoutError → `PublishError("pulling")`); compute `has_upstream_commits`.
2. **merging** — `_materialize` under `tree_lock()`: apply overlay ops onto `content/*.json`
   + `theme/theme.json` (canonical rewrite; `_rewrite_draft_media_refs` maps
   `/admin/draft-media/<name>` → `images/<name>`); apply page ops (`git rm` deleted, `git add`
   duplicated templates from `draft/pages/`); **copy** referenced staged media into `images/`
   + `git add`; `build_site_source` + `validate_site`. On `BuildError` or a not-ok validate →
   `_reset_hard(HEAD)` (`git reset --hard` + `git clean -fd`) + `PublishError("merging")`.
   **Only past this abort point** are the copied staged originals unlinked — so a validate
   failure never loses data (Inv 16, decisions/00024).
3. **committing** — `next_version` → `version`; `_commit_push_and_tag` under `tree_lock()`:
   `git add -A` → if `git diff --cached --quiet` says nothing is staged, **skip the commit**
   (pure-upstream publish, no `--allow-empty`) → else commit as
   `Wixy <wixy@cinnamons.uk>` msg `wixy: publish v<N> — <message>` → `git push origin <branch>`.
   **Push-reject retry (once):** `_reset_hard(pre_commit_sha)`, re-`ensure_checkout`,
   re-`_materialize`, re-push; a second failure → `_reset_hard(origin/<branch>)` +
   `PublishError("committing", "…overlay untouched")`. Then `_tag_and_push` the annotated
   `wixy-publish-v<version>` — created **even for a pure-upstream publish** (uniform recovery
   surface, Inv 17).
4. **building / verifying** — `build_site` into `builds/<sha>/` (temp dir + atomic rename);
   `_smoke_check` compares the `get_text()` of the first 2 pages against the previous build
   (`difflib` ratio) — ratio `< 0.5` is a **WARNING in the job log only, never aborts**
   (catches catastrophes without blocking intentional edits).
5. **swapping** (the only step that changes the live site) — in order:
   `save_live_pointer(sha, version)` (atomic flip) → `append_ledger(LedgerEntry(...,
   source=_publish_source_kind(...), changed=_changed_summary(overlay)))` →
   `save_overlay(discard_all(overlay))` (clears the overlay, bumps rev) → `_prune_builds`
   (keep the shas of the last `_MAX_KEPT_VERSIONS = 20` ledger entries). `job.stage = "done"`.

**Failure / kill:** any `PublishError`/`CheckoutError`/`BuildError` → `job.stage = "failed"`,
re-raise; `finally` unlinks the lock. Any failure **before step 5** leaves live + ledger +
draft untouched. A hard process-kill skips `finally` → orphaned lock, self-healed by the
watcher after 600s (Inv 18). Step 5 itself is four individually-atomic writes, not one
transaction — see the Inv 7 caveat.

## Restore (`restore.py:run_restore`)

`POST /api/admin/restore {version}` — flip live to a past version and stage the diff into the
draft; **no git commit happens** (the owner's next publish materializes it):
1. `find_version` (None → `RestoreError`).
2. `ensure_build(sha)` — returns `builds/<sha>/`, rebuilding via a detached scratch
   `_worktree_at_sha` if `_prune_builds` deleted it.
3. Diff **current main (baseline) vs the restored version (target)** via `_collect_ops`/
   `_diff_content` for each shared page, `_global`, `theme`. `_diff_content` recurses into
   dicts only; **arrays and scalars compare atomically** and emit one whole-value op (the
   spec's "list-bound keys emit one whole-array op"). Ops tagged `by="restore"`.
4. Page-set reconciliation: `resurrect = old_pages - current_pages` → any → **`RestoreError`**
   (a fully-deleted page can't be resurrected — `PageAdd` only duplicates an existing
   template); `to_delete = current_pages - old_pages` → `pages_deleted`.
5. `save_overlay(new Overlay(rev+1, ops, pages_deleted=to_delete))` **first**, then
   `save_live_pointer(entry.sha, new_version)` (instant flip), then
   `append_ledger({action:"restore", of:version})`. Returns `RestoreResult(version, sha, of)`.

`_worktree_at_sha`: `git worktree add --detach <tmp> <sha>` in a `mkdtemp`; cleanup =
`git worktree remove --force` + `rmtree` + fallback `git worktree prune` if remove failed
(decisions/00027, robustness against rare full-suite resource contention — never lower `-n 4`
to "fix" that flake).

## Ledger & versions (`ledger.py`)

`publishes.jsonl` — append-only, one JSON object per line
(`json.dumps(sort_keys=True, ensure_ascii=False)` + `flush` + `os.fsync`; never rewritten in
place). Two shapes reconciled into one `LedgerEntry`:
- **publish**: `{version, sha, when, message, source, changed}` — `source ∈ editor | upstream
  | mixed | bootstrap`, `changed = {file_key: [dotted paths]}`.
- **restore**: `{version, sha, when, action:"restore", of:<version>}` — reuses the restored
  version's **same sha** but consumes a **new** sequential version (Inv 11).

`read_ledger` oldest-first; `next_version = max+1`; `find_version` linear scan.
`GET /api/admin/publishes?limit=` returns them newest-first with the live one marked. The
ledger is the product history; `git log` + the `wixy-publish-v<N>` tags are the forensic
layer and let history survive Storage loss.

## Publish preview (`GET /api/admin/publish/preview`)

Returns `{changes: {<file_key>: [{key, kind, old, new}]}, validate: {ok, errors:[…]}}` — the
review-drawer diff of what a publish would commit, plus a pre-flight `validate_site`. It is
**overlay-op-driven** (not a two-tree diff): `get_publish_preview` iterates `sorted(overlay.ops)`,
pairs each op's `new` value with the `old` read from merged content, and looks up `kind` via
`extract_bindings_map` (`_binding_kind_lookup`; `theme` keys report `"theme"`, an unmapped key
defaults `"text"`). The kind lookup normalizes the bindings map's `@` global-scope marker
(`@hours`) away — ops address the field as `hours` — and builds the `_global` bucket as the
UNION of every page's global fields, since a global binding only appears on the pages that
bind it (decisions/00081; both mistakes previously reported kind `"text"`, which rendered a
whole-array op as raw JSON in the drawer). Because collections are already stored as whole-array ops in the overlay,
the granularity matches the overlay's collection rule (Inv 6) — but note this is a *different
mechanism* from restore's diff, which computes ops by a full structural two-tree diff
(`_diff_content`, above) rather than reading existing overlay ops.
