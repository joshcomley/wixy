# Milestone 11 slice 1: repo-side install & deploy artifacts

First slice of milestone 11 (spec/07-hosting-deploy.md, read fresh before starting,
same discipline every prior milestone transition in this chain has followed). Builds
every repo-side artifact spec/07 §1 lists — `launcher.py`, `deploy.py`,
`slots.wixy.yaml`, `install.py`, `requirements.txt`, `tooling/provision_ca_cloudflare.py`
— plus the product-code pieces those artifacts assume already exist and didn't:
`wixy_server/__main__.py` (so `python -m wixy_server` means something), the server's
own startup self-bootstrap, and `/api/version`'s `slot` field. Does NOT touch live
infrastructure (Devfleet/Slots registration, Cloudflare provisioning) — see "Scope
boundary" below.

## Decision 1: `launcher.py` re-execs itself into the slot's own venv — it does NOT
mirror Loom's "post_swap repoints Devfleet's argv" mechanism

Read Loom (`D:\Servers\Loom\`, spec/07's own cited "reference anatomy") closely before
writing anything, since spec/07 names it as the model. Its `launcher.py` does NOT
actually exec into `<slot>/.venv` itself — it runs `runpy.run_module` in the SAME
process Devfleet spawned (whatever interpreter is in Devfleet's `argv[0]`), and
`deploy.py`'s `post_swap` instead MUTATES `services.toml`'s `argv[0]` on every swap to
point at the newly-active slot's venv python, so the *next* restart picks it up.

spec/07 §1-§2 gives Wixy a different, simpler, EXPLICIT design: `launcher.py` itself
resolves `active.txt` and hands off to `<slot>/.venv/Scripts/python.exe -m
wixy_server` (**originally implemented via `os.execv`; corrected to a blocking child
`subprocess.run` in decisions/00037 after a real Devfleet registration showed `execv`
orphans the server from Windows Job Object supervision — the handoff MECHANISM was a
bug, not this decision's actual point, which is §2's own `services.toml` snippet
confirming `argv` stays FIXED** (`pythoncore-3.14-64\python.exe launcher.py`, no
subcommand, never mutated by any hook). This is spec's own decided design, not
something to reconcile with Loom's older mechanism — implemented literally, and it's
materially simpler (no post_swap argv-rewriting, no Devfleet-reload dependency for a
plain slot swap, no "which slot is Devfleet currently pointed at" state to reason
about). Hall's `services.toml` entry turned out to follow Loom's mechanism too
(`argv[0]` = a literal slot path) — confirms this is a real fork in the fleet's own
conventions, not a mistake on my part; Wixy deliberately takes the simpler one because
spec says so.

`launcher.py` itself never needs the system interpreter (only the slot's own venv,
already built by the time it runs) — but `deploy.py`/`install.py` both need the
SYSTEM pythoncore-3.14 interpreter to CREATE that venv in the first place. Resolved
dynamically via `os.environ["LOCALAPPDATA"] / "Python" / "pythoncore-3.14-64" /
"python.exe"`, never a hardcoded `C:\Users\<name>\...` the way `cor`'s own `deploy.py`
does (`_CANONICAL_PYTHON` there is hardcoded to a specific username — a real landmine
the global CLAUDE.md flags explicitly, "differs per box: josh vs joshc" — not copied
here).

## Decision 2: `deploy.py` modeled on cor/Smartbell's clean template, not Loom's
evolved complexity — per-slot venv borrowed as a concept, not Loom's argv-mutation
machinery

Read three real, working deploy.py files before writing (`onboarding.md`'s own
"worked reference implementations" list): Loom, Hall, cor/Smartbell. Loom's has
accumulated substantial Loom-specific complexity over its history (editable installs
of a separately-cloned `slot_swap_deploy`, a bespoke frontend-build library wrapper,
migration-window fallback branches for a still-in-progress shared-venv-to-per-slot-venv
transition) that doesn't apply to a fresh install with no such history. cor's is
explicitly onboarding.md's "most recent... the one this guide was written from" and
structurally the closest to what spec/07 asks for. Wixy's `deploy.py` follows cor's
shape (`pre_validate`/`post_swap`/`post_restart` hooks, the deferred
`slot_swap_deploy` import for the cold-start-deadlock reason cor's own docstring
explains) with ONE build step swapped out: cor's `_pip_install_requirements` installs
into a pre-existing SHARED service-root venv; Wixy's `_pip_install_venv` builds
`<slot>/.venv` FRESH every deploy (`shutil.rmtree` + `python -m venv` + pinned
`requirements.txt` + `--no-deps .`), matching spec/07's explicit words ("per-slot
.venv... pinned requirements.txt") and Loom's own rationale for why per-slot beats
shared (a rollback to the other slot keeps its own independently-built venv
untouched). No npm build step — spec/07 §1 is explicit that frontend bundles are
committed and deploys stay pip-only.

## Decision 3: `requirements.txt` generated from a REAL venv install + freeze, not
hand-typed version guesses

"Pinned requirements.txt" only means something if the pins are real. Built a scratch
venv against the actual pythoncore-3.14 interpreter, ran `pip install ".[server]"`
(pulls both `pyproject.toml`'s core `dependencies` and its `server` extra — the
deployed slot needs both, since `wixy_server` imports `builder`), froze, stripped the
local `wixy` self-reference. 37 pinned packages. `deploy.py`'s build step installs
these FIRST, then `pip install --no-deps .` for the `wixy` package itself — no second,
unpinned dependency resolution on every deploy.

## Decision 4: the server self-bootstraps on EVERY startup (spec/07 §1's explicit
requirement), not just once from `install.py`

spec/07 §1 is explicit and deliberate about this being BOTH `install.py`'s job AND the
running server's own job ("the server also self-bootstraps this way... so
ca.cinnamons.uk serves the site at milestone #11, before the first human publish") —
read as a resilience requirement (a `Storage\` rebuilt from scratch without re-running
`install.py` — e.g. disaster recovery — should still self-heal into a servable state),
not a redundant restatement. Implemented as `wixy_server/bootstrap.py`'s
`bootstrap_if_needed(project, paths, now)`, called from `app.py`'s lifespan right
after the existing `fetch_once` call. Does no git I/O of its own (relies on the
checkout `fetch_once` — or `install.py`'s own explicit `ensure_checkout` — already
put there); a missing/empty/pre-migration checkout (`source.page_contents == {}` — no
`pages/*.html` at all) or any `CheckoutError`/`BuildError` is swallowed and logged,
mirroring `fetch_once`'s own established "never crash" shape exactly (spec/04 §3).
Version 0, source `"bootstrap"` (a new `PublishSource` literal, `ledger.py`) —
idempotent via `load_live_pointer(paths) is not None` as the very first check, so
every startup after the first is a single cheap read, never a rebuild.

**This is a real, load-bearing behavior change, not just new code**: any EXISTING
test that builds an app against a real, buildable site-repo fixture (real
`pages/*.html` + `content/*.json`) and then asserts "nothing published yet" now
observes a genuinely different, more-correct reality (a real version-0 live pointer +
ledger entry), because that pre-bootstrap window no longer exists in production once
this ships — by the time any request can reach the app, lifespan's `await` on this
call has already completed. Found this consequence BEFORE writing the code (traced
`build_site`/`load_site_source`'s exact behavior against an empty `pages/` glob to
confirm it wouldn't silently "succeed" on unbuilt test fixtures — Python's
`Path.glob` on a missing dir returns empty rather than raising, which is *why* the
`source.page_contents` emptiness guard exists at all, not an incidental detail), then
delegated an exhaustive, ground-truth sweep (an Explore agent that actually ran the
full 361-test suite against the code as it already sat in this worktree, not just
static reasoning) to make sure the blast radius was fully enumerated before touching
any test. Confirmed exactly 3 affected tests, zero more — all three fixed to assert
the new bootstrapped shape instead of a null one:

- `test_routes_admin_api.py::TestGetState` — `body["live"]` is now
  `{"version": 0, "sha": <head>}`, not `None`.
- `test_routes_admin_api.py::TestGetPublishes::test_only_the_auto_bootstrap_entry_...`
  (renamed from `test_empty_when_nothing_ever_published`) — the publishes list has
  exactly the one bootstrap entry, not `[]`.
- `test_routes_admin_api.py::TestGetPublishes::test_lists_newest_first_and_marks_the_live_one`
  — version sequence is `[2, 1, 0]` (the bootstrap entry trails, oldest, never live
  once a real publish exists), not `[2, 1]`.

Every other test touching a buildable fixture (`test_app.py`'s preview-render tests,
publish/restore pipeline tests that call `run_publish` directly rather than through
`create_app`, `test_kill_during_publish.py`'s relative before/after snapshots,
`e2e/fixture_server.py`'s own pre-seeded `live.json`) is unaffected — confirmed, not
assumed, via the same sweep.

## Decision 5: `install.py` derives the site repo from the registered project JSON,
never hardcodes "ca"

`install.py` globs `Slots/blue/projects/*.json` (exactly the same "expect exactly one"
invariant `ProjectRegistry` already enforces at runtime) rather than assuming the slug
is `"ca"` anywhere beyond what's already committed in `projects/ca.json` — stays
correct automatically if the registry ever changes, no second place to update. The
final bootstrap-serving step shells out to the ACTIVE SLOT's own freshly-built venv
python (a `python -c` snippet, same subprocess-driven pattern as `deploy.py`'s own
`_testclient_validate`) rather than importing `wixy_server`/`builder` into
`install.py`'s own process — those packages aren't installed anywhere install.py's own
interpreter can see until the venv step has already run.

Verified end-to-end via a structural dry run against a fully local fixture (a fake
git "wixy origin" + fake "site origin", `AIM_ROOT` pointed at a scratch dir,
`--skip-venv`): first run clones both slots, writes `active.txt`, mirrors
`launcher.py`/`deploy.py`, seeds `Storage\.env` (confirmed all 5 real `CF_*` keys
copied correctly from the real `D:\Servers\Loom\.env`, values present not just key
names), clones the site repo; second run is a clean no-op on every single step
(exit 0, zero errors, nothing re-cloned or overwritten). This is the "verify for
real" pass this whole chain keeps finding real bugs from — none turned up here,
which is itself the useful signal (the design held up against actual execution, not
just review).

## Decision 6: `Storage\.env` copies the CF_* keys from `D:\Servers\Loom\.env` for
real, at install time — not a placeholder for a human to fill in later

spec/07 §3 is explicit ("Copy them into `D:\Servers\Wixy\Storage\.env` during
install") — this is a plain local file-to-file copy on the same trusted machine, no
different in kind from any other install-time file operation, so `install.py` performs
it for real rather than leaving a `# TODO: fill in` placeholder. Confirmed the 5 exact
key names (`CF_API_TOKEN`/`CF_ACCESS_TOKEN`/`CF_ZONE_ID`/`CF_ACCOUNT_ID`/
`CF_TUNNEL_ID`) actually exist in the real file before writing the parsing logic
against them (grepped key names only, never printed/handled the secret values
themselves beyond the copy operation itself).

## Decision 7: `tooling/provision_ca_cloudflare.py` mirrors an EXISTING app's
policies dynamically rather than hardcoding an email address or service-token id

spec/07 §3 point 4's critical divergence from the Tenna template it's adapted from:
the template scopes one Access app to a WHOLE hostname (`"domain": HOSTNAME`); Wixy's
public site serves `/` with zero auth, so the app must use `self_hosted_domains`
(a list) covering only `/admin` and `/api/admin`. spec also says "copy the allow-list
emails from the existing apps' policy" for the operator-facing policy, plus a second
`non_identity` service-token policy spec names but doesn't give a concrete token id
for. Rather than hardcode either (an email address or a token id I'd have to guess/
assume, exactly the kind of specific-fact-that-goes-stale the global CLAUDE.md warns
about generally), the script fetches an existing, already-working reference app
(`tenna.cinnamons.uk`, confirmed live via `D:\Servers\Tenna\Storage\provision_cf.py`)
and mirrors its policies verbatim (the `allow`+email-include policy, and the
`non_identity`+service_token-include policy) onto the new app. Self-correcting if the
allow-list or service token ever rotates — this script would pick up whatever the
reference app currently has, not a value frozen at the moment this file was written.

Also folds in spec/07 §3 point 3's own operational note (a Cloudflared stop can report
"starting or stopping — try again") as a retry loop inside `restart_cloudflared`
itself (3 attempts, 5s apart) PLUS a `--restart-only` CLI flag so a future operator/
agent running this through the admin gate can submit it as the "two separate gate
scripts" spec explicitly recommends, without needing to re-derive that shape later.

**Written, NOT executed this slice** — see "Scope boundary" below.

## Scope boundary: repo-side code only, no live infrastructure touched

Milestone 11 spans two genuinely different categories of action: (a) normal repo code
— safe, reversible, the same branch/PR/merge/CI pattern every milestone in this chain
has already used ten times over; (b) live execution against SHARED fleet
infrastructure — Devfleet's supervisor config (affects every OTHER service on the hub
VM), Slots' consumer registry (affects other projects' deployments), and Cloudflare's
tunnel/DNS/Access config (routes ALL fleet subdomains, not just this one, plus a
new public-facing auth policy with real security consequences).

This slice is (a) only. Devfleet/Slots registration (spec/07 §2) — no elevation
needed, reversible (remove the entry + restart) — is planned as the very next action
once this PR is merged (merging to `main` is a precondition: Slots clones from
`origin/main`, not this worktree, so the consumer entry would find nothing to build
otherwise). Cloudflare provisioning (spec/07 §3) — elevated, shared blast radius,
real public auth policy — is flagged for explicit confirmation before execution,
per this session's own read of its system prompt's "hard-to-reverse operations" /
"affects shared systems beyond your local environment" categories, which takes
precedence over this chain's general "don't stop between milestones" instruction for
this SPECIFIC category of action (routine software development vs. live shared-
infrastructure changes with real public consequences are different things, and the
instruction to keep moving was written with the former in mind).

## Files changed

- New: `launcher.py`, `deploy.py`, `slots.wixy.yaml`, `install.py`,
  `requirements.txt`, `tooling/provision_ca_cloudflare.py`,
  `wixy_server/__main__.py`, `wixy_server/bootstrap.py`,
  `wixy_server/tests/test_bootstrap.py`.
- Modified: `wixy_server/app.py` (lifespan wires in `bootstrap_if_needed`),
  `wixy_server/settings.py` (`Settings.slot`, from `WIXY_SLOT` — process-env only, no
  `.env` fallback, same precedent as `WIXY_STORAGE_ROOT`), `wixy_server/routes_version.py`
  (`/api/version`'s `slot` field, previously hardcoded `None`), `wixy_server/ledger.py`
  (`PublishSource` gains `"bootstrap"`), `wixy_server/tests/test_settings.py`,
  `wixy_server/tests/test_routes_version.py`, `wixy_server/tests/test_routes_admin_api.py`
  (the 3 fixed assertions above), `README.md` + `tooling/README.md` (ops notes,
  spec/07 §5).

**Verification**: 542 Python tests passing (535 + 7 net new — 5 in `test_bootstrap.py`,
1 in `test_settings.py`, net +1 in `test_routes_version.py`), mypy strict clean
(94 files), ruff check + format clean. `install.py` structurally dry-run end-to-end
twice (fresh install + idempotent re-run) against a fully local fixture. No frontend
changes this slice (spec/07 is backend/infra-only).
