"""Unit tests for `wixy_server.github` against the fake GitHub double (spec/
independence/04 §2). Same `httpx.ASGITransport` pattern as `test_cmdchat.py`."""

from __future__ import annotations

import socket

import httpx
import pytest
from fastapi import FastAPI

from wixy_server.github import GitHubApiError, GitHubClient
from wixy_server.tests.fake_github import FakeGitHubState, create_fake_github_app


def _make_client(app: FastAPI, *, max_attempts: int = 2) -> GitHubClient:
    return GitHubClient(
        pat="fake-pat",
        transport=httpx.ASGITransport(app=app),
        max_attempts=max_attempts,
        timeout_s=5.0,
    )


def _reserve_closed_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
    return port


# ---------------------------------------------------------------------------
# trigger_workflow_dispatch
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_trigger_workflow_dispatch_sends_inputs() -> None:
    state = FakeGitHubState()
    app = create_fake_github_app(state)
    async with _make_client(app) as client:
        await client.trigger_workflow_dispatch(
            "acme/wixy-engine", "sync-upstream.yml", inputs={"mode": "sync"}
        )

    assert len(state.dispatch_calls) == 1
    assert state.dispatch_calls[0]["inputs"] == {"mode": "sync"}
    assert state.dispatch_calls[0]["ref"] == "main"


@pytest.mark.asyncio
async def test_trigger_workflow_dispatch_non_204_raises() -> None:
    state = FakeGitHubState()
    state.dispatch_status_code = 422
    app = create_fake_github_app(state)
    async with _make_client(app) as client:
        with pytest.raises(GitHubApiError):
            await client.trigger_workflow_dispatch("acme/wixy-engine", "sync-upstream.yml")


# ---------------------------------------------------------------------------
# get_latest_workflow_run
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_latest_workflow_run_returns_none_when_empty() -> None:
    state = FakeGitHubState()
    app = create_fake_github_app(state)
    async with _make_client(app) as client:
        run = await client.get_latest_workflow_run("acme/wixy-engine", "sync-upstream.yml")

    assert run is None


@pytest.mark.asyncio
async def test_get_latest_workflow_run_parses_entry() -> None:
    state = FakeGitHubState()
    state.latest_run = {
        "id": 42,
        "status": "completed",
        "conclusion": "success",
        "html_url": "https://github.com/acme/wixy-engine/actions/runs/42",
        "created_at": "2026-07-19T12:00:00Z",
    }
    app = create_fake_github_app(state)
    async with _make_client(app) as client:
        run = await client.get_latest_workflow_run("acme/wixy-engine", "sync-upstream.yml")

    assert run is not None
    assert run.id == 42
    assert run.status == "completed"
    assert run.conclusion == "success"
    assert run.html_url == "https://github.com/acme/wixy-engine/actions/runs/42"


@pytest.mark.asyncio
async def test_get_latest_workflow_run_malformed_entry_raises() -> None:
    state = FakeGitHubState()
    state.latest_run = {"status": "completed"}  # missing id
    app = create_fake_github_app(state)
    async with _make_client(app) as client:
        with pytest.raises(GitHubApiError):
            await client.get_latest_workflow_run("acme/wixy-engine", "sync-upstream.yml")


@pytest.mark.asyncio
async def test_get_latest_workflow_run_non_200_raises() -> None:
    state = FakeGitHubState()
    state.runs_status_code = 500
    app = create_fake_github_app(state)
    async with _make_client(app) as client:
        with pytest.raises(GitHubApiError):
            await client.get_latest_workflow_run("acme/wixy-engine", "sync-upstream.yml")


# ---------------------------------------------------------------------------
# compare_commits
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_compare_commits_parses_ahead_by_and_commits() -> None:
    state = FakeGitHubState()
    state.compare_ahead_by = 3
    state.compare_commits = [
        {
            "sha": "abc123",
            "commit": {
                "message": "feat: add thing\n\nlonger body",
                "author": {"name": "Jane Dev", "date": "2026-07-18T10:00:00Z"},
            },
        }
    ]
    app = create_fake_github_app(state)
    async with _make_client(app) as client:
        result = await client.compare_commits("acme/wixy-engine", "main", "joshcomley:main")

    assert result.ahead_by == 3
    assert len(result.commits) == 1
    assert result.commits[0].sha == "abc123"
    assert result.commits[0].subject == "feat: add thing"
    assert result.commits[0].author == "Jane Dev"
    assert result.commits[0].when == "2026-07-18T10:00:00Z"


@pytest.mark.asyncio
async def test_compare_commits_skips_malformed_entries() -> None:
    state = FakeGitHubState()
    state.compare_ahead_by = 2
    state.compare_commits = [
        {"sha": "abc123", "commit": {"message": "ok"}},
        {"sha": "def456"},  # missing "commit"
        {"commit": {"message": "no sha"}},  # missing "sha"
    ]
    app = create_fake_github_app(state)
    async with _make_client(app) as client:
        result = await client.compare_commits("acme/wixy-engine", "main", "joshcomley:main")

    assert len(result.commits) == 1
    assert result.commits[0].sha == "abc123"


@pytest.mark.asyncio
async def test_compare_commits_non_200_raises() -> None:
    state = FakeGitHubState()
    state.compare_status_code = 404
    app = create_fake_github_app(state)
    async with _make_client(app) as client:
        with pytest.raises(GitHubApiError):
            await client.compare_commits("acme/wixy-engine", "main", "joshcomley:main")


# ---------------------------------------------------------------------------
# retry behavior
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_connect_refused_retries_then_raises_structured_error() -> None:
    closed_port = _reserve_closed_port()
    client = GitHubClient(
        pat="fake-pat",
        api_base_url=f"http://127.0.0.1:{closed_port}",
        timeout_s=2.0,
        max_attempts=2,
    )
    async with client:
        with pytest.raises(GitHubApiError, match="failed after 2 attempts"):
            await client.trigger_workflow_dispatch("acme/wixy-engine", "sync-upstream.yml")
