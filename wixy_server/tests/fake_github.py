"""A fake GitHub REST API server (spec/independence/04 §2) — stands in for the
three endpoints `wixy_server.github.GitHubClient` calls, so `wixy_server.github`
and `wixy_server.routes_engine` tests run against a hermetic double instead of
the real `api.github.com`. Mirrors `fake_cmd.py`'s own state-dataclass +
FastAPI-app-factory convention.

Not a `test_*.py` file — a reusable fixture module, imported by test files, never
collected by pytest itself.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from builder.jsontypes import JsonObject


@dataclass
class FakeGitHubState:
    dispatch_calls: list[JsonObject] = field(default_factory=list)
    dispatch_status_code: int = 204
    latest_run: JsonObject | None = None
    runs_status_code: int = 200
    compare_ahead_by: int = 0
    compare_commits: list[JsonObject] = field(default_factory=list)
    compare_status_code: int = 200
    pull_request_calls: list[JsonObject] = field(default_factory=list)
    pull_request_status_code: int = 201
    next_pull_request_number: int = 1


def create_fake_github_app(state: FakeGitHubState | None = None) -> FastAPI:
    state = state if state is not None else FakeGitHubState()
    app = FastAPI()
    app.state.fake = state

    @app.post("/repos/{owner}/{repo}/actions/workflows/{workflow_file}/dispatches")
    async def dispatch(owner: str, repo: str, workflow_file: str, request: Request) -> Response:
        if state.dispatch_status_code != 204:
            return Response(status_code=state.dispatch_status_code, content=b"boom")
        body = await request.json()
        state.dispatch_calls.append(body if isinstance(body, dict) else {})
        return Response(status_code=204)

    @app.get("/repos/{owner}/{repo}/actions/workflows/{workflow_file}/runs")
    async def runs(owner: str, repo: str, workflow_file: str) -> Response:
        if state.runs_status_code != 200:
            return Response(status_code=state.runs_status_code, content=b"boom")
        workflow_runs = [state.latest_run] if state.latest_run is not None else []
        return JSONResponse({"workflow_runs": workflow_runs})

    @app.get("/repos/{owner}/{repo}/compare/{basehead}")
    async def compare(owner: str, repo: str, basehead: str) -> Response:
        if state.compare_status_code != 200:
            return Response(status_code=state.compare_status_code, content=b"boom")
        return JSONResponse({"ahead_by": state.compare_ahead_by, "commits": state.compare_commits})

    @app.post("/repos/{owner}/{repo}/pulls")
    async def create_pull(owner: str, repo: str, request: Request) -> Response:
        if state.pull_request_status_code != 201:
            return Response(status_code=state.pull_request_status_code, content=b"boom")
        body = await request.json()
        state.pull_request_calls.append(body if isinstance(body, dict) else {})
        number = state.next_pull_request_number
        state.next_pull_request_number += 1
        return JSONResponse(
            status_code=201,
            content={
                "number": number,
                "html_url": f"https://github.com/{owner}/{repo}/pull/{number}",
            },
        )

    return app
