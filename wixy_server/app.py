"""The Wixy FastAPI app (spec/04-server.md). Milestone 6's final slice (slice 4 of the
PR train, decisions/00010) wires: public serving (§3), CF Access JWT (§9), the
`/api/admin/state|content|draft|media(list)` subset (§8), `/internal/*` + `/healthz`
(§9-10), `/api/version` (§9/07 §1), and a minimal instant-render admin shell (§5). See
decisions/00014 for this slice's design choices. Slice 3's preview route
(`GET /admin/preview/{page}.html`) now lives in `wixy_server/routes_preview`.
"""

from __future__ import annotations

import functools
import logging
import re
import shutil
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import anyio
import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException as FastAPIHTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from wixy_server.ai.anthropic_backend import AnthropicAIBackend
from wixy_server.ai.backend import AIBackend, CmdAIBackend
from wixy_server.auth import JwksCache, build_admin_auth_middleware, jwks_url, verify_access_jwt
from wixy_server.background import BackgroundTaskHealth, ContainedTaskGroup
from wixy_server.bootstrap import bootstrap_if_needed
from wixy_server.chat_sends import ChatSendsCache
from wixy_server.chat_working import WorkingCache
from wixy_server.chats import ChatRuntimeEntry
from wixy_server.cmdchat import CmdChatClient
from wixy_server.github import GitHubClient
from wixy_server.livechat import janitor as livechat_janitor
from wixy_server.livechat import media_queue as livechat_media_queue
from wixy_server.livechat import processing as livechat_processing
from wixy_server.livechat import thumbnails as livechat_thumbnails
from wixy_server.livechat.adventure_bank import AdventureBank, load_bank_or_empty
from wixy_server.livechat.adventure_game import ADVENTURE_LIVE_BATCHES_PER_SECOND
from wixy_server.livechat.adventure_pack import (
    RESEARCH_DIRNAME,
    AdventurePackRunner,
    AdventureResearcher,
    CmdAdventureResearcher,
    PackTiming,
)
from wixy_server.livechat.adventure_pictures import (
    AdventurePictureFinder,
    AdventurePictureJob,
    PictureTiming,
    WebPictureFinder,
)
from wixy_server.livechat.call_broker import CallBroker
from wixy_server.livechat.cookout_ai import (
    AiBank,
    CmdCookoutRunner,
    CookoutTiming,
    build_cookout_runner,
)
from wixy_server.livechat.cookout_game import (
    BankLike as CookoutBankLike,
)
from wixy_server.livechat.cookout_game import (
    CookoutRunner,
    NullCookoutRunner,
    default_bank,
)
from wixy_server.livechat.cookout_pack import SLOT_REFRESH_S, PackStore
from wixy_server.livechat.cookout_visuals import (
    IMAGE_ROUTE_PREFIX,
    CookoutVisualsService,
    IngredientVisuals,
    is_sha,
    load_visuals,
    search_path,
    set_default_visuals,
)
from wixy_server.livechat.drawing_broker import DrawingBroker
from wixy_server.livechat.drawings import MAX_LIVE_BATCHES_PER_SECOND
from wixy_server.livechat.grants import GrantFailureLimiter
from wixy_server.livechat.models import MessageHook, MessageRow
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.pinclient import CmdPinVerifier, PinVerifier
from wixy_server.livechat.push import (
    dispatch_push_notifications,
    load_or_create_vapid_keys,
)
from wixy_server.livechat.safe_fetch import SafeFetcher
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.sw import server_sw_response
from wixy_server.livechat.tokens import load_or_create_secret
from wixy_server.livechat.transcribe import CmdTranscriber, Transcriber
from wixy_server.livechat.transcription import (
    SlidingWindowRateLimiter,
    TranscriptionRuntime,
)
from wixy_server.livechat.wyr_game import (
    WyrDemand,
    clear_wyr_scratch,
    run_wyr_pool_forever,
    run_wyr_sweep_forever,
    wyr_image_limiter,
)
from wixy_server.livechat.wyr_images import ComfyImageGenerator
from wixy_server.livechat.wyr_pool import WyrPool
from wixy_server.livechat.wyr_questions import load_questions as load_wyr_questions
from wixy_server.publisher import PublishJob
from wixy_server.redirects import load_redirects
from wixy_server.registry import load_registry
from wixy_server.robots_header import build_robots_header_middleware
from wixy_server.routes_admin_api import router as admin_api_router
from wixy_server.routes_ai import router as ai_router
from wixy_server.routes_chat import StreamTiming
from wixy_server.routes_chat import router as chat_router
from wixy_server.routes_engine import EngineStatusCache
from wixy_server.routes_engine import router as engine_router
from wixy_server.routes_internal import router as internal_router
from wixy_server.routes_livechat import router as livechat_router
from wixy_server.routes_livechat_adventure import router as livechat_adventure_router
from wixy_server.routes_livechat_calls import router as livechat_calls_router
from wixy_server.routes_livechat_cookout import router as livechat_cookout_router
from wixy_server.routes_livechat_media import router as livechat_media_router
from wixy_server.routes_preview import DEFAULT_PREVIEW_STALENESS_THRESHOLD_S
from wixy_server.routes_preview import router as preview_router
from wixy_server.routes_public import router as public_router
from wixy_server.routes_system import router as system_router
from wixy_server.routes_version import router as version_router
from wixy_server.routes_versions import router as versions_router
from wixy_server.settings import load_settings
from wixy_server.staticcache import FingerprintedStaticFiles, fingerprinted_url
from wixy_server.storage import ensure_project_dirs, project_paths
from wixy_server.watcher import DEFAULT_INTERVAL_S, WatcherStatus, fetch_once, watch_upstream

_STATIC_DIR = Path(__file__).parent / "static"


def _fingerprint_shell_assets(shell_html: str) -> str:
    """Rewrite every `src`/`href` pointing into `/admin/static/` to its
    content-fingerprinted `?v=<hash>` form (wixy_server/staticcache.py —
    decisions/00069). Done once at import, on the same cached string the shell
    route serves, so a rebuilt bundle is a new URL on the very next deploy and
    no cache layer can serve a stale copy. A reference whose file is missing
    keeps its bare URL (fingerprinted_url's own fallback)."""

    def repl(match: re.Match[str]) -> str:
        attr, url, quote = match.group(1), match.group(2), match.group(3)
        on_disk = _STATIC_DIR / url.removeprefix("/admin/static/")
        return f'{attr}="{fingerprinted_url(url, on_disk)}{quote}'

    return re.sub(r'(src|href)="(/admin/static/[^"?]+)(")', repl, shell_html)


_ADMIN_SHELL_HTML = _fingerprint_shell_assets(
    (_STATIC_DIR / "admin_shell.html").read_text(encoding="utf-8")
)
# Uxer MCP compliance-bridge integration (slice 7, decisions/00050). `Uxer/`
# is gitignored (cloned + `npm run build` locally per UXER-INTEGRATION.md's
# "Web Application Integration" section) and won't exist on a fresh checkout
# or the deployed slot unless someone's explicitly built it there — this is
# an AI/MCP-tooling-only surface gated behind `?uxer=` client-side (see
# admin_shell.html), so a missing bundle just means the overlay never
# activates, not a broken app.
_REPO_ROOT = Path(__file__).parent.parent
_UXER_DIST_DIR = _REPO_ROOT / "Uxer" / "web" / "dist"
_UXER_STYLE_PATH = _REPO_ROOT / "uxer-style.json"
_UXER_WEB_PORT_PATH = _REPO_ROOT / ".uxer-web-port"
# The independence-phase HTML guide (milestone 8, spec/independence/07) — built
# by `guide.build` (source in `guide/`, committed output here, same "committed
# bundle, CI checks for drift" convention admin-ui/editor already use). A
# DEDICATED mount, not nested under `/admin/static` — spec's own literal
# wording is "served... at /admin/guide/", not `/admin/static/guide/`.
_GUIDE_DIST_DIR = _STATIC_DIR / "guide"


def create_app(
    *,
    storage_root: Path,
    wixy_repo_root: Path,
    watcher_interval_s: float = DEFAULT_INTERVAL_S,
    preview_staleness_threshold_s: float = DEFAULT_PREVIEW_STALENESS_THRESHOLD_S,
    cmdchat_client: CmdChatClient | None = None,
    chat_stream_timing: StreamTiming | None = None,
    github_client: GitHubClient | None = None,
    ai_backend: AIBackend | None = None,
    pin_verifier: PinVerifier | None = None,
    transcriber: Transcriber | None = None,
    image_generator: ComfyImageGenerator | None = None,
    adventure_bank: AdventureBank | None = None,
    adventure_researcher: AdventureResearcher | None = None,
    adventure_pack_timing: PackTiming | None = None,
    adventure_picture_finder: AdventurePictureFinder | None = None,
    adventure_picture_timing: PictureTiming | None = None,
    cookout_timing: CookoutTiming | None = None,
    cookout_bank: CookoutBankLike | None = None,
    cookout_runner: CookoutRunner | None = None,
    cookout_cmd_client: CmdChatClient | None = None,
    cookout_visuals: IngredientVisuals | None = None,
    cookout_visuals_refresh_s: float = SLOT_REFRESH_S,
) -> FastAPI:
    """Build the Wixy FastAPI app for one project.

    `storage_root` is the Storage tree root (spec/04 §2) — tests always pass a
    `tmp_path`-backed one; the real production default only exists from milestone 11's
    install onward. `wixy_repo_root` is the wixy repo checkout this process runs from
    (where `projects/*.json` lives, spec/04 §1) — milestone 11's launcher resolves this
    for real; this function never guesses a default for either path. `cmdchat_client`
    defaults to a real `CmdChatClient()` (localhost cmd, spec/06 §1) — overridable so
    the E2E fixture server can point it at a fake cmd instead (milestone 10 slice 5).
    Wrapped in `CmdAIBackend`, one of two backend candidates `app.state.ai_backend`
    (spec/independence/05 §1) is picked from — `settings.ai_backend` (`WIXY_AI_BACKEND`)
    chooses `cmd` vs `anthropic` unless the `ai_backend` PARAMETER below overrides that
    choice outright. `cmdchat_client` itself stays its own separate override point
    (every existing test constructs a fake-cmd-pointed `CmdChatClient` this way;
    wrapping it internally means none of them need to change for this extraction).
    `chat_stream_timing` defaults to spec/06 §1's own numbers (1.2s poll, 10s offline
    retry, 15s transcript-lag grace) — overridable so tests don't have to wait out
    real multi-second intervals to exercise the stream's timing-dependent branches.
    `github_client` defaults to a real `GitHubClient(pat=settings.engine_pat)`
    (spec/independence/04 §2) — overridable so tests point `routes_engine.py` at a
    fake GitHub double instead, same reason `cmdchat_client` is. Constructed
    unconditionally (even on the fleet edition, where `engine_pat` is empty and
    `_require_standalone` 404s before ever touching it) — same posture `cmdchat_client`
    already takes, no per-edition branching needed. `ai_backend` (the parameter)
    overrides `settings.ai_backend`'s choice entirely — tests that want to exercise
    `AnthropicAIBackend` specifically pass one pointed at a fake worker
    (`wixy_server.tests.fake_worker`), same reasoning as every override above; both
    concrete backends are still constructed unconditionally below (same "no
    per-edition branching, everything closes uniformly at shutdown" posture as
    `gh_client`), only WHICH ONE gets exposed on `app.state` branches.
    `pin_verifier` (spec/server-chat/00-brief.md R4/§5.1): the server-chat PIN
    gate's `PinVerifier`. Defaults to `CmdPinVerifier()` on the fleet edition
    (`settings.edition != "standalone"`), `None` on standalone (no cmd there —
    `POST /unlock` then always answers 503 `not_configured`) — overridable so
    tests point it at `fake_cmd.py`'s `/api/pins/<app_key>/verify` double instead, same
    injection seam as `cmdchat_client`/`ai_backend`/`github_client` above.
    `transcriber` (spec/server-chat/05-voice-transcription.md): the private voice-
    transcription hop to cmd. Same seam and same per-edition default as `pin_verifier`
    (`CmdTranscriber()` on the fleet, `None` on standalone — the feature is then always
    unavailable). It only ever talks to cmd through cmd's private mode, and only once cmd's
    capability probe says `private: true`.
    `image_generator` (workspace 00045): the would-you-rather game's on-demand image painter
    (a `ComfyImageGenerator`). Defaults to one built from `WIXY_COMFY_URL` on the fleet edition
    and `None` when that is unset or on standalone — rounds are then text-only.
    `adventure_bank` (workspace 00056): the Adventure Time destination bank. Defaults to the
    shipped `adventure_destinations.json`, validated strictly at start (a broken file is logged
    and the game then answers 503 `game_unavailable`); tests pass a small fixture bank.
    `cookout_cmd_client`: the cmd client the default Cookout runner uses instead of
    `cmdchat_client` (the e2e fixture points it at its second, never-stopped fake cmd, as it does
    the Adventure researcher).
    `adventure_researcher`: what researches a chosen destination's holiday pack. Defaults to a
    `CmdAdventureResearcher` over `chat_client` on the fleet edition when the AI backend is cmd,
    and `None` otherwise (standalone: every pack is `unavailable` at once; Bank/Reject still
    work) — overridable so tests and the e2e fixture inject a fake. `adventure_pack_timing` shortens
    the job's pacing (poll interval, spawn gap, give-up) for tests and the fixture.
    `adventure_picture_finder`: what finds a ready holiday pack's pictures (spec §4.3a). Defaults to
    a `WebPictureFinder` over a production `SafeFetcher` ONLY on the same default path as the
    researcher (fleet edition, cmd AI backend, no researcher injected) and only with the media
    pipeline available; an injected researcher therefore never reaches the internet unless the test
    also injects a finder. Standalone / no researcher / no media pipeline: a pack has no pictures.
    `adventure_picture_timing` shortens how long a `pending` picture wait must last before the
    supervised sweep re-runs its hunt, and how often the sweep looks (tests).
    """
    settings = load_settings(storage_root)
    registry = load_registry(wixy_repo_root)
    projects = registry.all()
    if len(projects) != 1:
        # spec/04 §1: "v1 runs with exactly one but nothing may assume that" — read as
        # "don't hardcode a slug," not "build multi-project routing that isn't in the
        # spec's own route table" (decisions/00013). A registry with any other count is
        # a real misconfiguration for what this app can serve today.
        raise RuntimeError(
            "wixy_server.app v1 requires exactly one registered project, found "
            f"{len(projects)} ({[p.slug for p in projects]})"
        )
    project = projects[0]
    paths = project_paths(storage_root, project.slug)
    ensure_project_dirs(paths)
    watcher_status = WatcherStatus()
    publish_job: PublishJob | None = None
    chat_client = cmdchat_client if cmdchat_client is not None else CmdChatClient()
    if ai_backend is not None:
        resolved_ai_backend: AIBackend = ai_backend
    elif settings.ai_backend == "anthropic":
        resolved_ai_backend = AnthropicAIBackend()
    else:
        resolved_ai_backend = CmdAIBackend(chat_client, cmd_project=project.cmd_project)
    chat_runtime: dict[str, ChatRuntimeEntry] = {}
    stream_timing = chat_stream_timing if chat_stream_timing is not None else StreamTiming()
    gh_client = (
        github_client if github_client is not None else GitHubClient(pat=settings.engine_pat)
    )

    # spec/server-chat/00-brief.md §4/§10 P1: the "Server" panel's own store +
    # secret, entirely separate from every above (Inv 40 — private data, never in
    # the site repo/builds/publish/reports/backups). `secret.key` load-or-create is
    # a blocking file op, same posture as `ensure_project_dirs` a few lines up —
    # this whole function is plain synchronous setup, not an async context.
    livechat_store = LiveChatStore(paths.server_db)
    livechat_secret = load_or_create_secret(paths.server_secret)
    livechat_vapid_keys = load_or_create_vapid_keys(paths.server_vapid)
    livechat_push_client = httpx.AsyncClient(timeout=10.0)
    livechat_push_test_limiter = SlidingWindowRateLimiter(max_events=1, window_s=5.0)
    livechat_notifier = LiveChatNotifier()
    livechat_message_hooks: list[MessageHook] = []
    # spec/server-chat/07-live-drawing.md §4: an in-progress stroke's points relay
    # through this in-process broker, never through the notifier (which carries no
    # data) or the database (Inv 40/46 — live points are chat content).
    livechat_drawing_broker = DrawingBroker()
    livechat_drawing_live_limiter = SlidingWindowRateLimiter(
        max_events=MAX_LIVE_BATCHES_PER_SECOND, window_s=1.0
    )

    async def dispatch_server_push(message: MessageRow) -> None:
        await dispatch_push_notifications(
            message,
            store=livechat_store,
            client=livechat_push_client,
            project_domain=project.domain,
            keys=livechat_vapid_keys,
        )

    livechat_message_hooks.append(dispatch_server_push)
    livechat_started_at = time.time()
    # spec/server-chat/00-brief.md §7 Dependencies, §10 P2b: resolved once at
    # startup (WIXY_FFMPEG/WIXY_FFPROBE, falling back to `shutil.which`), not
    # per-request — `resolve_binaries` itself ERROR-logs when either binary is
    # missing. Both binaries and pillow-heif must be available before uploads
    # and the queue are enabled; text chat keeps working regardless.
    livechat_queue_config = livechat_media_queue.resolve_binaries(
        settings.ffmpeg_path, settings.ffprobe_path
    )
    livechat_media_available = (
        livechat_queue_config is not None and livechat_processing.PILLOW_HEIF_AVAILABLE
    )
    if pin_verifier is not None:
        resolved_pin_verifier: PinVerifier | None = pin_verifier
    elif settings.edition == "standalone":
        # R4: "there's no PIN verifier, so /unlock -> 503 not_configured" — no cmd
        # on her droplet to call.
        resolved_pin_verifier = None
    else:
        resolved_pin_verifier = CmdPinVerifier(app_key=settings.server_pin_app_key)
    if transcriber is not None:
        resolved_transcriber: Transcriber | None = transcriber
    elif settings.edition == "standalone":
        resolved_transcriber = None
    else:
        resolved_transcriber = CmdTranscriber()
    # Would-you-rather game (workspace 00045): the question bank loads once; the image
    # generator is the optional local-ComfyUI client (`WIXY_COMFY_URL`; empty / standalone
    # edition = text-only cards). A test passes its own generator the way it passes a
    # `transcriber`.
    wyr_questions = load_wyr_questions()
    if image_generator is not None:
        resolved_image_generator: ComfyImageGenerator | None = image_generator
    elif settings.comfy_url and settings.edition != "standalone":
        if settings.comfy_output_dir:
            resolved_image_generator = ComfyImageGenerator(
                settings.comfy_url,
                model=settings.wyr_image_model,
                output_dir=Path(settings.comfy_output_dir),
            )
        else:
            # Fail closed: ComfyUI keeps every picture it renders in its own output folder, and
            # without knowing that folder this server could never delete them (Inv 54).
            logging.getLogger(__name__).error(
                "WIXY_COMFY_URL is set but WIXY_COMFY_OUTPUT_DIR is not — would-you-rather "
                "pictures are DISABLED (rounds are text-only) until the folder ComfyUI writes "
                "to is configured"
            )
            resolved_image_generator = None
    else:
        resolved_image_generator = None
    # The picture pool (pictures painted ahead for upcoming questions) only exists beside a
    # generator and only when its size is non-zero; switched off, any stale pool is removed.
    wyr_pool: WyrPool | None = (
        WyrPool(paths.server_dir / "wyr-pool")
        if resolved_image_generator is not None and settings.wyr_pool_size > 0
        else None
    )
    wyr_demand = WyrDemand()
    # Adventure Time (workspace 00056): the destination bank loads once; the holiday-pack runner
    # needs a researcher — cmd-backed on the fleet when the AI backend is cmd, none otherwise.
    resolved_adventure_bank = adventure_bank if adventure_bank is not None else load_bank_or_empty()
    owned_picture_finder: WebPictureFinder | None = None
    if adventure_researcher is not None:
        resolved_adventure_researcher: AdventureResearcher | None = adventure_researcher
    elif settings.edition != "standalone" and isinstance(resolved_ai_backend, CmdAIBackend):
        resolved_adventure_researcher = CmdAdventureResearcher(chat_client)
        if adventure_picture_finder is None and livechat_media_available:
            # The production picture sources: the one SSRF-safe fetcher with its default (strict)
            # address policy, ports and certificate checks — nothing here relaxes any of it.
            owned_picture_finder = WebPictureFinder(SafeFetcher())
    else:
        resolved_adventure_researcher = None
    resolved_picture_finder: AdventurePictureFinder | None = (
        adventure_picture_finder if adventure_picture_finder is not None else owned_picture_finder
    )

    def _picture_space_ok(size_bytes: int) -> bool:
        """Room for a pack's pictures: under the chat-media quota and above the free-space floor
        (the checks an upload makes at init)."""
        used = livechat_store.media_bytes_used() + livechat_store.pending_upload_bytes()
        if used + size_bytes > settings.server_media_quota_bytes:
            return False
        free = shutil.disk_usage(paths.root).free
        return free - size_bytes >= settings.server_min_free_bytes

    adventure_picture_job: AdventurePictureJob | None = (
        AdventurePictureJob(
            store=livechat_store,
            paths=paths,
            bank=resolved_adventure_bank,
            finder=resolved_picture_finder,
            notifier=livechat_notifier,
            space_ok=_picture_space_ok,
            timing=adventure_picture_timing,
        )
        if resolved_picture_finder is not None and resolved_adventure_researcher is not None
        else None
    )
    livechat_adventure_runner = AdventurePackRunner(
        store=livechat_store,
        bank=resolved_adventure_bank,
        researcher=resolved_adventure_researcher,
        notifier=livechat_notifier,
        cwd=paths.server_dir / RESEARCH_DIRNAME,
        timing=adventure_pack_timing,
        pictures=adventure_picture_job,
    )
    livechat_adventure_live_limiter = SlidingWindowRateLimiter(
        max_events=ADVENTURE_LIVE_BATCHES_PER_SECOND, window_s=1.0
    )
    # Cookout (workspace 00058): the ingredient bank loads once. The fleet edition on the cmd AI
    # backend gets the real runner (concept + recipe runs through cmd, dish pictures on the shared
    # ComfyUI); any other edition has none, so the game is fully playable but its dish ideas and
    # recipes are `unavailable`.
    resolved_cookout_bank: CookoutBankLike | None = (
        cookout_bank if cookout_bank is not None else default_bank()
    )
    # Cookout pictures (09b): catalogue + manifest + object search path joined once, installed as
    # the process default every snapshot is enriched from. A test injects its own.
    resolved_cookout_visuals = (
        cookout_visuals
        if cookout_visuals is not None
        else load_visuals(
            search_path(
                settings.storage_root,
                settings.cookout_images_dir,
                settings.cookout_images_baked_dir,
            )
        )
    )
    set_default_visuals(resolved_cookout_visuals)
    cookout_visuals_service = CookoutVisualsService(
        resolved_cookout_visuals,
        PackStore(
            settings.storage_root / "cookout-images",
            min_free_bytes=settings.server_min_free_bytes,
        ),
        refresh_s=cookout_visuals_refresh_s,
    )
    resolved_cookout_runner: CookoutRunner
    if cookout_runner is not None:
        resolved_cookout_runner = cookout_runner
    elif (
        settings.edition != "standalone"
        and isinstance(resolved_ai_backend, CmdAIBackend)
        and resolved_cookout_bank is not None
    ):
        resolved_cookout_runner = build_cookout_runner(
            store=livechat_store,
            bank=cast(AiBank, resolved_cookout_bank),
            client=cookout_cmd_client if cookout_cmd_client is not None else chat_client,
            notifier=livechat_notifier,
            paths=paths,
            generator=resolved_image_generator if livechat_media_available else None,
            limiter=lambda: wyr_image_limiter(app.state),  # `app` is bound below, used lazily
            demand=wyr_demand,
            space_ok=_picture_space_ok,
            timing=cookout_timing,
        )
    else:
        resolved_cookout_runner = NullCookoutRunner()
    livechat_transcription = TranscriptionRuntime(
        store=livechat_store,
        paths=paths,
        notifier=livechat_notifier,
        transcriber=resolved_transcriber,
    )

    jwks = JwksCache(
        fetch=functools.partial(_fetch_jwks, settings.cf_access_team_domain),
    )
    admin_auth = build_admin_auth_middleware(
        dev_no_auth=settings.dev_no_auth,
        jwks=jwks,
        audience=settings.cf_access_aud,
        team_domain=settings.cf_access_team_domain,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # Best-effort initial fetch (fetch_once already swallows CheckoutError) —
        # spec/04 §3's "never crash" posture applies here too: a transient network
        # failure at startup shouldn't prevent the process from coming up; the
        # background watcher keeps retrying, and request-serving routes report
        # 503/CheckoutError until the checkout exists.
        # The picture store's slot pin is registered before anything else touches it (09b B.6).
        await anyio.to_thread.run_sync(cookout_visuals_service.register)
        await anyio.to_thread.run_sync(fetch_once, project, paths, watcher_status)
        # The server's own "publish zero" (spec/07 §1: "the server also
        # self-bootstraps this way on first startup") — a no-op once live.json
        # exists (every startup after the first), and equally a no-op if the fetch
        # just above never got a checkout on disk at all (bootstrap_if_needed does
        # no git I/O of its own, see its own docstring).
        await anyio.to_thread.run_sync(
            bootstrap_if_needed, project, paths, datetime.now(UTC).isoformat()
        )
        # Schema v6 moves the old file marker into SQLite. Retry an unlink that
        # failed during a previous process start before launching the scrubber.
        await anyio.to_thread.run_sync(livechat_store.import_legacy_scrub_marker)
        # No transcription job can be running in a process that has only just started, so a
        # `pending` row belongs to one that died with its process: fail it (the owner can
        # retry) rather than leave a spinner up forever.
        livechat_transcription.reset_loop_state()
        # A game image run that died with the previous process leaves its PNGs in the
        # scratch dir; they are chat content, so they must not outlive it (Inv 54).
        await anyio.to_thread.run_sync(lambda: clear_wyr_scratch(paths))
        if wyr_pool is None:
            await anyio.to_thread.run_sync(WyrPool(paths.server_dir / "wyr-pool").clear)
        await anyio.to_thread.run_sync(
            lambda: livechat_store.fail_stale_wyr_images(now=time.time())
        )
        await anyio.to_thread.run_sync(
            lambda: livechat_store.fail_stale_pending_transcripts(now=time.time())
        )
        if resolved_adventure_researcher is not None:
            # The empty, non-git folder cmd runs the holiday-pack research in (it must exist
            # before cmd is asked to use it as a working directory).
            await anyio.to_thread.run_sync(livechat_adventure_runner.prepare_directory)

        async def _run_watcher() -> None:
            await watch_upstream(
                project, paths, interval_s=watcher_interval_s, status=watcher_status
            )

        async def _run_media_queue() -> None:
            assert livechat_queue_config is not None
            await livechat_media_queue.run_forever(
                store=livechat_store,
                paths=paths,
                notifier=livechat_notifier,
                config=livechat_queue_config,
            )

        async def _run_janitor() -> None:
            # Catch up grid thumbnails for media sent before every video had one (workspace
            # 00046). Idempotent, so a supervised restart of the janitor repeats it harmlessly;
            # a failure must never keep the janitor itself from running.
            try:
                await anyio.to_thread.run_sync(
                    lambda: livechat_thumbnails.backfill_thumbnails(
                        store=livechat_store, paths=paths
                    )
                )
            except Exception:
                logging.getLogger(__name__).exception("server-chat thumbnail backfill failed")
            await livechat_janitor.run_forever(store=livechat_store, paths=paths)

        async def _run_scrubber() -> None:
            await livechat_janitor.run_scrubber_forever(store=livechat_store, paths=paths)

        async def _run_wyr_sweep() -> None:
            assert resolved_image_generator is not None
            await run_wyr_sweep_forever(resolved_image_generator)

        async def _run_wyr_pool() -> None:
            assert resolved_image_generator is not None and wyr_pool is not None
            await run_wyr_pool_forever(
                store=livechat_store,
                paths=paths,
                generator=resolved_image_generator,
                pool=wyr_pool,
                questions=wyr_questions,
                target=settings.wyr_pool_size,
                demand=wyr_demand,
                limiter=lambda: wyr_image_limiter(_app.state),
                min_free_bytes=settings.server_min_free_bytes,
            )

        async def _run_view_once_backstop() -> None:
            await livechat_janitor.run_view_once_backstop_forever(
                store=livechat_store, paths=paths, notifier=livechat_notifier
            )

        try:
            async with anyio.create_task_group() as tg:
                background = ContainedTaskGroup(tg, BackgroundTaskHealth())
                # Route handlers may schedule work, but cannot access the raw task
                # group and accidentally cancel every app-lifetime task.
                _app.state.background_tasks = background
                _app.state.background_health = background.health
                background.supervise("watcher", _run_watcher)
                background.supervise("livechat-erasure", _run_scrubber)
                background.supervise("livechat-view-once-backstop", _run_view_once_backstop)
                # Only started when the media pipeline actually resolved (see
                # `livechat_queue_config` above) — nothing valid to hand it
                # otherwise. The janitor runs regardless: it's pure DB/filesystem
                # housekeeping with no ffmpeg dependency.
                if livechat_media_available:
                    background.supervise("livechat-media", _run_media_queue)
                background.supervise("livechat-janitor", _run_janitor)
                if resolved_image_generator is not None:
                    background.supervise("livechat-wyr-sweep", _run_wyr_sweep)
                if wyr_pool is not None:
                    background.supervise("livechat-wyr-pool", _run_wyr_pool)
                # A holiday pack still `pending` belongs to a job that died with the previous
                # process: resume polling its run, or start one if it never got that far.
                await livechat_adventure_runner.resume(background)
                # ...and a picture wait is never startup-only: a supervised sweep re-runs any hunt
                # pending longer than a hunt can take (a blue/green hand-off can stop the old
                # side mid-hunt after this side's resume), ending a round whose hunts keep dying.
                livechat_adventure_runner.supervise_pictures(background)
                # Cookout: resume any concept/recipe run the previous process left `pending`, and
                # keep the supervised sweep (stale pictures, scratch cleanup) going.
                if isinstance(resolved_cookout_runner, CmdCookoutRunner):
                    await anyio.to_thread.run_sync(resolved_cookout_runner.prepare_directory)
                await resolved_cookout_runner.resume(background)
                resolved_cookout_runner.supervise(background)
                background.supervise("cookout-visuals", cookout_visuals_service.run)
                yield
                tg.cancel_scope.cancel()
        finally:
            cookout_visuals_service.retire()
            livechat_call_broker.shutdown()
            await livechat_push_client.aclose()
            await chat_client.aclose()
            await gh_client.aclose()
            if owned_picture_finder is not None:
                await owned_picture_finder.aclose()
            if resolved_pin_verifier is not None:
                await resolved_pin_verifier.aclose()
            if resolved_transcriber is not None:
                await resolved_transcriber.aclose()
            # `CmdAIBackend.aclose()` is just a passthrough to `chat_client`
            # (already closed above) — closing it again would double-close
            # that same underlying httpx client, so only close
            # `resolved_ai_backend` itself when it's a genuinely SEPARATE
            # resource (AnthropicAIBackend's own httpx client, or an injected
            # override neither of the two concrete types above).
            if not isinstance(resolved_ai_backend, CmdAIBackend):
                await resolved_ai_backend.aclose()

    app = FastAPI(lifespan=lifespan)
    livechat_call_broker = CallBroker()
    app.state.livechat_call_broker = livechat_call_broker
    app.state.call_access_verifier = functools.partial(
        verify_access_jwt,
        jwks=jwks,
        audience=settings.cf_access_aud,
        team_domain=settings.cf_access_team_domain,
    )
    app.state.call_origins = frozenset(
        {f"http://127.0.0.1:{settings.port}", f"http://localhost:{settings.port}"}
        if settings.dev_no_auth
        else {f"https://{project.domain}"}
    )
    app.state.project = project
    app.state.paths = paths
    app.state.settings = settings
    app.state.watcher_status = watcher_status
    app.state.preview_staleness_threshold_s = preview_staleness_threshold_s
    app.state.publish_job = publish_job
    app.state.wixy_repo_root = wixy_repo_root
    app.state.cmdchat_client = chat_client
    app.state.ai_backend = resolved_ai_backend
    app.state.chat_runtime = chat_runtime
    app.state.chat_stream_timing = stream_timing
    app.state.chat_working_cache = WorkingCache()
    app.state.chat_sends = ChatSendsCache(paths.chat_sends_json)
    app.state.github_client = gh_client
    app.state.redirects = load_redirects()
    app.state.engine_status_cache = EngineStatusCache()
    app.state.livechat_store = livechat_store
    app.state.livechat_secret = livechat_secret
    app.state.livechat_vapid_keys = livechat_vapid_keys
    app.state.livechat_push_client = livechat_push_client
    app.state.livechat_push_test_limiter = livechat_push_test_limiter
    app.state.livechat_notifier = livechat_notifier
    app.state.livechat_message_hooks = livechat_message_hooks
    app.state.livechat_media_available = livechat_media_available
    app.state.livechat_started_at = livechat_started_at
    app.state.livechat_pin_verifier = resolved_pin_verifier
    app.state.livechat_grant_limiter = GrantFailureLimiter()
    app.state.livechat_transcription = livechat_transcription
    app.state.livechat_drawing_broker = livechat_drawing_broker
    app.state.livechat_wyr_questions = wyr_questions
    app.state.livechat_wyr_image_generator = resolved_image_generator
    app.state.livechat_wyr_pool = wyr_pool
    app.state.livechat_wyr_demand = wyr_demand
    app.state.livechat_drawing_live_limiter = livechat_drawing_live_limiter
    app.state.livechat_adventure_bank = resolved_adventure_bank
    app.state.livechat_adventure_runner = livechat_adventure_runner
    app.state.livechat_adventure_live_limiter = livechat_adventure_live_limiter
    app.state.livechat_cookout_bank = resolved_cookout_bank
    app.state.livechat_cookout_runner = resolved_cookout_runner

    @app.exception_handler(FastAPIHTTPException)
    async def _http_exception_handler(_request: Request, exc: FastAPIHTTPException) -> JSONResponse:
        """Overrides Starlette's default (which always wraps `exc.detail` as
        `{"detail": ...}`) so a route can raise `HTTPException(status_code=...,
        detail={"error": "locked"})` and get that dict back VERBATIM as the top-
        level JSON body — spec/server-chat/00-brief.md §5's contracts are literal
        shapes like `{"error":"locked"}`, never `{"detail":{"error":"locked"}}`.
        A plain string `detail` (every existing route's own usage) is untouched —
        still wrapped as `{"detail": "..."}`, exactly as before this handler."""
        if isinstance(exc.detail, dict):
            return JSONResponse(status_code=exc.status_code, content=exc.detail)
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    app.middleware("http")(admin_auth)
    app.middleware("http")(build_robots_header_middleware(indexable=project.indexable))

    # Registration order matters: more specific routes/mounts first, the public
    # catch-all (`GET /{path:path}`) last, or it would shadow everything above it.
    app.include_router(internal_router)
    app.include_router(version_router)
    app.include_router(preview_router)
    app.include_router(admin_api_router)
    app.include_router(chat_router)
    app.include_router(engine_router)
    app.include_router(ai_router)
    app.include_router(system_router)
    app.include_router(versions_router)
    app.include_router(livechat_router)
    app.include_router(livechat_adventure_router)
    app.include_router(livechat_cookout_router)
    app.include_router(livechat_calls_router)
    app.include_router(livechat_media_router)

    @app.get("/admin", response_class=HTMLResponse, include_in_schema=False)
    @app.get("/admin/", response_class=HTMLResponse, include_in_schema=False)
    async def get_admin_shell() -> HTMLResponse:
        """Bare instant-render shell (spec/05 §1) — paints immediately, no server-side
        data dependency; the real admin-ui panels are milestone 7's job. Routing is
        client-side on PROPER PATHS (`/admin/pages`, `/admin/edit/<page>`, … —
        decisions/00087; legacy `#/…` hashes canonicalize client-side), so every
        `/admin` sub-route the browser might deep-link to is this same document (see
        `get_admin_shell_deep_link` below for the catch-all half).
        `Cache-Control: no-cache` — the shell is the document that CARRIES the
        fingerprinted bundle URLs (decisions/00069), so it must always be
        revalidated for a deploy's new fingerprints to be picked up."""
        return HTMLResponse(content=_ADMIN_SHELL_HTML, headers={"Cache-Control": "no-cache"})

    @app.get("/uxer-style.json", include_in_schema=False)
    async def uxer_style() -> FileResponse:
        """Uxer MCP compliance-bridge design tokens (slice 7, decisions/00050) —
        a fixed, protocol-level path Uxer's own browser module and MCP server
        look for by convention, not something wixy renames the way the static
        asset mount below is namespaced under /admin/static."""
        return FileResponse(_UXER_STYLE_PATH)

    @app.get("/.uxer-web-port", include_in_schema=False)
    async def uxer_web_port() -> HTMLResponse:
        """Uxer bridge auto-discovery — the MCP server's WebSocket port, if one
        is running locally. Absent outside an active `ui_launch`/MCP session,
        which is expected — the bridge just fails to connect, same as any
        other optional dev-tooling endpoint would."""

        def _read_port() -> str | None:
            if not _UXER_WEB_PORT_PATH.exists():
                return None
            return _UXER_WEB_PORT_PATH.read_text(encoding="utf-8").strip()

        port = await anyio.to_thread.run_sync(_read_port)
        if port is None:
            return HTMLResponse("0", status_code=404)
        return HTMLResponse(port)

    @app.get("/admin/server-sw.js", include_in_schema=False)
    async def get_server_service_worker() -> FileResponse:
        """Serve the push worker before the admin SPA's broad catch-all route."""

        return server_sw_response()

    @app.get(IMAGE_ROUTE_PREFIX + "{name}", include_in_schema=False)
    async def get_cookout_image(name: str, request: Request) -> Response:
        """A Cookout ingredient picture by content hash (09b B.7). Engine catalogue data, same
        for everyone, so it sits under `/admin` (behind Access like the admin bundles) and NOT
        behind the chat unlock token. Only a manifest sha whose file exists is served."""
        sha, dot, ext = name.partition(".")
        if ext != "webp" or not dot or not is_sha(sha):
            raise FastAPIHTTPException(status_code=404)
        path = await anyio.to_thread.run_sync(resolved_cookout_visuals.resolve_object, sha)
        if path is None:
            raise FastAPIHTTPException(status_code=404)
        headers = {
            "Cache-Control": "private, max-age=31536000, immutable",
            "ETag": f'"{sha}"',
            "X-Content-Type-Options": "nosniff",
        }
        if request.headers.get("if-none-match") in (f'"{sha}"', f'W/"{sha}"', sha):
            return Response(status_code=304, headers=headers)
        return FileResponse(path, media_type="image/webp", headers=headers)

    # Mount BEFORE /admin/static (more specific path first, per Uxer's own
    # doc) so /admin/static/uxer/... resolves here rather than falling
    # through to the broader static mount below.
    if not _UXER_DIST_DIR.exists():
        _UXER_DIST_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/admin/static/uxer", StaticFiles(directory=_UXER_DIST_DIR), name="uxer-static")

    app.mount("/admin/static", FingerprintedStaticFiles(directory=_STATIC_DIR), name="admin-static")
    # `html=True`: serves `index.html` for the bare `/admin/guide/` root and
    # resolves an extension-less path — `guide.build`'s own output always
    # includes an `index.html` copy of `start-here.html` for exactly this.
    # CF Access already gates this (same `is_admin_path` middleware every
    # other `/admin/*` path gets — no separate auth wiring needed here).
    app.mount("/admin/guide", StaticFiles(directory=_GUIDE_DIST_DIR, html=True), name="guide")
    # Serves whatever `_save_upload`/`_media_item` (routes_admin_api.py) construct as
    # a staged upload's `url` (`/admin/draft-media/<hash8>-<slug>.<ext>`) — `paths.
    # draft_media` already exists by now (`ensure_project_dirs` above), and staying
    # per-project (not the fixed `_STATIC_DIR` `/admin/static` uses) is correct since
    # each app instance serves exactly one project (spec/04 §1). Without this mount a
    # freshly uploaded/staged image is correctly listed by `GET /api/admin/media` and
    # correctly targeted by an `<img src>`, but 404s the moment anything actually
    # fetches it — found by driving a real browser through the upload/replace flow,
    # not by any of this milestone's existing unit tests (they mock the API and never
    # fetch the constructed URL).
    app.mount("/admin/draft-media", StaticFiles(directory=paths.draft_media), name="draft-media")
    # Staged in-place replacements (decisions/00080) preview in the admin grid
    # before the publish that applies them.
    app.mount(
        "/admin/draft-media-replace",
        StaticFiles(directory=paths.draft_media_replace),
        name="draft-media-replace",
    )

    # SPA deep links (decisions/00087): the admin routes on PROPER PATHS
    # (`/admin/edit/<page>`, `/admin/settings/<sub>`, …) — every panel path is
    # this same shell document and the client router parses the path. Registered
    # AFTER every real /admin/* mount above (Starlette matches in registration
    # order) so static/guide/draft-media/preview always win their prefixes, and
    # BEFORE routes_public's `/{path:path}` site catch-all below.
    @app.get("/admin/{rest:path}", response_class=HTMLResponse, include_in_schema=False)
    async def get_admin_shell_deep_link(rest: str) -> HTMLResponse:
        return HTMLResponse(content=_ADMIN_SHELL_HTML, headers={"Cache-Control": "no-cache"})

    app.include_router(public_router)

    return app


def _fetch_jwks(team_domain: str) -> dict[str, object]:
    response = httpx.get(jwks_url(team_domain), timeout=10.0)
    response.raise_for_status()
    data: dict[str, object] = response.json()
    return data
