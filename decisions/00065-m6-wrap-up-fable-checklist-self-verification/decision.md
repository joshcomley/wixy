# M6 wrap-up: anthropic backend + worker complete, self-verified against the 05§4 Fable checklist

## What M6 delivers

spec/independence/05's `anthropic` backend, end to end: `AnthropicAIBackend`
(the client half, M6 slice 1) talking to a new `worker` compose service (the
server half) that clones her site repo per conversation, runs the real Claude
Agent SDK against it, and — once a turn produces real commits — pushes and
opens a real PR via a dedicated bot credential. Budget-capped
(`WIXY_AI_MONTHLY_BUDGET_USD`), transcript-persisted (JSONL, a separate
volume from the git clones), and surfaced in Settings → AI (month-to-date
spend). `WIXY_AI_BACKEND` selects it independent of `WIXY_EDITION`.

Six commits on `indep/m6-anthropic-backend-worker` (after the inherited
slice-1 commit `8adb598`): workspace model + backend wiring (`473db3b`),
compose/setup infrastructure (`9cdd885`), transcript persistence (`08ddc40`),
Settings AI card + the live smoke test (`53770b0`), backend-contract route
coverage + the multi-conversation budget test (`d3e261d`). ~5,300 lines
across 56 files. decisions/00059-00065 (this entry) cover the design calls.

## Self-verification against spec/independence/05 §4's Fable checklist

Written out explicitly, with the evidence, rather than asserting "done" —
the point of doing this BEFORE requesting review is to make Fable's own pass
faster (a clear starting point per item) and to catch anything a fresh
outside read would flag, before spending a review round on it.

**"Key never logged/committed"** — verified two ways: (1) `ANTHROPIC_API_KEY`
is never modeled in `WorkerSettings` at all (the SDK reads it straight from
`os.environ`, its own documented contract — `wixy_server/worker/settings.py`'s
own docstring). `WIXY_AI_BOT_PAT` (`WorkerSettings.bot_pat`) only ever
appears as (a) an HTTP `Authorization` header value (`GitHubClient._headers()`,
never passed to any `logger.*` call — verified by reading every call site),
or (b) a one-off `-c http.extraHeader=` git argv element
(`wixy_server/worker/workspace.py`, decisions/00060 — never written to any
file, verified for REAL in `test_worker_workspace.py` by reading
`.git/config` off disk after both clone and push and asserting the raw PAT
string is absent, not just asserted against a mock call). Grepped
`wixy_server/worker/` for every `logger.*` call (2 total, both
`logger.exception` with only a `conv_id`/static message, no settings/
secrets) and for any string-interpolation of a whole `settings` object (none
found). (2) `WorkerSettings.bot_pat` is a plain dataclass field with no
`repr=False` — checked this is CONSISTENT with, not weaker than, the
existing precedent: `wixy_server.settings.Settings.engine_pat` (M4's
already-Fable-approved credential) is the identical shape, relying on
verified logging discipline rather than defensive repr-suppression. Adding
`repr=False` to only the NEW field would have been an unjustified asymmetry
against an already-reviewed pattern, not real hardening.

**"Worker egress restricted to Anthropic + GitHub as far as compose allows"**
— best-effort, exactly as spec's own words scope it ("plain compose cannot
express egress allowlists... a proxy/iptables sidecar is a noted hardening
upgrade, not v1"): the `worker` service has no published ports, no
`docker.sock` mount, no site-repo SSH deploy key (it never needed one —
decisions/00060), and reaches only the compose network's implicit default
(shared with `wixy`, for the internal `POST http://worker:8100/...` calls)
plus whatever the real Agent SDK/git/GitHub REST calls dial out to.
Documented explicitly in `docker-compose.yml`'s own comments on the `worker`
block.

**"Scratch clones cleaned"** — an hourly (+once at startup) idle sweep
(`sweep_idle_workspaces`, `_run_scratch_sweep`), tested for real against
actual directories/marker files in `test_worker_workspace.py`'s
`TestSweepIdleWorkspaces` (5 tests: removes-when-idle, keeps-when-active,
falls back to directory mtime when no marker exists, ignores non-directory
entries, handles a missing scratch root). Two robustness bugs found and
fixed while building this specifically (decisions/00060): a Windows
read-only-file deletion failure that `ignore_errors=True` was silently
swallowing, and the sweep loop sharing its task group with every live
conversation with no exception guard (would have crashed the whole worker
on one bad cleanup).

**"Budget enforcement tested"** — the original single-conversation
already-over-cap case (`test_402s_past_the_monthly_budget`) PLUS a genuine
multi-conversation test added this slice
(`test_spend_accumulates_across_conversations_until_a_later_one_402s`): two
$0.30 conversations against a $0.50 cap both succeed (proving accumulation
isn't gated too early), their combined spend is confirmed via `GET /budget`,
and a third conversation is refused only once the combined total actually
crosses the cap.

## What's deliberately out of scope (not gaps, decided calls)

- Engine-fork editing (spec/independence/04 §4 calls it "a noted later
  enhancement") — the worker only ever targets the site repo.
- Concurrent turns on the same conversation aren't serialized — a
  pre-existing gap in how `run_turn`'s own message/session-id mutation
  already worked before this milestone, not newly introduced (decisions/00060).
- Transcript persistence is write-only, no rehydration of `WorkerState` on
  worker restart (decisions/00062) — `state.py`'s own docstring already
  accepted in-flight-state loss on restart before this milestone; this
  slice makes the durable HISTORY survive without also rebuilding the live
  session bookkeeping, which spec's own wording doesn't explicitly demand.

## Correction (Fable review, PR #76 R1+R2)

Fable's actual gate review found one real gap this self-verification's "key never
logged/committed" pass missed, plus one hardening the self-verification didn't think
to ask for at all — both closable, neither requiring the deeper redesign also on the
table. Full review reply banked in the session handover
(`handover/2607200017-wixy-m6-ci-fix-and-fable-review.md`); the operative findings and
fixes:

**R1 — process-environment inheritance.** "Key never logged/committed" (above) checked
disk and log-line channels but missed a third: `runner.build_options` passes no `env=`
to `ClaudeAgentOptions`, and the Agent SDK's spawned CLI child inherits the WHOLE
worker process environment by default (confirmed by reading
`claude_agent_sdk/_internal/transport/subprocess_cli.py` — `ClaudeAgentOptions.env`
only ADDS keys on top of the inherited set, it cannot un-inherit one). So
`WIXY_AI_BOT_PAT`, sitting in `os.environ` after `load_worker_settings` read it, would
have been handed straight to the agent's own Bash tool (`echo $WIXY_AI_BOT_PAT`) — a
misbehaving or prompt-injected turn could have pushed straight to `main`, exactly the
credential the "agents can only PR" trust model depends on. **Fix**:
`load_worker_settings` (`wixy_server/worker/settings.py`) now pops
`WIXY_AI_BOT_PAT` from `os.environ` the instant after capturing it into
`WorkerSettings.bot_pat` — proven by `wixy_server/tests/test_worker_settings.py`
(`os.environ` no longer holds it after the call, a second call sees it already gone,
`ANTHROPIC_API_KEY` — which the SDK IS supposed to inherit, by its own documented
contract — is deliberately left untouched). Stated honestly, not overclaimed:
`wixy_server/worker/workspace.py`'s module docstring now documents the residual
same-uid `/proc/<worker-pid>/environ` channel this does NOT close — full privilege
separation (moving push/PR duties server-side via a read-only-mounted scratch fetch)
would close it, and Fable explicitly ACCEPTED deferring that as disproportionate for
v1 (the blast radius of a leaked site-repo PAT is repo vandalism on branches, not
live-site compromise — publishes are owner-pinned SHAs — or the engine or her key),
banked as a hardening upgrade alongside the egress-sidecar note already above.

**R2 — GitHub-ENFORCED branch protection, not a convention.** Even with R1 fixed, the
"agents can only PR" safety claim still ultimately rested on the bot PAT never leaking
by ANY channel — a claim about secrecy, not a structural guarantee. Requiring branch
protection on `main` (PR + a passing required status check, no bypass actors) on BOTH
her site repo and her engine fork removes main-integrity from the trust equation
entirely: even a PAT in the wrong hands cannot push `main` once this is on. This is a
manual, per-repo GitHub org/admin settings step no deploy script can perform on her
behalf (the bot PAT is deliberately scoped to `contents:write` + `pull_requests:write`
only, decisions/00061 — not repo-admin). Three deliverables, landed at the layer each
actually belongs to right now: (1) `deploy/standalone/setup.sh` gained
`print_branch_protection_step`, pausing for confirmation on both repos before it
writes `.env` — the concrete, shippable-today piece, mirroring the existing
deploy-key/PAT manual-step pattern; `deploy/standalone/README.md` documents the why.
(2) The friendly, illustrated walkthrough version of this same step belongs in the
M8 guide's Track P.2 chapter (GitHub org/repo setup) — forward obligation recorded in
that milestone's own todo sidecar, same precedent as M2's `ca-business` population
procedure. (3) Fable's own ask for **"a verify/drill assertion that main rejects a
direct push"** does NOT belong in `verify.sh`: that script is a droplet/compose
infra-health check with no GitHub-API surface at all today, and per spec/independence/
07 §2's own chapter ordering, Track P's GitHub-settings chapter (2) runs BEFORE the
droplet-setup chapter (6) — so by the time `verify.sh` ever runs, branch protection
should already be configured, but `verify.sh` has no way to know that reliably for a
script that must "stay always green on a correctly-configured install," not fail on a
manual step it can't observe. The drill (chapter 7, spec/independence/08 §1 item 1
"org + repos in place") runs strictly after the GitHub-settings chapter and already
exercises real GitHub credentials against real (drill) repos — the live assertion
belongs there. Forward obligation recorded in the M9 todo sidecar. Fable will mirror
the branch-protection requirement into spec/independence/05 §2 themselves — not edited
here.

## What to watch for

- `wixy_server/worker/app.py`'s `_DEFAULT_BRANCH = "main"` and the
  site-repo-only targeting are hardcoded assumptions tied to the "engine-fork
  editing is later" decision above — if that scope ever expands, this file
  needs a real repo-selection parameter, not just a bigger default.
- The bot PAT's actual GitHub account (her own vs. a dedicated "AI bot"
  account) is a guide-time (M8) operational choice, not enforced by any code
  here (decisions/00061) — the guide must actually walk her through it
  clearly, or PRs will be attributed confusingly.
- `docker-compose.yml`'s `worker` service shares `wixy`'s image tag and
  Watchtower label deliberately (kept in lockstep) — if a future change ever
  gives the worker its own separate image/versioning, `update.sh`'s
  `do_update`/`do_rollback` (both updated this slice to touch both services)
  need to move together with that change.
