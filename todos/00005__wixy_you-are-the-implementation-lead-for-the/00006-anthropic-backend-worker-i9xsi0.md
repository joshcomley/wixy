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
Depends on M5 (interface must exist) and M4 (site CLAUDE.md neutralized). Node LTS already
in the image from M3. This is the largest single milestone — likely needs its own internal
slicing (interface impl, worker container/process model, budget enforcement, transcript
compat, tests) similar to how the base CMS build sliced M6-M10 internally.

## Relevant files + commits
(fill in as PR lands)

## How to continue + acceptance
**SECURITY-GATED**: PR -> peer author with checklist 05 §4 (key never logged/committed;
worker egress restricted to Anthropic+GitHub as far as compose allows; scratch clones
cleaned; budget enforcement tested) -> ScheduleWakeup -> merge only on explicit approval.

## Links
spec/independence/05 (full, esp. §2-4); spec/independence/09 row 6.
