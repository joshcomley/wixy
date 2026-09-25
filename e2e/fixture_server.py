"""Standalone fixture server for Playwright E2E flows (spec/08-testing-acceptance.md
§2: "Fixture: temp clone of the site repo (post-migration shape) + wixy server on an
ephemeral port"). Lives in `e2e/` (an npm package) rather than `wixy_server/` on
purpose — it exists ONLY in service of this test suite, nothing product-side depends
on it; it imports `builder`/`wixy_server` directly instead of reimplementing
checkout/app-construction in TypeScript.

Builds a real, throwaway git repo from `builder/tests/fixtures/mini-site` (the same
"real-shaped" fixture the Python unit suite trusts, per this repo's own testing
culture — not a hand-rolled toy that might miss a real edge case) in a fresh temp
directory, a temp Storage root, and a temp wixy-repo-root with one project pointed at
that local repo (git clone from a local path — no network, per spec/08 §1's "never
hit the real network" rule). Publishes ONE initial build before starting so the
preview route's own asset URLs resolve instead of 503ing (decisions/00018 — a fresh
install with no live.json yet is correct-but-noisy for what E2E flows actually test).
Then runs `wixy_server.app.create_app` via uvicorn on the port
`playwright.config.ts`'s `webServer.url` health-checks — 8799 by default,
overridable via `WIXY_E2E_PORT` so two agent sessions on the same box can run
the suite in parallel instead of colliding on the one fixed port (found live
2026-08-02: a second session's run kept failing with "already used" while a
first was mid-suite).

Usage: python fixture_server.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import anyio

E2E_DIR = Path(__file__).resolve().parent
WIXY_REPO_ROOT = E2E_DIR.parent
MINI_SITE_FIXTURE = WIXY_REPO_ROOT / "builder" / "tests" / "fixtures" / "mini-site"
PORT = int(os.environ.get("WIXY_E2E_PORT", "8799"))

# spec/server-chat/00-brief.md §11: "the fixture's FakeCmdServer registers a
# made-up test PIN for the app key". Matches settings.py's own
# `_DEFAULT_SERVER_PIN_APP_KEY` — the fixture never sets
# `WIXY_SERVER_PIN_APP_KEY`, so `create_app`'s default resolves to this same
# value; kept as a literal here (rather than imported) so this file has no
# reach into `wixy_server.settings`'s private constant.
TEST_SERVER_PIN_APP_KEY = "wixy-livechat"
TEST_SERVER_PIN = "246813"

sys.path.insert(0, str(WIXY_REPO_ROOT))

from builder.build import build_site  # noqa: E402
from builder.config import ProjectConfig  # noqa: E402
from wixy_server.chats import find_chat  # noqa: E402
from wixy_server.checkout import current_sha, ensure_checkout  # noqa: E402
from wixy_server.cmdchat import CmdChatClient  # noqa: E402
from wixy_server.livechat.pinclient import CmdPinVerifier  # noqa: E402
from wixy_server.livechat.store import LiveChatStore  # noqa: E402
from wixy_server.livechat.transcribe import CmdTranscriber  # noqa: E402
from wixy_server.livechat.transcription import SlidingWindowRateLimiter  # noqa: E402
from wixy_server.registry import load_registry  # noqa: E402
from wixy_server.site_source import build_site_source  # noqa: E402
from wixy_server.storage import ProjectPaths, ensure_project_dirs, project_paths  # noqa: E402
from wixy_server.tests.fake_cmd import FakeCmdServer, FakeCmdState  # noqa: E402
from wixy_server.watcher import WatcherStatus, fetch_once  # noqa: E402

# spec/server-chat/00-brief.md §11: "the fixture's FakeCmdServer registers a
# made-up test PIN for the app key, and sets WIXY_SERVER_UPLOAD_CHUNK_BYTES=
# 65536" — shared across server-lock.spec.ts (P4), server-chat.spec.ts (P5b)
# and server-media.spec.ts (P6b). Landed here first (P4 hadn't pushed yet);
# whoever's spec runs first in the suite wires this up, the others just use
# it. TEST_SERVER_PIN is a made-up fixture value, never the operator's real
# PIN (spec/server-chat/00-brief.md's own banner: the real PIN must never
# appear in this public repo).
TEST_SERVER_PIN_APP_KEY = "wixy-livechat"
TEST_SERVER_PIN = "246813"


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(
        ["git", "-c", "credential.helper=", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )


_GALLERY_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>placeholder</title>
<link rel="stylesheet" href="site.css">
</head>
<body data-page="gallery">
<!-- wx:partial header -->
<main>
  <ul class="sliders" data-wx-list="gallery.sliders">
    <li data-wx-list-item data-wx-attr="data-cat:.cat">
      <img data-wx-img=".before" src="" alt="">
      <img data-wx-img=".after" src="" alt="">
      <h3 data-wx=".title">Title</h3>
      <p data-wx=".sub">Sub</p>
    </li>
  </ul>
  <ul class="tiles" data-wx-list="gallery.tiles">
    <li data-wx-list-item data-wx-attr="data-cat:.cat">
      <img data-wx-img=".img" src="" alt="">
      <h3 data-wx=".title">Title</h3>
    </li>
  </ul>
</main>
<!-- wx:partial footer -->
<!-- wx:partial booking-modal -->
</body>
</html>
"""

_GALLERY_JSON = """{
  "meta": {
    "title": "Gallery",
    "description": "Before and after photos.",
    "navLabel": "Gallery",
    "inNav": true,
    "navOrder": 30
  },
  "gallery": {
    "sliders": [
      {
        "before": { "src": "images/hero.jpg", "alt": "Before" },
        "after": { "src": "images/icon.jpg", "alt": "After" },
        "title": "Hidden Pair",
        "sub": "Seed",
        "cat": "lips",
        "visible": false
      }
    ],
    "tiles": []
  }
}
"""


def _write_gallery_page(seed: Path) -> None:
    """Adds a `gallery` page + `content/gallery.json` to the E2E fixture's OWN
    seed clone (never the shared `builder/tests/fixtures/mini-site` the Python
    unit suite also trusts — adding a page there would ripple into every test
    asserting an exact page count/slug set) — decisions/00098's section panel
    e2e coverage needs a REAL page using the SAME `gallery.sliders`/
    `gallery.tiles` collection paths + schemas `builder.collections.
    COLLECTION_RULES` already registers (from PR 1), so the write gate and
    publish-time schema validation are exercised for real, not faked."""
    (seed / "pages" / "gallery.html").write_text(_GALLERY_HTML, encoding="utf-8")
    (seed / "content" / "gallery.json").write_text(_GALLERY_JSON, encoding="utf-8")


def _build_site_origin(tmp_root: Path) -> Path:
    """A genuine BARE repo (spec/08 §1, mirroring wixy_server/tests/test_publisher.py's
    own `bare_origin` fixture) — pushed to from a scratch seed clone, never a working
    tree of its own. A non-bare origin refuses `git push` to its checked-out branch by
    default, which would break every E2E flow that actually publishes (1, 4, 5, 6) the
    moment they existed; this fixture predates any of them needing a real push, so the
    gap was latent until milestone 9 slice 5."""
    bare = tmp_root / "site-origin.git"
    bare.mkdir(parents=True)
    _git(["init", "--bare", "--initial-branch=main"], bare)

    seed = tmp_root / "site-origin-seed"
    _git(["clone", str(bare), str(seed)], tmp_root)
    shutil.copytree(MINI_SITE_FIXTURE, seed, dirs_exist_ok=True)
    _write_gallery_page(seed)
    _git(["config", "user.email", "e2e@example.invalid"], seed)
    _git(["config", "user.name", "E2E Fixture"], seed)
    _git(["add", "."], seed)
    _git(["commit", "-m", "initial fixture site"], seed)
    _git(["push", "origin", "main"], seed)
    return bare


_ADMIN_SECTIONS = json.dumps(
    [
        {
            "id": "before-after",
            "navLabel": "Before & After",
            "title": "Before & After",
            "description": "Drag to reorder — changes go live when you press Publish.",
            "page": "gallery",
            "collections": [
                {
                    "path": "gallery.sliders",
                    "label": "Drag-to-compare photos",
                    "itemNoun": "photo pair",
                    "schema": "gallery-slider",
                    "alignAspect": "640:360",
                    "fields": [
                        {"key": "before", "kind": "image", "label": "Before photo"},
                        {"key": "after", "kind": "image", "label": "After photo"},
                        {"key": "title", "kind": "text", "label": "Treatment name"},
                        {"key": "sub", "kind": "text", "label": "Treatment type"},
                        {
                            "key": "cat",
                            "kind": "choice",
                            "label": "Category",
                            "options": [
                                {"value": "lips", "label": "Lips"},
                                {"value": "cheeks", "label": "Cheeks"},
                            ],
                        },
                        {"key": "visible", "kind": "toggle", "label": "Show on site"},
                    ],
                },
                {
                    "path": "gallery.tiles",
                    "label": "Tap-to-zoom photos",
                    "itemNoun": "photo",
                    "schema": "gallery-tile",
                    "fields": [
                        {"key": "img", "kind": "image", "label": "Photo"},
                        {"key": "title", "kind": "text", "label": "Caption"},
                        {
                            "key": "cat",
                            "kind": "choice",
                            "label": "Category",
                            "options": [
                                {"value": "lips", "label": "Lips"},
                                {"value": "cheeks", "label": "Cheeks"},
                            ],
                        },
                        {"key": "visible", "kind": "toggle", "label": "Show on site"},
                    ],
                },
            ],
        }
    ]
)


def _write_project_registry(tmp_root: Path, site_origin: Path) -> Path:
    projects_dir = tmp_root / "wixy-repo" / "projects"
    projects_dir.mkdir(parents=True)
    (projects_dir / "e2e.json").write_text(
        (
            '{"slug": "e2e", "name": "E2E Fixture", '
            f'"repo": "{site_origin.as_posix()}", "defaultBranch": "main", '
            '"cmdProject": "e2e", "domain": "e2e.example.invalid", '
            '"locale": "en-GB", "indexable": false, '
            '"media": {"maxLongSidePx": 2000, "jpegQuality": 85}, '
            f'"adminSections": {_ADMIN_SECTIONS}}}'
        ),
        encoding="utf-8",
    )
    return projects_dir.parent


def _publish_initial_build(project: ProjectConfig, storage_root: Path, slug: str) -> None:
    """Materializes ONE published build before the server ever starts, so preview
    pages' own relative asset URLs (site.css/theme.css/images/*, re-anchored to the
    site root by preview.py's `<base href="/">`, decisions/00018) resolve to a real
    file instead of routes_public.py's expected-but-noisy "no live.json yet" 503 —
    that 503 is CORRECT behavior for a genuinely fresh install (spec/04 §3), but it
    would pollute every E2E flow's console-error check with expected noise unrelated
    to whatever that flow actually tests. Mirrors what a real milestone 12 cutover's
    first publish does, just done here directly rather than through milestone 9's
    (not yet built) publish pipeline."""
    paths = project_paths(storage_root, slug)
    ensure_project_dirs(paths)
    ensure_checkout(project.repo, project.default_branch, paths.repo)

    sha = current_sha(paths.repo)
    source = build_site_source(project, paths.repo)
    out_dir = paths.build_dir(sha)
    build_site(paths.repo, source, out_dir)
    paths.live_json.write_text(
        json.dumps({"sha": sha, "version": 1, "buildDir": str(out_dir)}),
        encoding="utf-8",
    )


def _simulate_upstream_commit(site_origin: Path, tmp_root: Path, title: str) -> str:
    """E2E 6 (spec/08 §2): "fake cmd 'ships' a commit to the temp origin's main."
    A scratch clone edits `content/index.json`'s `hero.title` and pushes straight
    to the bare origin, exactly as a real AI-lane merge (milestone 10's cmdchat,
    not built yet) would land one — fixture-only simulation, never imported by
    product code. Returns the new commit's SHA (unused today, kept for a future
    assertion/debugging)."""
    scratch = tmp_root / f"upstream-commit-{uuid.uuid4().hex[:8]}"
    _git(["clone", str(site_origin), str(scratch)], tmp_root)
    content_path = scratch / "content" / "index.json"
    data = json.loads(content_path.read_text(encoding="utf-8"))
    data["hero"]["title"] = title
    content_path.write_text(json.dumps(data), encoding="utf-8")
    _git(["config", "user.email", "ai-lane@example.invalid"], scratch)
    _git(["config", "user.name", "AI Lane"], scratch)
    _git(["add", "."], scratch)
    _git(["commit", "-m", f"AI: {title}"], scratch)
    _git(["push", "origin", "main"], scratch)
    result = subprocess.run(
        ["git", "-c", "credential.helper=", "rev-parse", "HEAD"],
        cwd=scratch,
        capture_output=True,
        text=True,
        check=True,
        encoding="utf-8",
    )
    return result.stdout.strip()


def main() -> None:
    tmp_root = Path(tempfile.mkdtemp(prefix="wixy-e2e-"))
    site_origin = _build_site_origin(tmp_root)
    wixy_repo_root = _write_project_registry(tmp_root, site_origin)
    storage_root = tmp_root / "storage"

    os.environ["WIXY_DEV_NO_AUTH"] = "1"
    os.environ["WIXY_ENV"] = "dev"
    # spec/server-chat/00-brief.md §11: exercises the chunked-upload path
    # (413/409/missing-chunk cases) without multi-megabyte fixture uploads.
    os.environ["WIXY_SERVER_UPLOAD_CHUNK_BYTES"] = "65536"

    registry = load_registry(wixy_repo_root)
    _publish_initial_build(registry.get("e2e"), storage_root, "e2e")

    import uvicorn
    from starlette.middleware.base import RequestResponseEndpoint
    from starlette.requests import Request
    from starlette.responses import Response

    from wixy_server.app import create_app

    # E2E 7 (milestone 10, spec/08 §2/06): a real FakeCmdServer (the same
    # ephemeral-port uvicorn double the Python unit suite uses,
    # wixy_server/tests/fake_cmd.py) rather than a hand-rolled TS stub — one
    # fake, one behavior contract, exercised from both test layers.
    # `default_ready_after_polls=1` means every conversation the browser
    # creates becomes ready almost immediately with zero per-session fixture
    # wiring; a real cmd instance is never touched (fleet rule).
    fake_cmd_state = FakeCmdState(default_ready_after_polls=1)
    fake_cmd_server = FakeCmdServer(fake_cmd_state)
    fake_cmd_port = fake_cmd_server.start()
    cmdchat_client = CmdChatClient(
        portal_base_url=f"http://127.0.0.1:{fake_cmd_port}",
        chats_base_url=f"http://127.0.0.1:{fake_cmd_port}",
        readiness_poll_interval_s=0.2,
        readiness_timeout_s=10.0,
    )
    # spec/server-chat/00-brief.md §11: the Server chat's PIN-verify double.
    # Deliberately a SECOND, INDEPENDENT `FakeCmdServer` instance (own
    # uvicorn thread + port) rather than reusing `fake_cmd_server` above —
    # `chat-ux.spec.ts`'s offline-banner test does a ONE-WAY
    # `/test/chat/stop-fake-cmd` as the LAST thing it does, documented there
    # as safe only because "no other spec file touches chat/cmd" (a Python
    # `Thread` can only ever be started once, so that stop has no clean
    # restart). This spec file is now a second consumer, so sharing the same
    # instance would leave PIN verification permanently broken for every
    # later spec file in the same `workers:1` run once chat-ux's test has
    # run (found live: 12/20 server-lock.spec.ts tests failing with a
    # consistent 503 "pin_service_unavailable" whenever run after
    # chat-ux.spec.ts). Same underlying `FakeCmdState` (so
    # `register_pin_app`'s data lives in one place regardless), fully
    # independent server lifecycle — nothing chat-ux does can affect it.
    fake_pin_server = FakeCmdServer(fake_cmd_state)
    fake_pin_port = fake_pin_server.start()
    fake_cmd_state.register_pin_app(TEST_SERVER_PIN_APP_KEY, TEST_SERVER_PIN)
    # `create_app`'s own default `CmdPinVerifier` points at the REAL cmd
    # loopback base URL (Inv 13) — the fixture must point it at the fake
    # instead, same app key `create_app` would otherwise have resolved from
    # settings (TEST_SERVER_PIN_APP_KEY matches that default, see above).
    pin_verifier = CmdPinVerifier(
        app_key=TEST_SERVER_PIN_APP_KEY,
        base_url=f"http://127.0.0.1:{fake_pin_port}",
    )

    # spec/server-chat/05-voice-transcription.md: the transcription hop is pointed at the SAME
    # fake cmd as the PIN service (never the real one — `create_app`'s default would talk to
    # 127.0.0.1:9320). It starts as a cmd WITHOUT the private mode, so every spec that does not
    # care sees no Transcribe control; `server-transcription.spec.ts` flips it through
    # `/test/server/transcribe-config`.
    fake_cmd_state.transcribe_private_supported = False
    transcriber = CmdTranscriber(base_url=f"http://127.0.0.1:{fake_pin_port}")

    app = create_app(
        storage_root=storage_root,
        wixy_repo_root=wixy_repo_root,
        pin_verifier=pin_verifier,
        transcriber=transcriber,
        # No E2E flow depends on the PERIODIC watcher tick (spec/04 §7) — E2E 6's
        # own simulated upstream commit fetches directly (this file's
        # `/test/simulate-upstream-commit`, decisions/00030), never waiting on
        # it. A rare, full-suite-only theme-change.spec.ts timeout was
        # INVESTIGATED and this periodic tick coinciding with the suite's own
        # ~60s runtime was a suspected cause — DISPROVEN (the timeout still
        # occurred, equally rarely, with the tick disabled entirely); kept
        # disabled anyway purely because it's genuinely unneeded background
        # work for this fixture, not as a fix. The real pattern matches this
        # box's own already-documented transient disk-I/O contention from
        # OTHER unrelated processes (decisions/00025, 00027) — profiled with
        # `fleet_diag.py` during an active failure window and confirmed
        # elevated CPU/disk-I/O from unrelated PIDs, same as those prior
        # incidents (decisions/00030).
        watcher_interval_s=3600.0,
        cmdchat_client=cmdchat_client,
    )

    delete_response_delay_s = 0.0

    @app.middleware("http")
    async def _delay_delete_response(
        request: Request,
        call_next: RequestResponseEndpoint,
    ) -> Response:
        response = await call_next(request)
        if (
            request.method == "DELETE"
            and request.url.path.startswith("/api/admin/server/messages/")
            and delete_response_delay_s > 0
        ):
            # The route has committed, published its message_deleted event, and
            # finished cleanup before this fixture-only delay holds the HTTP reply.
            await anyio.sleep(delete_response_delay_s)
        return response

    @app.post("/test/server/delete-response-delay", include_in_schema=False)
    async def _post_delete_response_delay(payload: dict[str, object]) -> dict[str, float]:
        """Hold DELETE responses after commit to prove the SSE event settles the UI."""
        nonlocal delete_response_delay_s
        seconds = payload.get("seconds", 0.0)
        assert isinstance(seconds, (int, float)) and 0 <= seconds <= 30
        delete_response_delay_s = float(seconds)
        return {"seconds": delete_response_delay_s}

    @app.post("/test/server/config", include_in_schema=False)
    async def _post_server_test_config() -> dict[str, str]:
        """spec/server-chat/00-brief.md §11 — the shared PIN fixture: the specs
        need the PIN's actual value to drive the real PIN pad, and hardcoding
        the same literal independently in Python and TypeScript would silently
        drift. `server-lock.spec.ts` (P4), `server-chat.spec.ts` (P5b) and
        `server-media.spec.ts` (P6b) all fetch this once per test. POST (not
        GET) like every other fixture-only route here: a GET on this path
        would be shadowed by the site's own public catch-all route, which
        `create_app()` already registered before this module adds its own
        test-only routes — measured live (a GET returned the site's "Page not
        found" page, not this handler)."""
        return {"pin": TEST_SERVER_PIN}

    @app.post("/test/server/seed-messages", include_in_schema=False)
    async def _post_seed_server_messages(payload: dict[str, object]) -> dict[str, int]:
        """server-chat.spec.ts's history-paging leg needs ~120 messages without
        driving the UI 120 times over — writes straight through the real
        `LiveChatStore` (the same one `routes_livechat.py` uses), so the
        seeded rows are indistinguishable from ones a real send would have
        produced. `startAgoS`/`spreadS` place messages far enough apart in
        time to land on more than one calendar day, exercising the day
        separator. `label` (default "Seeded message") lets each test tag its
        own batch distinctly — this fixture server runs ONE project for the
        WHOLE spec file (playwright.config.ts's own `workers: 1`, no reset
        between tests), so two tests seeding the generic default label would
        make each other's leftover rows indistinguishable from their own."""
        count = payload["count"]
        assert isinstance(count, int)
        start_ago_s = payload.get("startAgoS", 172_800.0)  # 2 days, by default
        assert isinstance(start_ago_s, (int, float))
        spread_s = payload.get("spreadS", 120.0)
        assert isinstance(spread_s, (int, float))
        sender = payload.get("sender", "Fixture")
        assert isinstance(sender, str)
        label = payload.get("label", "Seeded message")
        assert isinstance(label, str)

        store: LiveChatStore = app.state.livechat_store

        def _seed() -> int:
            base = time.time() - start_ago_s
            for i in range(count):
                store.create_message(
                    client_id=f"seed-{uuid.uuid4().hex}",
                    sender=sender,
                    device_id=f"seed-device-{uuid.uuid4().hex[:16]}",
                    by_email=None,
                    text=f"{label} #{i + 1}",
                    attachment_ids=[],
                    now=base + i * spread_s,
                )
            return count

        return {"seeded": await anyio.to_thread.run_sync(_seed)}

    @app.post("/test/server/seed-photo", include_in_schema=False)
    async def _post_seed_server_photo(payload: dict[str, object]) -> dict[str, object]:
        """Seed one ready private photo for delete/wipe E2E coverage.

        The row and files use the real server-chat paths and media route; only
        processing is bypassed so this remains deterministic without ffmpeg.
        """
        sender = payload.get("sender", "Purdy")
        text = payload.get("text", "E2E photo")
        assert isinstance(sender, str) and isinstance(text, str)
        store: LiveChatStore = app.state.livechat_store
        paths: ProjectPaths = app.state.paths

        def _seed() -> dict[str, object]:
            now = time.time()
            attachment_id = uuid.uuid4().hex
            conn = store._connect()
            try:
                conn.execute(
                    "INSERT INTO attachments "
                    "(id, kind, status, mime, width, height, renditions, bytes_on_disk, "
                    "created_at, updated_at) "
                    "VALUES (?, 'photo', 'ready', 'image/jpeg', 16, 12, ?, ?, ?, ?)",
                    (attachment_id, '["full","thumb"]', 0, now, now),
                )
            finally:
                conn.close()
            message, _created = store.create_message(
                client_id=f"seed-photo-{uuid.uuid4().hex}",
                sender=sender,
                device_id=f"seed-device-{uuid.uuid4().hex[:16]}",
                by_email=None,
                text=text,
                attachment_ids=(attachment_id,),
                now=now,
            )
            image = (E2E_DIR / "fixtures" / "tiny-second-image.jpg").read_bytes()
            media_dir = paths.server_attachment_media_dir(attachment_id)
            media_dir.mkdir(parents=True, exist_ok=True)
            (media_dir / "full.jpg").write_bytes(image)
            (media_dir / "thumb.jpg").write_bytes(image)
            conn = store._connect()
            try:
                conn.execute(
                    "UPDATE attachments SET bytes_on_disk = ? WHERE id = ?",
                    (len(image) * 2, attachment_id),
                )
            finally:
                conn.close()
            app.state.livechat_notifier.publish()
            return {"seq": message.seq, "attachmentId": attachment_id}

        return await anyio.to_thread.run_sync(_seed)

    def _transcribe_stats() -> dict[str, object]:
        last = (
            fake_cmd_state.transcribe_requests[-1] if fake_cmd_state.transcribe_requests else None
        )
        return {
            "requests": len(fake_cmd_state.transcribe_requests),
            "retained": len(fake_cmd_state.transcribe_retained),
            "maxInFlight": fake_cmd_state.transcribe_max_in_flight,
            "lastFields": last.fields if last is not None else None,
            "lastAudioBytes": len(last.audio) if last is not None else 0,
            "lastAudioIsMp4": bool(last is not None and last.audio[4:8] == b"ftyp"),
        }

    @app.post("/test/server/transcribe-config", include_in_schema=False)
    async def _post_transcribe_config(payload: dict[str, object]) -> dict[str, object]:
        """server-transcription.spec.ts drives the fake cmd's private mode from the browser test:
        `private` (whether cmd honours it), `text` (the transcript), `status` (make cmd fail),
        `hold` (True parks every transcription request at cmd until False), `reset` (forget the
        recorded requests). Always drops the probe cache so a flip is seen at once."""
        private = payload.get("private")
        if isinstance(private, bool):
            fake_cmd_state.transcribe_private_supported = private
        text = payload.get("text")
        if isinstance(text, str):
            fake_cmd_state.transcribe_text = text
        status = payload.get("status")
        if isinstance(status, int):
            fake_cmd_state.transcribe_status_code = status
        hold = payload.get("hold")
        if hold is True:
            fake_cmd_state.transcribe_gate = threading.Event()
        elif hold is False and fake_cmd_state.transcribe_gate is not None:
            fake_cmd_state.transcribe_gate.set()
            fake_cmd_state.transcribe_gate = None
        if payload.get("reset") is True:
            fake_cmd_state.transcribe_requests.clear()
            fake_cmd_state.transcribe_retained.clear()
            fake_cmd_state.transcribe_max_in_flight = 0
            # Every spec shares one identity, and the real 6-a-minute budget would throttle a
            # busy suite; a fresh limiter per test keeps each test independent of the last.
            app.state.livechat_transcription.rate_limiter = SlidingWindowRateLimiter()
        transcriber.invalidate_probe()
        return _transcribe_stats()

    @app.post("/test/server/transcribe-stats", include_in_schema=False)
    async def _post_transcribe_stats() -> dict[str, object]:
        return _transcribe_stats()

    @app.post("/test/server/seed-voice", include_in_schema=False)
    async def _post_seed_server_voice(payload: dict[str, object]) -> dict[str, object]:
        """Seed one READY voice note with real, playable AAC audio (a `seconds`-long tone made
        with ffmpeg, the same tool the real queue uses) — deterministic, and long enough that
        "the note is still playing when its transcript arrives" is a real browser check."""
        sender = payload.get("sender", "Purdy")
        seconds = payload.get("seconds", 12)
        assert isinstance(sender, str) and isinstance(seconds, int) and 1 <= seconds <= 60
        store: LiveChatStore = app.state.livechat_store
        paths: ProjectPaths = app.state.paths
        ffmpeg = os.environ.get("WIXY_FFMPEG") or shutil.which("ffmpeg")
        assert ffmpeg, "the e2e voice fixture needs ffmpeg (as the real media queue does)"

        def _seed() -> dict[str, object]:
            now = time.time()
            attachment_id = uuid.uuid4().hex
            media_dir = paths.server_attachment_media_dir(attachment_id)
            media_dir.mkdir(parents=True, exist_ok=True)
            play = media_dir / "play.m4a"
            subprocess.run(
                [
                    ffmpeg,
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    f"sine=frequency=330:duration={seconds}",
                    "-ac",
                    "1",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "32k",
                    str(play),
                ],
                check=True,
                capture_output=True,
            )
            conn = store._connect()
            try:
                conn.execute(
                    "INSERT INTO attachments "
                    "(id, kind, status, mime, duration_s, peaks, renditions, bytes_on_disk, "
                    "created_at, updated_at) "
                    "VALUES (?, 'voice', 'ready', 'audio/mp4', ?, ?, '[\"play\"]', ?, ?, ?)",
                    (
                        attachment_id,
                        float(seconds),
                        json.dumps([0.2, 0.6, 0.9, 0.4, 0.7, 0.3] * 8),
                        play.stat().st_size,
                        now,
                        now,
                    ),
                )
            finally:
                conn.close()
            message, _created = store.create_message(
                client_id=f"seed-voice-{uuid.uuid4().hex}",
                sender=sender,
                device_id=f"seed-device-{uuid.uuid4().hex[:16]}",
                by_email=None,
                text=None,
                attachment_ids=(attachment_id,),
                now=now,
            )
            app.state.livechat_notifier.publish()
            return {"seq": message.seq, "attachmentId": attachment_id}

        return await anyio.to_thread.run_sync(_seed)

    @app.post("/test/server/reset-pin-lockout", include_in_schema=False)
    async def _post_reset_pin_lockout() -> dict[str, bool]:
        """spec/server-chat/00-brief.md §11: `server-lock.spec.ts`'s lockout
        test drives 5 wrong PINs to trigger cmd's fake lockout, then needs a
        clean slate for the NEXT test in the same run (the fake's lockout
        state persists across specs — there's no per-test fixture restart)."""
        fake_cmd_state.reset_pin_lockout(TEST_SERVER_PIN_APP_KEY)
        return {"ok": True}

    @app.post("/test/simulate-upstream-commit", include_in_schema=False)
    async def _post_simulate_upstream_commit(payload: dict[str, str]) -> dict[str, str]:
        """E2E 6 (decisions/00030) needs the pushed commit to be visible to the
        checkout deterministically and promptly, without depending on (or
        lowering, suite-wide) the real staleness-triggered fetch on the preview
        route (spec/04 §7) — that mechanism is for a REAL AI-lane merge arriving
        with no other signal; this fixture-only endpoint has a much stronger
        signal available (it just pushed the commit itself), so it fetches
        directly rather than waiting for the next preview load to notice."""
        paths: ProjectPaths = app.state.paths
        project: ProjectConfig = app.state.project
        watcher_status: WatcherStatus = app.state.watcher_status
        sha = await anyio.to_thread.run_sync(
            _simulate_upstream_commit, site_origin, tmp_root, payload["title"]
        )
        await anyio.to_thread.run_sync(fetch_once, project, paths, watcher_status)
        return {"sha": sha}

    def _find_fake_session(conv_id: str) -> object | None:
        paths: ProjectPaths = app.state.paths
        conversation = find_chat(paths.chats_json, conv_id)
        if conversation is None:
            return None
        return fake_cmd_state.sessions.get(conversation.session_id)

    @app.post("/test/chat/set-messages", include_in_schema=False)
    async def _post_set_chat_messages(payload: dict[str, object]) -> dict[str, bool]:
        """E2E 7: scripts a fake assistant reply (incl. tool-activity rows,
        spec/06 §1's message `kind`s) into the conversation the browser
        already created through the real admin UI — mirrors this file's own
        `_simulate_upstream_commit` pattern (fixture-only, never imported by
        product code)."""
        conv_id = payload["convId"]
        assert isinstance(conv_id, str)
        messages = payload["messages"]
        assert isinstance(messages, list)

        def _apply() -> bool:
            session = _find_fake_session(conv_id)
            if session is None:
                return False
            session.messages = messages  # type: ignore[attr-defined]
            return True

        return {"ok": await anyio.to_thread.run_sync(_apply)}

    @app.post("/test/chat/set-activity", include_in_schema=False)
    async def _post_set_chat_activity(payload: dict[str, object]) -> dict[str, bool]:
        """decisions/00097, 00099, 00100: scripts cmd's own `activity` field on
        the fake session — an ENUM ("active"/"idle"/"done"/"unknown"), never a
        timestamp. The list-view working pulse (`chat_working.WorkingCache`)
        is driven ENTIRELY by this field, independent of the wixy-tasks
        block content (`set-messages` above never touches it), so exercising
        the list-dot pulse through the real UI needs it settable too."""
        conv_id = payload["convId"]
        assert isinstance(conv_id, str)
        activity = payload["activity"]
        assert activity is None or isinstance(activity, str)

        def _apply() -> bool:
            session = _find_fake_session(conv_id)
            if session is None:
                return False
            session.status["activity"] = activity  # type: ignore[attr-defined]
            return True

        return {"ok": await anyio.to_thread.run_sync(_apply)}

    @app.post("/test/chat/set-send-status", include_in_schema=False)
    async def _post_set_send_status(payload: dict[str, object]) -> dict[str, bool]:
        """E2E 7's send-retry-on-502 leg (spec/06 §3): the test sets a bad
        status code, drives a send through the real UI, asserts the bubble
        error, then calls this again with 202 before retrying."""
        conv_id = payload["convId"]
        assert isinstance(conv_id, str)
        status_code = payload["statusCode"]
        assert isinstance(status_code, int)

        def _apply() -> bool:
            session = _find_fake_session(conv_id)
            if session is None:
                return False
            session.send_status_code = status_code  # type: ignore[attr-defined]
            return True

        return {"ok": await anyio.to_thread.run_sync(_apply)}

    @app.post("/test/chat/stop-fake-cmd", include_in_schema=False)
    async def _post_stop_fake_cmd() -> dict[str, bool]:
        """E2E 7's offline-banner leg (spec/06 §3) — the LAST thing any chat
        E2E test does (no other spec file touches chat/cmd, so a one-way stop
        is safe for the shared, workers:1 fixture server)."""
        await anyio.to_thread.run_sync(fake_cmd_server.stop)
        return {"ok": True}

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
