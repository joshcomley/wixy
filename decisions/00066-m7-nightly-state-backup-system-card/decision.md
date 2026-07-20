# M7: nightly state backup (snapshot-branch container) + System card

## What M7 delivers

spec/independence/06's automatic, owner-custodied state backup, end to end: a new
`backup` compose service (`wixy_server/backup/`, same image as `wixy`/`worker`,
different `command:`) that nightly copies the residual droplet state a fresh git
checkout can't reconstruct into a checkout of `<org>/ca-state-backup` and
force-pushes a single-commit `snapshot` branch, tagging `monthly/YYYY-MM` on the
1st of each month (12 kept). Plus the in-admin System card
(`wixy_server/routes_system.py`, `GET /api/admin/system/status`): backup age with
a 48h stale banner, disk usage, last publish, engine version/edition — one combined
fetch, not edition-gated (unlike Engine/AI). Plus a documented, not-yet-installed
hub-side pre-cutover mirror (`deploy/hub-mirror/`) reusing the identical backup
module against the fleet's own Storage tree.

## The core design choice: an allowlist, not a denylist

`wixy_server/backup/snapshot.py`'s `_project_backup_items` enumerates EXACTLY the
paths spec/independence/06 §1 names as "residual droplet state" (`live.json`,
`publishes.jsonl`, `chats.json`, `draft/overlay.json`, `draft/media/`) rather than
copying everything under a project directory minus a few excluded names. A future
`wixy_server.storage.ProjectPaths` field added for some new purpose is therefore
NOT backed up until someone deliberately adds it here — the safe failure mode for
content about to be force-pushed to an external repository, even a private one.
Verified for real in `test_backup_snapshot.py`'s `TestAllowlistContent` (seeds a
realistic tree with `repo/`, `builds/`, `locks/`, and a secret-bearing top-level
`.env`; asserts none of it reaches the pushed tree, and greps the pushed tree's
full file contents for the `.env` secret value to catch a leak through any
channel, not just the obvious one). `repo/` is excluded because "git already
holds" it (spec's own words — the site checkout is redundant with GitHub);
`builds/` because it's reproducible from `repo/` + a SHA; `logs/`/`.env` because
they're operational/secret, not "state."

## M7's own FABLE-light gate checklist (spec/independence/09 row 7: "key-scope +
force-push-target checklist only")

**Key scope**: the `backup` service authenticates against `ca-state-backup` with
its OWN deploy key (`deploy/standalone/setup.sh`'s new `generate_deploy_key
"state-backup"` + `print_deploy_key_step "state-backup" ...`), never the
site-repo/engine-fork key — a completely separate keypair, generated and pasted
at a completely separate GitHub URL. `docker-compose.yml`'s `backup` service
mounts `${WIXY_KEYS_DIR}:/keys:ro` (the same keys directory as `wixy`, since both
need SOME key from it) but its `GIT_SSH_COMMAND` points at `/keys/state-backup`
specifically — `run_git` (reused unmodified from `wixy_server.checkout`) never
receives any other key material. `wixy_server/backup/settings.py`'s
`BackupSettings` doesn't model the key at all (matching `WorkerSettings`'s own
precedent for `ANTHROPIC_API_KEY`): `GIT_SSH_COMMAND` is read directly by `git`
itself from the process environment, never touched by this codebase's own code —
one less place a credential could be logged or mishandled.

**Force-push target**: `_SNAPSHOT_BRANCH = "snapshot"` is a module-level constant
in `snapshot.py`, never runtime-configurable, and the ONE `git push --force` call
in the entire module (`_push_snapshot`) names both sides of the refspec as the
fully qualified `f"{_SNAPSHOT_BRANCH}:refs/heads/{_SNAPSHOT_BRANCH}"` — nothing
caller-supplied, nothing that could resolve to `main` or any other ref. Verified
for real in `test_backup_snapshot.py`'s `TestForcePushTarget`: seeds a bare repo
with real content on `main`, runs a backup, and asserts `main`'s tip SHA is
byte-identical before and after (not merely "the push succeeded") — plus a
first-run-against-a-genuinely-empty-repo case (`git init --bare` with zero
commits, the actual state a fresh `gh repo create` leaves), since that's the
trickiest edge case for the orphan-branch mechanics below. The monthly tag push
(`_maybe_push_monthly_tag`) is deliberately a NORMAL (non-force) push — tags are
meant to be immutable once published; only `_prune_old_monthly_tags` ever removes
one, via an explicit `push origin --delete`, never a force-overwrite.

## Single-commit history via a fresh orphan branch every run

"Force-pushes a single-commit `snapshot` branch (history never accumulates)"
(spec's own words) is achieved by `git checkout --orphan snapshot` inside a
BRAND NEW scratch clone every run (never a persisted, reused local clone) — no
parent commit exists to accumulate onto, by construction, not by a manual
history-squashing step after the fact. `--allow-empty` on the commit
(`_create_snapshot_commit`) is deliberate: a night where nothing changed since
the last snapshot must still produce and push a fresh, independently-verifiable
commit, because "a backup that isn't verified isn't a backup" (spec §2) means
every night is actually exercised end-to-end, never silently skipped as a
no-op. Verified in `TestSingleCommitHistory`: two consecutive runs both leave
`snapshot` at exactly one commit, and the second run's commit is a genuine new
root (zero parents), not an amend of the first.

## Verification: re-clone and compare SHAs, not "did the push exit zero"

`_verify_pushed` re-clones the `snapshot` branch SHALLOW into a fresh directory
and compares its `HEAD` SHA against what was just pushed — git's own
content-addressing makes a SHA match a genuine integrity proof (the remote holds
EXACTLY this tree) rather than trusting the push subprocess's exit code alone.
A verification failure is recorded as a failed run (`BackupStatus.ok = False`),
never silently treated as success.

## Least-privilege compose wiring

The `backup` service mounts `wixy-storage` and `worker-transcripts` **read-only**
(`:ro` in `docker-compose.yml`) — it only ever needs to COPY state elsewhere,
never write to the site's own storage, so a bug anywhere in its own code
structurally cannot touch live state. Its own small `backup-status` volume is the
ONLY thing it can write to (its own last-run status file,
`wixy_server/backup/status.py`); `wixy` mounts that SAME volume **read-only**, so
`routes_system.py` can read it without the backup process ever being able to
write anywhere in `wixy`'s own storage. `update.sh`/`verify.sh` extended to touch
all three same-image services (`wixy`/`worker`/`backup`) together, matching
decisions/00065's "What to watch for" note that these stay in lockstep.

## The System card is deliberately NOT edition-gated

Unlike the Engine card (spec/independence/04, standalone-only — the fleet
deployment has no fork-sync concept at all) and the AI card (anthropic-backend
only — `cmd` has no budget concept), `GET /api/admin/system/status` 200s on
BOTH editions: disk usage and publish history are meaningful on the fleet's own
Wixy deployment too, it just has no `backup` service to report on there (`backup`
field reports `stale: true` with null timestamps, the same shape a fresh
standalone install shows before its first night — never a crash, never a 404).
`stale` is computed server-side (no backup ever run, OR the last run
failed/wasn't verified, OR it's older than 48h — spec's own "banner when > 48
h") so the frontend never does its own date arithmetic; `TestBackupField` in
`test_routes_system.py` exercises all three staleness triggers independently.

## What's deliberately out of scope (not gaps, decided calls)

- **Actually installing the hub-side pre-cutover mirror** — `deploy/hub-mirror/`
  ships the script + full runbook now (buildable/reviewable engine work), but
  does NOT register anything against real hub infrastructure: `<org>/ca-state-
  backup` doesn't exist yet (created at drill/real-cutover time,
  spec/independence/08 §1 item 1). Forward obligation recorded in the M10 todo
  sidecar.
- **Restore tooling** — spec's own words: "Restore path (guide Appendix A): fresh
  droplet + `setup.sh` + copy the snapshot tree into the volume." That's an M8
  guide-writing concern (a documented manual procedure), not code this milestone
  builds; nothing here needs to change for it.
- **UptimeRobot / publish-failure email** (spec §3's other two monitoring
  bullets) — both explicitly "her account, guide step" / "guide offers ... as
  optional" in spec's own words, not engine code.

## What to watch for

- `wixy_server/backup/settings.py`'s `_bool_env`/env-var names mirror
  `wixy_server.worker.settings`'s own conventions deliberately — if that
  module's pattern ever changes, revisit this one too for consistency.
- `_BACKUP_STATUS_PATH` in `routes_system.py` is a hardcoded container-path
  constant (`/backup-status/status.json`), matching `docker-compose.yml`'s own
  fixed volume mount point — the two are NOT connected by any shared
  configuration, only by convention; changing one without the other silently
  breaks the System card's backup field.
- If `wixy_server.storage.ProjectPaths` ever grows a field that genuinely
  belongs in the backup (e.g. a new durable state file), it must be added
  explicitly to `_project_backup_items` — it will NOT be picked up
  automatically, by design (see "the core design choice" above).
