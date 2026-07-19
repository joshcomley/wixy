"""Drives one agent turn via the Agent SDK (spec/independence/05 §2) — the
translation layer between `claude_agent_sdk`'s own message stream and this
worker's transcript format (`WorkerMessage`, matching the chat panel's existing
message model, `wixy_server.cmdchat.ChatMessage`'s own shape: index/role/kind/
text/timestamp/toolName/truncated).
"""

from __future__ import annotations

from datetime import UTC, datetime

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from wixy_server.worker.agent_client import AgentSDKClientFactory, real_agent_sdk_client
from wixy_server.worker.state import WorkerConversation, WorkerMessage

# spec/independence/05 §2's "Model default claude-sonnet-5".
DEFAULT_MODEL = "claude-sonnet-5"
# spec §2: "Per-conversation turn cap as a runaway brake."
DEFAULT_MAX_TURNS = 30
# spec §3: "tools: read/write/git/run-tests in its clone — no fleet skills, no
# web browsing v1." Bash covers git + running tests; nothing here reaches the
# network or any fleet-specific tool.
DEFAULT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def build_options(
    *, cwd: str, resume: str | None, max_budget_usd: float | None
) -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        cwd=cwd,
        model=DEFAULT_MODEL,
        allowed_tools=DEFAULT_ALLOWED_TOOLS,
        # Headless — there is no human to answer an interactive permission
        # prompt, so `allowed_tools` above (not a prompt) is the real gate on
        # what this agent can touch; matches the fleet's own `chat-spawn`
        # skill's default posture for headless spawned agents.
        permission_mode="bypassPermissions",
        max_turns=DEFAULT_MAX_TURNS,
        max_budget_usd=max_budget_usd,
        resume=resume,
    )


def _entry_from_block(conv: WorkerConversation, block: object) -> WorkerMessage | None:
    if isinstance(block, TextBlock):
        return WorkerMessage(
            index=conv.next_index(),
            role="assistant",
            kind="text",
            text=block.text,
            timestamp=_now_iso(),
        )
    if isinstance(block, ThinkingBlock):
        return WorkerMessage(
            index=conv.next_index(),
            role="assistant",
            kind="thinking",
            text=block.thinking,
            timestamp=_now_iso(),
        )
    if isinstance(block, ToolUseBlock):
        return WorkerMessage(
            index=conv.next_index(),
            role="assistant",
            kind="tool_use",
            text=None,
            timestamp=_now_iso(),
            tool_name=block.name,
        )
    if isinstance(block, ToolResultBlock):
        content = block.content
        return WorkerMessage(
            index=conv.next_index(),
            role="assistant",
            kind="tool_result",
            text=content if isinstance(content, str) else None,
            timestamp=_now_iso(),
        )
    # ServerToolUseBlock / ServerToolResultBlock: server-executed tools (a
    # future web-search grant, say) — spec §3 says v1 grants none, so these
    # never actually appear; skip defensively rather than crash if one ever
    # does show up in a future SDK version's response.
    return None


async def run_turn(
    conv: WorkerConversation,
    prompt: str,
    *,
    cwd: str,
    max_budget_usd: float | None = None,
    client_factory: AgentSDKClientFactory | None = None,
) -> None:
    """Runs one prompt through the Agent SDK, appending every user-visible
    message to `conv.messages` as it arrives and accumulating
    `conv.total_cost_usd` from the terminal `ResultMessage`. Never raises for
    an in-conversation agent error (recorded as a `kind="error"` transcript
    entry instead — spec/06's own "structured errors surfaced to the UI,
    never a silent hang" extended to this backend) — only a genuine SDK
    connection/transport failure propagates, which the caller
    (`wixy_server.worker.app`) turns into the conversation's own
    `failure_reason`/`failure_message`.

    `client_factory` defaults to the real SDK (`real_agent_sdk_client`) —
    overridable so tests inject `fake_agent_sdk.py`'s scripted double instead
    of making real, billed API calls.
    """
    factory = client_factory if client_factory is not None else real_agent_sdk_client
    options = build_options(cwd=cwd, resume=conv.sdk_session_id, max_budget_usd=max_budget_usd)
    client = factory(options)
    async with client:
        await client.query(prompt)
        async for message in client.receive_response():
            if isinstance(message, SystemMessage):
                if message.subtype == "init":
                    session_id = message.data.get("session_id")
                    if isinstance(session_id, str):
                        conv.sdk_session_id = session_id
                continue
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    entry = _entry_from_block(conv, block)
                    if entry is not None:
                        conv.append(entry)
                continue
            if isinstance(message, UserMessage):
                # Tool-result turns the SDK feeds back to itself — surfaced
                # too (the existing "tool_result" kind), not just
                # assistant-authored content, so the transcript shows what a
                # tool actually returned.
                content = message.content
                if isinstance(content, list):
                    for block in content:
                        entry = _entry_from_block(conv, block)
                        if entry is not None:
                            conv.append(entry)
                continue
            if isinstance(message, ResultMessage):
                if message.total_cost_usd is not None:
                    conv.total_cost_usd += message.total_cost_usd
                if message.is_error:
                    conv.append(
                        WorkerMessage(
                            index=conv.next_index(),
                            role="assistant",
                            kind="error",
                            text=message.result or f"agent run failed ({message.subtype})",
                            timestamp=_now_iso(),
                        )
                    )
                continue
            # StreamEvent (only ever yielded with include_partial_messages=True,
            # which this worker never sets) / RateLimitEvent: neither is
            # user-visible transcript content — the settled AssistantMessage/
            # ResultMessage above already carries the final text.
