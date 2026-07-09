# Milestone 6 slice 3: preview renderer + first FastAPI app

## Context

Third slice of the M6 PR train (decisions/00010 explains the slicing). This slice
builds the preview-render pipeline (`wixy_server/preview.py`, consuming decisions/00012's
bindings-map) and wires it into the first FastAPI app (`wixy_server/app.py`) via
`GET /admin/preview/{page}.html` (spec/04 §4), plus the upstream watcher (§7) that
keeps the site-repo checkout fresh in the background.

## Decisions

**1. `render_preview_page(source, slug)` takes an already-overlay-merged `SiteSource`
— it doesn't call `merge_overlay` itself.** `wixy_server/preview.py` therefore has no
dependency on `wixy_server.overlay`/`merged_content` at all; merging is the caller's
job (the route: checkout → load overlay → `load_site_source` → `merge_overlay` →
`render_preview_page`). Single responsibility (this module only renders + injects) and
a simpler, independently-testable signature — every `test_preview.py` case builds a
plain synthetic `SiteSource` with no `Overlay` machinery in sight.

**2. Editor-asset injection re-parses the rendered HTML string with BeautifulSoup
(`html5lib`, matching every other HTML operation in this codebase) rather than raw
string splicing on `</head>`/`</body>`.** A targeted string-replace on those literal
substrings would in fact be safe (a real HTML serializer always entity-escapes stray
`<`/`>` in text content, so an unescaped `</head>`/`</body>` can only be the genuine
closing tag) — but it would be the only piece of raw-string HTML manipulation anywhere
in `builder`/`wixy_server`, a real reviewer red flag for something that doesn't need to
be fast: measured at real CA-page scale (decision 6), the extra parse costs single-digit
milliseconds against a 150ms budget with 3x headroom to spare. Consistency won over a
micro-optimization nothing here needs yet.

**3. The bindings-map JSON is escaped for safe embedding inside a `<script>` tag**
(`&`/`<`/`>` → `&`/`<`/`>`, same technique as Django's `json_script`
filter) **before being set as the script tag's text**, not left to whatever the HTML
serializer does by default. A `data-wx-*` key containing a literal `</script>` (however
unlikely from a PR-reviewed template today) must not be able to prematurely close the
injected script element — tested explicitly
(`test_key_containing_script_close_tag_is_escaped_safely`) by round-tripping such a key
through the full pipeline and counting real `</script` occurrences in the output.

**4. The site-repo checkout is kept fresh by a background watcher
(`wixy_server/watcher.py`, spec/04 §7), never by an inline `git fetch` inside the
preview route.** This is the one place this slice went beyond the handover's own literal
step list ("ensure_checkout → load_overlay → ... " read as a per-request pipeline) —
spec/04 §4 and §7 are explicitly cross-referenced ("The working tree sits at
origin/main because the watcher fast-forwards it (§7)"), and a synchronous
`git fetch`/`git merge --ff-only` against a real remote is a network round trip that
would either blow the <150ms render budget outright or silently violate it depending on
network conditions — that's the wrong architecture to build even once, not a simpler
version of the right one. `watch_upstream` loops `fetch_once` (which wraps
`ensure_checkout`, swallowing `CheckoutError` — "fetch failures degrade gracefully",
§7) every `interval_s` (default 60, spec's own number) via `anyio.to_thread.run_sync`;
the app's `lifespan` does one best-effort synchronous bootstrap fetch before serving,
then starts the watcher as a background task in an `anyio` task group, cancelled
cleanly on shutdown. The preview route itself never touches the network — it 503s via
`CheckoutError` only if the checkout hasn't completed its first clone yet
(`(paths.repo / ".git").exists()` is false).
   - **Deliberately NOT built here** (real, tracked follow-up work, not a corner cut):
     exposing `{aheadOfPublished, fetchedAt}` via `/api/admin/state` (that route doesn't
     exist until slice 4) and coordinating the watcher with the publish lock (that lock
     doesn't exist until the publisher, M9). Both are additive surface on top of an
     already-complete fetch loop, not missing pieces of this loop itself — flagged here
     so slice 4/M9 wire them in deliberately rather than rediscovering the need.

**5. `create_app` asserts the registry has exactly one project, raising `RuntimeError`
otherwise — a new, slice-3-specific check (`registry.py`'s own `ProjectRegistry` only
guards against *zero*).** Spec/04 §1: "v1 runs with exactly one but nothing may assume
that (all paths/state are per-slug...)." Read as: don't hardcode a slug string into
business logic (nothing here does — `project.slug` flows through generically), not as
"build a multi-project URL scheme the spec's own route tables
(§4, §8) don't have" (every route is bare `/admin/preview/{page}.html`, no project
segment). If a second project ever needs serving, that's a real architectural
extension (probably per-instance config naming which slug this process serves, wired
by milestone 11's launcher) — asserting the current constraint loudly beats silently
picking `registry.all()[0]` and hiding a real multi-project misconfiguration.

**6. Every blocking step of one request (git `rev-parse`, overlay/content JSON reads,
template parse + render + bindings extraction + injection re-parse) is bundled into one
plain synchronous function (`_build_preview_html`) and run through exactly one
`anyio.to_thread.run_sync` call per request** — not four or five separate hops.
Spec/04 §8's "no route blocks the event loop (git/build/Pillow work in a thread pool
via `anyio.to_thread`)" is treated as a hard, general invariant (not scoped only to the
four routes literally listed in that section's table), but chaining several separate
thread-pool round trips for what is fundamentally one CPU/local-disk-bound unit of work
would add overhead without buying anything (nothing here needs to interleave with other
async I/O mid-pipeline). **Measured** (throwaway script against the real CA pages in
`cottage-aesthetics-preview__worktrees/00001`, 20 iterations each, full
`render_preview_page` pipeline): `gallery` (largest template, 14.5KB) mean 31.7ms/max
38.7ms; `index` (largest rendered output) mean 51.6ms/max 65.3ms; `treatments` mean
43.0ms/max 52.6ms — comfortably inside spec/04 §4's 150ms budget with roughly 3x
headroom even at the observed max, confirming decision 2's "not a problem yet" call
with a real number instead of an assumption.

**7. `CheckoutError` → HTTP 503, `BuildError` → HTTP 404, both via FastAPI's default
`HTTPException` JSON body** (`{"detail": "..."}"`), not yet the RFC7807-ish
`{error, detail, field?}` shape spec/04 §8 mandates for `/api/admin/*`. `/admin/preview/*`
returns HTML on success and isn't literally one of the JSON routes that section
enumerates, so this isn't a spec violation, but it's also not yet a deliberate,
spec-driven choice — flagged for slice 4 to reconcile once the broader admin-API error
convention is actually being built (that's genuinely its scope, not this route's).

**8. Structured file logging (`Storage/logs/wixy.log`, rotating — spec/04 §10) is not
wired up; `logging.getLogger(__name__)` calls exist (the watcher's failure log) but
write wherever the process's default logging config sends them (stderr).** This is a
handler-configuration concern, cleanly separable from every call site already logging
correctly — unlike decision 4's watcher (a wrong-architecture risk), routing existing
log calls to a rotating file is pure, low-risk, additive wiring for whichever slice
sets up the app's real startup sequence (most naturally milestone 11's launcher, which
knows the real `Storage/logs` path and process lifetime).

## Verification

`python -m pytest` — 247 tests (up from 230 after decisions/00012's bindings-map slice),
including `test_preview.py` (injection + XSS-safety), `test_watcher.py` (fetch-loop +
clean cancellation, against a real local git origin per `test_checkout.py`'s own
fixture pattern), and `test_app.py` (full HTTP-level end-to-end: real git origin +
`tmp_path` Storage root + `TestClient`, covering happy-path render, preview-mode
hidden-section retention, editor-asset injection, unknown-page 404, draft-overlay
precedence over repo content, a real `theme.json` present, and the
more-than-one-project misconfiguration). `mypy --strict` clean (59 source files).
`ruff check`/`format --check` clean.

## What to watch for

- Slice 4 must expose the watcher's state (`{aheadOfPublished, fetchedAt}`) via
  `/api/admin/state` and coordinate `fetch_once`/`watch_upstream` with the publish
  lock once it exists (decision 4) — this is real, expected, tracked work, not a gap
  discovered by accident.
- The admin API's actual error-response shape (RFC7807-ish, spec/04 §8) should be
  designed once, for real, in slice 4, and this route's current plain `HTTPException`
  usage revisited then for consistency (decision 7).
- Rotating file logging (spec/04 §10) is still open — wire it into whichever slice
  builds the app's real startup entry point (milestone 11's launcher, most likely).
- decisions/00012 remains PROVISIONAL — nothing in this slice changed that; M7 is
  still the first real consumer that can validate or revise the bindings-map shape.
