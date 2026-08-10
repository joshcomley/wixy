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

## What was discovered — the `github-pages` environment gates on the triggering branch

Found while rolling this out against the real `joshcomley/cottage-aesthetics-preview` repo,
not caught by any PR's own CI (the workflow doesn't trigger on `pull_request`, so this never
surfaced until a real push to `wixy-live` was exercised): GitHub's auto-provisioned
`github-pages` deployment environment already carried a **custom branch policy** restricting
deploys to `gh-pages`/`main` only — a job that references `environment: {name: github-pages}`
is gated on `github.ref` (the ref that triggered the RUN), not on whatever a `checkout` step
inside the job happens to check out. Left alone, every automatic `wixy-live`-triggered run
would have failed at the `deploy` job with "Branch 'wixy-live' is not allowed to deploy to
github-pages due to environment protection rules" — silently defeating the entire feature
despite every other piece working. Fixed by adding `wixy-live` as a third allowed branch via
`gh api -X POST .../environments/github-pages/deployment-branch-policies` (repo-admin-level;
the fleet's ordinary bot-PAT 403s on it — used the operator's token instead, same fallback
pattern as `gh repo create`). See runbook.md's GitHub Pages section and the site repo's
decisions/00013 for the operational detail.

## What to watch for

- **The environment branch policy above** is a pure GitHub repo SETTING, invisible to a diff
  of this code — a fresh Pages setup (fork, or from-scratch reinstall) needs the same
  one-time fix, and nothing here will fail loudly until an actual push to `wixy-live` is
  exercised for real, since PR CI never triggers this workflow.
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

## Correction (2026-08-10)

The "verified end-to-end with the real domain... production health confirmed" claim above
covered the built pages' own domain-stamping (canonical link, sitemap, robots.txt — all
correctly emitted for `cottageaesthetics.co.uk`), not real-world DNS resolution to that domain.
The domain's nameservers were still Wix's own the entire time that claim was made — real
visitors to `cottageaesthetics.co.uk` were seeing the old Wix site, not GitHub Pages. See
decisions/00129 for the measurement and the go-live guide fix.
