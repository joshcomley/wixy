# 00002 [1oie6p] claude-agent-sdk 0.2.137 CI unblocker

## What

Fixed a `mypy --strict` break on `wixy_server/worker/agent_client.py:51` caused by
`claude-agent-sdk` 0.2.137 (released between PR #196 and PR #197's CI runs) adding
`ConversationResetMessage` to `ClaudeSDKClient.receive_response()`'s return-type union,
making the real client structurally narrower than this repo's `AgentSDKClient` Protocol.

## Why

Flagged mid-session by the spec-author session (7c82288a) as the first blocker to clear
before opening any SEO implementation PRs — main was red and a green main is required
before merging new work (fleet test discipline).

## Outcome

- Widened `AgentMessage` to include `ConversationResetMessage`; added an explicit,
  documented no-op branch in `wixy_server/worker/runner.py:run_turn` (safe because
  `run_turn` opens one fresh `ClaudeSDKClient` per turn — no multi-turn cost total for a
  mid-connection reset to invalidate).
- Added a regression test (`test_conversation_reset_message_ignored_not_crashed`).
- Verified against the real installed 0.2.137: mypy --strict (175 files), ruff, full suite
  (1210 passed).
- Assessed against independence milestone 6's actual Fable review checklist
  (spec/independence/05-pluggable-ai.md §4: key handling/logging/egress) and confirmed this
  type-only compat fix touches none of it — shipped on green CI per normal train discipline,
  not through the milestone security gate. The spec-author session reviewed and explicitly
  confirmed this classification after the fact.

## Where shipped

PR #198, merged as `d3cb9db342a99ff0230881fb2acfc9de06c8f1ea` on `joshcomley/wixy`.

## Links

Failed run that surfaced it: https://github.com/joshcomley/wixy/actions/runs/31641729615
