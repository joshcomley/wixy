"""Shared helpers for the PUBLIC Adventure Time tests (workspace 00065). Not a `test_*.py` file, so
pytest never collects it. Builds the whole app with the public host switched on (the real
`create_app`, host gate included), with a fake researcher and (optionally) a fake picture finder, so
a test never reaches cmd or the internet."""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock
from urllib.parse import unquote

import anyio
import pytest
from fastapi.testclient import TestClient
from starlette.types import Message

from wixy_server.adventure_public.limits import PublicLimits
from wixy_server.adventure_public.service import AdventurePublicService
from wixy_server.app import create_app
from wixy_server.livechat.adventure_bank import AdventureBank
from wixy_server.livechat.adventure_pack import AdventureResearcher, PackTiming
from wixy_server.livechat.adventure_pictures import AdventurePictureFinder, PictureTiming
from wixy_server.tests.adventure_testkit import FAST, FakeResearcher, fixture_bank
from wixy_server.tests.no_visuals import no_visuals
from wixy_server.tests.test_livechat_view_once import _git

PUBLIC_HOST = "adventure.example.test"
PUBLIC_ORIGIN = f"https://{PUBLIC_HOST}"
OTHER_HOST = "ca.example.test"
ORIGIN_HEADERS = {"Origin": PUBLIC_ORIGIN}


def make_static_dir(root: Path) -> Path:
    """A stand-in for the client bundle directory, with the two files the shell references."""
    static = root / "adventure-public-static"
    static.mkdir(parents=True, exist_ok=True)
    (static / "app.js").write_text("/* stub bundle */\n", encoding="utf-8")
    (static / "app.css").write_text("/* stub css */\n", encoding="utf-8")
    return static


@contextmanager
def public_client(
    storage_root: Path,
    wixy_repo_root: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    researcher: AdventureResearcher | None = None,
    no_researcher: bool = False,
    finder: AdventurePictureFinder | None = None,
    bank: AdventureBank | None = None,
    timing: PackTiming | None = None,
    picture_timing: PictureTiming | None = None,
    limits: PublicLimits | None = None,
    static_dir: Path | None = None,
    host: str = PUBLIC_HOST,
    base_host: str | None = None,
    **extra: Any,
) -> Iterator[TestClient]:
    """The app with `WIXY_ADVENTURE_PUBLIC_HOST` set, entered (so its lifespan runs), as a client
    whose requests carry `Host: <base_host or host>`. A `FakeResearcher` unless told otherwise."""
    monkeypatch.setenv("WIXY_ADVENTURE_PUBLIC_HOST", host)
    resolved = (
        None if no_researcher else (researcher if researcher is not None else FakeResearcher())
    )
    app = create_app(
        storage_root=storage_root,
        wixy_repo_root=wixy_repo_root,
        pin_verifier=AsyncMock(),
        transcriber=AsyncMock(),
        adventure_bank=bank if bank is not None else fixture_bank(),
        adventure_public_researcher=resolved,
        adventure_public_picture_finder=finder,
        adventure_public_pack_timing=timing if timing is not None else FAST,
        adventure_public_picture_timing=picture_timing,
        adventure_public_limits=limits,
        adventure_public_static_dir=static_dir,
        **{"cookout_visuals": no_visuals(), **extra},
    )
    client = TestClient(app, base_url=f"https://{base_host or host}")
    client.__enter__()
    try:
        yield client
    finally:
        client.__exit__(None, None, None)


def service(client: TestClient) -> AdventurePublicService:
    found: AdventurePublicService = client.app.state.adventure_public  # type: ignore[attr-defined]
    return found


def code_of(client: TestClient, destination_id: str) -> str:
    code = service(client).bank.code_of(destination_id)
    assert code is not None, destination_id
    return code


def wait_for(predicate: Callable[[], bool], *, timeout_s: float = 10.0, what: str = "") -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {what or 'the condition'}")


def get_pack(client: TestClient, code: str) -> dict[str, Any]:
    response = client.get(f"/api/pack/{code}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def request_pack(client: TestClient, code: str) -> Any:
    return client.post(f"/api/pack/{code}", headers=ORIGIN_HEADERS)


def wait_for_state(
    client: TestClient, code: str, state: str, *, timeout_s: float = 10.0
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    view = get_pack(client, code)
    while view["state"] != state:
        if time.monotonic() > deadline:
            raise AssertionError(f"pack never became {state}: {view}")
        time.sleep(0.02)
        view = get_pack(client, code)
    return view


def wait_for_images(
    client: TestClient, code: str, images: str, *, timeout_s: float = 10.0
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    view = get_pack(client, code)
    while view["images"] != images:
        if time.monotonic() > deadline:
            raise AssertionError(f"images never became {images}: {view}")
        time.sleep(0.02)
        view = get_pack(client, code)
    return view


def make_engine_repo(root: Path) -> Path:
    """A minimal engine checkout + site origin under `root` (what `create_app` needs to start)."""
    origin = root / "origin"
    origin.mkdir(parents=True, exist_ok=True)
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    (origin / "README.md").write_text("hi\n", encoding="utf-8")
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)
    engine = root / "wixy-repo"
    (engine / "projects").mkdir(parents=True)
    (engine / "projects" / "test.json").write_text(
        json.dumps(
            {
                "slug": "test",
                "name": "test",
                "repo": str(origin),
                "defaultBranch": "main",
                "cmdProject": "test",
                "domain": "test.example.invalid",
                "locale": "en-GB",
                "indexable": False,
                "media": {"maxLongSidePx": 2000, "jpegQuality": 85},
            }
        ),
        encoding="utf-8",
    )
    _git(["init", "--initial-branch=main"], engine)
    _git(["config", "user.email", "test@example.com"], engine)
    _git(["config", "user.name", "Test"], engine)
    _git(["add", "."], engine)
    _git(["commit", "-m", "engine commit"], engine)
    return engine


@contextmanager
def module_public_client(root: Path, **kwargs: Any) -> Iterator[TestClient]:
    """For MODULE-scoped fixtures (read-only route/gate tests share one app: starting the app is the
    expensive part): the engine repo, the env the app needs and the app itself, all under `root`."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("WIXY_DEV_NO_AUTH", "1")
        engine = make_engine_repo(root)
        with public_client(root / "storage", engine, mp, **kwargs) as client:
            yield client


def asgi_request(
    app: Any,
    raw_path: str,
    *,
    host: str,
    method: str = "GET",
    headers: Sequence[tuple[str, str]] = (),
) -> tuple[int, dict[str, str], bytes]:
    """Run ONE request straight through the app's ASGI interface with `raw_path` exactly as a server
    would hand it over (percent-escapes decoded for `path`, dot segments NOT collapsed — an HTTP
    client library normalises `..` and `//` before sending, which would hide a traversal)."""
    path, _, query = raw_path.partition("?")
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "https",
        "path": unquote(path),
        "raw_path": path.encode("latin-1"),
        "root_path": "",
        "query_string": query.encode("latin-1"),
        "headers": [(b"host", host.encode("latin-1"))]
        + [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 9380),
    }
    sent: list[Message] = []

    async def receive() -> Message:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: Message) -> None:
        sent.append(message)

    async def go() -> None:
        await app(scope, receive, send)

    anyio.run(go)
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    response_headers = {
        k.decode("latin-1").lower(): v.decode("latin-1") for k, v in start["headers"]
    }
    return int(start["status"]), response_headers, body
