"""The ONLY module that talks to the GitHub REST API (spec/independence/04 §2):
drives the "Get engine updates" / "Undo last update" buttons and the Engine card's
commits-behind/changelog display. Standalone-edition only — the fleet never
constructs this client (`Settings.engine_pat` is empty there, and `routes_engine.py`
never mounts on the fleet edition).

Follows `wixy_server.cmdchat`'s own documented convention (bounded timeouts, retries
on transport errors only — never on an HTTP status code — structured errors surfaced
to the UI) since that's this repo's established shape for an external API client,
even though nothing mandates it for GitHub specifically.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger(__name__)

DEFAULT_API_BASE_URL = "https://api.github.com"
DEFAULT_TIMEOUT_S = 10.0
# "retries x2 on connect errors" — same convention as cmdchat.py: 1 initial + 2 retries.
DEFAULT_MAX_ATTEMPTS = 3

SYNC_WORKFLOW_FILE = "sync-upstream.yml"


class GitHubApiError(Exception):
    """A GitHub API call failed after retries — a structured error surfaced to the
    UI, matching `wixy_server.cmdchat.CmdChatError`'s own contract."""


@dataclass(frozen=True, slots=True)
class CommitInfo:
    sha: str
    subject: str
    author: str
    when: str


@dataclass(frozen=True, slots=True)
class CompareResult:
    """`ahead_by`/`commits` describe how far `head` is ahead of `base` — callers
    comparing "how far behind upstream is her fork" pass her fork's branch as
    `base` and the upstream ref as `head` (spec/independence/04's "commits behind")."""

    ahead_by: int
    commits: list[CommitInfo]


@dataclass(frozen=True, slots=True)
class WorkflowRun:
    id: int
    status: str  # queued | in_progress | completed
    conclusion: str | None  # success | failure | cancelled | ... ; None until completed
    html_url: str
    created_at: str


@dataclass(slots=True)
class _RetryState:
    last_error: Exception | None = field(default=None)


def _commit_info_from_dict(data: object) -> CommitInfo | None:
    """Defensive parse — an unrecognized/malformed entry is skipped, not fatal
    (matches `wixy_server.cmdchat._message_from_dict`'s own convention)."""
    if not isinstance(data, dict):
        return None
    sha = data.get("sha")
    commit = data.get("commit")
    if not isinstance(sha, str) or not isinstance(commit, dict):
        return None
    message = commit.get("message")
    subject = message.splitlines()[0] if isinstance(message, str) and message else ""
    author_name = ""
    when = ""
    author = commit.get("author")
    if isinstance(author, dict):
        name = author.get("name")
        date = author.get("date")
        author_name = name if isinstance(name, str) else ""
        when = date if isinstance(date, str) else ""
    return CommitInfo(sha=sha, subject=subject, author=author_name, when=when)


class GitHubClient:
    def __init__(
        self,
        *,
        pat: str,
        api_base_url: str = DEFAULT_API_BASE_URL,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._pat = pat
        self._api_base_url = api_base_url.rstrip("/")
        self._timeout_s = timeout_s
        self._max_attempts = max_attempts
        self._client = httpx.AsyncClient(transport=transport)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> GitHubClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    def _headers(self) -> dict[str, str]:
        # Never logged (spec/independence/04 §2 Fable checklist: "PAT never
        # logged") — this dict is only ever handed to httpx as request headers,
        # never passed to `logger.*` anywhere in this module.
        return {
            "Authorization": f"Bearer {self._pat}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    async def _request(
        self, method: str, path: str, *, json_body: dict[str, object] | None = None
    ) -> httpx.Response:
        url = f"{self._api_base_url}{path}"
        retry = _RetryState()
        for attempt in range(1, self._max_attempts + 1):
            try:
                return await self._client.request(
                    method, url, json=json_body, headers=self._headers(), timeout=self._timeout_s
                )
            except httpx.TransportError as exc:
                retry.last_error = exc
                logger.warning(
                    "github: %s %s attempt %d/%d failed: %s",
                    method,
                    path,
                    attempt,
                    self._max_attempts,
                    exc,
                )
        raise GitHubApiError(
            f"{method} {path} failed after {self._max_attempts} attempts: {retry.last_error}"
        ) from retry.last_error

    async def trigger_workflow_dispatch(
        self,
        repo: str,
        workflow_file: str,
        *,
        ref: str = "main",
        inputs: dict[str, str] | None = None,
    ) -> None:
        """`POST /repos/{repo}/actions/workflows/{workflow_file}/dispatches` — 204
        on success, no body. GitHub's dispatch API is fire-and-forget: it queues the
        run but the response carries no run id, which is why callers poll
        `get_latest_workflow_run` afterward rather than getting one back here."""
        body: dict[str, object] = {"ref": ref}
        if inputs:
            body["inputs"] = inputs
        response = await self._request(
            "POST", f"/repos/{repo}/actions/workflows/{workflow_file}/dispatches", json_body=body
        )
        if response.status_code != 204:
            raise GitHubApiError(
                f"workflow_dispatch for {repo}/{workflow_file} returned "
                f"{response.status_code}: {response.text[:500]}"
            )

    async def get_latest_workflow_run(self, repo: str, workflow_file: str) -> WorkflowRun | None:
        response = await self._request(
            "GET", f"/repos/{repo}/actions/workflows/{workflow_file}/runs?per_page=1"
        )
        if response.status_code != 200:
            raise GitHubApiError(
                f"GET runs for {repo}/{workflow_file} returned {response.status_code}: "
                f"{response.text[:500]}"
            )
        body = response.json()
        if not isinstance(body, dict):
            raise GitHubApiError(f"runs response malformed: {body!r}")
        runs = body.get("workflow_runs")
        if not isinstance(runs, list) or not runs:
            return None
        run = runs[0]
        if not isinstance(run, dict):
            raise GitHubApiError(f"malformed workflow run entry: {run!r}")
        run_id = run.get("id")
        status = run.get("status")
        if not isinstance(run_id, int) or not isinstance(status, str):
            raise GitHubApiError(f"malformed workflow run entry: {run!r}")
        html_url = run.get("html_url")
        created_at = run.get("created_at")
        conclusion = run.get("conclusion")
        return WorkflowRun(
            id=run_id,
            status=status,
            conclusion=conclusion if isinstance(conclusion, str) else None,
            html_url=html_url if isinstance(html_url, str) else "",
            created_at=created_at if isinstance(created_at, str) else "",
        )

    async def compare_commits(self, repo: str, base: str, head: str) -> CompareResult:
        """`GET /repos/{repo}/compare/{base}...{head}` — `head` may name a
        cross-fork ref as `owner:branch` (GitHub's own compare API), used here to
        compare her fork's branch against the upstream repo's branch without a
        second repo argument."""
        response = await self._request("GET", f"/repos/{repo}/compare/{base}...{head}")
        if response.status_code != 200:
            raise GitHubApiError(
                f"compare {base}...{head} on {repo} returned {response.status_code}: "
                f"{response.text[:500]}"
            )
        body = response.json()
        if not isinstance(body, dict):
            raise GitHubApiError(f"compare response malformed: {body!r}")
        ahead_by = body.get("ahead_by")
        raw_commits = body.get("commits")
        if not isinstance(ahead_by, int) or not isinstance(raw_commits, list):
            raise GitHubApiError(f"compare response malformed: {body!r}")
        commits = [
            c for c in (_commit_info_from_dict(item) for item in raw_commits) if c is not None
        ]
        return CompareResult(ahead_by=ahead_by, commits=commits)
