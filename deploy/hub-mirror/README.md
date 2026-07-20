# `deploy/hub-mirror/` — the pre-cutover hub-side state mirror

spec/independence/06 §2: *"Until cutover, an equivalent scheduled hub job mirrors fleet
Storage the same way — her backup custody starts BEFORE her hosting does."*

This is fleet-infrastructure glue, not part of the portable Docker deployment target
(that's `deploy/standalone/`, which this directory has nothing to do with) — it runs on
**hub**, backing up the FLEET's own `D:\Servers\Wixy\Storage\` tree (the staging
deployment) into `<org>/ca-state-backup`, using the exact same
[`wixy_server.backup`](../../wixy_server/backup/__init__.py) module the droplet's
`backup` compose service runs, just pointed at a different `WIXY_STORAGE_ROOT` and
invoked once per call (`WIXY_BACKUP_RUN_ONCE=1`) by an external Scheduled Task instead
of the module's own internal nightly loop. Same force-push-to-`snapshot`,
single-commit, verify-after-push behavior — see that module's own docstrings for the
mechanism; nothing here reimplements any of it.

## Status: NOT YET INSTALLED

`<org>/ca-state-backup` does not exist yet — it's created at drill/real-cutover time
(spec/independence/08 §1 item 1; spec/independence/09 row 9/10, Track J). This
directory ships the ready-to-run script now (engine work, buildable and reviewable
today) but does **not** register anything against real hub infrastructure — that's a
real, one-time change to a shared production box, and there's nothing meaningful to
point it at until the repo is real. Installing it for real is a **Track J** action,
tracked in the M10 (real-run support pack) todo sidecar.

## Contents

- **`hub_mirror.ps1`** — one-shot invocation. Sets the env vars `wixy_server.backup`
  needs (`WIXY_STORAGE_ROOT`, `WIXY_STATE_BACKUP_REPO`, `WIXY_BACKUP_RUN_ONCE=1`,
  `WIXY_BACKUP_STATUS_PATH`, `GIT_SSH_COMMAND`) and runs `python -m wixy_server.backup`
  once, then exits with its exit code. Defaults assume the fleet's own conventions
  (`D:\Servers\Wixy\Storage`, the `pythoncore-3.14-64` interpreter,
  `C:\Admin\wixy-hub-backup-status.json` for its status file — a DIFFERENT path from
  the droplet's own `/backup-status/status.json`, since nothing on hub reads it the
  way `wixy_server.routes_system` does on the droplet; it exists purely for a human to
  check after the fact). Pass `-StateBackupRepo`/`-DeployKeyPath` to override.

## Prerequisites (before this can run for real)

1. `<org>/ca-state-backup` exists (Track J).
2. A dedicated SSH deploy key on hub, **write-scoped to `ca-state-backup` ONLY** —
   never reused from the site-repo/engine-fork keys, matching
   `deploy/standalone/setup.sh`'s own `generate_deploy_key "state-backup"` precedent
   (decisions/00066). Generate with `ssh-keygen -t ed25519 -f
   "$env:USERPROFILE\.ssh\wixy-hub-state-backup" -N '""'`, paste the `.pub` half at
   `https://github.com/<org>/ca-state-backup/settings/keys/new` (tick "Allow write
   access").
3. The wixy engine checked out on hub with its `[server]` extra installed (the same
   environment the fleet's own `Wixy` Slots deployment already runs under) — this
   script's `WorkingDirectory` when registered as a Scheduled Task action.

## Installing the Scheduled Task (once, on hub, when the above are real)

An **interactive** logon type — never session 0 (the fleet's own SERVERS/SLOTS/
DEVFLEET doctrine: non-interactive S4U tasks silently kill child processes; this
script's own `git`/`python` subprocesses would be exactly that kind of child):

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File D:\path\to\wixy\deploy\hub-mirror\hub_mirror.ps1"
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
$principal = New-ScheduledTaskPrincipal -UserId "<hub-service-account>" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "WixyHubStateMirror" -Action $action -Trigger $trigger -Principal $principal
```

Verify a run manually first (`& D:\path\to\wixy\deploy\hub-mirror\hub_mirror.ps1`,
check the exit code and `C:\Admin\wixy-hub-backup-status.json`) before trusting the
schedule.

## When this stops being needed

Once real cutover happens (spec/independence/09 row 10) and her droplet's own `backup`
compose service is the live, authoritative backup path, this hub-side job's job is
done — spec's own framing is explicitly "**until** cutover." Decommissioning it
(unregistering the Scheduled Task) is itself a Track J / post-cutover cleanup step, not
covered here.
