# M3 — standalone Docker deploy target

## Context

spec/independence/03: `deploy/standalone/` — the image + compose stack + scripts +
GHCR publish workflow + CI image-boot proof that lets Wixy run anywhere Docker runs.
No Dockerfile/compose file existed anywhere in the repo before this milestone
(confirmed via a full-repo sweep during M1). SECURITY-GATED — waits for Fable review
(03 §4 checklist) before merge.

## What was built

- `Dockerfile`: `python:3.14-slim`, `git`/`ffmpeg`/`openssh-client`/CA-certs/Node LTS,
  `github.com` pinned into `/etc/ssh/ssh_known_hosts`, non-root `wixy` user (uid 1000),
  `HEALTHCHECK` (shell-form `CMD` so `$WIXY_PORT` expands at container runtime, not
  build time — correct under either edition's own port choice), `WIXY_ENGINE_SHA`/
  `WIXY_SYNC_BASE` build args. Deliberately does NOT bake `WIXY_EDITION`/
  `WIXY_CONTAINERIZED`/`WIXY_STORAGE_ROOT`/`WIXY_PORT` — spec's own words place those
  under "env from `.env`" (i.e. the COMPOSE file's job), and baking them here would
  reintroduce the standalone/fleet image drift decision 6 (decisions/00051) exists to
  prevent.
- `docker-compose.yml`: `wixy` + `cloudflared` + `watchtower` only — `worker`
  (milestone 6) and `backup` (milestone 7) are added by their OWN later PRs, not
  stubbed here (a stub service referencing a build context that doesn't exist yet
  would break `docker compose config`).
- `setup.sh` / `verify.sh` / `update.sh` / `logs.sh`: idempotent setup (Docker install,
  engine clone, ONE deploy-key generation — just the site repo; M4's fork-sync PAT and
  M7's `ca-state-backup` key are added when THOSE features land, same incremental
  principle as the compose services), a systemd unit, and a five-check `verify.sh`
  (services up, `/healthz`, `edition:"standalone"`, site-checkout-on-disk, tunnel
  connected) with retries (~30s per check) since it runs immediately after
  `systemctl start wixy` — cloudflared's outbound connection and the app's own
  startup both take real seconds, and a single-shot check would spuriously fail on a
  perfectly healthy first run.
- `.github/workflows/publish-image.yml`: builds+pushes `ghcr.io/<owner>/wixy:latest`
  + `:<sha>` on every `main` push.
- `.github/workflows/ci.yml`'s new `image-boot-proof` job: builds the image, boots it
  twice (`WIXY_EDITION=standalone` and `WIXY_EDITION=fleet`, the latter's cmd backend
  faked via `deploy/standalone/ci_fake_cmd.py` reusing the existing
  `wixy_server/tests/fake_cmd.py` fixture on the exact ports `CmdChatClient`'s
  defaults expect, `--network host` so the container's own loopback reaches it),
  asserting `/healthz` + `/api/version`'s `edition` field each time.

## Decisions beyond the spec's literal text (with reasoning)

1. **`image-boot-proof` runs on every PR, not just `main` merges.** Spec's literal
   words ("on every main merge") describe the MINIMUM; running it on PRs too is
   strictly additive safety (a broken Dockerfile should never merge in the first
   place) and matches how `python`/`frontend`/`e2e` already work in this repo's own
   `ci.yml`. `publish-image.yml` (the actual GHCR push) stays `main`-only — untested
   PR-branch images must never reach the public registry under `:latest`.
2. **GHCR package visibility requires a one-time manual step**, documented in
   `publish-image.yml`'s own header comment: GHCR creates a brand-new package PRIVATE
   by default regardless of the repo's own visibility, and no workflow token can flip
   that on its own — same class of unavoidable human GitHub-settings action as the
   MIT visibility flip itself (spec/independence/02 §3). Carried forward as a Track J
   guide step (milestone 8).
3. **`setup.sh` generates ONE deploy key now** (site repo only), not every key the
   whole phase will eventually need. M4's org PAT and M7's `ca-state-backup` deploy
   key are added by those milestones' own PRs when the features that consume them
   actually exist — generating unused keys now would be dead setup with nothing to
   verify against.

## A real bug caught and fixed during self-review (before any CI/Fable review)

`docker-compose.yml`'s `wixy` service originally had `env_file: - .env`. This is
WRONG: a relative `env_file:` path resolves against the COMPOSE FILE's own directory
(the cloned engine checkout, `$COMPOSE_DIR` = `.../engine/deploy/standalone/`), never
against `/opt/wixy/.env`, which is where `setup.sh` actually writes it (one level
above the checkout entirely). `docker compose up` would have failed outright on
literally the first real deployment — every script already correctly used
`docker compose --env-file /opt/wixy/.env ...` for compose-YAML-level `${VAR}`
substitution, but the SEPARATE `env_file:` directive inside the service block used a
different (and broken) resolution rule. Fixed by removing `env_file:` entirely and
explicitly listing every variable the container needs under `environment:`, sourced
from the SAME `--env-file`-driven substitution every script already uses — one
mechanism, no risk of the two silently diverging again. Caught by manually re-tracing
every variable from `setup.sh`'s write path through to the container's actual runtime
environment, not by running `docker compose up` for real (Docker isn't installed on
this dev box — see Verification).

Also found missing during the same trace: `setup.sh` never prompted for
`WIXY_CF_TEAM_DOMAIN`/`WIXY_CF_ACCESS_AUD` (the CF Access JWT middleware's own
settings, `wixy_server/settings.py`) — without them the admin surface's auth would be
misconfigured. Added both prompts + wired them into `.env`/`environment:`.

## Verification

- All four shell scripts: `bash -n` clean.
- `deploy/standalone/ci_fake_cmd.py`: `ruff check` clean; its `create_fake_cmd_app`
  wiring verified locally on alternate ports (19320/19321 — this dev box's REAL cmd
  service already owns 9320/9321, so the exact target ports couldn't be tested here;
  a fresh GH Actions runner has neither).
- `pip install ".[server]"` (the exact extra the Dockerfile installs) verified in a
  clean, isolated venv: resolves, builds the `wixy` wheel via the pyproject.toml
  changes from M2, installs cleanly; `wixy_server.__main__`/`.app`/`.settings`/
  `.redirects`/`.registry`/`.routes_version` all import without error.
- `wixy_server/static/admin/` + `.../editor/` bundles confirmed present, non-empty,
  and git-tracked (not gitignored) — what `COPY wixy_server/` in the Dockerfile
  actually ships.
- All three workflow/compose YAML files: parsed clean with `yaml.safe_load`.
- **NOT independently verified**: an actual `docker build`/`docker compose up` — Docker
  is not installed on this dev box, and installing Docker Desktop (WSL2/Hyper-V,
  often a reboot) is a heavier system change than warranted on a shared fleet box for
  this alone. The CI `image-boot-proof` job is the first REAL verification this image
  boots at all — flagged explicitly in the PR rather than claimed as tested.
- Full pytest suite: 577 passed, 1 failed — `test_kill_during_publish.py`'s
  pre-existing, already-diagnosed-and-fixed-elsewhere flake (decisions/00053, fixed in
  PR #66, not yet present on this branch since M3 stacks on M1 not on the bugfix
  branch). Not a new regression; not investigated further here.

## What to watch for

- The `image-boot-proof` job is the FIRST time the Dockerfile itself gets built for
  real, anywhere. If it fails on a subtlety this review couldn't catch without Docker
  (base-image package availability, a COPY path typo, permission issues from the
  non-root user), that's expected risk from not having local Docker — fix forward,
  don't treat it as a sign the review process itself failed.
- `setup.sh`'s `WIXY_ENGINE_REPO` default points at upstream (`joshcomley/wixy`) for
  drill/testing purposes — the guide (milestone 8) MUST make her override this to her
  own fork when she runs the real one-liner, or she'd deploy Josh's upstream instead
  of her own fork.
- If M4/M6/M7 land and need to extend `docker-compose.yml`/`setup.sh`, follow the same
  incremental-delivery principle this milestone established: add exactly what that
  milestone needs, don't pre-stub for milestones further out.
