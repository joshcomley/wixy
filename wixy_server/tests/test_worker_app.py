"""HTTP-level tests for `wixy_server.worker.app` — request shapes, budget
refusal, idempotency, and 404s. `wixy_server.worker.runner`'s own message-
translation logic is covered by `test_worker_runner.py`; this file only proves
the ROUTE layer wires it correctly, using `fake_agent_sdk.py`'s scripted
episodes so the background agent-run task completes fast and deterministically
(spec/independence/05 §4)."""

from __future__ import annotations

import json
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock, ThinkingBlock
from fastapi import FastAPI
from fastapi.testclient import TestClient

import wixy_server.worker.app as worker_app_module
from wixy_server.github import GitHubClient
from wixy_server.tests.fake_agent_sdk import ScriptedEpisode, create_fake_agent_sdk_client_factory
from wixy_server.tests.fake_github import FakeGitHubState, create_fake_github_app
from wixy_server.worker.app import create_worker_app
from wixy_server.worker.settings import WorkerSettings
from wixy_server.worker.transcript import transcript_path


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


def _settings(
    tmp_path: Path,
    *,
    monthly_budget_usd: float = 40.0,
    site_repo_url: str = "",
    bot_pat: str = "",
) -> WorkerSettings:
    return WorkerSettings(
        port=8100,
        scratch_root=tmp_path,
        transcripts_root=tmp_path / "transcripts",
        monthly_budget_usd=monthly_budget_usd,
        site_repo_url=site_repo_url,
        bot_pat=bot_pat,
    )


def _poll_until(
    predicate: Callable[[], bool], *, timeout_s: float = 3.0, interval_s: float = 0.02
) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval_s)
    raise AssertionError(f"condition not met within {timeout_s}s")


# ---------------------------------------------------------------------------
# Real-git workspace integration helpers (spec/independence/05 §2, §4) — a
# genuine bare repo standing in for github.com, mirroring `test_publisher.py`'s
# own `bare_origin` fixture / spec/08-testing-acceptance.md §1's "real repos,
# not mocked" convention. `wixy_server.worker.app.github_https_clone_url` is
# monkeypatched (per-test) to redirect the CLONE target to this local repo —
# `owner_repo_slug` (used for the PR-open call) is deliberately left UNpatched
# so it still derives a realistic slug from a realistic `site_repo_url` value.
# ---------------------------------------------------------------------------


def _run_git(args: list[str], cwd: Path) -> None:
    subprocess.run(
        ["git", "-c", "credential.helper=", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def _make_bare_origin(tmp_path: Path) -> Path:
    remote_root = tmp_path / "remote"
    bare_dir = remote_root / "origin.git"
    bare_dir.mkdir(parents=True)
    _run_git(["init", "--bare", "--initial-branch=main"], cwd=bare_dir)

    seed = remote_root / "seed"
    _run_git(["clone", str(bare_dir), str(seed)], cwd=remote_root)
    _run_git(["config", "user.email", "seed@example.com"], cwd=seed)
    _run_git(["config", "user.name", "Seed"], cwd=seed)
    (seed / "content").mkdir()
    (seed / "content" / "index.json").write_text('{"hero": "original"}', encoding="utf-8")
    _run_git(["add", "."], cwd=seed)
    _run_git(["commit", "-m", "initial"], cwd=seed)
    _run_git(["push", "origin", "main"], cwd=seed)
    return bare_dir


def _commit_change_episode(dest: Path, *, text: str, cost: float = 0.01) -> ScriptedEpisode:
    """A scripted turn that ALSO makes a real commit in `dest` via its
    `on_query` hook — standing in for what the real agent's own Bash-tool
    `git commit` would have done (this fake never executes tools for real,
    see `fake_agent_sdk.py`'s own docstring)."""

    def _make_commit() -> None:
        (dest / "content" / "index.json").write_text('{"hero": "updated"}', encoding="utf-8")
        _run_git(["add", "."], cwd=dest)
        _run_git(["commit", "-m", "wixy-ai: update hero"], cwd=dest)

    return ScriptedEpisode(
        on_query=_make_commit,
        messages=[
            AssistantMessage(content=[TextBlock(text=text)], model="claude-sonnet-5"),
            _result(total_cost_usd=cost),
        ],
    )


def _fake_github_client_factory(fake_app: FastAPI) -> Callable[[], GitHubClient]:
    return lambda: GitHubClient(pat="fake-bot-pat", transport=httpx.ASGITransport(app=fake_app))


class TestGetBudget:
    def test_reports_zero_spend_and_the_configured_budget_initially(self, tmp_path: Path) -> None:
        _clients, factory = create_fake_agent_sdk_client_factory([])
        app = create_worker_app(
            settings=_settings(tmp_path, monthly_budget_usd=25.0), client_factory=factory
        )
        with TestClient(app) as client:
            response = client.get("/budget")

        assert response.status_code == 200
        assert response.json() == {"monthToDateUsd": 0.0, "monthlyBudgetUsd": 25.0}

    def test_reflects_accumulated_spend_after_a_turn(self, tmp_path: Path) -> None:
        episodes = [_text_episode("done", cost=0.07)]
        _clients, factory = create_fake_agent_sdk_client_factory(episodes)
        app = create_worker_app(settings=_settings(tmp_path), client_factory=factory)
        with TestClient(app) as client:
            create = client.post(
                "/conversations",
                json={"preamble": "you are a site editor", "firstMessage": "go"},
            )
            conv_id = create.json()["convId"]
            _poll_until(
                lambda: any(
                    m["role"] == "assistant"
                    for m in client.get(f"/conversations/{conv_id}/messages").json()["messages"]
                )
            )
            time.sleep(0.1)
            response = client.get("/budget")

        assert response.json()["monthToDateUsd"] == pytest.approx(0.07)


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


class TestWorkspaceIntegration:
    """The real git-clone/branch/push/PR flow (spec/independence/05 §2) driven
    end to end through the HTTP API — a REAL local bare repo standing in for
    github.com (see the module-level helpers above), a REAL commit made via
    `ScriptedEpisode.on_query` standing in for the agent's own Bash-tool `git
    commit`, and a fake GitHub app standing in for the REST PR-open call.
    `github_https_clone_url` is monkeypatched to redirect the clone target at
    the local bare repo; nothing else in the real code path is faked."""

    def test_full_turn_clones_commits_pushes_and_opens_pr(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        bare_origin = _make_bare_origin(tmp_path)
        monkeypatch.setattr(
            worker_app_module, "github_https_clone_url", lambda _url: str(bare_origin)
        )
        # The first conversation `create_worker_app`'s fresh WorkerState hands
        # out is always "anthropic-1" (next_id_n starts at 1) — deterministic,
        # so the scratch dir the episode's on_query hook writes into is known
        # up front.
        dest = tmp_path / "scratch" / "anthropic-1"
        episodes = [_commit_change_episode(dest, text="Updated the hero title for you.")]
        _clients, agent_factory = create_fake_agent_sdk_client_factory(episodes)
        github_state = FakeGitHubState()
        fake_github_app = create_fake_github_app(github_state)
        app = create_worker_app(
            settings=_settings(
                tmp_path / "scratch",
                site_repo_url="https://github.com/acme/wixy-site.git",
                bot_pat="fake-bot-pat",
            ),
            client_factory=agent_factory,
            github_client_factory=_fake_github_client_factory(fake_github_app),
        )
        with TestClient(app) as client:
            create = client.post(
                "/conversations",
                json={"preamble": "you are a site editor", "firstMessage": "update the hero"},
            )
            conv_id = create.json()["convId"]
            assert conv_id == "anthropic-1"

            def _ready() -> bool:
                return bool(client.get(f"/conversations/{conv_id}/status").json()["ready"])

            _poll_until(_ready)

            def _has_assistant_reply() -> bool:
                body = client.get(f"/conversations/{conv_id}/messages").json()
                return any(m["role"] == "assistant" for m in body["messages"])

            _poll_until(_has_assistant_reply)

            def _pr_opened() -> bool:
                return len(github_state.pull_request_calls) > 0

            _poll_until(_pr_opened)
            status = client.get(f"/conversations/{conv_id}/status").json()

        # The branch actually landed on "origin" (the real bare repo).
        branches = subprocess.run(
            ["git", "branch", "-a"],
            cwd=bare_origin,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        assert "wixy-ai/anthropic-1" in branches.stdout

        # The PR-open call carried the right head/base/repo.
        assert len(github_state.pull_request_calls) == 1
        pr_call = github_state.pull_request_calls[0]
        assert pr_call["head"] == "wixy-ai/anthropic-1"
        assert pr_call["base"] == "main"
        pr_title = pr_call["title"]
        assert isinstance(pr_title, str)
        assert "update the hero" in pr_title

        # No failure recorded, and the PAT never touched disk in the clone.
        assert status["failureReason"] is None
        config_text = (dest / ".git" / "config").read_text(encoding="utf-8")
        assert "fake-bot-pat" not in config_text

    def test_second_turn_pushes_more_commits_without_a_second_pr(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        bare_origin = _make_bare_origin(tmp_path)
        monkeypatch.setattr(
            worker_app_module, "github_https_clone_url", lambda _url: str(bare_origin)
        )
        dest = tmp_path / "scratch" / "anthropic-1"
        episodes = [
            _commit_change_episode(dest, text="First update done."),
            _commit_change_episode(dest, text="Second update done."),
        ]
        _clients, agent_factory = create_fake_agent_sdk_client_factory(episodes)
        github_state = FakeGitHubState()
        fake_github_app = create_fake_github_app(github_state)
        app = create_worker_app(
            settings=_settings(
                tmp_path / "scratch",
                site_repo_url="https://github.com/acme/wixy-site.git",
                bot_pat="fake-bot-pat",
            ),
            client_factory=agent_factory,
            github_client_factory=_fake_github_client_factory(fake_github_app),
        )
        with TestClient(app) as client:
            create = client.post(
                "/conversations",
                json={"preamble": "you are a site editor", "firstMessage": "first change"},
            )
            conv_id = create.json()["convId"]
            _poll_until(lambda: len(github_state.pull_request_calls) > 0)

            client.post(
                f"/conversations/{conv_id}/messages",
                json={"text": "second change", "idempotencyKey": "k2"},
            )

            def _second_reply() -> bool:
                body = client.get(f"/conversations/{conv_id}/messages").json()
                return any(m.get("text") == "Second update done." for m in body["messages"])

            _poll_until(_second_reply)
            # Give the post-turn push a moment to complete (no PR-count change
            # to poll on for the "stayed at one" case).
            time.sleep(0.2)

        # Still exactly ONE PR opened — the second turn's push just updated
        # the same branch (GitHub's own auto-update-on-push behavior).
        assert len(github_state.pull_request_calls) == 1

    def test_turn_with_no_commits_never_pushes_or_opens_pr(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        bare_origin = _make_bare_origin(tmp_path)
        monkeypatch.setattr(
            worker_app_module, "github_https_clone_url", lambda _url: str(bare_origin)
        )
        episodes = [_text_episode("Sure, here's an answer with no edits needed.")]
        _clients, agent_factory = create_fake_agent_sdk_client_factory(episodes)
        github_state = FakeGitHubState()
        fake_github_app = create_fake_github_app(github_state)
        app = create_worker_app(
            settings=_settings(
                tmp_path / "scratch",
                site_repo_url="https://github.com/acme/wixy-site.git",
                bot_pat="fake-bot-pat",
            ),
            client_factory=agent_factory,
            github_client_factory=_fake_github_client_factory(fake_github_app),
        )
        with TestClient(app) as client:
            create = client.post(
                "/conversations",
                json={"preamble": "you are a site editor", "firstMessage": "what does this do?"},
            )
            conv_id = create.json()["convId"]

            def _has_assistant_reply() -> bool:
                body = client.get(f"/conversations/{conv_id}/messages").json()
                return any(m["role"] == "assistant" for m in body["messages"])

            _poll_until(_has_assistant_reply)
            time.sleep(0.2)  # let any (wrongly) pending push/PR settle

        assert github_state.pull_request_calls == []
        branches = subprocess.run(
            ["git", "branch", "-a"],
            cwd=bare_origin,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        assert "wixy-ai/anthropic-1" not in branches.stdout

    def test_bad_repo_url_surfaces_as_workspace_failed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _clients, agent_factory = create_fake_agent_sdk_client_factory([])
        app = create_worker_app(
            settings=_settings(
                tmp_path / "scratch",
                site_repo_url="https://github.com/acme/does-not-exist.git",
                bot_pat="fake-bot-pat",
            ),
            client_factory=agent_factory,
        )
        with TestClient(app) as client:
            create = client.post(
                "/conversations",
                json={"preamble": "you are a site editor", "firstMessage": "go"},
            )
            conv_id = create.json()["convId"]

            def _failed() -> bool:
                body = client.get(f"/conversations/{conv_id}/status").json()
                return bool(body["failureReason"] is not None)

            _poll_until(_failed)
            status = client.get(f"/conversations/{conv_id}/status").json()
            messages = client.get(f"/conversations/{conv_id}/messages").json()["messages"]

        assert status["failureReason"] == "workspace_failed"
        assert status["ready"] is False
        assert any(m["kind"] == "error" for m in messages)


class TestTranscriptPersistence:
    """spec/independence/05 §2: "the worker persists conversations as JSONL
    compatible with the existing chat panel's message model." Written once
    per turn, in `_run_and_track`'s own `finally` (see that function's
    docstring) — these tests drive it through the real HTTP API rather than
    calling `write_transcript` directly, so they prove the WIRING, not just
    the module in isolation (that's `test_worker_transcript.py`'s job)."""

    def test_transcript_file_exists_after_a_turn(self, tmp_path: Path) -> None:
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
            time.sleep(0.1)  # the finally-block write races the poll by a beat

        path = transcript_path(tmp_path / "transcripts", conv_id)
        assert path.exists()
        lines = path.read_text(encoding="utf-8").splitlines()
        assert len(lines) == 2  # the user message + the assistant's reply
        assert json.loads(lines[0])["text"] == "fix the typo"
        assert json.loads(lines[1])["text"] == "Sure, I'll help with that."

    def test_transcript_survives_an_agent_run_failure(self, tmp_path: Path) -> None:
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
                return bool(body["failureReason"] is not None)

            _poll_until(_failed)
            time.sleep(0.1)

        path = transcript_path(tmp_path / "transcripts", conv_id)
        assert path.exists()
        lines = path.read_text(encoding="utf-8").splitlines()
        assert json.loads(lines[0])["text"] == "go"

    def test_second_turn_rewrites_the_transcript_with_both_turns(self, tmp_path: Path) -> None:
        episodes = [_text_episode("first reply"), _text_episode("second reply")]
        _clients, factory = create_fake_agent_sdk_client_factory(episodes)
        app = create_worker_app(settings=_settings(tmp_path), client_factory=factory)
        with TestClient(app) as client:
            create = client.post(
                "/conversations",
                json={"preamble": "you are a site editor", "firstMessage": "first message"},
            )
            conv_id = create.json()["convId"]
            _poll_until(
                lambda: any(
                    m["role"] == "assistant"
                    for m in client.get(f"/conversations/{conv_id}/messages").json()["messages"]
                )
            )

            client.post(
                f"/conversations/{conv_id}/messages",
                json={"text": "second message", "idempotencyKey": "k2"},
            )

            def _second_reply() -> bool:
                body = client.get(f"/conversations/{conv_id}/messages").json()
                return any(m.get("text") == "second reply" for m in body["messages"])

            _poll_until(_second_reply)
            time.sleep(0.1)

        path = transcript_path(tmp_path / "transcripts", conv_id)
        lines = path.read_text(encoding="utf-8").splitlines()
        texts = [json.loads(line)["text"] for line in lines]
        assert texts == ["first message", "first reply", "second message", "second reply"]
