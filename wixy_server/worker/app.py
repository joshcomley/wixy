"""The worker's internal HTTP API (spec/independence/05 §2) —
`wixy_server.ai.anthropic_backend.AnthropicAIBackend`'s counterpart, run as the
`worker` compose service (docker-compose.yml, same image as `wixy`, different
`command:`). No published port; reachable from the `wixy` service alone, over
the compose network, matching `wixy`'s own "no published ports, cloudflared is
the only ingress" convention extended to this internal-only surface.

Route shapes mirror cmd's own conventions closely (POST .../conversations 202
queued, GET .../status polled for readiness, POST .../messages 202 accepted) —
not because this repo talks to cmd here, but because `AnthropicAIBackend` is
deliberately shaped like `CmdChatClient` (see that module's own docstring), so
matching the wire shape keeps both backend implementations equally simple.
"""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

import anyio
from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from builder.jsontypes import JsonObject
from wixy_server.github import GitHubApiError, GitHubClient
from wixy_server.worker.agent_client import AgentSDKClientFactory
from wixy_server.worker.runner import run_turn
from wixy_server.worker.settings import WorkerSettings, load_worker_settings
from wixy_server.worker.state import WorkerConversation, WorkerMessage, WorkerState
from wixy_server.worker.transcript import write_transcript
from wixy_server.worker.workspace import (
    WorkspaceError,
    github_https_clone_url,
    head_sha,
    owner_repo_slug,
    provision_workspace,
    push_branch,
    sweep_idle_workspaces,
    touch_activity,
)

logger = logging.getLogger(__name__)

# spec/independence/04 §4: her "engine-dev chat tab" (targeting the engine
# fork rather than her site repo) is "a noted later enhancement" — v1's
# worker always targets the site repo, always at its own default branch,
# which is "main" in every project this codebase registers (projects/*.json).
_DEFAULT_BRANCH = "main"
_SWEEP_INTERVAL_S = 3600.0
_PR_TITLE_MAX_CHARS = 60
_PR_BODY = (
    "Opened automatically by Wixy's AI assistant from a chat conversation.\n\n"
    "Nothing here is published on its own — it's a pull request like any other "
    "change to this repo, gated by the same review and CI you'd apply to your "
    "own edits."
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _compose_prompt(preamble: str, first_message: str | None) -> str:
    # Matches CmdAIBackend.create_conversation's own composition exactly (see
    # wixy_server/ai/backend.py) — kept identical across both backends so a
    # conversation looks the same to the model regardless of which one is
    # driving it.
    return preamble if not first_message else f"{preamble}\n\n---\n\n{first_message}"


def _compose_pr_title(title_hint: str) -> str:
    # Same word-boundary truncation as routes_chat.py's own
    # _title_from_first_message (spec/06 §1) — kept independent rather than
    # imported since that function lives in a main-server-only module the
    # worker doesn't otherwise depend on.
    collapsed = " ".join(title_hint.split())
    if not collapsed:
        return "Wixy AI: site update"
    if len(collapsed) <= _PR_TITLE_MAX_CHARS:
        return f"Wixy AI: {collapsed}"
    truncated = collapsed[:_PR_TITLE_MAX_CHARS]
    boundary = truncated.rfind(" ")
    head = (truncated[:boundary] if boundary > 0 else truncated).rstrip()
    return f"Wixy AI: {head}…"


def _append_error(conv: WorkerConversation, text: str) -> None:
    conv.append(
        WorkerMessage(
            index=conv.next_index(),
            role="assistant",
            kind="error",
            text=text,
            timestamp=_now_iso(),
        )
    )


async def _ensure_workspace(
    conv: WorkerConversation, dest: Path, settings: WorkerSettings
) -> bool:
    """Provisions `dest` (clone + branch) the first time this conversation
    runs a turn — a no-op on every later turn (`workspace_provisioned` already
    True). Returns whether the conversation is safe to proceed (False means a
    `workspace_failed` outcome was already recorded and the caller must stop).
    """
    if conv.workspace_provisioned:
        return True
    try:
        await anyio.to_thread.run_sync(
            lambda: provision_workspace(
                clone_url=github_https_clone_url(settings.site_repo_url),
                default_branch=_DEFAULT_BRANCH,
                branch_name=conv.branch_name,
                dest=dest,
                pat=settings.bot_pat,
            )
        )
    except WorkspaceError as exc:
        conv.failure_reason = "workspace_failed"
        conv.failure_message = str(exc)
        _append_error(conv, f"Couldn't set up a workspace to make this change: {exc}")
        return False
    conv.workspace_provisioned = True
    return True


async def _ship_if_new_commits(
    conv: WorkerConversation,
    dest: Path,
    settings: WorkerSettings,
    head_before: str,
    title_hint: str,
    github_client_factory: Callable[[], GitHubClient],
) -> None:
    """Pushes + (first time only) opens a PR — but only if the turn that just
    ran actually produced a new commit (spec §2: agents "ship a PR"; a turn
    that only answered a question, with no edits, must never push an empty
    branch or open an empty PR). `github_client_factory` mirrors
    `wixy_server.app.create_app`'s own `github_client` override — tests point
    it at a fake GitHub double (`httpx.ASGITransport`) instead of the real
    api.github.com, exactly like `test_github.py` already does for the main
    server's client."""
    try:
        head_after = await anyio.to_thread.run_sync(head_sha, dest)
    except WorkspaceError:
        return  # the workspace itself is in a bad state; nothing more to do here
    if head_after == head_before:
        return
    try:
        await anyio.to_thread.run_sync(
            lambda: push_branch(dest=dest, branch_name=conv.branch_name, pat=settings.bot_pat)
        )
        if conv.pr_url is None:
            async with github_client_factory() as gh:
                pr = await gh.create_pull_request(
                    owner_repo_slug(settings.site_repo_url),
                    head=conv.branch_name,
                    base=_DEFAULT_BRANCH,
                    title=_compose_pr_title(title_hint),
                    body=_PR_BODY,
                )
            conv.pr_url = pr.html_url
    except (WorkspaceError, GitHubApiError) as exc:
        _append_error(
            conv, f"Your changes were saved, but I couldn't publish them as a pull request: {exc}"
        )


async def _run_and_track(
    conv: WorkerConversation,
    prompt: str,
    state: WorkerState,
    cwd: str,
    settings: WorkerSettings,
    client_factory: AgentSDKClientFactory | None,
    title_hint: str,
    github_client_factory: Callable[[], GitHubClient],
) -> None:
    """Fire-and-forget background task (spawned per create/send via `TaskGroup.
    start_soon`, which only ever forwards POSITIONAL args — no keyword-only
    parameters here, unlike this codebase's usual convention, specifically
    because of that constraint) — shares its task group with the scratch
    sweep AND every OTHER conversation's own turn (`lifespan`'s
    `background_tasks`), so an uncaught exception ANYWHERE below would take
    the whole worker down via anyio's fail-one-cancel-all TaskGroup semantics,
    not just fail this one conversation. `_ensure_workspace`/
    `_ship_if_new_commits` already catch the SPECIFIC failures this module
    anticipates (`WorkspaceError`/`GitHubApiError`) for a precise
    `failure_reason` — this outer catch is the backstop for anything neither
    anticipates (e.g. `subprocess.TimeoutExpired` from a hung git clone/push:
    `wixy_server.checkout.run_git` doesn't catch that itself, matching
    `wixy_server.publisher`'s own pre-existing gap there — but publisher.py's
    failure mode is one failed HTTP request, not a shared task group).

    The transcript (spec §2: "persists conversations as JSONL") is written
    ONCE here, in a `finally`, rather than scattered across every place a
    message gets appended — this is the one place guaranteed to run after
    EVERY turn settles, success or failure, so it always captures the full,
    current `conv.messages` regardless of which internal path was taken.
    """
    try:
        await _run_and_track_inner(
            conv, prompt, state, cwd, settings, client_factory, title_hint, github_client_factory
        )
    except Exception:  # noqa: BLE001 - see docstring: must never crash the worker
        logger.exception("conversation %s: unexpected failure running a turn", conv.conv_id)
        if conv.failure_reason is None:
            conv.failure_reason = "agent_run_failed"
            conv.failure_message = "An unexpected error occurred while running this turn."
    finally:
        await anyio.to_thread.run_sync(
            lambda: write_transcript(settings.transcripts_root, conv.conv_id, conv.messages)
        )


async def _run_and_track_inner(
    conv: WorkerConversation,
    prompt: str,
    state: WorkerState,
    cwd: str,
    settings: WorkerSettings,
    client_factory: AgentSDKClientFactory | None,
    title_hint: str,
    github_client_factory: Callable[[], GitHubClient],
) -> None:
    """`settings.site_repo_url` empty (not configured — see settings.py's own
    docstring) skips ALL workspace/git handling below, matching this
    function's pre-M6-slice-2 behavior exactly: a bare scratch dir, no clone,
    no push, no PR. Every pre-existing test (none of which set up a fake git
    remote) keeps passing unchanged; the real compose deployment always has
    `WIXY_SITE_REPO` set (`setup.sh`'s own required prompt), so this is a
    test/dev-only degrade path in practice, not a silent production gap.
    """
    dest = Path(cwd)
    has_repo = bool(settings.site_repo_url)

    if has_repo and not await _ensure_workspace(conv, dest, settings):
        return
    conv.ready = True

    head_before: str | None = None
    if has_repo:
        try:
            head_before = await anyio.to_thread.run_sync(head_sha, dest)
        except WorkspaceError:
            head_before = None  # shouldn't happen right after a successful provision

    try:
        await run_turn(
            conv,
            prompt,
            cwd=cwd,
            max_budget_usd=settings.monthly_budget_usd,
            client_factory=client_factory,
        )
        state.month_to_date_usd += conv.total_cost_usd
    except Exception as exc:  # noqa: BLE001 - genuinely any SDK/transport failure lands here
        conv.failure_reason = "agent_run_failed"
        conv.failure_message = str(exc)
        return
    finally:
        if has_repo:
            await anyio.to_thread.run_sync(touch_activity, dest)

    if has_repo and head_before is not None:
        await _ship_if_new_commits(
            conv, dest, settings, head_before, title_hint, github_client_factory
        )


async def _run_scratch_sweep(settings: WorkerSettings) -> None:
    """Background loop (started from `lifespan`, cancelled alongside the rest
    of the app's task group at shutdown) — an immediate sweep at startup
    (catches anything left over from a previous worker lifetime) then hourly
    thereafter.

    This task shares its task group with every in-flight conversation's own
    `_run_and_track` (`lifespan`'s `background_tasks` — the same group). An
    uncaught exception here would propagate through anyio's own
    fail-one-cancel-all TaskGroup semantics and take the ENTIRE worker down
    over a mere cleanup hiccup (a locked file, a permissions edge case) — the
    `except` below is what keeps "scratch clones cleaned" a best-effort
    hygiene pass, never a crash risk for the actual product.
    """
    while True:
        try:
            # Wall-clock epoch time, matching `Path.stat().st_mtime` — NOT
            # `anyio.current_time()`, which is a monotonic clock with no
            # fixed epoch and would make every idle-age comparison
            # meaningless.
            await anyio.to_thread.run_sync(
                lambda: sweep_idle_workspaces(settings.scratch_root, now=time.time())
            )
        except Exception:  # noqa: BLE001 - see docstring: must never crash the worker
            logger.exception("scratch-workspace sweep failed; will retry next interval")
        await anyio.sleep(_SWEEP_INTERVAL_S)


def create_worker_app(
    *,
    settings: WorkerSettings | None = None,
    client_factory: AgentSDKClientFactory | None = None,
    github_client_factory: Callable[[], GitHubClient] | None = None,
) -> FastAPI:
    """`client_factory` overridable so tests inject `fake_agent_sdk.py`'s
    scripted double instead of the real SDK. `settings` overridable so tests
    don't need real env vars or a real scratch-root filesystem layout.
    `github_client_factory` overridable so tests point the PR-open call at a
    fake GitHub double instead of the real api.github.com — same reasoning as
    `wixy_server.app.create_app`'s own `github_client` override.

    `router` is constructed FRESH here, not at module scope — every route
    handler below closes over this call's own `state`/`resolved_settings`/
    `client_factory` directly (unlike `wixy_server/routes_engine.py`'s own
    module-level router, whose handlers read everything from
    `request.app.state` instead and so have no such closure to worry about).
    A shared module-level router would accumulate handlers across every call
    to this factory, with FastAPI matching routes in registration order —
    the first test to build a worker app would silently keep intercepting
    every later test's requests with ITS OWN stale `state` and (empty, by
    default) `client_factory`. Caught by two tests in the same file
    interfering with each other under pytest despite passing individually —
    see decisions/00059 for the full diagnosis.
    """
    resolved_settings = settings if settings is not None else load_worker_settings()
    resolved_github_client_factory = (
        github_client_factory
        if github_client_factory is not None
        else lambda: GitHubClient(pat=resolved_settings.bot_pat)
    )
    state = WorkerState()
    router = APIRouter(prefix="/conversations")

    @router.post("", response_model=None)
    async def create_conversation(request: Request) -> JSONResponse:
        if state.month_to_date_usd >= resolved_settings.monthly_budget_usd:
            # spec §2: "refuses new conversations past the cap with a friendly
            # message" — 402 Payment Required is the literal HTTP status for
            # exactly this ("the request can't be fulfilled without payment"),
            # closest fit in the spec without inventing a bespoke code.
            raise HTTPException(
                status_code=402,
                detail=(
                    "This month's AI budget has been used up. It resets on the 1st, "
                    "or you can raise the limit in your Anthropic console."
                ),
            )
        body = await request.json()
        preamble = body.get("preamble", "") if isinstance(body, dict) else ""
        first_message = body.get("firstMessage") if isinstance(body, dict) else None
        conv = state.new_conversation(preamble)
        if isinstance(first_message, str) and first_message:
            # Readiness is set by `_run_and_track` itself once workspace
            # provisioning (if any repo is configured) succeeds — see that
            # function's own docstring and AnthropicAIBackend's generous
            # readiness_timeout_s, sized for exactly this clone-before-ready
            # sequencing. Nothing to wait for below (no first message means no
            # background task at all yet), so THAT path still flips it here.
            conv.append(
                WorkerMessage(
                    index=conv.next_index(),
                    role="user",
                    kind="text",
                    text=first_message,
                    timestamp=_now_iso(),
                )
            )
            scratch_dir = resolved_settings.scratch_root / conv.conv_id
            await anyio.to_thread.run_sync(lambda: scratch_dir.mkdir(parents=True, exist_ok=True))
            prompt = _compose_prompt(conv.preamble, first_message)
            request.app.state.background_tasks.start_soon(
                _run_and_track,
                conv,
                prompt,
                state,
                str(scratch_dir),
                resolved_settings,
                client_factory,
                first_message,
                resolved_github_client_factory,
            )
        else:
            conv.ready = True
        return JSONResponse(
            status_code=202, content={"convId": conv.conv_id, "pendingState": "queued"}
        )

    @router.get("/{conv_id}/status", response_model=None)
    async def get_status(conv_id: str) -> JsonObject:
        conv = state.conversations.get(conv_id)
        if conv is None:
            raise HTTPException(status_code=404, detail="unknown conversation")
        return {
            "activity": conv.activity,
            "ready": conv.ready,
            "failureReason": conv.failure_reason,
            "failureMessage": conv.failure_message,
        }

    @router.post("/{conv_id}/messages", response_model=None, status_code=202)
    async def send_message(conv_id: str, request: Request) -> JsonObject:
        conv = state.conversations.get(conv_id)
        if conv is None:
            raise HTTPException(status_code=404, detail="unknown conversation")
        body = await request.json()
        text = body.get("text", "") if isinstance(body, dict) else ""
        idem_key = body.get("idempotencyKey") if isinstance(body, dict) else None
        if isinstance(idem_key, str):
            seen_count = conv.idempotency_seen.get(idem_key, 0)
            conv.idempotency_seen[idem_key] = seen_count + 1
            if seen_count > 0:
                # Same idempotency key seen before — the send already
                # happened; report accepted without re-running the agent
                # (spec/06 §1's own "a UI retry can't double-send" contract,
                # extended to this backend).
                return {"accepted": True, "buffered": False}
        conv.append(
            WorkerMessage(
                index=conv.next_index(), role="user", kind="text", text=text, timestamp=_now_iso()
            )
        )
        scratch_dir = resolved_settings.scratch_root / conv.conv_id
        # Idempotent (exist_ok=True) — already created by `create_conversation`
        # if THAT turn had a first message; a conversation created bare (no
        # first message) never got one, so this is the only mkdir its first
        # real turn (this send) ever sees. `provision_workspace` (workspace.py)
        # clones straight into this dir fine either way — `git clone` accepts
        # an already-existing but EMPTY destination.
        await anyio.to_thread.run_sync(lambda: scratch_dir.mkdir(parents=True, exist_ok=True))
        request.app.state.background_tasks.start_soon(
            _run_and_track,
            conv,
            text,
            state,
            str(scratch_dir),
            resolved_settings,
            client_factory,
            text,
            resolved_github_client_factory,
        )
        return {"accepted": True, "buffered": False}

    @router.get("/{conv_id}/messages", response_model=None)
    async def get_messages(
        conv_id: str, limit: int = 80, after: int | None = None, includeThinking: bool = False
    ) -> JsonObject:
        conv = state.conversations.get(conv_id)
        if conv is None:
            raise HTTPException(status_code=404, detail="unknown conversation")
        items = conv.messages
        if not includeThinking:
            items = [m for m in items if m.kind != "thinking"]
        if after is not None:
            items = [m for m in items if m.index > after]
        if limit > 0:
            items = items[-limit:]
        return {"messages": [m.to_json() for m in items]}

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        async with anyio.create_task_group() as tg:
            _app.state.background_tasks = tg
            tg.start_soon(_run_scratch_sweep, resolved_settings)
            yield
            tg.cancel_scope.cancel()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = resolved_settings
    app.state.worker_state = state
    app.include_router(router)

    @app.get("/budget", response_model=None)
    async def get_budget() -> JsonObject:
        # spec §2: "the worker tracks spend... the Settings -> AI card shows
        # month-to-date spend" — top-level, not under `/conversations`
        # (`router`'s own prefix): budget is a property of the WORKER, not of
        # any one conversation. `wixy_server.ai.anthropic_backend.
        # AnthropicAIBackend.get_budget_status` is this route's client.
        return {
            "monthToDateUsd": state.month_to_date_usd,
            "monthlyBudgetUsd": resolved_settings.monthly_budget_usd,
        }

    return app
