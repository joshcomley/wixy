# Milestone 9 slice 1: the publish pipeline core + ledger — materialize, commit/push/tag with retry, build/verify, swap/prune

## Context

Milestones 1-8 are done. This is the first slice of milestone 9 ("Publish +
history," spec/09-work-plan.md), and the first genuinely new subsystem since M6 —
`wixy_server/publisher.py` did not exist before this slice. Every prior milestone's
"Publish" button, page-delete route, media-delete route, and E2E 1/4 test have been
explicit placeholders pointing here (decisions/00011 #4, 00013's watcher/lock gap,
00015 #3/#4, 00019, 00020 #4, 00022, 00023 all name this milestone by number). This
slice builds the pipeline ITSELF — steps 1-5 of spec/04-server.md §5 — with no HTTP
surface yet (that's slice 2); everything is exercised directly against real git
repos, origin simulated as a genuine bare repo (spec/08-testing-acceptance.md §1),
not mocked.

## Decisions

**1. Media materialize COPIES the referenced staged file into `images/` BEFORE
running `builder validate`, and only DELETES the original from `draft/media/`
AFTER validate succeeds.** The naive approach — move-then-validate — has a real
data-loss bug: if validate fails on a DIFFERENT key in the same publish, the
abort path (`git reset --hard HEAD` + `git clean -fd`) reverts tracked content
changes and removes the newly-added (untracked) `images/<name>` copy, but a
raw filesystem MOVE would have already deleted the ORIGINAL from `draft/media/`
by then — the file would be gone from both places. Validate must run AFTER the
file physically exists at `images/<name>` (its own image-exists check resolves
against the real published path), so copy-then-conditionally-delete is the only
order that's both correct (validate sees the real target) and safe (a failure
never loses data, even transiently). Covered by
`TestMediaMove::test_a_validate_failure_leaves_the_staged_draft_file_in_place`.

**2. A font role/image src rewrite (`/admin/draft-media/<name>` → `images/<name>`)
walks the op's value RECURSIVELY, the same shape `scan_image_refs`
(`builder/content.py`) and `scan_media_references` (`wixy_server/media.py`)
already key off — a `{src, alt}`-shaped dict anywhere inside the value, not just
at its top level.** This is what makes an item-scoped list op (e.g. a whole
`showcase.items` array containing an image nested inside one item) rewrite
correctly without any special-casing for "is this a direct or item-scoped
binding" — the SAME recursive walk handles both uniformly. Verified by
`TestMediaMove::test_an_item_scoped_whole_array_media_reference_is_rewritten`.

**3. `theme.json` is treated as a PLAIN JSON object inside materialize — no
`Theme`/`FontSpec` parsing, no round-trip through `theme_from_dict`/
`theme_to_dict`.** `dotted_set`/`write_json_canonical` don't need typed theme
knowledge to apply an op and write the result; a STRUCTURALLY invalid theme
write would surface naturally as a `BuildError` from the very next
`build_site_source` call materialize already makes (for its own `validate_site`
step) — caught there and converted to `PublishError`, not silently persisted as
something a real build could never load. Adding a redundant typed round-trip
inside materialize itself would be extra code duplicating a check that already
happens one call later.

**4. Page duplicate/delete materialization is built NOW (generically, driven by
whatever's in `overlay.pages_added`/`pages_deleted`) even though NO route
produces either yet.** `_delete_page` does the literal spec text ("applies
`deleted` as `git rm`"); `_add_page` duplicates the FROM-page's template file
directly at materialize time — no new `draft/pages/` staging directory/
`ProjectPaths` property was invented, since the new page's CONTENT is already
carried as ordinary overlay ops keyed under the new slug (handled by the exact
same per-file application every other page already goes through). This is
simpler than what spec's prose literally suggests (a staged draft-side
template) and needs no new storage convention — whether a DRAFT-SIDE "pending
new page" indicator is ever wanted in the admin UI before publish is a separate,
smaller UI question for whichever slice actually builds the producing routes
(still an open scope question — see this project's own M9 sidecar).

**5. A publish with a clean `git status` after materialize (staged changes are
empty) skips creating a commit entirely, rather than forcing one.** This is the
"pure upstream, zero draft edits" case: the owner clicks Publish purely to move
the pointer forward to whatever the AI lane already merged. `git commit`
without `--allow-empty` would otherwise fail outright and misreport a
genuinely-fine publish as a pipeline error. The published SHA in this case is
simply whatever `origin/<branch>` already pointed at after the fetch+merge —
still gets tagged (`wixy-publish-v<N>`) and ledgered like any other publish, so
the tag-based history-recovery mechanism and "last N versions" prune logic both
still treat it uniformly. Covered by
`TestRunPublishHappyPath::test_a_pure_upstream_publish_with_no_draft_ops_still_succeeds`.

**6. Git identity for the publish commit is passed per-invocation
(`-c user.name=Wixy -c user.email=wixy@cinnamons.uk`), not configured once on
the checkout.** Matches this codebase's existing `-c credential.helper=`
convention exactly (`wixy_server/checkout.py`'s `run_git`) — no repo-level `git
config` mutation, no state to accidentally leave behind or forget to set on a
fresh checkout.

**7. `wixy_server/checkout.py`'s `_run_git` is renamed to the public `run_git`
and re-exported from `publisher.py` (`from wixy_server.checkout import run_git
as run_git`) — but checkout.py's OWN functions still only ever call read-only
git operations (clone/fetch/merge --ff-only/rev-parse/log).** The shared
subprocess convention (credential.helper disabled, timeout-bounded), not
read-only-ness, is what's actually reusable; `publisher.py` is the only module
that calls `run_git` for a write operation (add/commit/push/tag/reset/clean).
The explicit `as run_git` re-export (not a bare `from ... import run_git`) is
needed because this project's `mypy --strict` config implies
`no_implicit_reexport` — `test_publisher.py`'s push-rejection test monkeypatches
`wixy_server.publisher.run_git` directly (the name as bound INSIDE publisher's
own module namespace, which is what its functions actually call), and mypy
would otherwise reject that as accessing a non-exported attribute.

**8. The UI-phase-to-pipeline-step mapping (spec/05 §5's `pulling → merging →
committing → building → verifying → swapping → done`, seven UI phases against
spec/04 §5's five numbered steps) folds `merging` to cover BOTH step 1's local
merge AND step 2's materialize.** "Merging the draft into the tree" reads
naturally as one user-facing phase even though it's two internal operations;
`verifying` gets its own phase covering step 4's second half (the smoke check),
distinct from `building` (step 4's first half, the actual `builder build`
call). `PublishJob.stage` uses exactly these seven values plus a terminal
`failed`.

**9. The "text-diff sanity" smoke check (spec/04 §5 step 4: "catches
catastrophes without blocking intentional edits") compares 2 pages'
BeautifulSoup-extracted visible text via `difflib.SequenceMatcher` ratio,
logging a WARNING (never aborting) below a 0.5 similarity floor.** Spec
specifies neither the comparison method nor a threshold; a warning-only
outcome is the correct posture regardless of the exact number chosen, since a
deliberate full-page content rewrite is a completely legitimate, common edit
this check must never block. Not yet unit-tested in isolation this slice (the
happy-path tests all publish once, so there's no "previous build" to compare
against yet) — worth a dedicated test once slice 2/3 makes multi-publish flows
easier to set up through the HTTP layer; tracked as a gap, not silently
dropped.

**10. Prune keeps every build referenced by the ledger's last 20 ENTRIES (by
count), not by distinct SHA.** A restore re-using an old SHA still counts as
one of the 20 "versions" for this purpose — spec's "last 20 versions" reads
naturally as entry-count. Verified with 22 publishes:
`TestPrune::test_keeps_only_the_last_20_versions_worth_of_builds` confirms
exactly 20 build directories survive on disk, matching the union of SHAs from
the ledger's last 20 entries.

**11. The publish lock is a real FILE (`locks/publish.lock`), written at the
start of `run_publish` and removed in a `finally` — `wixy_server.watcher`'s
`fetch_once` checks it FIRST, before attempting `ensure_checkout` at all, and
no-ops (not an error) while it exists.** This closes decisions/00013's
explicitly flagged gap ("coordinating the watcher with the publish lock — that
lock doesn't exist until the publisher, M9"): without this, the background
fetch loop could fast-forward the working tree out from under an in-flight
publish's uncommitted materialize. The IN-PROCESS "is a publish already
running" check (for mapping a concurrent HTTP request to 409) is deliberately
NOT this module's job — that's a plain `PublishJob.is_running` read on
`app.state`, synchronous and race-free on its own within asyncio's
single-threaded event loop, which slice 2's route builds.

**12. `PublishJob` mirrors `WatcherStatus`'s existing pattern exactly**: a plain
mutable dataclass, mutated in place from the thread running the pipeline,
meant to be read directly by a concurrent SSE/poll reader (slice 2) with no
additional locking — the same shape this codebase already trusts for the
watcher's own status exposure.

## Verification

`wixy_server/ledger.py` (new) + `test_ledger.py` (12 tests): append-only,
fsync'd, publish + restore entry shapes coexisting in one file, `next_version`
correctly advancing past a restore. `wixy_server/live_pointer.py` gained
`save_live_pointer` (tmp+rename, matching `overlay.save_overlay`'s own pattern)
+ 3 new tests. `wixy_server/checkout.py`'s `_run_git` → public `run_git`
(decision 7) — existing tests unaffected (no test referenced the private name
directly). `wixy_server/watcher.py`'s lock-skip + 1 new test. `wixy_server/
publisher.py` (new, ~450 lines) + `test_publisher.py` (19 tests) against REAL
bare-origin git repos: full happy path (content, theme, `_global`, second
publish gets version 2), rev-conflict (nothing touched), validate-failure
abort (working tree genuinely clean after — `git status --porcelain` asserted
empty), media move + item-scoped rewrite + the copy-before-delete safety
property, page delete + duplicate, a GENUINE two-attempt push-rejection race
(a real competing commit pushed from a second clone, `_commit_push_and_tag`
driven directly to force the exact mid-pipeline race `run_publish`'s own
preflight would otherwise absorb harmlessly) succeeding on retry with both
changes present, a forced second-rejection abort (leaves the overlay
untouched), prune, and lock-file cleanup on both success and failure paths.

One real bug found and fixed by running the tests, not by inspection:
`run_publish`'s first line originally called `current_sha(paths.repo)` — for a
fresh project's very first publish (no checkout cloned yet), this raised
`CheckoutError` before `ensure_checkout` ever ran, since there was no git repo
at that path yet. All 19 new tests failed identically on the first run with a
`NotADirectoryError` from the git subprocess call. Fixed by guarding the same
way `wixy_server.site_source.build_site_source` already guards its own first
checkout read (`if (paths.repo / ".git").exists()`).

`python -m pytest` 412 passed (was 377); `mypy --strict` clean (80 files);
`ruff check` + `format --check` clean. No frontend files changed this slice
(backend-only, no HTTP surface yet) — nothing to rebuild.

## What to watch for

- Slice 2 (publish HTTP surface + admin-ui) is next: `POST /api/admin/publish`
  should kick off the pipeline as a background task and return promptly
  (202-style), with `GET /api/admin/publish/stream` (SSE) as the sole progress
  channel polling the shared `PublishJob` — spec's "concurrent request -> 409
  with the running job id" only makes sense if the first POST isn't still
  synchronously blocking for the whole multi-second pipeline. This is a design
  choice spec leaves open; log it as its own decision when slice 2 builds it.
- The smoke-check threshold (decision 9, `_SMOKE_SIMILARITY_FLOOR = 0.5`) has
  no direct unit test yet — add one once a multi-publish flow is easier to
  drive (slice 2/3), don't let it stay untested indefinitely.
- Slice 4's scope question (page duplicate/delete ROUTES, not just
  materialization) is still explicitly undecided — spec/09's own M9 one-liner
  doesn't name it, and decisions/00015 #3 only committed to building it
  "once M9 clarifies the contract," not to M9 doing so automatically. Decide
  explicitly, one way or the other, rather than let it drift.
- Restore (slice 3) rebuilding a PRUNED build needs some way to reconstruct an
  arbitrary historical tree — recommend `git worktree add <scratch-dir> <sha>`
  (reuses the exact same `load_site_source`/`build_site` calls this slice's
  own pipeline already uses) over decisions/00010 decision 4's originally
  anticipated per-file `git show` reconstruction, which would need its own
  scratch-directory materialization anyway since `builder`'s functions are
  Path-based, not content-addressable. Log this deviation explicitly when
  slice 3 builds it.
