## Symptom / starting point

Milestone 1 (spec/independence/09-work-plan.md row 1) calls for four things the spec
describes at the "what" level but not the "which module" level: env overrides
(`WIXY_SITE_REPO`/`WIXY_DOMAIN`/`WIXY_INDEXABLE`/`WIXY_EDITION`) layered over
`projects/ca.json`; `/api/version` gaining `edition` + baked-SHA-with-git-fallback;
a new redirects facility "served by `routes_public`"; and the `WIXY_CONTAINERIZED`
bind gate. Ground-truth audit of the pre-existing code (via an Explore sweep, 2026-07-19)
confirmed: `builder/config.py` has zero env-var awareness today (JSON-only,
`os.environ`/`getenv` grep returns nothing), `/api/version` unconditionally shells
`git rev-parse HEAD` via `checkout.current_sha` with no caller catching
`CheckoutError` — an unhandled 500 on any gitless checkout — and `routes_public.py`
has no redirect concept of any kind.

## Root cause / what was decided

**1. Env overrides split across two modules, not bundled into one.** `WIXY_SITE_REPO`/
`WIXY_DOMAIN`/`WIXY_INDEXABLE` were added to `wixy_server/registry.py`
(`_apply_env_overrides`, applied to every loaded `ProjectConfig` via
`dataclasses.replace` after `builder.config.load_all_projects` returns) — deliberately
NOT to `builder/config.py`, which this repo's own CLAUDE.md requires stay import-clean
of server concerns ("No server imports. Importable standalone (the site repo's CI
installs just this)"). `WIXY_EDITION` and the new `WIXY_CONTAINERIZED` bind gate went
into `wixy_server/settings.py`'s `Settings` dataclass instead, alongside `env`/
`dev_no_auth` — because 01 §3 states the standalone `/opt/wixy/.env` file holds
general `WIXY_*` config (not just secrets), matching `settings.py`'s existing
`.env`-then-process-env precedence, whereas the registry overrides are pure
process-env (no `.env` fallback), the same precedent `WIXY_STORAGE_ROOT`/`WIXY_SLOT`
already set for "deployment-identity facts fixed for the container's lifetime, not
hand-edited after install." `load_registry(wixy_repo_root)` has no `.env`-file access
today and adding one just for these three fields would be a wider signature change
than the spec asks for.

**2. Redirects facility implemented inside `routes_public.py`, not as a separate
router or middleware.** The spec's own wording — "a file/env-driven 301 map served by
`routes_public`" — is literal, not incidental: a redirects router registered before
`public_router`'s catch-all `/{path:path}` would need to match every possible path
to decide whether to redirect, which means it would shadow the ENTIRE public router
unconditionally (FastAPI routes match by registration order, not by "try this, fall
through if unhandled"). A `@app.middleware("http")` was also rejected — Starlette's
middleware ordering relative to the existing `admin_auth` middleware is non-obvious
and would need its own careful reasoning for zero benefit over the simpler option.
Instead: `wixy_server/redirects.py` provides a pure `load_redirects()` (reads
`WIXY_REDIRECTS_FILE`, a JSON `{"/old": "/new"}` map) and `resolve_redirect(map, path)`;
`app.py` loads the map once into `app.state.redirects` at app-creation time (same
pattern as every other piece of app state); `routes_public._serve` checks it FIRST,
before even the live-pointer/503 check — a redirect is a pure URL-routing decision,
independent of publish state, so it must win over "site not yet published" too.

**3. `WIXY_REDIRECTS_FILE` fails loudly when set-but-broken, silently when unset.**
Mirrors the fail-fast precedent `settings.py` already set for
`WIXY_DEV_NO_AUTH`-in-`WIXY_ENV=prod`: an operator who explicitly configured a
redirects file and got the path wrong (or shipped malformed JSON) needs to find out
at startup, not have it silently serve zero redirects. An unset env var is the
ordinary case (the fleet ships none, spec/independence/01 §2.2) and stays silent.

**4. `WIXY_SYNC_BASE`'s "git fallback" is deliberately absent — baked-env-or-null.**
The spec's wording groups `WIXY_ENGINE_SHA` and `WIXY_SYNC_BASE` together as "sourced
from baked build args... with git fallback," but a generic git fallback only makes
literal sense for `WIXY_ENGINE_SHA` (`git rev-parse HEAD` is well-defined in any repo).
"The fork's sync base" (spec/independence/04) is fork-specific metadata — which
upstream commit HER fork last merged from — and no well-known git ref in a plain
checkout represents that generically; inventing one (e.g. assuming a remote named
`upstream` with a specific branch) would be guessing at milestone 4's not-yet-built
sync workflow's exact shape. Decided: `sync_base` is `os.environ.get("WIXY_SYNC_BASE")`
with no fallback attempt at all — `None` on the fleet (not a fork, correctly has no
sync base) and on any standalone deployment before milestone 4's image-build wiring
sets the baked arg. Revisit this if milestone 4 turns out to need a real git-derived
value instead of a purely baked one.

**5. `/api/version` response shape addition confirmed non-breaking.** Checked the one
existing consumer (`admin-ui/src/api.ts:321`, `getServerCommit()`) before adding
`edition`/`syncBase` alongside the existing `commit`/`slot`/`version` keys — it already
types the response as `{ commit?: { sha_full?: string } }` and reads via
`commit?.sha_full ?? null`, so a `null` `sha_full` (the gitless-image case) was already
handled gracefully client-side with no change needed there. The fleet's Slots deploy
config (`slots.wixy.yaml:61`, `sha_match_jsonpath: commit.sha_full`) is unaffected:
the fleet always has `.git` present (checked out via git, never pip-installed), so
`WIXY_ENGINE_SHA` stays unset there and the git fallback keeps succeeding exactly as
it does today — verified by leaving the existing `TestApiVersion` tests' assertions
unmodified rather than rewriting them to accommodate the new code path.

## Verification

Full pytest suite run after all M1 changes (`ruff check`, `ruff format --check`,
`mypy` strict, `pytest -n 4`) — see the PR for the actual run. New tests added
alongside each change (`test_settings.py`'s `TestEdition`/`TestContainerized`,
`test_registry.py`'s `TestEnvOverrides`, `test_routes_version.py`'s
`TestEdition`/`TestBakedEngineSha`/`TestSyncBase`, `test_redirects.py`, and
`test_routes_public.py`'s `TestRedirects`) rather than only exercised manually.

## What to watch for

- If milestone 3's Dockerfile ever bakes `WIXY_ENGINE_SHA` via a build ARG that isn't
  actually a full 40-char SHA (e.g. a short SHA, or a tag), `/api/version` will report
  it verbatim with no validation — the field is trusted input from the image build,
  not re-validated at request time. Keep the image-boot CI proof (03 §5) asserting the
  full-length format if that ever matters downstream.
- The redirects map is loaded ONCE at app-creation time (`app.state.redirects`), not
  re-read per request — matches every other piece of static app state (`settings`,
  `project`, etc.), but means a redirects-file edit on a running standalone deployment
  needs a process restart to take effect, same as any other `.env`/config change today.
  If a future milestone wants hot-reload for this, that's a new decision, not an
  oversight in this one.
- Milestone 4 (fork sync) is the first real consumer of `WIXY_SYNC_BASE` — when that
  workflow is built, revisit decision 4 above and confirm the baked-value-only design
  still holds, or record why it changed.
