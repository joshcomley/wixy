# Subsystem: serving, draft overlay & preview

The read side of the server: how the public site is served, how draft edits layer over
published content, how the preview renders, and how the upstream watcher keeps the draft
fresh. The write side (publish/restore) is [publish-pipeline.md](publish-pipeline.md); the
HTTP shapes are [contracts.md](contracts.md). Spec: [`spec/04-server.md`](../../spec/04-server.md)
§3–4, §7 and [`spec/02-content-model.md`](../../spec/02-content-model.md) §8.

## Three read paths over one process

| Path | Route | Source | Editor? | Cache |
|---|---|---|---|---|
| Public (published) | `/`, `/{path}` (`routes_public.py`) | live pointer → `builds/<sha>/` | no | `max-age=300` HTML / `86400` assets |
| Draft preview | `/admin/preview/{page}.html` (`routes_preview.py`) | checkout ⊕ overlay, rendered live | **yes** | `no-store` |
| Archived version | `/admin/versions/{n}/{path}` (`routes_versions.py`) | a historical build (rebuilt if pruned) | no | — |

## Public serving (`routes_public.py`)

`GET /` + the catch-all `GET /{path:path}` (registered **last** so it never shadows admin/
internal routes). Reads the **atomic live pointer fresh per request** (`load_live_pointer` →
`pointer.build_dir`) — no in-process cache, so a publish takes effect with no restart. Serves
prebuilt static files, path-traversal-guarded (`_resolve_within_build_dir`). Before the first
bootstrap there is no `live.json` → **503 plain text** `"Site not yet published"` (never a
crash). A miss falls back to the build's `404.html`.

## The live pointer (`live_pointer.py`)

`live.json` = `{sha, version, buildDir}`. `save_live_pointer` writes atomically
(`tempfile.mkstemp` in the same dir + `os.replace`); this is the **only** moment public
serving changes, written solely by the publisher's swap step and by `run_restore`. `load_live_
pointer` returns `None` before anything is published (caller serves 503), and recomputes
`build_dir` from `sha` via `paths.build_dir(sha)` rather than trusting the stored string (one
fewer traversal surface). Every other reader (preview, public, `/api/admin/state`) only reads
it (decisions/00014).

## The draft overlay (`overlay.py`)

The visual editor never writes content files — it accumulates a sparse overlay at
`draft/overlay.json`:
```json
{ "rev": 41, "baseSha": "31fa784…",
  "ops": { "index:hero.title": {"value":"…","ts":"…","by":"editor"},
           "index:treatments.cards": {"value":[…whole array…], …},
           "theme:colors.clay": {"value":"#B26E4A", …} },
  "pages": { "added": [{"slug":"aftercare-tips","fromSlug":"aftercare"}], "deleted": [] } }
```
Key = `<file>:<dotted.path>`, `file ∈ <slug> | "_global" | "theme"`. Written atomically
(`atomic_write_json`) on every accepted PATCH. **Overlay algebra** — all raise
`RevConflictError` on `expected_rev` mismatch and return an overlay at `rev+1` (Inv 9):
`apply_patch` (SetOp writes a key, DiscardOp pops it), `add_page` (seeds a
`<slug>:meta.navLabel` op + a `PageAdd`), `delete_page` (appends to `pages_deleted`),
`discard_all` (empties everything, **still bumps rev**). `by`/`now` are explicit params (never
system clock / hardcoded — restore writes ops programmatically, decisions/00011).

## Merged content (`merged_content.py:merge_overlay`) — load-bearing

Computes `content = checkout ⊕ overlay` and is used by both preview and publish:
1. Deep-copies `page_contents` + `global_content`; `theme_dict = theme_to_dict(theme)` or
   `None`.
2. `pages_added`: seed `page_contents[slug] = deepcopy(page_contents[from_slug])` (content
   only — the template is copied at publish time).
3. Each op: `key.partition(":")` → dispatch to `_global` / `theme` (only if present) / a
   known page slug via `dotted_set`. **Unknown slug → skip** (tolerates a partially-stale
   draft, e.g. a page deleted upstream). Overlay wins per key; un-drafted keys flow through
   from the checkout — so an AI-lane upstream edit shows in the draft (Inv 6).
4. `pages_deleted` is **deliberately not applied here** — deletion takes effect at publish,
   so a staged-for-deletion page keeps rendering in the draft.
5. Returns `dataclasses.replace(source, …)`.

## Preview render + editor injection (`preview.py`)

`GET /admin/preview/{page}.html` → `render_preview_page`: `build_site_source` +
`load_overlay` + `merge_overlay` → `builder.render_page(mode="preview")`, all under
`tree_lock()`. Injects `editor.js`/`editor.css` (`EDITOR_SCRIPT_PATH`/`EDITOR_STYLESHEET_PATH`)
and a `<script type="application/json" id="wx-bindings">` blob (the page's binding map). If
the watcher's last fetch is older than `preview_staleness_threshold_s` (default 10s) it runs
an on-demand `fetch_once` first so freshly-merged upstream commits surface promptly. Must stay
fast (`no-store`; it's only reloaded on a hard refresh — live edits are DOM-applied
client-side).

## Upstream watcher (`watcher.py`)

`watch_upstream` loops forever (until the lifespan cancels it): `fetch_once` then
`sleep(interval_s=60)` (`sleep` injectable for tests). `fetch_once` keeps `paths.repo`
fast-forwarded to `origin/main` off the request path — but **first checks the publish lock
and no-ops if it's live** (never fast-forwards the tree out from under an in-flight publish).
Lock liveness = mtime age `< _LOCK_STALE_AFTER_S = 600s`, which also **self-heals an orphaned
lock** left by a hard process-kill (Inv 18). Fetch failures — and a non-fast-forward (diverged)
`origin/main`, which `ensure_checkout` raises as a hard `CheckoutError` (Inv 8) — degrade
gracefully **in the watcher**: `fetch_once` records them in `WatcherStatus.last_error` (stale
badge after 5 min), keeps the checkout at its last-good sha, and never forces. (The same non-ff
is *not* softened during a publish — `run_publish`'s `pulling` step propagates it as a hard
`PublishError`, [publish-pipeline.md](publish-pipeline.md).) `/api/admin/state`'s `upstream` block (`aheadOfPublished` + `fetchedAt`) drives the draft
chip and the chat "preview updated" chip.

## Concurrency (`treelock.py`)

One process-wide **re-entrant** `threading.RLock` exposed as `tree_lock()`, guarding the
Storage working tree. Every mutation (`ensure_checkout` fetch+ff, publisher materialize/
commit/reset) and every tree read (state, content, preview) runs in an `anyio.to_thread`
worker, so this gives readers a mutation-consistent snapshot with no async plumbing.
Re-entrant because the publisher holds it across a step that calls `ensure_checkout` (which
re-acquires). Held one step at a time — **never across the multi-second build/verify** (those
read a committed, quiescent tree). It exists to close the 2026-07-19 Edit-button-latch race:
`GET /api/admin/state` computes each page's `editable` as `pages/<slug>.html` existing on disk,
and an unlocked read racing a working-tree mutation (the watcher's fast-forward, or a publish's
materialize/`_reset_hard`) could observe a template mid-replacement, report `editable:false`,
and the shell would cache it. `_build_state` wraps the whole read in `tree_lock()` so a snapshot
never sees a half-replaced tree. Cross-process coordination is the separate `publish.lock` file
+ the single serving process (Inv 18).

## Media serving & staging

Uploads are processed by `media.py` (see [media.md](media.md)) and staged at
`draft/media/<name>`, where the basename `<name>` = `<hash8>-<upload-slug>.<ext>`, served for
preview at `/admin/draft-media/<name>` (the full basename; a `StaticFiles` mount under
`/admin`, so CF-Access-gated). On publish, staged files referenced by the overlay are moved
into the site repo's `images/` and their `{src}` refs rewritten from `/admin/draft-media/<name>`
to `images/<name>` ([publish-pipeline.md](publish-pipeline.md)).

## First-serve bootstrap (`bootstrap.py`)

`bootstrap_if_needed` is the server's own "publish zero" so `ca.cinnamons.uk` serves the site
from first startup, before any human Publish. Idempotent: a no-op once `live.json` exists, or
if the checkout isn't ready / has no pages yet (it silently returns `False` rather than
raising — `except CheckoutError, BuildError:` at line 52, PEP 758, Inv 14). Called from the
app lifespan (right after the watcher's initial fetch) and by `install.py`.
