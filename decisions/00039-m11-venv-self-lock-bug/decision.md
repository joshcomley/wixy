# `deploy.py`'s in-place venv rmtree deleted its own running interpreter

Found immediately after decisions/00037 (the `os.execv` fix), while watching the
promised spec/07 §4 item 2 slot-cycle proof (decisions/00038) actually run.
Green's HEAD advanced to the target commit within seconds, but the swap never
happened — 4+ minutes with zero progress. Investigated rather than assuming
"still building" (this repo's own standing "suspiciously slow — profile it, don't
theorize" discipline).

## Symptom

`D:\Servers\Devfleet\Storage\logs\Slots\stdout.log` showed Slots' own self-healing
firing: `executor stuck detected for wixy (3 consecutive 'unexpected') — firing AI
repair`. No error text in the shared log (it's a 58k-line multi-consumer stream).
Traced to the actual record via Slots' own SQLite DB
(`D:\Servers\Slots\Storage\slots.db`, table `executor_outcomes`) rather than
guessing:

```
error_message: "deploy run failed: build step deploy:_pip_install_venv failed
  (exit=3, kind=build_step_raised): PermissionError: [WinError 5] Access is
  denied: 'D:\\Servers\\Wixy\\Slots\\green\\.venv\\Scripts\\python.exe'"
consecutive failures: 107 (and climbing every ~30-90s)
```

## Root cause

`_pip_install_venv` did `if venv_dir.exists(): shutil.rmtree(venv_dir)` before
rebuilding. That's fine for the very first build (no existing venv) — which is
the ONLY case I'd actually exercised, via `install.py`'s own fresh install and a
manual dry run. It is NOT fine for every subsequent deploy, because of how Slots'
executor actually invokes a build-step runner (`slot_swap_deploy.hook_runner
.run_build_step` → `find_slot_python(slot)`): it prefers the slot's OWN existing
venv interpreter when one is already there. So the build-step SUBPROCESS running
`_pip_install_venv`'s own code is ITSELF interpreted by
`<slot>/.venv/Scripts/python.exe` — meaning the function was asked to delete the
very executable currently running it. Windows refuses (`PermissionError:
Access is denied`) on the locked `.pyd`/`.exe` files, but succeeds on everything
else in the tree, so each failed attempt left a partially-deleted `.venv` behind
for the next retry to trip over differently.

Read `D:\Slots\self\src\slot_swap_deploy\runners.py`'s own `run_pip_install`
docstring AFTER finding this (confirming, not guessing, the fix): this is a
previously-documented fleet outage class, not a novel failure mode —
*"the 2026-05-25 outage was the deployer rebuilding the venv of a still-running
service... rmtree hit the loaded, Windows-locked .pyd/.exe files and deleted only
what wasn't locked — leaving an empty `click/` dir → import crash → dead
orchestrator."* The library's own fix, already used by every other requirements.txt-
shaped consumer (foodgrid/hall/douglas-web/tenna), is exactly the pattern applied
here: build fully OUT OF PLACE at `.venv.new`, then swap it in atomically — the live
`.venv` is never touched until the very last step, and even then only via a RENAME
(not a delete).

Also found, tracing the same code path: `_run_or_raise` and `_testclient_validate`
raised the library's `DeployError` on a genuine failure. `DeployError` is the
library's documented graceful-skip signal (`pre_validate`'s "nothing to deploy"
case) — `hook_runner.run_build_step` special-cases it and reports a benign no-op
to the executor, NOT a failure. Every real build-step failure in this file would
have been silently swallowed as "nothing to deploy" rather than surfacing loudly —
a second, independent bug in the same two functions, fixed alongside the first by
introducing a distinct `BuildStepError` for genuine failures and reserving
`DeployError` exclusively for its one documented use in `pre_validate`.

## Fix

- `_atomic_swap_dir(new_dir, live_dir)` — if `live_dir` exists, rename it aside to
  `<name>.old.<pid>.<timestamp>` (a rename succeeds even with the running
  interpreter's own binary open inside it — Windows keeps an open handle valid via
  the underlying file object regardless of a path rename of its containing
  directory; only an in-place DELETE of the open file is refused), then rename
  `new_dir` into `live_dir`'s place.
- `_pip_install_venv` now builds everything at `<slot>/.venv.new` (venv create,
  `pip install -r requirements.txt`, `pip install --no-deps .`) and calls
  `_atomic_swap_dir` only at the very end.
- `BuildStepError(RuntimeError)` — new class for genuine build-step failures;
  `_run_or_raise` and `_testclient_validate` now raise this instead of
  `DeployError`. `DeployError`'s docstring updated to say explicitly it is
  reserved for the graceful-skip case only.

Deliberately did NOT take on a dependency on `slot_swap_deploy` being importable
inside wixy's own venv (the library's own `run_pip_install_requirements` would
have reused this exact logic, and IS what foodgrid/hall/tenna/douglas-web actually
call) — that would require bootstrapping `slot_swap_deploy` into wixy's venv too
(an extra build step, a dependency on the fleet-internal `D:\Slots\self` clone
path), which spec/07 never asked for and which would entangle wixy's otherwise
self-contained deploy.py with Loom/cmd's more evolved, fleet-internal-path-
dependent conventions — exactly the complexity decisions/00036 decision 2 already
chose to avoid. Reimplementing the same proven TECHNIQUE (atomic rename) without
the library DEPENDENCY keeps wixy's deploy pipeline self-contained while still
being correct.

## Cleanup

`D:\Servers\Wixy\Slots\green\.venv` was left completely absent by the failed
retries (successive partial-rmtree attempts eventually cleared it out entirely).
Not a data-loss concern (an inactive slot's venv is disposable, rebuilt every
deploy by design) — the next successful `_pip_install_venv` run rebuilds it from
scratch, `.venv.new` first, same as a from-scratch slot.

## Files changed

- `deploy.py` — `_atomic_swap_dir` (new), `_pip_install_venv` (out-of-place build
  + atomic swap), `BuildStepError` (new), `_run_or_raise` +
  `_testclient_validate` (raise `BuildStepError`, not `DeployError`).
