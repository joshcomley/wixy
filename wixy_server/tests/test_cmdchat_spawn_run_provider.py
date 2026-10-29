"""`CmdChatClient.spawn_run`'s additive `provider`/`tool_profile`/`naked` parameters (Cookout
round 2, spec 09b §G.3): in the request body only when given, so every existing caller's body is
byte-identical."""

from __future__ import annotations

import json

import httpx
import pytest

from wixy_server.cmdchat import CmdChatClient

BASE_KWARGS = {
    "caller": "wixy-test",
    "prompt": "hello",
    "model": "claude-haiku-5-5",
    "effort": "medium",
    "cwd": "D:/x/y",
    "timeout_secs": 900,
    "disallowed_tools": ["Bash"],
}


async def _body(**extra: object) -> dict[str, object]:
    seen: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.content)
        return httpx.Response(201, json={"run": {"run_id": "r1", "status": "queued"}})

    client = CmdChatClient(transport=httpx.MockTransport(handler))
    try:
        await client.spawn_run(**BASE_KWARGS, **extra)  # type: ignore[arg-type]
    finally:
        await client.aclose()
    (content,) = seen
    decoded = json.loads(content)
    assert isinstance(decoded, dict)
    return decoded


@pytest.mark.asyncio
async def test_existing_body_has_none_of_the_new_keys() -> None:
    body = await _body()
    assert not {"provider", "tool_profile", "naked"} & set(body)
    assert body["model"] == "claude-haiku-5-5"
    assert body["bucket"] == "subscription"


@pytest.mark.asyncio
async def test_new_keys_appear_only_when_given() -> None:
    body = await _body(provider="codex", tool_profile="judge", naked=False)
    assert body["provider"] == "codex"
    assert body["tool_profile"] == "judge"
    assert body["naked"] is False


@pytest.mark.asyncio
async def test_each_key_is_independent() -> None:
    body = await _body(tool_profile="scout")
    assert body["tool_profile"] == "scout"
    assert "provider" not in body and "naked" not in body


@pytest.mark.asyncio
async def test_body_without_new_keys_is_identical_to_explicit_none() -> None:
    assert await _body() == await _body(provider=None, tool_profile=None, naked=None)
