## Symptom

2026-09-26: the operator reported the wixy admin Server status page showed free disk space
on the host dropping from ~100GB to ~16GB in one day, then it kept falling to under 7GB
before the emergency cleanup below.

## Root cause

`deploy.py`'s `_atomic_swap_dir` (used by `_pip_install_venv` to swap the freshly-built
`.venv.new` into place) renames the *old* `.venv` aside as `.venv.old.<pid>.<timestamp>`
rather than deleting it in place. That rename-not-delete choice is itself correct — an
in-place `rmtree` of the live `.venv` tries to delete the currently-running interpreter's
own binary and Windows refuses it (see `_pip_install_venv`'s own docstring for the prior
outage this avoids). But nothing ever cleaned up the renamed-aside copies afterward, so
**every single deploy permanently leaked one ~205MB folder**. By the time of the incident,
228 of them had accumulated across `Slots/blue` and `Slots/green` (45.7GB) — one clear
contributor to the wider fleet-wide disk emergency (a separate, much larger contributor was
an unrelated pile-up of git worktrees across the whole `Storage/clones` tree, out of scope
here).

## What was decided

Added `_cleanup_old_venvs(slot)`, called at the very start of `_pip_install_venv(slot)`
(before creating this cycle's `.venv.new`), which globs `slot/.venv.old.*` and removes every
match. It is safe unconditionally: `_pip_install_venv` only ever runs against the
currently-*inactive* slot (Slots' executor always rebuilds the inactive slot before
swapping it live), so nothing can have any of that slot's venvs — old or current — open at
the moment this runs.

The cleanup runs at the **start** of the next build, not the end of the previous one — the
operator's explicit direction: a failure partway through an end-of-deploy cleanup would
leave things half-cleaned, whereas cleaning up *previous, definitely-finished* deploys right
before starting a new one has no such failure mode (a crash during cleanup just means it
retries next deploy).

## Why not fix this generically in one place instead

It should be — this same leak pattern was independently confirmed on Cmd (~37GB), Kiln,
Loom and Cmd-Chats, all of which import the shared `Aim.SlotSwap` / `slot_swap_deploy`
library for their own blue/green deploys. This wixy-local fix is the immediate, low-risk
stopgap for wixy specifically. A generic fix in `slot_swap_deploy` itself (so every consumer
gets it automatically, no per-project copy-paste) was commissioned the same day as a
separate piece of work — see that repo's own decision log once it lands.

## What to watch for

If `_pip_install_venv`'s slot-targeting assumption ever changes (e.g. a future rollback path
rebuilds the *active* slot in place), this cleanup's safety argument needs re-checking before
it stays correct.
