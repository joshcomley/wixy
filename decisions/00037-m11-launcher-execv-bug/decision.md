# `launcher.py`'s `os.execv` orphaned the server from Devfleet's supervision

Found by actually registering Wixy with Devfleet and checking `/status` for real
(this whole chain's own repeated "verify for real" discipline, once again catching a
real bug an install.py dry-run and a standalone manual smoke test both missed —
neither of those ran launcher.py UNDER Devfleet's own process supervision).

## Symptom

After the M11 slice 1 PR merged, `install.py` ran cleanly end-to-end against
`D:\Servers\Wixy\` (both slots cloned + venvs built, `active.txt` = blue, the real
Cottage Aesthetics site cloned and bootstrapped as version 0 — confirmed via
`/healthz`, `/api/version`, and `curl /` returning the real homepage, all run as a
plain standalone `python launcher.py` invocation OUTSIDE Devfleet first). Registering
`[services.Wixy]` in `D:\Servers\Devfleet\supervisor\services.toml` and
`POST /reload`, then checking `GET :9999/status`, showed:

```
"status": "exited", "pid": null, "last_exit_code": 0,
"restart_count_total": 2, "restarts_in_window": 3
```

`D:\Servers\Devfleet\Storage\logs\Wixy\stderr.log` showed a repeating pattern with NO
error or traceback anywhere:

```
INFO:     Started server process [23564]
INFO:     Waiting for application startup.
INFO:     Started server process [23656]
INFO:     Waiting for application startup.
INFO:     Started server process [5712]
INFO:     Waiting for application startup.
```

Every attempt starts uvicorn, begins the FastAPI lifespan startup sequence, and is
cut off before ever logging "Application startup complete" — then Devfleet restarts
it and the same thing happens again. A genuinely different symptom from the standalone
run, which completed startup and served real requests successfully.

## Root cause

`launcher.py` used `os.execv(venv_python, [venv_python, "-m", "wixy_server"])` to hand
off from the fixed system interpreter Devfleet spawns into the active slot's own venv
interpreter — modeled on the mental model of POSIX `execve`, which truly replaces the
calling process's image in place (same PID, same process object, the supervisor's
handle stays valid throughout).

**`os.execv` on Windows does not do this.** CPython's Windows implementation goes
through the C runtime's `_wexecv` family, which has no true in-place image
replacement available on Windows — it spawns a genuinely SEPARATE process and the
calling process then exits. Confirmed directly: a standalone `python launcher.py &`
run from a shell showed the shell's own captured PID become invalid immediately
(`kill <pid>` → "No such process") while a DIFFERENT pid was found bound to port 9380
via `Get-NetTCPConnection` — proof the execv'd process was never the same process
object the caller started.

Devfleet supervises its children via a Windows Job Object (the standard, correct
mechanism for reliable child-process lifetime tracking on Windows). A process spawned
by `_wexecv` is a new, separate `CreateProcess` call — it is NOT the same process
Devfleet's job handle is tracking. The moment `launcher.py`'s own process exits
(immediately after handing off), Devfleet observes ITS tracked process exit and acts
on it (restart-on-exit, and/or job-scoped cleanup) — tearing down the newly-spawned
uvicorn child along with it, mid-startup, before it ever finishes. Restart, repeat.
This is why the standalone manual test (no supervisor watching the launching shell)
never surfaced this — nothing was watching the parent's exit to react to it.

## Fix

Replaced the `os.execv` handoff with a blocking child `subprocess.run` call, letting
`launcher.py`'s own process (the one Devfleet's job actually owns) stay alive for the
server's entire lifetime, then propagate the child's exit code:

```python
result = subprocess.run([str(venv_python), "-m", "wixy_server"])
sys.exit(result.returncode)
```

No `capture_output`/`PIPE` — the child inherits `launcher.py`'s own stdout/stderr
handles (the ones Devfleet is already capturing to
`Storage\logs\Wixy\{stdout,stderr}.log`), so uvicorn's own log lines keep landing in
the same place with no plumbing needed. This also gives STRICTLY BETTER supervision
semantics than `execv` would even in principle: the child is a normal Windows child
process of the process inside Devfleet's job, so a Devfleet-initiated kill correctly
tears down the real server, and a real server crash correctly propagates its exit code
back through `launcher.py`'s own exit — both properties `execv` accidentally broke by
detaching the real server from the supervised process entirely.

## Verification

Re-deployed the fix into the already-installed `D:\Servers\Wixy\` (both slots
`git fetch` + `reset --hard` to the newly-merged main, `launcher.py` re-mirrored to
the install root — the exact operations `deploy.py`'s `pre_validate`/`post_swap`
would perform automatically once Slots is registered; done manually here since
that registration is this milestone's own next step, not yet in place). Restarted
the Devfleet child and re-checked `/status`: `"status": "running"`, `"healthy": true`,
stable `pid`, zero further restarts. `curl http://127.0.0.1:9380/` still serves the
real Cottage Aesthetics homepage; `/api/version` still reports the correct slot/sha.

## Files changed

- `launcher.py` — `os.execv` → blocking `subprocess.run` + `sys.exit(returncode)`.
