"""Live smoke test for the `anthropic` backend (spec/independence/05 §4: "One
`@live_anthropic` smoke (skipped in CI, run in the drill with her real key):
'change the FAQ wording X→Y' end-to-end to a PR"). Mirrors `test_cmdchat.py`'s
own `@live_cmd`/`test_live_cmd_round_trip` pattern — excluded from the default
suite via `pyproject.toml`'s addopts, run explicitly with real credentials.

Unlike `@live_cmd` (which connects to an already-running external cmd
instance), this test constructs a REAL worker app in-process
(`create_worker_app`, real Agent SDK client, real `GitHubClient`) and drives
it via `TestClient` — the HTTP layer between test and worker stays
synthetic/in-process (that's just OUR OWN code), but every OUTBOUND call
(Anthropic API, git clone/push, GitHub's REST API) is genuinely real. This
test:
  - Spends real money against the real `ANTHROPIC_API_KEY` in the environment.
  - Clones the real `WIXY_SITE_REPO` and opens a REAL pull request against it
    via the real `WIXY_AI_BOT_PAT`.
Never run this outside the M9 drill, and never without the operator's
explicit go-ahead for the spend (see the fleet's own SPEND GATE doctrine).
"""

from __future__ import annotations

from pathlib import Path

import anyio
import pytest
from fastapi.testclient import TestClient

from wixy_server.worker.app import create_worker_app
from wixy_server.worker.settings import load_worker_settings


@pytest.mark.live_anthropic
@pytest.mark.asyncio
async def test_live_anthropic_change_ships_a_pull_request(tmp_path: Path) -> None:
    """Creates a real conversation asking for a small, safe content tweak,
    waits for the workspace to provision and the turn to complete, and
    asserts a real PR got opened. `ANTHROPIC_API_KEY` is read by the Agent
    SDK directly from the process environment (never modeled in
    `WorkerSettings`, see that module's own docstring) — `load_worker_settings`
    supplies everything else (`WIXY_SITE_REPO`, `WIXY_AI_BOT_PAT`,
    `WIXY_AI_MONTHLY_BUDGET_USD`) from the SAME real environment a real
    `worker` compose service would read. `scratch_root`/`transcripts_root`
    are overridden to this test's own `tmp_path` (not `/data/...`, the
    production compose mount) so the smoke test is portable to wherever it's
    actually run from during the drill, and cleans up after itself.
    """
    settings = load_worker_settings(
        scratch_root=tmp_path / "scratch", transcripts_root=tmp_path / "transcripts"
    )
    assert settings.site_repo_url, "WIXY_SITE_REPO must be set to run this live smoke test"
    assert settings.bot_pat, "WIXY_AI_BOT_PAT must be set to run this live smoke test"

    app = create_worker_app(settings=settings)
    worker_state = app.state.worker_state

    with TestClient(app) as client:
        create = client.post(
            "/conversations",
            json={
                "preamble": "You are a careful site content editor for a real production site.",
                "firstMessage": (
                    "Please make one small, safe wording tweak somewhere in this site's "
                    "content (for example, in an FAQ or About section) — a trivial, "
                    "reversible change is fine, this is a live end-to-end smoke test. "
                    "Commit it when you're done."
                ),
            },
        )
        assert create.status_code == 202
        conv_id = create.json()["convId"]

        ready_deadline = anyio.current_time() + 120.0
        while anyio.current_time() < ready_deadline:
            status = client.get(f"/conversations/{conv_id}/status").json()
            if status["ready"]:
                break
            if status["failureReason"] is not None:
                pytest.fail(f"workspace provisioning failed: {status['failureReason']}")
            await anyio.sleep(2.0)
        else:
            pytest.fail("workspace never became ready within 120s")

        turn_deadline = anyio.current_time() + 300.0
        conv = worker_state.conversations[conv_id]
        while anyio.current_time() < turn_deadline:
            if conv.pr_url is not None:
                break
            if conv.failure_reason is not None:
                pytest.fail(f"the agent turn failed: {conv.failure_reason}: {conv.failure_message}")
            await anyio.sleep(3.0)
        else:
            pytest.fail("no pull request appeared within 300s")

    assert conv.pr_url is not None
    assert conv.pr_url.startswith("https://github.com/")
