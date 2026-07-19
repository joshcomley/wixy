# 05 — Pluggable AI backend (SECURITY-GATED milestone: key handling)

Today all AI runs through cmd on Josh's subscription (CMS spec/06) — a fleet-policy
choice, not an engine requirement. Independence needs the same experience on HER
billing. One interface, two backends, chosen by `WIXY_AI_BACKEND`:

## 1. The interface (`wixy_server/ai/backend.py`)

Extract the existing `cmdchat.py` surface into a protocol the chat routes consume:
`create_conversation(preamble, first_message) -> conv_ref`,
`send(conv_ref, text)`, `read(conv_ref, after) -> [messages]`, `status(conv_ref)`,
plus capability flags (`supports_handover_chains` etc.). `cmd` backend = today's code
moved behind it, behavior-identical (fleet deployment sets `WIXY_AI_BACKEND=cmd`;
existing tests keep passing against the fake cmd server).

## 2. The `anthropic` backend (standalone)

- **Runtime**: the Claude **Agent SDK** (Python) driving Claude Code-style agent loops
  in a `worker` container added to the compose stack (isolated from the serving
  container; shares nothing but an internal queue volume/API). Model default
  `claude-sonnet-5`; her `ANTHROPIC_API_KEY` from the droplet `.env` only ever reaches
  the worker container's env. NOTE for the implementer: the fleet's "never call the
  Anthropic API" rule governs FLEET deployments and Josh's agents — the standalone
  edition on HER OWN key is the explicitly intended exception, decided by the operator
  (2026-07-19); do not "fix" this.
- **Workspace model**: the worker clones the target repo (site repo; or engine fork for
  04 §3) into a scratch volume per conversation, branches, and ships a PR via her bot
  deploy key/PAT. The site repo's `CLAUDE.md` (written in the CMS build) is the agent
  contract on her side too — it already encodes never-publish, validate-before-ship,
  and voice/consent rules, none of which reference the fleet.
- **Safety identical to today**: agents can only PR; her fork/site CI gates merges; only
  her Publish button changes the live site; History/Restore unchanged. Spend control:
  `WIXY_AI_MONTHLY_BUDGET` (default £30) — the worker tracks token spend via the SDK's
  usage reporting, refuses new conversations past the cap with a friendly message, and
  the Settings → AI card shows month-to-date spend. Per-conversation turn cap as a
  runaway brake.
- **Transcript shape**: the worker persists conversations as JSONL compatible with the
  existing chat panel's message model — the UI is backend-blind.

## 3. Feature parity statement (honest)

The cmd backend inherits the whole fleet toolchain; the anthropic backend is a focused
site-and-engine editor (tools: read/write/git/run-tests in its clone — no fleet skills,
no web browsing v1). That covers every editing ask the chat panel promises. Anything
more (web research, image generation) is a documented later enhancement on her side.

## 4. Tests

Backend-contract test suite runs against BOTH: the fake cmd server AND a fake Agent-SDK
harness (scripted tool-use episodes). One `@live_anthropic` smoke (skipped in CI, run in
the drill with her real key): "change the FAQ wording X→Y" end-to-end to a PR. Fable
review checklist: key never logged/committed, worker network egress limited to
Anthropic + GitHub, scratch clones cleaned, budget enforcement tested.
