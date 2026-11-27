"""The public Adventure Time routes (workspace 00065, spec/adventure-public/README.md §2.3, Inv 61).

These routes belong to a SEPARATE application (`build_adventure_public_app`), not to the main
router: the host gate (`adventure_public.gate`) hands a request to it only when its `Host` is the
public host, and hands nothing else from that host to anything. So the public host can reach
exactly the routes below — an unknown path is a plain 404 (never the site's 404 page, never the
admin) — and the main application's routes (admin, `/api/admin/*`, `/internal/*`, the site, the
version routes) do not exist on it. Nothing here needs a login: the game is public and
single-player; a visitor stores nothing on the server (the bank and "never again" list live in
the visitor's own browser).

Routes: `GET /` and `GET /d/{code}` (the page shell), `GET /assets/{name}`, `GET /api/bank`,
`GET|POST /api/pack/{code}`, `GET /media/{id}/{thumb|full}.jpg`, `GET /robots.txt`,
`GET /manifest.webmanifest`. See docs/ai/adventure-public.md and docs/ai/contracts.md.
"""

from __future__ import annotations

import json
import math
import os
import re
import stat
import time
from collections.abc import Callable
from typing import Any, Final

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.types import DecoratedCallable
from starlette.exceptions import HTTPException as StarletteHTTPException

from wixy_server.adventure_public.codes import PublicDestination
from wixy_server.adventure_public.files import PooledFileResponse
from wixy_server.adventure_public.limits import StartTicket, client_key
from wixy_server.adventure_public.pictures import FULL_NAME, THUMB_NAME
from wixy_server.adventure_public.runner import PUBLIC_UNAVAILABLE_TEXT
from wixy_server.adventure_public.service import AdventurePublicService
from wixy_server.adventure_public.shell import (
    OpenGraph,
    manifest_json,
    media_type,
)
from wixy_server.adventure_public.store import PackRow, PictureRow

_PICTURE_ID_RE: Final = re.compile(r"[0-9a-f]{32}")
_MEDIA_NAMES: Final = {THUMB_NAME: "thumb", FULL_NAME: "full"}
_IMMUTABLE: Final = "public, max-age=31536000, immutable"
_READY_MAX_AGE_S: Final = 60
UNAVAILABLE_TEXT: Final = (
    "Adventure Time isn't available right now - please try again in a little while"
)
"""What every public page and API route answers (503) while the public store has not prepared."""


def _service(request: Request) -> AdventurePublicService:
    service: AdventurePublicService = request.app.state.adventure_public
    return service


def _json(content: Any, *, status: int = 200, cache: str = "no-store") -> JSONResponse:
    return JSONResponse(content, status_code=status, headers={"Cache-Control": cache})


def _picture_json(picture: PictureRow) -> dict[str, Any]:
    return {
        "thumbUrl": f"/media/{picture.id}/{THUMB_NAME}",
        "fullUrl": f"/media/{picture.id}/{FULL_NAME}",
        "credit": picture.credit,
        "page": picture.page,
        "caption": picture.caption,
    }


def _pictures_json(pictures: list[PictureRow]) -> dict[str, Any]:
    """`{hero: [Picture], items: {"<section>:<index>": Picture}}`, hero in order."""
    hero: list[tuple[int, dict[str, Any]]] = []
    items: dict[str, Any] = {}
    for picture in pictures:
        if picture.slot.startswith("hero:"):
            index = picture.slot.removeprefix("hero:")
            hero.append(
                (int(index) if index.isdigit() else picture.ordinal, _picture_json(picture))
            )
        else:
            items[picture.slot] = _picture_json(picture)
    hero.sort(key=lambda entry: entry[0])
    return {"hero": [entry for _, entry in hero], "items": items}


def pack_view(
    service: AdventurePublicService,
    destination: PublicDestination,
    stored: tuple[PackRow, list[PictureRow]] | None,
    *,
    now: float,
) -> tuple[dict[str, Any], str]:
    """`(the GET /api/pack/{code} body, its Cache-Control)`.

    `state` is `none` (nothing asked for yet), `pending`, `ready` or `failed`. `images` is
    `pending` while the pictures are still being found and `done` otherwise (as in the private
    game's pack view). `canRetry` says a `POST` would start research now; `retryAfterS` is how long
    a failed pack must still wait. With no researcher configured a pack can never be made: it reads
    as `failed` with a plain message and `canRetry: false`, so the client does not loop."""
    available = service.runner.available
    base: dict[str, Any] = {"code": destination.code, "destinationId": destination.destination.id}
    if stored is None:
        if not available:
            view = {
                **base,
                "state": "failed",
                "data": None,
                "error": PUBLIC_UNAVAILABLE_TEXT,
                "canRetry": False,
                "images": "done",
                "pictures": {"hero": [], "items": {}},
                "retryAfterS": None,
            }
        else:
            view = {
                **base,
                "state": "none",
                "data": None,
                "error": None,
                "canRetry": True,
                "images": "done",
                "pictures": {"hero": [], "items": {}},
                "retryAfterS": None,
            }
        return view, "no-store"
    row, pictures = stored
    data: Any = None
    if row.state == "ready" and row.pack_json is not None:
        try:
            data = json.loads(row.pack_json)
        except json.JSONDecodeError:
            data = None
    waiting = row.next_try_at is not None and now < row.next_try_at
    can_retry = available and row.state == "failed" and not waiting
    retry_after = (
        max(1, math.ceil((row.next_try_at or now) - now))
        if row.state == "failed" and waiting
        else None
    )
    view = {
        **base,
        "state": row.state,
        "data": data,
        "error": row.error if row.state == "failed" else None,
        "canRetry": can_retry,
        "images": "pending" if row.images == "pending" else "done",
        "pictures": _pictures_json(pictures),
        "retryAfterS": retry_after,
    }
    settled = row.state == "ready" and row.images != "pending"
    return view, f"public, max-age={_READY_MAX_AGE_S}" if settled else "no-store"


def _accepts_gzip(header: str | None) -> bool:
    if not header:
        return False
    for part in header.split(","):
        name, _, params = part.strip().partition(";")
        if name.strip().lower() in ("gzip", "x-gzip"):
            quality = params.replace(" ", "").lower()
            return quality not in ("q=0", "q=0.0", "q=0.00", "q=0.000")
    return False


def _etag_matches(header: str | None, etag: str) -> bool:
    if not header:
        return False
    if header.strip() == "*":
        return True
    wanted = etag.removeprefix("W/")
    return any(token.strip().removeprefix("W/") == wanted for token in header.split(","))


def _once(call: Callable[[], None]) -> Callable[[], None]:
    """`call` at most once (a start-budget refund is owed once, whichever path discovers it)."""
    done = False

    def run() -> None:
        nonlocal done
        if not done:
            done = True
            call()

    return run


def build_adventure_public_app(service: AdventurePublicService) -> FastAPI:
    """The public application: the routes above and nothing else (no docs, no OpenAPI, no slash
    redirects). Mounted behind the host gate by `create_app`.

    Every blocking call goes through `service.threads` (the public host's own worker-thread budget,
    never anyio's shared default pool), and every page and API route first checks that the public
    store prepared at start: if it did not, they answer 503 and touch nothing (the static assets,
    robots and the manifest need no store and are still served)."""
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)
    app.state.adventure_public = service
    threads = service.threads

    @app.exception_handler(StarletteHTTPException)
    async def _plain_errors(_request: Request, exc: StarletteHTTPException) -> Response:
        """Every unknown path is the same plain 404; nothing of the main app's error shapes."""
        if exc.status_code == 404:
            text = "Not found"
        elif exc.status_code == 503:
            text = UNAVAILABLE_TEXT
        else:
            text = "Method not allowed"
        return PlainTextResponse(text, status_code=exc.status_code, headers=exc.headers)

    async def require_ready() -> None:
        if not service.status.ready:
            raise StarletteHTTPException(
                503, headers={"Cache-Control": "no-store", "Retry-After": "30"}
            )

    router = APIRouter(dependencies=[Depends(require_ready)])
    open_router = APIRouter()  # needs no store: served even when the store did not prepare

    def page(path: str, *, gated: bool = True) -> Callable[[DecoratedCallable], DecoratedCallable]:
        target = router if gated else open_router
        return target.api_route(path, methods=["GET", "HEAD"], include_in_schema=False)

    # -- the page shell --------------------------------------------------------------------------

    @page("/")
    async def get_shell() -> HTMLResponse:
        return HTMLResponse(service.shell.render(), headers={"Cache-Control": "no-cache"})

    @page("/d/{code}")
    async def get_place(code: str) -> HTMLResponse:
        place = service.bank.lookup(code)
        if place is None:
            return HTMLResponse(
                service.shell.render(missing=True),
                status_code=404,
                headers={"Cache-Control": "no-cache"},
            )
        stored = await threads.run(service.store.get_with_pictures, place.destination.id)
        image: str | None = None
        if stored is not None and stored[0].state == "ready":
            heroes = sorted(
                (p for p in stored[1] if p.slot.startswith("hero:")), key=lambda p: p.ordinal
            )
            if heroes:
                image = f"{service.shell.origin}/media/{heroes[0].id}/{THUMB_NAME}"
        graph = OpenGraph(
            title=place.destination.name,
            description=f"{place.unit.name} · {place.destination.blurb}",
            url=service.shell.short_url(place.code),
            image=image,
        )
        return HTMLResponse(
            service.shell.render(code=place.code, graph=graph),
            headers={"Cache-Control": "no-cache"},
        )

    # -- assets ----------------------------------------------------------------------------------

    async def regular_file(path: Any) -> os.stat_result | None:
        """The `os.stat` of `path` when it is a regular file (taken on the public threads), else
        `None`."""
        try:
            found: os.stat_result = await threads.run(os.stat, path)
        except OSError:
            return None
        return found if stat.S_ISREG(found.st_mode) else None

    @page("/assets/{name}", gated=False)
    async def get_asset(name: str, request: Request) -> Response:
        path = await threads.run(service.assets.resolve, name)
        if path is None:
            return PlainTextResponse("Not found", status_code=404)
        found = await regular_file(path)
        if found is None:
            return PlainTextResponse("Not found", status_code=404)
        fingerprint = await threads.run(service.assets.fingerprint, path)
        asked = request.query_params.get("v")
        immutable = fingerprint is not None and asked == fingerprint
        return PooledFileResponse(
            path,
            threads=threads,
            stat_result=found,
            media_type=media_type(path),
            headers={"Cache-Control": _IMMUTABLE if immutable else "no-cache"},
        )

    @page("/media/{picture_id}/{name}")
    async def get_media(picture_id: str, name: str) -> Response:
        rendition = _MEDIA_NAMES.get(name)
        if rendition is None or _PICTURE_ID_RE.fullmatch(picture_id) is None:
            return PlainTextResponse("Not found", status_code=404)
        path = service.pictures_dir / picture_id / name
        found = await regular_file(path)
        if found is None:
            return PlainTextResponse("Not found", status_code=404)
        return PooledFileResponse(
            path,
            threads=threads,
            stat_result=found,
            media_type="image/jpeg",
            headers={"Cache-Control": _IMMUTABLE},
        )

    @page("/robots.txt", gated=False)
    async def get_robots() -> PlainTextResponse:
        return PlainTextResponse("User-agent: *\nDisallow: /\n")

    @page("/manifest.webmanifest", gated=False)
    async def get_manifest() -> Response:
        return Response(
            manifest_json(),
            media_type="application/manifest+json",
            headers={"Cache-Control": "no-cache"},
        )

    # -- the bank --------------------------------------------------------------------------------

    @page("/api/bank")
    async def get_bank(request: Request) -> Response:
        bank = service.bank
        gzip_ok = _accepts_gzip(request.headers.get("accept-encoding"))
        etag = bank.gzip_etag if gzip_ok else bank.etag
        headers = {"ETag": etag, "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
        if _etag_matches(request.headers.get("if-none-match"), etag):
            return Response(status_code=304, headers=headers)
        if gzip_ok:
            headers["Content-Encoding"] = "gzip"
            return Response(bank.gzipped, media_type="application/json", headers=headers)
        return Response(bank.body, media_type="application/json", headers=headers)

    # -- a place's holiday pack ------------------------------------------------------------------

    @router.get("/api/pack/{code}", include_in_schema=False)
    async def get_pack(code: str) -> JSONResponse:
        place = service.bank.lookup(code)
        if place is None:
            return _json({"error": "not_found"}, status=404)
        stored = await threads.run(service.store.get_with_pictures, place.destination.id)
        view, cache = pack_view(service, place, stored, now=time.time())
        return _json(view, cache=cache)

    @router.post("/api/pack/{code}", include_in_schema=False)
    async def post_pack(code: str, request: Request) -> JSONResponse:
        if request.headers.get("origin") != service.shell.origin:
            return _json({"error": "forbidden"}, status=403)
        place = service.bank.lookup(code)
        if place is None:
            return _json({"error": "not_found"}, status=404)
        destination_id = place.destination.id

        async def current() -> JSONResponse:
            stored = await threads.run(service.store.get_with_pictures, destination_id)
            view, cache = pack_view(service, place, stored, now=time.time())
            return _json(view, cache=cache)

        if not service.runner.available:
            return await current()
        now = time.time()
        row = await threads.run(service.store.get, destination_id)
        if row is not None and (
            row.state != "failed" or (row.next_try_at is not None and now < row.next_try_at)
        ):
            return await current()  # already researched or under way, or not yet retryable
        client = client_key(request.headers, request.client.host if request.client else None)
        ticket = service.limiter.acquire(client)
        if not isinstance(ticket, StartTicket):
            wait = ticket
            return JSONResponse(
                {"error": "rate_limited", "retryAfterS": wait},
                status_code=429,
                headers={"Retry-After": str(wait), "Cache-Control": "no-store"},
            )
        result = await threads.run(service.store.request_start, destination_id)
        if result.kind != "started":
            service.limiter.release(ticket)  # someone else began it first
            return await current()
        refund = _once(lambda: service.limiter.release(ticket))
        if not service.runner.start(destination_id, refund):
            # Nobody can run the job (the background group is gone): never leave a `pending` row
            # no one is researching. It becomes a failure that may be asked for again
            # in a minute (the cmd-unreachable rule), and the visitor's start is given back.
            await threads.run(
                lambda: service.store.finish(
                    destination_id,
                    run_id=None,
                    state="failed",
                    error=PUBLIC_UNAVAILABLE_TEXT,
                    transient=True,
                )
            )
            refund()
        return await current()

    app.include_router(open_router)
    app.include_router(router)
    return app
