# 00011 [zoapor] site-repo: .github/workflows/pages.yml deploy workflow

## What
Clone `https://github.com/joshcomley/cottage-aesthetics-preview.git` into a SHORT path (e.g.
`C:\Users\josh\AppData\Local\Temp\ca-<first-8-of-session-id>\site-repo` — deep paths hit
"Filename too long" on Windows). Branch `feat/pages-deploy`. Add `.github/workflows/pages.yml`
— shape given verbatim in brief §5 (job `build` triggers on push to `wixy-live` +
`workflow_dispatch`, guards `vars.WIXY_PUBLIC_DOMAIN != ''`, checks out `ref: wixy-live`,
checks out the wixy engine via the verbatim pattern from the site repo's existing `ci.yml`,
`pip install -e .`, `builder validate` + `builder build --domain ... --indexable true`,
`upload-pages-artifact` + `deploy-pages`; job `not-configured` no-ops green with a
`$GITHUB_STEP_SUMMARY` message when the variable is unset). Verify action majors
(`actions/checkout`, `setup-python`, `upload-pages-artifact`, `deploy-pages`) are current, not
stale from planning time.

## Why
This is the actual GitHub Pages deploy mechanism — deploys the `wixy-live` mirror ref (never
`main` HEAD, which would bypass the owner's Publish gate).

## Context / current state
Not started. Depends on [[00003]]/[[00004]]/[[00005]] existing conceptually (the ref this
workflow watches) but can be authored in parallel since it only needs the REF NAME, not the
wixy-repo code to be merged yet.

## Files
- `.github/workflows/pages.yml` (new, in the site repo)

## How to continue + acceptance
No Playwright browser install needed here (parity doesn't run in this workflow). No
`.nojekyll`/CNAME file needed (workflow-based Pages; custom domain lives in repo Settings).
Validate the YAML is well-formed and the guard logic matches brief §5 before opening the PR.

## Links
Brief §5 (full YAML shape + notes), §2 (the verbatim engine-checkout pattern to mirror from
`ci.yml`), Windows gotchas in brief §2 (short clone path, gh via PowerShell).
