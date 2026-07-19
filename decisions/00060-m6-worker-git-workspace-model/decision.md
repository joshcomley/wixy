# M6 worker git workspace model: clone/branch/push mechanics, credential handling, and cleanup

## Context

spec/independence/05 §2: "the worker clones the target repo... into a scratch
volume per conversation, branches, and ships a PR via her bot deploy key/PAT."
The prior slice (decisions/00059) built the worker's HTTP API and agent-run
loop against a bare scratch directory with no real repo content — this slice
is the actual git mechanics: `wixy_server/worker/workspace.py` (new),
threaded through `wixy_server/worker/app.py`'s `_run_and_track`.

v1 always targets the SITE repo, never the engine fork — spec/independence/04
§4 calls the engine-fork editing tab "a noted later enhancement," not part of
this milestone, so `_DEFAULT_BRANCH = "main"` and `WIXY_SITE_REPO` are hardcoded
assumptions in `wixy_server/worker/app.py`, not a repo-selection parameter.

## The core security constraint

The agent has unrestricted Bash access inside its clone for the rest of its
turn (spec §3: "tools: read/write/git/run-tests in its clone"). This means
`git remote -v` or `cat .git/config` is one tool call away from the model at
all times — if the bot PAT ever touched either at rest, it would leak straight
into the conversation transcript the owner reads (the Fable checklist's "key
never logged/committed" is really about this specific channel, not just log
files).

**Decision**: every credentialed git call (clone, push) passes the PAT via a
ONE-OFF `-c http.extraHeader=` flag — git's own per-invocation auth override,
applied to that single subprocess and never written to any config file. The
clone itself uses this transiently; immediately after, `origin`'s remote URL
is reset to the bare, credential-free HTTPS form (`git remote set-url origin
<bare-url>`) BEFORE the agent ever gets a chance to run. The push (after the
agent's turn ends, issued by the worker's own code, never by the agent) uses
the same one-off header again, and again never persists it. Verified for real
in `test_worker_workspace.py` (reads `.git/config` off disk after both clone
and push, asserts the raw PAT string is absent) rather than just asserted
against a mock call.

## Why HTTPS + a bot PAT, not the main server's SSH deploy key

The main server's own site-repo checkout (`wixy_server/checkout.py`) uses an
SSH deploy key (`WIXY_SITE_REPO` as an SSH URL, `run_git` disabling credential
helpers because "HTTPS+token isn't an option" for THAT use case — see
checkout.py's own docstring). The worker can't reuse that key even if it
wanted to: opening a PR needs the GitHub REST API (`POST /repos/{repo}/pulls`),
which an SSH deploy key has no bearing on at all — only a PAT (or GitHub App
token) authenticates REST calls. Given a PAT is required anyway for the
PR-open step, it's simpler and more consistent to have the SAME credential
also drive the git clone/push (HTTPS), rather than provisioning a second SSH
key into the worker container purely for git transport. See decisions/00061
for the credential's own design (scope, naming, why not `WIXY_ENGINE_PAT`).

## Splitting URL validation from git mechanics

`owner_repo_slug`/`github_https_clone_url` (workspace.py) parse a `github.com`
URL (SSH or HTTPS form, with or without `.git`) down to a bare HTTPS clone URL
and an `owner/repo` slug — using plain string prefix-stripping, not a regex
(easier to verify by eye, which matters for code a security checklist
explicitly covers). `provision_workspace` itself takes an ALREADY-RESOLVED
`clone_url`, not a raw `repo_url` — the github-specific validation happens in
the caller (`wixy_server/worker/app.py`'s `_ensure_workspace`), not inside the
git-mechanics function. This was a deliberate split, not the first draft:
folding the conversion into `provision_workspace` made it impossible to test
the actual clone/branch/push mechanics against a local bare repo (this repo's
own established real-git testing convention, `test_publisher.py`'s
`bare_origin` fixture) — `owner_repo_slug` would reject any non-github.com URL
before git ever ran. Separating them means `provision_workspace`/`push_branch`
are tested with a REAL local git remote (`test_worker_workspace.py`), while
`owner_repo_slug`/`github_https_clone_url` are tested as pure string functions
— each with the right tool for what it actually does.

## One branch per conversation, commit-detection via head-sha diff

`WorkerConversation.branch_name` (`wixy-ai/<conv_id>`) is fixed at conversation
creation (`WorkerState.new_conversation`) and reused across every turn — the
workspace clone persists in `scratch_root/<conv_id>` for the conversation's
whole lifetime, not re-provisioned per turn. Before/after each agent turn,
`head_sha(dest)` is compared; a push + PR-open only happens if it changed. This
matters because not every turn edits anything (a turn that just answers a
question must never push an empty branch or open an empty PR) — spec §2's
"ships a PR" is describing what happens when there's something to ship, not an
unconditional per-turn action.

The PR itself opens once (`WorkerConversation.pr_url` tracks this); every
LATER turn that produces new commits just pushes again — GitHub's own
auto-update-on-push behavior handles keeping the PR current, no separate
"update PR" API call needed.

## Cleanup: idle-sweep, not merge/close-aware

"Scratch clones cleaned" (Fable checklist) is satisfied by a plain time-based
idle sweep (`sweep_idle_workspaces`, `wixy_server/worker/app.py`'s
`_run_scratch_sweep` background loop, hourly + once at startup), not a
GitHub-webhook-driven "delete once the PR merges" mechanism — building the
latter would mean standing up a webhook receiver, which nothing in the spec
asks for and which is disproportionate to what a personal-scale, low-volume AI
chat panel actually needs. The pushed branch + PR on GitHub is the durable
artifact (spec's own "ships a PR via her bot deploy key/PAT" — the PR IS the
record); the local clone is disposable working state, exactly the same
posture `wixy_server/worker/state.py` already takes for in-memory conversation
state surviving a worker restart (it doesn't, and that's an accepted
tradeoff — see that module's own docstring).

Idleness is tracked via an explicit marker file (`touch_activity`,
`.wixy-last-active`, bumped after every completed turn) rather than the
workspace DIRECTORY's own mtime — a directory's mtime only updates when an
entry is added/removed/renamed DIRECTLY inside it, which many ordinary git/
file operations don't trigger (editing an existing file's contents doesn't
touch its parent directory's mtime, and most of a turn's writes/commits touch
files nested well below the top level). Relying on directory mtime would have
made an active-but-quiet conversation (the owner reading a reply, not yet
typing the next message) look artificially idle.

## Two robustness bugs caught before they could matter

1. **`cleanup_workspace` silently left partial deletions.** The first draft
   used `shutil.rmtree(dest, ignore_errors=True)` — on Windows, git marks some
   of its own object/pack files read-only, which blocks `os.remove` outright
   (unlike Linux, where delete permission lives on the directory, not the
   file). `ignore_errors=True` swallowed that failure completely, leaving
   `dest` still on disk with no error raised anywhere — exactly the kind of
   silent failure a disk-hygiene guarantee must not have, found by the test
   suite actually asserting the directory was gone afterward rather than just
   that the call didn't raise. Fixed with `shutil.rmtree(dest, onexc=<clear
   read-only bit and retry>)` — Python 3.12+'s replacement for the deprecated
   `onerror` hook.

2. **The scratch-sweep background task shared its task group with every live
   conversation.** `_run_scratch_sweep` runs in `lifespan`'s own
   `background_tasks` task group — the SAME group every `_run_and_track` call
   runs in. An uncaught exception anywhere in either would propagate through
   anyio's fail-one-cancel-all `TaskGroup` semantics and take the WHOLE worker
   process down, not just fail one sweep pass or one conversation's turn. This
   is a materially bigger blast radius than the equivalent gap already
   accepted elsewhere in this codebase (`wixy_server/checkout.py`'s `run_git`
   doesn't catch `subprocess.TimeoutExpired` from a hung git call, and neither
   does `wixy_server/publisher.py` — but `publisher.py` runs isolated per HTTP
   request, so an uncaught timeout there just fails that one request). Fixed
   with two layers: `_run_scratch_sweep`'s loop body catches+logs any
   exception per pass (never lets one bad sweep kill the loop), and
   `_run_and_track` now wraps its ENTIRE body (not just the `run_turn` call,
   as the prior slice's narrower catch did) in an outer guard that records a
   generic `agent_run_failed` outcome for anything neither of the more
   specific `WorkspaceError`/`GitHubApiError` handlers already caught, rather
   than letting it escape.

## What this slice does NOT handle

- **Concurrent turns on the same conversation** (e.g. a second `send` arriving
  before the first turn's background task finishes) aren't serialized —
  the same pre-existing gap `run_turn`'s own message/session-id mutation
  already had before this slice, not something newly introduced. Flagging it
  here rather than silently building unrequested locking machinery around it;
  revisit if it ever actually bites (the chat UI's own send-while-pending
  behavior is the practical guard today).
- **Engine-fork editing** (spec/04 §4's "a noted later enhancement") — nothing
  here supports targeting any repo other than the site repo.
