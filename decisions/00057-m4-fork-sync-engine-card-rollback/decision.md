# M4: fork-sync workflow, Engine settings card, and image-tag rollback

## Symptom / starting point

spec/independence/04 specifies three tightly-coupled pieces: the `sync-upstream.yml`
workflow (fetch upstream, merge, deploy), the Engine settings card (version, commits
behind, changelog, "Get engine updates"/"Undo last update"), and a rollback mechanism.
The spec is clear on *what* each piece does but leaves the exact *mechanism* for
rollback implicit enough that an early draft of this milestone got it wrong.

## Decision 1: rollback is a GHCR image-tag retag, never git

**What was wrong first:** the first draft of `routes_engine.py`'s module docstring
described `mode=rollback` as `git reset --hard pre-sync && push --force` against a
`pre-sync` git tag the sync workflow would create before every merge.

**What's actually right**, confirmed by re-reading spec/independence/04 §3 closely
("Before flipping `:latest`, the sync workflow re-tags the currently-deployed image
`:rollback`") and cross-checking against M3's own `update.sh --rollback` (already
built, already the reference implementation for what "rollback" means end to end):
rollback operates entirely on the **GHCR image tag**, never on git history.

- `sync-upstream.yml` (`mode=sync`): before pushing a clean merge to `main` (which
  triggers `publish-image.yml` to build+push a new `:latest`), it snapshots
  whatever `:latest` *currently* points at as `:rollback` — a `docker buildx
  imagetools create --tag <repo>:rollback <repo>:latest` registry-side copy, no
  rebuild.
- `sync-upstream.yml` (`mode=rollback`, dispatched by the Engine card's "Undo last
  update" button): does no git and no build at all — it just re-points `:latest`
  back at whatever `:rollback` currently references
  (`docker buildx imagetools create --tag <repo>:latest <repo>:rollback`).
  Watchtower's own ~5 min poll then redeploys through the exact same path as a
  normal update, just walking the tag backwards.
- `update.sh --rollback` (M3, host-level) achieves the same *end state* by a
  completely different, host-only mechanism: it pins the compose service's
  `WIXY_IMAGE` env directly to `<repo>:rollback` and stops Watchtower so it can't
  immediately "helpfully" pull `:latest` again. This is the deliberate
  GH-Actions-independent escape hatch (03 §3) — not the same code path as the
  in-app button, and not expected to be, since the wixy container has no
  docker.sock/`.env` write access to do what `update.sh` does (03 §2 boundary).

**Why this matters:** git history staying untouched by rollback is actually the
*simpler* and more correct design than the git-based draft — her fork's `main`
keeps moving forward regardless of whether a deployed image gets rolled back, which
matches how `update.sh --rollback` already worked (it never touched git either) and
avoids force-pushing a shared branch as part of an automated "undo" action.

## Decision 2: `GitHubClient` is shared `app.state`, not constructed per request

First draft had `routes_engine.py` build a fresh `GitHubClient(pat=settings.
engine_pat)` inside each handler via a private `_client_for()` helper — opening and
closing a whole new `httpx.AsyncClient` (connection pool and all) on every single
request, and with no way for a test to inject a fake transport.

Fixed to match the *already-established* pattern `cmdchat_client` uses: `wixy_server.
app.create_app` gains a `github_client: GitHubClient | None = None` parameter,
defaults to a real `GitHubClient(pat=settings.engine_pat)` constructed once, stored
on `app.state.github_client`, closed in the lifespan's `finally` alongside
`chat_client.aclose()`. Route handlers pull it from `request.app.state.github_client`
directly. Constructed unconditionally even on the fleet edition (where `engine_pat`
is empty and `_require_standalone` 404s before ever touching it) — same posture
`cmdchat_client` already takes, no per-edition branching needed. This is what makes
`wixy_server/tests/fake_github.py` + `test_routes_engine.py` possible at all.

## Decision 3: the conflict-PR path reuses ONE trigger check, not two

spec §1 requires a review PR (never auto-merge) for two textually distinct
conditions: an actual merge conflict, OR a clean merge whose diff touches
`.github/workflows/**`. The workflow computes the workflow-file-diff check
*before* attempting the merge (`git diff HEAD upstream/main -- .github/workflows`),
then attempts the merge once. If either condition is true, the already-merged
(or the raw pre-merge conflicted) branch content is pushed as a PR-source branch;
GitHub's own PR mergeability computation shows the conflict natively (including its
web-based conflict editor when trivial) rather than the workflow trying to hand-roll
conflict resolution or markers itself.

`SYNC_PUSH_TOKEN` (a real fine-grained PAT, `contents:write` + `pull_requests:write`)
is used for BOTH the direct-to-main push and the conflict/review-PR's branch push +
`gh pr create` — never `GITHUB_TOKEN` for either, because `GITHUB_TOKEN`-authored
pushes and PR-opens don't trigger other workflows (spec's own stated reason: "the
image build would silently never run"). The registry retag steps (snapshot-before-
flip, and the whole of `mode=rollback`) use plain `GITHUB_TOKEN` with
`packages: write` instead — they're terminal actions that don't need to cascade into
anything else, so there's no reason to widen `SYNC_PUSH_TOKEN`'s own scope any
further than these two git-and-PR-writing operations actually need (Fable review
checklist item: "PAT scope minimality").

**Correction (Fable review, PR #74 R2)**: the first draft of this decision, and the
PAT scope this repo's own `sync-upstream.yml` comments originally didn't state at
all, both under-scoped this to `contents:write` alone — matching spec/independence/
04 §1's own literal words, "(contents:write on the fork)". That's not enough:
`gh pr create` in the conflict-PR step needs `pull_requests:write` too, or that path
403s exactly when it's needed (a real conflict or workflow-file diff, the two cases
the review-PR mechanism exists for). This was the SPEC's own under-specification,
not a misreading of it — Fable (spec author) is amending 04 §1 to match. `sync-
upstream.yml`'s header comment now states the correct two-scope requirement
explicitly, and the guide (M8, not yet written) must carry it into whatever PAT-
creation step it walks her through.

## Decision 4: a YAML-authoring bug, caught by validating before running

An early draft of the review-PR step wrote the PR body as a raw multi-line bash
string literal (`body="line one\n\nline two..."`) directly inside a YAML `run: |`
block. That broke: a literal block scalar requires every non-blank line to carry at
least the block's own indentation, and the unindented continuation lines terminated
the scalar early, corrupting the rest of the file. Caught before ever pushing by
running the workflow through `yaml.safe_load` (structural parse) and, per `run:`
step, `bash -n` on the extracted script body (syntax-only check, GH Actions
`${{ }}` expressions neutralized first) — not by eyeballing it. Fixed by switching to
`printf '%s\n' "line one" "" "line two" ... > file` — every argument independently
quoted, no embedded raw newlines, so there's nothing for YAML's indentation rule to
trip over. `gh pr create --body-file` reads it back.

## Decision 5: the Engine settings tab is always visible; the page degrades

Considered gating the Settings → Engine tab's very visibility on the running
edition (fetch `/api/version`'s `edition` field once at shell startup, thread a
boolean through `SettingsPanelDeps`). Rejected: it would add a second `/api/version`
round-trip to shell startup (the first already exists for `getServerCommit`'s
revalidation loop) purely to decide whether to show one settings tab, and a small
new dependency of its own. Instead the tab always renders; `GET /api/admin/engine/
status` is fetched only when the user actually navigates to it, and a 404 (the
fleet edition's `_require_standalone` guard) renders a plain "isn't available on
this deployment" message rather than an error. Matches the same "never blocking
state" posture the backend already takes for a stale/unreachable GitHub API.

## What to watch for

- If a later milestone changes what `:latest`/`:rollback` mean (e.g. multi-arch
  manifests, a registry migration away from GHCR), both the sync workflow's retag
  steps AND `update.sh --rollback`'s own `docker image inspect`/`docker pull`
  existence check need to move together — they're independent code paths but share
  the same tag-naming contract.
- `routes_engine.py`'s `EngineStatusCache` is a single process-lifetime slot (no
  per-user/per-request scoping) — correct for v1 (one operator), would need
  revisiting if this surface ever serves more than one concurrent admin.
