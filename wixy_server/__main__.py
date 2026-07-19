"""`python -m wixy_server` entrypoint (spec/07-hosting-deploy.md §1) — boots uvicorn
serving the app `create_app` builds. `launcher.py` (running under the active slot's own
venv) execs this. `storage_root` resolves the same way `create_app`'s docstring
describes (`WIXY_STORAGE_ROOT`, set by `launcher.py`, falling back to the production
default — see `wixy_server.settings`); `wixy_repo_root` is this checkout's own root (the
parent of this package), which IS the slot directory at runtime.
"""

from __future__ import annotations

from pathlib import Path

import uvicorn

from wixy_server.app import create_app
from wixy_server.settings import load_settings, resolve_storage_root

_WIXY_REPO_ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    storage_root = resolve_storage_root()
    settings = load_settings(storage_root)
    app = create_app(storage_root=storage_root, wixy_repo_root=_WIXY_REPO_ROOT)
    # Loopback-only by default (spec/07's opening line) — the cloudflared tunnel is
    # the only path in from the public internet, never a direct bind on a routable
    # interface. The standalone edition's compose file sets WIXY_CONTAINERIZED=1
    # (spec/independence/01 §2.2, 03 §2): its own cloudflared container reaches this
    # process over the compose network, not loopback, so binding 0.0.0.0 there stays
    # container-internal (docker-compose.yml publishes no ports) rather than a public
    # bind — the gate exists so a bare-metal/non-compose run can never accidentally
    # bind a routable interface.
    host = "0.0.0.0" if settings.containerized else "127.0.0.1"
    uvicorn.run(app, host=host, port=settings.port)


if __name__ == "__main__":
    main()
