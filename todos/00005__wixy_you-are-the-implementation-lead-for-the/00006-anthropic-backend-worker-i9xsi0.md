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

**Slice 1 — DONE, tested, all checks green**: `wixy_server/ai/anthropic_backend.py`
(`AnthropicAIBackend`, `supports_handover_chains=False`) + `wixy_server/worker/` (new
subpackage: `agent_client.py` DI protocol around `ClaudeSDKClient`, `state.py`,
`runner.py` — the SDK-message-to-transcript translation layer, `app.py` — the internal
HTTP API with budget-refusal (402) + idempotent sends, `settings.py`, `__main__.py`).
Two REAL bugs found by tests interfering with each other across the same file (root-
caused properly, not dismissed as a flake) — decisions/00059: a module-level `APIRouter`
singleton causing stale-closure cross-test pollution, and `send_message` returning 200
instead of the 202 the client contract requires (would have broken every real send).
40 new tests (`test_anthropic_backend.py` 18, `test_worker_runner.py` 10,
`test_worker_app.py` 12). `pyproject.toml` gained `claude-agent-sdk` in the `server`
extra.

**Not yet built**: real git workspace cloning/branching/PR-shipping (currently uses a
bare per-conversation scratch dir with no repo content at all — the agent has nowhere
real to work yet), the bot PAT/credential design for that (needs its own decisions/
entry — NOT the same token as `WIXY_ENGINE_PAT` from M4, which only dispatches/reads;
this one needs `contents:write`+`pull_requests:write` on both her site repo and engine
fork), `wixy_server/app.py`'s own backend-selection wiring (`WIXY_AI_BACKEND=cmd|
anthropic`), docker-compose.yml's `worker` service, transcript JSONL persistence to
disk (current state is in-memory only, lost on worker restart — acceptable for now per
the module's own docstring, but the spec calls for JSONL specifically), the Settings ->
AI card (frontend), the `@live_anthropic` smoke test, and the full Fable review.

## Relevant files + commits
Branch: `indep/m6-anthropic-backend-worker` (off main, after M4/M5 merged). Commits so
far: AnthropicAIBackend client + fake_worker.py double; worker skeleton (github.py-style
agent_client.py, state.py, runner.py, app.py, settings.py, __main__.py) +
fake_agent_sdk.py scripted-episode harness + the two bugfixes above. decisions/00059.

## How to continue + acceptance
**SECURITY-GATED**: NOT ready for Fable review yet — real key-handling (workspace
cloning with a real bot credential) and budget enforcement's cost-tracking are only
partially real (cost accumulates correctly from `ResultMessage.total_cost_usd`, but
nothing exercises it against a real repo yet). Continue building: workspace/git model
next (biggest remaining piece), then compose/settings wiring, then transcript
persistence + frontend AI card, THEN checklist 05 §4 (key never logged/committed;
worker egress restricted to Anthropic+GitHub as far as compose allows; scratch clones
cleaned; budget enforcement tested) -> peer author -> ScheduleWakeup -> merge only on
explicit approval.

## Links
spec/independence/05 (full, esp. §2-4); spec/independence/09 row 6.
