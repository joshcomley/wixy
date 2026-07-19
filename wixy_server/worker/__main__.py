"""`python -m wixy_server.worker` entrypoint — the `worker` compose service's own
`command:` (docker-compose.yml), same image as `wixy` but never bound to any
address `wixy`/cloudflared reach it at except the compose-internal network (no
published port — see `wixy_server.worker.app`'s own docstring). Binds `0.0.0.0`
unconditionally: unlike `wixy_server.__main__`, there is no bare-metal/non-compose
run of this process to guard against (it only ever exists as this compose service).
"""

from __future__ import annotations

import uvicorn

from wixy_server.worker.app import create_worker_app
from wixy_server.worker.settings import load_worker_settings


def main() -> None:
    settings = load_worker_settings()
    app = create_worker_app(settings=settings)
    uvicorn.run(app, host="0.0.0.0", port=settings.port)  # noqa: S104 - compose-internal only, see docstring


if __name__ == "__main__":
    main()
