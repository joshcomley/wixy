# 00014 [vxvckt] site-repo: push branch + PR, wait CI green

## What
Push `feat/pages-deploy`, open PR, wait for the site repo's `CI` workflow to pass. Hold for
the planner's final gate (§8) before merging — do NOT merge on green CI alone.

## Why
Operating contract §8: no merge in either repo before FINAL HANDOFF CLEARED naming both
candidate SHAs.

## Context / current state
Not started. Depends on [[00011]], [[00012]], [[00013]].

## Contingency (verified gotcha, brief §5)
If the branch push is rejected with a workflow-scope error ("refusing to allow a Personal
Access Token to create or update workflow"), the machine askpass bot-PAT lacks `workflow`
scope — redo the push using the operator's token: write a 2-line askpass script in the
scratchpad printing the content of `D:\Servers\Cmd\Storage\user-gh-token`, then
`GIT_ASKPASS=<that script> git push ...` (never embed the token in the URL). Same token via
`$env:GH_TOKEN` is the fallback for the repo-variable and workflow-dispatch API calls in
[[00016]] if default credentials 403.

## Files
N/A (process step).

## How to continue + acceptance
PR URL recorded for the FINAL HANDOFF ([[00015]]). CI green.

## Links
Brief §5 (contingency verbatim), §8.
