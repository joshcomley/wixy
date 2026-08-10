# Decision: GitHub Pages go-live via a `wixy-live` mirror ref, not `main` HEAD

## Symptom

The operator: "We are going to be going live with the Wix Published Cottage Aesthetics
website... hosted using GitHub Pages with a custom domain we own." The obvious
implementation — point a GitHub Pages workflow at the site repo's `main` branch — is wrong for
this product specifically: content PRs land on `main` routinely without the owner's
involvement (an agent merging a copy fix, the AI chat lane's own upstream commits), and the
site repo's own `CLAUDE.md` states as a hard guardrail that merging to `main` must never make
anything go live — only the owner's Publish click (or Restore) in the Wixy admin does that.
Deploying `main` HEAD to Pages would silently break that guarantee the moment any agent merged
anything.

## What was decided — a server-owned mirror ref, `wixy-live`

`wixy_server/checkout.py:push_live_mirror(repo, sha)` force-pushes the current live pointer's
sha to `refs/heads/wixy-live` on the site repo's origin, called at the end of `publisher.py`'s
swap stage (after a successful publish) and from `restore.py` (after a restore's live-pointer
flip). **Only the wixy server ever writes this ref.** The GitHub Pages workflow
(`.github/workflows/pages.yml`, site repo) triggers on pushes to `wixy-live`, always checking
out that exact ref — so the public site materializes precisely "what the owner published or
restored to," never "whatever an agent last merged." `git push --force` is required, not
incidental: a restore moves the live pointer to an OLDER sha already on the remote, which a
non-force push would reject as non-fast-forward.

**Advisory, never blocking.** `push_live_mirror` retries once, swallows every exception a git
subprocess can raise, and returns a plain `bool` — a failure logs a warning (the publish job
log, or `logger.warning` for restore, which has no job log) and the pipeline completes
normally either way. The alternative — failing a publish because a *secondary* mirror push
failed — would hold the owner's actual publish hostage to GitHub's availability for a
completely different, non-essential concern. The mirror self-heals: the next successful
publish or restore re-pushes the ref regardless of whether the previous push succeeded.

## What was decided — `--domain`/`--indexable` CLI overrides, not env vars

The Pages workflow needs to build with the operator's real public domain and
`indexable=true`, while `projects/ca.json` (the fleet/staging registry) stays
`ca.cinnamons.uk` / `indexable=false` until independence-phase cutover. `builder/cli.py`
gained `--domain`/`--indexable` flags applied via `dataclasses.replace` on the loaded
`ProjectConfig`, rather than reading environment variables inside `builder/` — deliberately
consistent with `wixy_server/registry.py`'s own `_apply_env_overrides` docstring, which
already records that env-var resolution belongs server-side only, keeping `builder/` a pure,
env-blind library callable identically from a CLI, a workflow, or a test.

## What was decided — a canonical `<link>` on every page

`apply_head` (`builder/templates.py`) now writes `<link rel="canonical"
href="https://{domain}{page_url_path}">` on every page, overwriting any hand-authored value.
Needed for this go-live specifically: for a transition window the same content is reachable at
both `https://joshcomley.github.io/cottage-aesthetics-preview/` (GitHub's default Pages URL)
and the real custom domain — an explicit canonical tells search engines which one is
authoritative, rather than leaving it to chance.

## What was decided — `WIXY_PUBLIC_DOMAIN` gates the workflow, not a hardcoded domain

The Pages workflow reads the public domain from a repo Actions **variable**,
`WIXY_PUBLIC_DOMAIN`, and no-ops green (a `not-configured` job, not a failure) when it's
unset. This keeps the site repo — which is public — safe to fork: a fork's Pages workflow
does nothing destructive by default, and setting the variable is the one deliberate step that
turns deployment on. It also means changing the operator's domain later is a two-field edit
(the variable + the Pages custom-domain box), not a code change.

## What to watch for

- **The pre-workflow-sha restore edge.** GitHub resolves a push-triggered workflow run from
  the *pushed commit's own tree* — so a restore whose sha predates `pages.yml` existing on
  `main` moves `wixy-live` correctly but triggers no Pages run at all; the public domain then
  lags until the next publish (whose sha postdates the workflow file) or a manual
  `workflow_dispatch`. This is why the bootstrap procedure (runbook.md) needs one manual
  dispatch the first time, and is an accepted, documented gap, not a bug to chase.
- **This is additive, not a replacement.** The independence-phase droplet plan
  (`spec/independence/`) is untouched by this — when that cutover happens, it repoints DNS at
  the droplet; nothing here assumes GitHub Pages is permanent infrastructure.
- Any future change to what "live" means (e.g. a second concurrent domain) must keep
  `wixy-live` as the single source of truth for "what publish/restore last pointed at" — don't
  let a workflow or a manual step derive "what's live" from `main` HEAD by convenience; that
  reintroduces exactly the guardrail violation this decision exists to prevent.
