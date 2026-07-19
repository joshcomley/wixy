"""Unit tests for `wixy_server.worker.runner.run_turn` — the translation layer
between `claude_agent_sdk`'s message stream and this worker's own transcript
format. Uses `fake_agent_sdk.py`'s scripted episodes (spec/independence/05 §4)
rather than the real SDK."""

from __future__ import annotations

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from wixy_server.tests.fake_agent_sdk import ScriptedEpisode, create_fake_agent_sdk_client_factory
from wixy_server.worker.runner import run_turn
from wixy_server.worker.state import WorkerConversation


def _result(
    *, total_cost_usd: float | None = 0.01, is_error: bool = False, result: str | None = "done"
) -> ResultMessage:
    return ResultMessage(
        subtype="success" if not is_error else "error",
        duration_ms=100,
        duration_api_ms=90,
        is_error=is_error,
        num_turns=1,
        session_id="sdk-session-1",
        total_cost_usd=total_cost_usd,
        result=result,
    )


@pytest.mark.asyncio
async def test_text_block_appended_as_assistant_text() -> None:
    conv = WorkerConversation(conv_id="c1", preamble="edit the site", branch_name="wixy-ai/c1")
    episodes = [
        ScriptedEpisode(
            messages=[
                AssistantMessage(
                    content=[TextBlock(text="Sure, I'll do that.")], model="claude-sonnet-5"
                ),
                _result(),
            ]
        )
    ]
    _clients, factory = create_fake_agent_sdk_client_factory(episodes)
    await run_turn(conv, "please help", cwd="/scratch/c1", client_factory=factory)

    assert len(conv.messages) == 1
    assert conv.messages[0].role == "assistant"
    assert conv.messages[0].kind == "text"
    assert conv.messages[0].text == "Sure, I'll do that."


@pytest.mark.asyncio
async def test_tool_use_and_tool_result_both_appended() -> None:
    conv = WorkerConversation(conv_id="c1", preamble="edit the site", branch_name="wixy-ai/c1")
    episodes = [
        ScriptedEpisode(
            messages=[
                AssistantMessage(
                    content=[ToolUseBlock(id="t1", name="Edit", input={"file": "index.html"})],
                    model="claude-sonnet-5",
                ),
                UserMessage(
                    content=[ToolResultBlock(tool_use_id="t1", content="edited ok", is_error=False)]
                ),
                AssistantMessage(content=[TextBlock(text="Done.")], model="claude-sonnet-5"),
                _result(),
            ]
        )
    ]
    _clients, factory = create_fake_agent_sdk_client_factory(episodes)
    await run_turn(conv, "please help", cwd="/scratch/c1", client_factory=factory)

    kinds = [m.kind for m in conv.messages]
    assert kinds == ["tool_use", "tool_result", "text"]
    assert conv.messages[0].tool_name == "Edit"
    assert conv.messages[1].text == "edited ok"
    assert conv.messages[2].text == "Done."


@pytest.mark.asyncio
async def test_thinking_block_appended_with_thinking_kind() -> None:
    conv = WorkerConversation(conv_id="c1", preamble="edit the site", branch_name="wixy-ai/c1")
    episodes = [
        ScriptedEpisode(
            messages=[
                AssistantMessage(
                    content=[ThinkingBlock(thinking="considering approach...", signature="sig")],
                    model="claude-sonnet-5",
                ),
                _result(),
            ]
        )
    ]
    _clients, factory = create_fake_agent_sdk_client_factory(episodes)
    await run_turn(conv, "please help", cwd="/scratch/c1", client_factory=factory)

    assert conv.messages[0].kind == "thinking"
    assert conv.messages[0].text == "considering approach..."


@pytest.mark.asyncio
async def test_cost_accumulates_from_result_message() -> None:
    conv = WorkerConversation(conv_id="c1", preamble="edit the site", branch_name="wixy-ai/c1")
    episodes = [ScriptedEpisode(messages=[_result(total_cost_usd=0.05)])]
    _clients, factory = create_fake_agent_sdk_client_factory(episodes)
    await run_turn(conv, "please help", cwd="/scratch/c1", client_factory=factory)

    assert conv.total_cost_usd == 0.05


@pytest.mark.asyncio
async def test_second_turn_adds_to_existing_cost() -> None:
    conv = WorkerConversation(conv_id="c1", preamble="edit the site", branch_name="wixy-ai/c1")
    episodes = [
        ScriptedEpisode(messages=[_result(total_cost_usd=0.05)]),
        ScriptedEpisode(messages=[_result(total_cost_usd=0.03)]),
    ]
    _clients, factory = create_fake_agent_sdk_client_factory(episodes)
    await run_turn(conv, "turn one", cwd="/scratch/c1", client_factory=factory)
    await run_turn(conv, "turn two", cwd="/scratch/c1", client_factory=factory)

    assert conv.total_cost_usd == pytest.approx(0.08)


@pytest.mark.asyncio
async def test_result_error_appends_error_entry() -> None:
    conv = WorkerConversation(conv_id="c1", preamble="edit the site", branch_name="wixy-ai/c1")
    episodes = [ScriptedEpisode(messages=[_result(is_error=True, result="ran out of turns")])]
    _clients, factory = create_fake_agent_sdk_client_factory(episodes)
    await run_turn(conv, "please help", cwd="/scratch/c1", client_factory=factory)

    assert conv.messages[-1].kind == "error"
    assert conv.messages[-1].text == "ran out of turns"


@pytest.mark.asyncio
async def test_system_init_message_captures_session_id() -> None:
    conv = WorkerConversation(conv_id="c1", preamble="edit the site", branch_name="wixy-ai/c1")
    episodes = [
        ScriptedEpisode(
            messages=[
                SystemMessage(subtype="init", data={"session_id": "sdk-abc-123"}),
                _result(),
            ]
        )
    ]
    _clients, factory = create_fake_agent_sdk_client_factory(episodes)
    await run_turn(conv, "please help", cwd="/scratch/c1", client_factory=factory)

    assert conv.sdk_session_id == "sdk-abc-123"


@pytest.mark.asyncio
async def test_resume_passes_captured_session_id_on_next_turn() -> None:
    conv = WorkerConversation(conv_id="c1", preamble="edit the site", branch_name="wixy-ai/c1")
    episodes = [
        ScriptedEpisode(
            messages=[SystemMessage(subtype="init", data={"session_id": "sdk-abc-123"}), _result()]
        ),
        ScriptedEpisode(messages=[_result()]),
    ]
    clients, factory = create_fake_agent_sdk_client_factory(episodes)
    await run_turn(conv, "turn one", cwd="/scratch/c1", client_factory=factory)
    await run_turn(conv, "turn two", cwd="/scratch/c1", client_factory=factory)

    assert clients[0].options.resume is None
    assert clients[1].options.resume == "sdk-abc-123"


@pytest.mark.asyncio
async def test_options_pass_cwd_and_budget_through() -> None:
    conv = WorkerConversation(conv_id="c1", preamble="edit the site", branch_name="wixy-ai/c1")
    episodes = [ScriptedEpisode(messages=[_result()])]
    clients, factory = create_fake_agent_sdk_client_factory(episodes)
    await run_turn(
        conv, "please help", cwd="/scratch/c1", max_budget_usd=5.0, client_factory=factory
    )

    assert clients[0].options.cwd == "/scratch/c1"
    assert clients[0].options.max_budget_usd == 5.0


@pytest.mark.asyncio
async def test_connection_failure_propagates_not_swallowed() -> None:
    """A genuine SDK/transport failure (as opposed to an in-episode
    ResultMessage(is_error=True)) must propagate — the caller
    (wixy_server.worker.app) is what turns this into the conversation's own
    failure_reason/failure_message, not run_turn itself."""
    conv = WorkerConversation(conv_id="c1", preamble="edit the site", branch_name="wixy-ai/c1")
    episodes = [ScriptedEpisode(raises=ConnectionError("worker lost the CLI subprocess"))]
    _clients, factory = create_fake_agent_sdk_client_factory(episodes)
    with pytest.raises(ConnectionError, match="lost the CLI subprocess"):
        await run_turn(conv, "please help", cwd="/scratch/c1", client_factory=factory)
