## What

`POST /api/admin/publish`, `GET /api/admin/publish/stream` (SSE), `GET /api/admin/publishes`,
`GET /api/admin/publish/preview` (spec/04 §5-6, §8); `admin-ui/src/publishDrawer.ts` (new);
`shell.ts`'s Publish button + draft-status chip wired for real, replacing the
milestone-8-era `disabled=true`/"Publishing arrives in milestone 9" stub. Restore
(`POST /api/admin/restore`) and the history panel (`#/history`) are explicitly slice 3,
not built here.

## Decision 1 — the POST/SSE concurrency shape (the design question left open by slice 1)

`run_publish` (slice 1) is a fully synchronous function with no existing precedent
anywhere in this codebase for a request-triggered "fire and forget, outlives this
request" background task — every other route awaits `anyio.to_thread.run_sync(...)`
directly within its own handler, and the ONE place something outlives a single
request (the upstream watcher) is a single long-lived task spawned once at
app-lifespan startup, not per-request.

Decided: `POST /api/admin/publish` awaits the WHOLE pipeline on a worker thread and
returns only once it's actually finished (success or failure) — the HTTP request
itself is long-lived (mirrors the pipeline's real duration, tens of seconds), but
never blocks the event loop. `GET /api/admin/publish/stream` is a SEPARATE,
concurrently-open SSE connection that polls the SAME in-process `PublishJob` (stored
on `app.state.publish_job`, mirroring `WatcherStatus`'s exact pattern) purely for
LIVE progress observation — not the sole channel by which the outcome is learned.

Rejected: kicking the pipeline off via a detached task (a new task group /
`BackgroundTasks`) and having the POST return immediately with just a job id. This
would have been the first "outlives this request" mechanism in the app, and — more
importantly — an unhandled exception in a detached task started via
`anyio.create_task_group().start_soon(...)` propagates to the WHOLE task group
(structured concurrency), which also owns the watcher loop; a single bad publish
attempt could have taken down background fetching too unless carefully shielded.
Awaiting synchronously sidesteps this risk entirely and matches the one pattern
already proven throughout the file.

Why this reconciles with spec's "progress states stream" wording: a second tab (or
a reload of the first), or simply wanting a push-based progress UI rather than
polling `/api/admin/state`, is what the SSE stream is actually for — not "the POST
returns instantly." `POST`'s own resolved/rejected outcome is what the drawer treats
as authoritative for success/failure; the stream is a supplementary progress readout.

## Decision 2 — error-status mapping

- `RevConflictError` -> 409, reusing `patch_draft`'s EXACT existing convention (same
  exception class, same message shape) — `run_publish`'s own docstring says this is
  raised before the job is considered to have "started" at all, so the route ALSO
  rolls `app.state.publish_job` back to whatever it was before the attempt; leaving
  the freshly-constructed (never-progressed) job installed would have permanently
  stuck `is_running=True` and 409-locked every subsequent publish attempt forever.
- A second concurrent `POST` while one is already running -> also 409 (in-process
  `PublishJob.is_running` check, synchronous before any `await` — atomic on
  asyncio's single-threaded event loop, no separate lock object needed, per
  `run_publish`'s own top docstring).
- `PublishError`/`CheckoutError`/`BuildError` (the pipeline ran and failed at some
  stage — already fully recorded onto `job.stage="failed"`/`job.error` by
  `run_publish` itself before re-raising) -> 502. Considered 422 (matches
  `MediaUploadError`'s existing convention) and rejected it: 422 fits "the request
  body itself was bad," but publish's request body (`{message, expectedRev}`) is
  always trivially valid — what failed is the git/build-dependent OPERATION, not the
  input. 502 was chosen as a deliberate, distinct-from-503 signal: this codebase's
  503 always means "the checkout doesn't exist / isn't readable at all" (a more
  fundamental unavailability); a publish failure leaves the checkout perfectly
  intact, just failed part-way through a multi-step operation with an upstream-ish
  dependency (git remote / build / validate).

## Decision 3 — the diff-preview endpoint's design

`GET /api/admin/publish/preview` groups changed overlay keys by `file_key` (page
slug / `_global` / `"theme"`) — the SAME grouping `_changed_summary` already uses for
the ledger's `changed` field, not a new three-way pages/global/theme split. Each
entry carries `key`, `kind`, `old`, `new`:

- `old` is looked up via `dotted_get` against the PRE-overlay baseline
  (`build_site_source`, freshly loaded, never mutated).
- `new` is the overlay op's own stored value directly (never re-derived via a
  second `dotted_get` against the merged content) — since a discarded key is
  physically removed from `Overlay.ops` (never a tombstone entry), every remaining
  op IS, by construction, an active draft change, so `op.value` already equals what
  a fresh merge would produce at that path.
- `kind` is resolved per-page via `extract_bindings_map` (one call per page slug
  appearing in the overlay, computed once and reused for that page's own entries);
  the `_global` group's kind lookup is copied from whichever page's map was computed
  first rather than a separate `extract_bindings_map` call, since partials (where
  `_global`-bound keys actually render) are shared across every page. `theme` keys
  are reported as the synthetic kind `"theme"` directly (no bindings-map entry
  exists for the theme model at all — it's a separately-typed thing, never walked
  via `data-wx-*` attributes).

Runs `builder.validate.validate_site` against the overlay-merged, IN-MEMORY
`SiteSource` — confirmed safe with ZERO disk writes by tracing every validate
sub-check's actual reads (`_validate_pages`/`_validate_theme`/`_validate_collections`
never re-parse content JSON from disk, only templates via `source.pages_dir` and
image-existence via `project_root`, neither of which the overlay ever touches).

One real gap this closes: a currently-staged, not-yet-published upload's `src` is an
absolute-looking `/admin/draft-media/<name>` string, and `_validate_images`'s
existence check (`(project_root / src).exists()`) silently discards `project_root`
entirely for an absolute right-hand side (documented pathlib `/`-operator
behavior) — every staged-but-unpublished image would otherwise have false-positived
as `missing-image` in every preview until the NEXT publish actually copied it into
`images/`. `_staged_image_keys` walks the exact same content `_validate_images`
walks (mirrors its traversal structure precisely) and computes the set of
`(file_label, dotted_key)` pairs whose image ref is a draft-media reference that
genuinely exists in `paths.draft_media` — those specific `missing-image` errors are
filtered back out of the result; a TRULY missing image (never uploaded, or a typo'd
path) still fails validate correctly, since it wouldn't be in that safe set.

Rejected: rewriting `/admin/draft-media/<name>` refs to their post-publish
`images/<name>` form before validating (mirroring `publisher._rewrite_draft_media_refs`).
This doesn't actually fix the existence check by itself (the file still doesn't
exist at `paths.repo/images/<name>` until publish actually copies it there) and
would have made the "new" value shown in the diff LESS directly usable by the
frontend (`images/<name>` is a repo-relative path, not a servable URL without
extra base-URL logic the frontend doesn't have for this context, whereas
`/admin/draft-media/<name>` already IS a directly servable URL per milestone 8's
own fix).

## Decision 4 — recurring `JsonValue`/mypy structural-typing gotcha, again

Hit twice more in this slice (the diff-preview endpoint's `changes` dict and the
validate `errors` list) — a concrete `dict[str, list[JsonValue]]`/`dict[str, str]`
doesn't automatically satisfy the broader `JsonValue`-shaped return type even though
every value trivially fits. Fixed both times via a fresh dict/list comprehension at
the return site (re-triggers mypy's bidirectional inference against the expected
type), matching the exact precedent `ledger.py`'s `_changed_summary` already
established in slice 1 — not a new pattern, just its third occurrence. If this keeps
recurring in later milestones, it may be worth a small typed helper
(`as_json_object(d: Mapping[str, X]) -> JsonObject`) rather than hand-writing the
comprehension idiom afresh each time — not done here since three occurrences across
two slices isn't yet enough repetition to justify it, but flagging for whoever hits
a fourth.

## Decision 5 — frontend: `isRunning` added to the job wire shape

`_publish_job_to_dict` gained an explicit `"isRunning": job.is_running` field (the
Python `PublishJob.is_running` PROPERTY was never itself part of the serialized
dict). Rejected deriving "is a publish currently running" client-side from
`stage !== "done" && stage !== "failed"` — that would duplicate "which stages are
terminal" domain knowledge in TypeScript, able to drift out of sync with the Python
property that already encodes it authoritatively. Small, deliberate, one-line
addition instead. No existing test asserted an exact/closed shape for `publishJob`
or the SSE payload, so this didn't break anything already committed.

## Decision 6 — SSE hand-rolled, no new dependency; EventSource construction NOT
threaded through `win` for testability

No `sse-starlette` (or similar) anywhere in `pyproject.toml`, and none was added —
`GET /publish/stream` is a plain `StreamingResponse(..., media_type="text/event-
stream")` wrapping a small async generator that polls `app.state.publish_job` every
250ms and emits a full JSON snapshot (never a delta — a client reconnecting
mid-stream, e.g. after a dropped connection or a second tab, needs the FULL current
state from any single event, not an assumption it caught every prior one).

Client-side, `publishDrawer.ts`'s `openStream` dependency is the injection seam for
tests — NOT a `win: Window` parameter threaded down to `defaultOpenStream`, since
`EventSource` is a bare global constructor in this project's TypeScript DOM lib
(not typed as a member of the `Window` interface, so `win.EventSource` doesn't
type-check) and there was no other reason `publishDrawer.ts` needed a `win`
dependency at all (unlike `mediaDialog.ts`/`themePanel.ts`, which need `win` for
other window-level APIs). Tests supply a fake `openStream` function directly and
never construct a real `EventSource`, avoiding jsdom's limited/absent EventSource
support entirely.

## Decision 7 — drawer switching, not independent multi-drawer state

`shell.ts`'s `activeDrawer` slot is now widened to a common structural `{element,
teardown()}` shape shared by both `PageSettingsDrawer` and `PublishDrawer`, tagged
with `activeDrawerKind: "pageSettings" | "publish" | null`. Clicking a DIFFERENT
drawer's trigger while one is open now closes the current one and opens the
requested one, rather than the pre-existing single-drawer-era toggle's "any drawer
open -> just close" (which, with only ONE drawer type ever existing before this
slice, was equivalent — adding a second type would otherwise have made clicking
Publish while page-settings was open silently just close page-settings instead of
switching, a real UX regression introduced by the new drawer if left unfixed).

## What to watch for

- Slice 3 (history panel + restore) will want `GET /api/admin/publishes` (already
  built here) and can reuse this slice's diff/kind-lookup helpers
  (`_binding_kind_lookup`, `_container_for`, `dotted_get`-based old/new lookup) for
  restore's OWN binding-map-driven diff, per spec/04 §5's restore semantics —
  they're written generically enough (not publish-preview-specific) to be lifted
  into a shared helper at that point rather than duplicated; consider that
  refactor when slice 3 is built rather than pre-emptively extracting it now with
  no second caller yet.
- The diff-preview endpoint's `kind: "list"` entries are shown client-side as a
  bare "N item(s)" count, not a nested item-by-item diff — spec's own UI language
  ("old -> new text snippets, image thumbs before/after, theme token chips") never
  explicitly demos list-kind rendering; if a future session decides this needs
  richer treatment, it's a `publishDrawer.ts`-only change (the backend already
  reports the full old/new arrays, nothing more to add server-side).
- `_staged_image_keys`'s pathlib-absolute-join gotcha is specific to `/admin/
  draft-media/<name>`-prefixed src strings; if a THIRD media-URL convention is ever
  introduced, re-check whether the SAME false-positive class applies to it too.
