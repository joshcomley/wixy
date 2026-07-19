# M6 bot credential: a new WIXY_AI_BOT_PAT, distinct from M4's WIXY_ENGINE_PAT

## Context

spec/independence/05 §2 says the worker "ships a PR via her bot deploy key/
PAT" — under-specified in the same way M4's original spec text was for
`SYNC_PUSH_TOKEN`'s scope (corrected in decisions/00057 after the M4 Fable
gate review found a contents-only PAT 403s on `gh pr create`). This entry
makes that same class of gap explicit up front instead of discovering it the
same way M4 did.

## Decision: a NEW credential, not a reuse of `WIXY_ENGINE_PAT`

`WIXY_ENGINE_PAT` (M4, spec/independence/04 §2) is scoped `actions:write` +
`contents:read` on her ENGINE FORK only — it exists to dispatch the
sync-upstream workflow and read commits-behind, never to push or open a PR
anywhere. Reusing it for the worker would be wrong on BOTH axes:

- **Wrong repo**: the worker targets her SITE repo (v1 scope, decisions/00060),
  not her engine fork — `WIXY_ENGINE_PAT` isn't even scoped to reach it.
- **Wrong permissions**: even scoped to the right repo, `actions:write` +
  `contents:read` can't push a branch (`contents:read` is read-only) or open a
  PR (`pull_requests` isn't granted at all) — this PAT literally cannot do
  either of the two things the worker's whole job is.

**Name**: `WIXY_AI_BOT_PAT` — distinguishes it from `WIXY_ENGINE_PAT` by
naming what it authenticates AS (the AI bot identity) rather than what it's
FOR, matching this repo's existing convention of naming a secret after its
holder/purpose (`ANTHROPIC_API_KEY`, `WIXY_ENGINE_PAT`) rather than its
mechanism.

**Required scope**: fine-grained PAT, `contents:write` + `pull_requests:write`
on her SITE repo (`WIXY_SITE_REPO`) — `contents:write` for the push,
`pull_requests:write` for `POST /repos/{repo}/pulls` (the SAME lesson M4's own
gate review already learned the hard way for `SYNC_PUSH_TOKEN`: a
contents-only PAT 403s on PR creation). No `actions:write` needed (the worker
never dispatches a workflow) and no access to the engine fork at all (out of
scope per decisions/00060's "v1 always targets the site repo").

**Which GitHub account it belongs to** is an operational choice for the guide
(spec/independence/07, milestone 8) to walk her through, not something this
code enforces — a fine-grained PAT is always tied to SOME GitHub user account
(there's no first-class "bot account" concept for a personal-scale PAT the way
a GitHub App would have); PRs the worker opens will be attributed to whichever
account she creates the PAT under. Worth a dedicated "AI bot" GitHub account
in the guide's own recommendation (keeps AI-authored PRs visually distinct
from her own), but that's guidance text, not a code requirement.

## Where it lives

Read directly from the worker's own process environment
(`wixy_server/worker/settings.py`'s `WorkerSettings.bot_pat`, `WIXY_AI_BOT_PAT`)
— never modeled on the main server's `wixy_server/settings.py` `Settings`
dataclass at all, matching `ANTHROPIC_API_KEY`'s own precedent (worker.py's
own docstring: "not modeled here, so it never risks being logged via a
settings repr/dataclass field"). `docker-compose.yml`'s `worker` service
(spec/independence/05 §2, not yet wired as of this decision — see the open M6
work item for the compose file itself) is where it actually reaches the
container: alongside `ANTHROPIC_API_KEY`, on the `worker` service ONLY, never
on `wixy` — the main server process has no legitimate reason to ever hold this
credential, and keeping it worker-only shrinks the blast radius of any future
bug in the main server's own request-handling code logging something it
shouldn't.

## Never logged, never committed

Same discipline as `WIXY_ENGINE_PAT` (`Settings.engine_pat`) and
`GitHubClient._headers()`'s own existing comment ("never logged... only ever
handed to httpx as request headers"): `WorkerSettings` is a plain dataclass
with no custom `__repr__` suppression needed because nothing in this codebase
ever prints a whole `WorkerSettings`/`Settings` instance; the PAT string
itself only ever appears as an HTTP header value (`GitHubClient`) or a
git `-c http.extraHeader=` argv element (`wixy_server/worker/workspace.py`,
decisions/00060) — never in a log call, an exception message that echoes
request state, or (per decisions/00060's whole credential-handling design) any
file written to disk.
