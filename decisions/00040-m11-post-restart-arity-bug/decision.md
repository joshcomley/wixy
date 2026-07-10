# `post_restart(ctx, svc)` didn't match the real executor calling convention

Third bug found in the same live-verification pass (decisions/00037 execv,
00039 venv self-lock, this one) — found because the venv fix (decisions/00039)
actually let a deploy cycle reach the swap + restart phase for the first time,
which is the only way this could ever surface.

## Symptom

Slots' `executor_outcomes` table (`D:\Servers\Slots\Storage\slots.db`) showed a
`hook_error` for wixy immediately after the venv fix started succeeding:

```
error_message: "hook deploy:post_restart for phase 'post_restart' failed
  (exit=3, kind=hook_raised)"
stderr: {"exc_type": "TypeError", "message": "post_restart() missing 1
  required positional argument: 'svc'"}
```

## Root cause

`post_restart(ctx: dict, svc: Service) -> None` was copied verbatim from
`D:\Servers\Smartbell\deploy.py` (cor), which this file was modeled on
(decisions/00036). Reading `D:\Slots\self\src\slot_swap_deploy\hook_runner.py`'s
`_BOOTSTRAP` (already read once for the venv-lock bug, re-read here for the
actual calling contract) confirms every hook — `pre_validate`, `post_swap`,
`post_restart`, whatever a consumer names — is invoked as `fn(ctx)`, a SINGLE
dict argument, full stop. There is no code path in the executor that ever
supplies a second `svc` argument. A `(ctx, svc)`-shaped hook can only ever have
been exercised via the `--poll` CLI's in-process `Deploy.run()`, which cor's
own file supports as a documented (but "manual operator use only") fallback —
meaning cor's own `post_restart` likely carries the same latent bug, just never
triggered because cor's production path is the same Slots-executor mode wixy
uses, and apparently no one has hit this exact hook failing in a way that
surfaced it there either. Not something to go fix in cor's repo from here —
noted for the record, not actioned.

## Fix

`post_restart(ctx: dict) -> None` — single argument, matching the real,
production calling convention. The `svc.name == SERVICE_NAME` gate it used to
have is gone rather than replaced with a ctx-based equivalent: wixy has exactly
ONE service (`SERVICE_NAME = "Wixy"`), so that check was always true anyway —
removing it isn't a behavior change, just removing now-impossible-to-reach dead
branching now that there's no `svc` to read `.name` off of.

## Files changed

- `deploy.py` — `post_restart` signature + body.
