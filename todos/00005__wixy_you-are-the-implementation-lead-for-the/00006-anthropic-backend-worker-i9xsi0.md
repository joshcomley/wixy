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

**Not yet built**: the `@live_anthropic` smoke test (spec §4 — skipped in CI, run for
real in the M9 drill with a real key), a pass verifying the backend-contract test suite
genuinely covers both backends' shared contract (spec §4 — separate thorough test files
may already satisfy the spirit of this, needs a judgment-call review pass), the Fable
checklist verification pass itself (05 §4: key never logged/committed — verified in
code+tests already, worth a final explicit checklist pass; egress restricted as far as
compose allows — done, documented as best-effort; scratch clones cleaned — done,
decisions/00060; budget enforcement tested — the single-conversation 402 test exists,
a multi-conversation-hits-cap test would round this out), and the actual PR open +
Fable review round.

## Relevant files + commits
Branch: `indep/m6-anthropic-backend-worker` (off main, after M4/M5 merged). 5 commits
so far (slices 1-5 above, one commit each after slice 1's two): `8adb598` (slice 1a),
`473db3b` (slice 2, workspace model + backend wiring), `9cdd885` (slice 3, compose),
`08ddc40` (slice 4, transcript), plus slice 5's commit (AI budget card — commit hash
not yet recorded here, check `git log`). decisions/00059-00063.

## How to continue + acceptance
Functionally complete — what's left is verification/polish (smoke test, contract-suite
coverage judgment call, an explicit checklist pass, a stronger budget-cap test) before
the PR opens. Once those land: open PR -> green CI -> peer-message
`c42ea1cb-a9d6-413d-bdcb-fc77fc49abba` (Fable) with PR#+the 05§4 checklist -> wait for
explicit "APPROVED -- merge" (never merge without it; delta-only re-review if changes
requested, per M4's precedent) -> merge -> continue the train (M7).

## Links
spec/independence/05 (full, esp. §2-4); spec/independence/09 row 6.
