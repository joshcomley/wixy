# Milestone 6 slice 1: settings, Storage layout, site checkout manager

## Context

Spec/04-server.md is the M6 binding contract. Given the milestone's real size
(project registry, Storage layout + checkout manager, draft overlay store,
merged-content service, preview renderer, public serving, `/api/admin/*`
subset, CF Access JWT middleware, instant-render shell), it's being built as a
sequence of independently-shippable PRs rather than one — matching how M4's CA
migration was itself a train of per-page PRs, not a single one, and matching
the work-plan's own framing ("Milestones are sequenced so something real is
demonstrable at every step"). This PR is slice 1: the foundational pieces
everything else depends on — settings/`.env` loading, Storage directory layout,
project registry, and the site-repo checkout manager. No FastAPI app or HTTP
routes yet; that starts once the preview renderer (slice 3) has something to
serve.

## Decisions

**1. `WIXY_STORAGE_ROOT` is resolved from the process environment ONLY, never
from the `.env` file it would otherwise gate.** `Storage/.env` lives INSIDE the
storage root spec/04 §2 names — so the root itself can't be one of the values
that file configures (a chicken-and-egg problem). `resolve_storage_root()` and
`load_settings(storage_root)` are two separate functions for this reason:
resolve the root first (env var or the production default), then load
everything else from `<root>/.env` layered under process env. `launcher.py`
(milestone 11) will set `WIXY_STORAGE_ROOT` before the process starts; every
test in this PR passes an explicit root, never touching the real
`D:\Servers\Wixy\Storage` default.

**2. Hand-rolled `.env` parsing (`KEY=VALUE` lines, `#` comments), not a
`python-dotenv` dependency.** Matches this repo's established preference for
small hand-rolled parsers over new dependencies for a narrow, fixed format
(`builder/theme.py`'s theme loader, `builder/jsonschema_lite.py` — see
decisions/00002). The format needed here (no quoting, no multiline, no
variable interpolation) doesn't need a real parser.

**3. `wixy_server/registry.py` is a thin wrapper over `builder.config`, not a
reimplementation.** The loading logic (`load_all_projects`) already existed
from Milestone 2 for the CLI's `--project` flag — spec/04 §1 itself says "the
engine loads every `projects/*.json` at startup," the same operation, just
from a different caller. The wrapper adds what a SERVER specifically needs
that a one-shot CLI invocation doesn't: fail loudly on an empty registry
(a server with zero projects is a misconfiguration, not a valid state — the
CLI always names one project explicitly so this never arose there), and a
typed `UnknownProjectError` for routing to 404 vs "misconfigured" distinctly.

**4. The site checkout manager (`checkout.py`) always does a FULL `git clone`
— no `--depth`/`--single-branch`.** Spec/04 §5's restore step needs arbitrary
historical SHAs (`git show <old-sha>:<path>`, milestone 9), which a shallow
clone can't serve. This project has already been bitten by a shallow-clone/
short-SHA combination once (see this repo's earlier decisions/ entries,
referenced in the handover chain) — full clones avoid re-creating that failure
mode here. `ensure_checkout` intentionally does NOT implement `git show`
itself yet (that's genuinely milestone-9 scope, not needed until restore is
built) — only the clone/fetch/fast-forward operations M6 actually needs.

**5. Every git subprocess call passes `-c credential.helper=` and a 60s
timeout**, per the fleet's global git-subprocess convention (no shell-outs
with unvalidated strings; git args always passed as a list, never
shell-interpolated). The CA repo is public, so this slice needs no git
credentials at all — read-only clone/fetch works unauthenticated. Push
credentials (for the publisher, milestone 9) are a separate, later concern.

**6. `git rev-parse HEAD` is exposed as `current_sha()` now** (not deferred),
since the merged-content service (slice 2/3) and the public-serving pointer
(`live.json`'s `{"sha", ...}`) both need "what SHA is this checkout at" as a
basic primitive — unlike `git show`, this is genuinely needed by the very next
slice, not a speculative addition.

## Verification

`python -m pytest` (190 tests, up from 163 — 27 new across
`test_settings.py`/`test_storage.py`/`test_checkout.py`/`test_registry.py`,
`test_checkout.py` uses a real local git repo fixture, zero network
dependency). `mypy --strict` clean. `ruff check`/`format --check` clean.

## What to watch for

- `resolve_storage_root()`'s production default
  (`D:\Servers\Wixy\Storage`) is never exercised by tests and won't exist
  until milestone 11's install — if a future test accidentally omits
  `WIXY_STORAGE_ROOT`/an explicit root argument, it would silently resolve to
  a real (currently nonexistent, later real) machine path. All tests in this
  slice pass `tmp_path` explicitly; keep that discipline in future slices.
- The next slice (draft overlay store + merged-content service) is where
  `resolved_global_content`/`render_page`'s `SiteSource` actually gets built
  from a `checkout.py`-managed working tree — this PR only lays the
  foundation, it doesn't yet wire a `SiteSource` from Storage.
