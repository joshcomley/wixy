"""Route-ready response for the opt-in Server service worker.

P3b registers :func:`server_sw_response` before the admin SPA catch-all.  Keeping
the response constructor here makes that registration independent of the app
factory's route assembly and guarantees the worker's required headers.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.responses import FileResponse

_SERVER_SW_PATH = Path(__file__).parent.parent / "static" / "admin" / "server-sw.js"


def server_sw_response() -> FileResponse:
    """Return the built worker with the scope and cache headers it requires."""

    return FileResponse(
        _SERVER_SW_PATH,
        media_type="text/javascript",
        headers={
            "Cache-Control": "no-cache",
            "Service-Worker-Allowed": "/admin/",
        },
    )


__all__ = ["server_sw_response"]
