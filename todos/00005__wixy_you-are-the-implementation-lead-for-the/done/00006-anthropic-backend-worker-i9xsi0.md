# 00006 [i9xsi0] M6 — anthropic backend + worker + budget + backend-contract suite

## What
- `anthropic` backend implementing M5's protocol via the Claude Agent SDK (Python) in a
  new `worker` compose service (isolated container, shares only an internal queue
  volume/API with the serving container). Model default claude-sonnet-5. Her
  ANTHROPIC_API_KEY reaches ONLY the worker container's env — this is the operator-decided
  exception to the fleet's no-direct-Anthropic-API rule, scoped to standalone edition only.
- Worker clones target repo (site repo or engine fork) into scratch volume per conversation,
  branches, ships PR via her bot deploy key/PAT. Depends on M4's site-CLAUDE.md
  neutralization landing first (the agent contract wording).
- Spend control: WIXY_AI_MONTHLY_BUDGET_USD (default 40), worker tracks spend, refuses new
  conversations past cap with friendly message, Settings -> AI card shows MTD spend.
  Per-conversation turn cap as runaway brake.
- Transcript shape: worker persists JSONL compatible with existing chat panel message model
  (UI stays backend-blind).
- Backend-contract test suite runs against BOTH fake cmd server AND a fake Agent-SDK harness
  (scripted tool-use episodes). One @live_anthropic smoke (skipped in CI, run in drill M9
  with real key).

## Why
This is what gives her the same AI-assisted editing experience on her own billing, with
safety identical to today (agents can only PR; her CI gates merges; only her Publish button
changes the live site).

## Context / current state
Depends on M5 (interface must exist, merged) and M4 (site CLAUDE.md neutralized, merged).
Node LTS already in the image from M3. This is the largest single milestone — being built
in internal slices (not necessarily separate PRs, revisit if it gets unwieldy), similar to
how the base CMS build sliced M6-M10.

Ground-truth-verified the REAL `claude-agent-sdk` Python package (installed it, inspected
`dataclasses.fields()` directly — not just docs, since a docs-summary claim about
`ResultMessage`'s fields turned out to be wrong, see decisions/00059's sibling note in
`wixy_server/worker/agent_client.py`'s own docstring) before designing the worker.

**Slice 1 — DONE**: `wixy_server/ai/anthropic_backend.py` (`AnthropicAIBackend`,
`supports_handover_chains=False`) + `wixy_server/worker/` skeleton (`agent_client.py`
DI protocol, `state.py`, `runner.py`, `app.py` internal HTTP API, `settings.py`,
`__main__.py`). Two real bugs found+fixed via tests interfering with each other —
decisions/00059.

**Slice 2 — DONE**: real git workspace model. `wixy_server/worker/workspace.py`
(clone/branch/push against the site repo, one-off `-c http.extraHeader=` per
credentialed git call so the bot PAT never touches `.git/config` at rest — the agent
has unrestricted Bash access inside the clone all turn, decisions/00060). Bot PAT design
(`WIXY_AI_BOT_PAT`, distinct from M4's `WIXY_ENGINE_PAT` — decisions/00061).
`WIXY_AI_BACKEND` (cmd|anthropic) wiring in `wixy_server/settings.py`+`app.py`
(independent of `WIXY_EDITION`, per spec's own literal wording). Two robustness bugs
fixed along the way (Windows read-only-file cleanup failure, scratch-sweep sharing a
task group with every live conversation with no exception guard — see decisions/00060).

**Slice 3 — DONE**: `docker-compose.yml`'s `worker` service (own scratch volume, no
site-repo deploy key — authenticates as the bot PAT instead), `setup.sh` prompts
(Anthropic key, AI budget, bot-PAT creation walkthrough), `verify.sh`/`update.sh`
updated for the second service.

**Slice 4 — DONE**: transcript JSONL persistence. `wixy_server/worker/transcript.py`,
written once per turn from `_run_and_track`'s own `finally`. A SEPARATE volume/root
from the git scratch clones on purpose — the agent's own `git add -A` habit could
otherwise commit the transcript into her site repo (decisions/00062).

**Slice 5 — DONE**: Settings -> AI card. `wixy_server/routes_ai.py` (`GET
/api/admin/ai/budget`, anthropic-backend-only, proxies the worker's own new `GET
/budget`) + `AnthropicAIBackend.get_budget_status` (lives on the concrete class, not
the shared `AIBackend` protocol — decisions/00063) + `admin-ui` Settings -> AI tab
(mirrors the Engine card's loading/not-available/error states, simpler flat 60s poll,
no in-flight-run tracking needed). Frontend bundle rebuilt+committed.

**Slice 6 — DONE**: backend-contract route coverage (`test_routes_chat_backend_contract.py`
— `routes_chat.py`'s existing suite only ever exercised the `cmd` backend; surfaced a
real `fake_worker.py` bug, never filtered `includeThinking` — decisions/00064) + a
genuine multi-conversation budget-accumulation test (two conversations under a shared
cap both succeed, combined spend confirmed via `GET /budget`, a third is refused only
once the total actually crosses it).

**M6 wrap-up — DONE**: explicit self-verification against spec/independence/05 §4's
Fable checklist, written out with evidence before requesting review (decisions/00065).
PR #76 opened (`indep/m6-anthropic-backend-worker` -> `main`), CI green.

**Fable gate review round 1**: Fable replied CHANGES REQUIRED with two findings
(R1: `WIXY_AI_BOT_PAT` leaking to the Agent SDK's spawned CLI child via process-
environment inheritance; R2: "agents can only PR" needed to be a GitHub-ENFORCED
branch-protection guarantee, not a convention) — both fixed and verified locally
(ruff/mypy/pytest all clean), both are the "best-reasoned milestone yet" per
Fable's own words, no scope creep into the deeper privilege-separation redesign
Fable explicitly accepted deferring. Full detail: decisions/00065's "Correction
(Fable review, PR #76 R1+R2)". R1+R2 pushed as commit `e9eb5f2`, CI green (all 4
jobs), delta-only re-review requested.

## Relevant files + commits
Branch: `indep/m6-anthropic-backend-worker` (off main, after M4/M5 merged), PR #76.
Six slice commits: `8adb598` (slice 1a), `473db3b` (slice 2, workspace model + backend
wiring), `9cdd885` (slice 3, compose), `08ddc40` (slice 4, transcript), `53770b0`
(slice 5, AI budget card + live smoke test), `d3e261d` (slice 6, backend-contract
coverage + budget test), `358147a` (wrap-up: decisions/00065), `90ecc50` (ruff format
fix), `e9eb5f2` (Fable gate review R1+R2). decisions/00059-00065.

## Fable review verdict
**APPROVED — merge**, session `c42ea1cb-a9d6-413d-bdcb-fc77fc49abba`, 2026-07-19,
re-reviewing commit `e9eb5f2`. Verified the deltas directly: the `os.environ.pop`
happens at the exact right moment with the threat model documented where the next
maintainer will read it; `ANTHROPIC_API_KEY` correctly left inheritable; four tests
incl. the second-load case; `workspace.py` documents the residual `/proc` channel
honestly and records the privilege-separation deferral as a reviewed decision;
`setup.sh` walks both repos through branch protection with the pause-and-confirm
pattern before any secret is written; forward obligations landed in the M8/M9
sidecars. Explicitly RATIFIED the direct-push-assertion placement call (drill, not
`verify.sh`) as "exactly the kind of spec-interpretation judgment the kickoff hoped
for." Fable mirrored the branch-protection + PAT-scrub requirement into
spec/independence/05 §2 herself, commit `22be2d1` (landed on `main` independently,
picked up automatically by the merge).

**DONE — merged PR #76** (2026-07-19, merge commit `452188e`). Remote branch
deleted via `--delete-branch`; local worktree moved on to `indep/m7-backups-monitoring`
off the fresh `origin/main`.

## Links
spec/independence/05 (full, esp. §2-4); spec/independence/09 row 6.
