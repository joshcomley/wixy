"""HTTP-level tests for `wixy_server.worker.app` — request shapes, budget
refusal, idempotency, and 404s. `wixy_server.worker.runner`'s own message-
translation logic is covered by `test_worker_runner.py`; this file only proves
the ROUTE layer wires it correctly, using `fake_agent_sdk.py`'s scripted
episodes so the background agent-run task completes fast and deterministically
(spec/independence/05 §4)."""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path

from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock, ThinkingBlock
from fastapi.testclient import TestClient

from wixy_server.tests.fake_agent_sdk import ScriptedEpisode, create_fake_agent_sdk_client_factory
from wixy_server.worker.app import create_worker_app
from wixy_server.worker.settings import WorkerSettings


def _result(total_cost_usd: float = 0.01) -> ResultMessage:
    return ResultMessage(
        subtype="success",
        duration_ms=10,
        duration_api_ms=8,
        is_error=False,
        num_turns=1,
        session_id="sdk-1",
        total_cost_usd=total_cost_usd,
        result="done",
    )


def _text_episode(text: str, *, cost: float = 0.01) -> ScriptedEpisode:
    return ScriptedEpisode(
        messages=[
            AssistantMessage(content=[TextBlock(text=text)], model="claude-sonnet-5"),
            _result(total_cost_usd=cost),
        ]
    )


def _settings(tmp_path: Path, *, monthly_budget_usd: float = 40.0) -> WorkerSettings:
    return WorkerSettings(port=8100, scratch_root=tmp_path, monthly_budget_usd=monthly_budget_usd)


def _poll_until(
    predicate: Callable[[], bool], *, timeout_s: float = 3.0, interval_s: float = 0.02
) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval_s)
    raise AssertionError(f"condition not met within {timeout_s}s")


class TestCreateConversation:
    def test_returns_202_with_conv_id(self, tmp_path: Path) -> None:
        _clients, factory = create_fake_agent_sdk_client_factory([])
        app = create_worker_app(settings=_settings(tmp_path), client_factory=factory)
        with TestClient(app) as client:
            response = client.post("/conversations", json={"preamble": "you are a site editor"})

        assert response.status_code == 202
        assert "convId" in response.json()
        assert response.json()["pendingState"] == "queued"

    def test_first_message_triggers_a_background_agent_run(self, tmp_path: Path) -> None:
        episodes = [_text_episode("Sure, I'll help with that.")]
        _clients, factory = create_fake_agent_sdk_client_factory(episodes)
        app = create_worker_app(settings=_settings(tmp_path), client_factory=factory)
        with TestClient(app) as client:
            create = client.post(
                "/conversations",
                json={"preamble": "you are a site editor", "firstMessage": "fix the typo"},
            )
            conv_id = create.json()["convId"]

            def _has_assistant_reply() -> bool:
                body = client.get(f"/conversations/{conv_id}/messages").json()
                return any(m["role"] == "assistant" for m in body["messages"])

            _poll_until(_has_assistant_reply)
            messages = client.get(f"/conversations/{conv_id}/messages").json()["messages"]

        assert messages[0]["role"] == "user"
        assert messages[0]["text"] == "fix the typo"
        assert messages[1]["role"] == "assistant"
        assert messages[1]["text"] == "Sure, I'll help with that."

    def test_no_first_message_creates_conversation_with_no_transcript_yet(
        self, tmp_path: Path
    ) -> None:
        _clients, factory = create_fake_agent_sdk_client_factory([])
        app = create_worker_app(settings=_settings(tmp_path), client_factory=factory)
        with TestClient(app) as client:
            create = client.post("/conversations", json={"preamble": "you are a site editor"})
            conv_id = create.json()["convId"]
            messages = client.get(f"/conversations/{conv_id}/messages").json()["messages"]

        assert messages == []

    def test_402s_past_the_monthly_budget(self, tmp_path: Path) -> None:
        _clients, factory = create_fake_agent_sdk_client_factory([])
        app = create_worker_app(
            settings=_settings(tmp_path, monthly_budget_usd=0.0), client_factory=factory
        )
        with TestClient(app) as client:
            response = client.post("/conversations", json={"preamble": "you are a site editor"})

        assert response.status_code == 402
        assert "budget" in response.json()["detail"].lower()


class TestStatus:
    def test_ready_immediately_no_workspace_provisioning_yet(self, tmp_path: Path) -> None:
        _clients, factory = create_fake_agent_sdk_client_factory([])
        app = create_worker_app(settings=_settings(tmp_path), client_factory=factory)
        with TestClient(app) as client:
            create = client.post("/conversations", json={"preamble": "you are a site editor"})
            status = client.get(f"/conversations/{create.json()['convId']}/status")

        assert status.status_code == 200
        assert status.json()["ready"] is True

    def test_404_for_unknown_conversation(self, tmp_path: Path) -> None:
        _clients, factory = create_fake_agent_sdk_client_factory([])
        app = create_worker_app(settings=_settings(tmp_path), client_factory=factory)
        with TestClient(app) as client:
            response = client.get("/conversations/nope/status")
        assert response.status_code == 404


class TestSendMessage:
    def test_send_appends_user_message_and_runs_a_turn(self, tmp_path: Path) -> None:
        episodes = [_text_episode("Working on it now.")]
        _clients, factory = create_fake_agent_sdk_client_factory(episodes)
        app = create_worker_app(settings=_settings(tmp_path), client_factory=factory)
        with TestClient(app) as client:
            create = client.post("/conversations", json={"preamble": "you are a site editor"})
            conv_id = create.json()["convId"]
            send = client.post(
                f"/conversations/{conv_id}/messages",
                json={"text": "please fix the footer", "idempotencyKey": "k1"},
            )

            def _has_assistant_reply() -> bool:
                body = client.get(f"/conversations/{conv_id}/messages").json()
                return any(m["role"] == "assistant" for m in body["messages"])

            _poll_until(_has_assistant_reply)
            messages = client.get(f"/conversations/{conv_id}/messages").json()["messages"]

        assert send.status_code == 202
        assert messages[0]["text"] == "please fix the footer"
        assert messages[1]["text"] == "Working on it now."

    def test_repeated_idempotency_key_does_not_rerun(self, tmp_path: Path) -> None:
        episodes = [_text_episode("first reply")]
        _clients, factory = create_fake_agent_sdk_client_factory(episodes)
        app = create_worker_app(settings=_settings(tmp_path), client_factory=factory)
        with TestClient(app) as client:
            create = client.post("/conversations", json={"preamble": "you are a site editor"})
            conv_id = create.json()["convId"]
            client.post(
                f"/conversations/{conv_id}/messages",
                json={"text": "do the thing", "idempotencyKey": "same-key"},
            )

            def _has_assistant_reply() -> bool:
                body = client.get(f"/conversations/{conv_id}/messages").json()
                return any(m["role"] == "assistant" for m in body["messages"])

            _poll_until(_has_assistant_reply)

            # Retried with the SAME key — must not trigger a second agent run
            # (only one episode was ever scripted; a second real run would
            # exhaust fake_agent_sdk's episode list and fall back to an empty
            # ScriptedEpisode rather than raise, so assert on message COUNT
            # staying put instead of an exception).
            client.post(
                f"/conversations/{conv_id}/messages",
                json={"text": "do the thing", "idempotencyKey": "same-key"},
            )
            time.sleep(0.1)
            messages = client.get(f"/conversations/{conv_id}/messages").json()["messages"]

        # user + assistant from the first send only — the retry appended nothing.
        assert len(messages) == 2

    def test_404_for_unknown_conversation(self, tmp_path: Path) -> None:
        _clients, factory = create_fake_agent_sdk_client_factory([])
        app = create_worker_app(settings=_settings(tmp_path), client_factory=factory)
        with TestClient(app) as client:
            response = client.post(
                "/conversations/nope/messages", json={"text": "hi", "idempotencyKey": "k1"}
            )
        assert response.status_code == 404


class TestGetMessages:
    def test_thinking_excluded_by_default(self, tmp_path: Path) -> None:
        episodes = [
            ScriptedEpisode(
                messages=[
                    AssistantMessage(
                        content=[
                            ThinkingBlock(thinking="hmm", signature="s"),
                            TextBlock(text="here's the answer"),
                        ],
                        model="claude-sonnet-5",
                    ),
                    _result(),
                ]
            )
        ]
        _clients, factory = create_fake_agent_sdk_client_factory(episodes)
        app = create_worker_app(settings=_settings(tmp_path), client_factory=factory)
        with TestClient(app) as client:
            create = client.post(
                "/conversations",
                json={"preamble": "you are a site editor", "firstMessage": "go"},
            )
            conv_id = create.json()["convId"]

            def _has_text_reply() -> bool:
                body = client.get(f"/conversations/{conv_id}/messages").json()
                return any(m["kind"] == "text" for m in body["messages"])

            _poll_until(_has_text_reply)
            default_messages = client.get(f"/conversations/{conv_id}/messages").json()["messages"]
            with_thinking = client.get(
                f"/conversations/{conv_id}/messages?includeThinking=true"
            ).json()["messages"]

        assert all(m["kind"] != "thinking" for m in default_messages)
        assert any(m["kind"] == "thinking" for m in with_thinking)

    def test_404_for_unknown_conversation(self, tmp_path: Path) -> None:
        _clients, factory = create_fake_agent_sdk_client_factory([])
        app = create_worker_app(settings=_settings(tmp_path), client_factory=factory)
        with TestClient(app) as client:
            response = client.get("/conversations/nope/messages")
        assert response.status_code == 404


def test_agent_run_failure_surfaces_as_conversation_failure(tmp_path: Path) -> None:
    episodes = [ScriptedEpisode(raises=ConnectionError("CLI subprocess died"))]
    _clients, factory = create_fake_agent_sdk_client_factory(episodes)
    app = create_worker_app(settings=_settings(tmp_path), client_factory=factory)
    with TestClient(app) as client:
        create = client.post(
            "/conversations",
            json={"preamble": "you are a site editor", "firstMessage": "go"},
        )
        conv_id = create.json()["convId"]

        def _failed() -> bool:
            body = client.get(f"/conversations/{conv_id}/status").json()
            return body["failureReason"] is not None

        _poll_until(_failed)
        status = client.get(f"/conversations/{conv_id}/status").json()

    assert status["failureReason"] == "agent_run_failed"
    assert "CLI subprocess died" in status["failureMessage"]
