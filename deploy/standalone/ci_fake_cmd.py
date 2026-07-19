"""CI-only helper for the image-boot-proof job (spec/independence/03 §5):
boots `wixy_server.tests.fake_cmd`'s app on the two FIXED ports
`wixy_server.cmdchat.CmdChatClient`'s own defaults expect (9320 portal, 9321
Cmd-Chats) so a `WIXY_EDITION=fleet` container run with `--network host` can
reach a "cmd" without any real one existing on the runner. Not a pytest
fixture (that's `wixy_server/tests/fake_cmd.py`, which this imports and
reuses unchanged) — a standalone, foreground, run-and-block script invoked
directly by the CI workflow, never collected by pytest.
"""

from __future__ import annotations

import threading
import time

import uvicorn

from wixy_server.tests.fake_cmd import create_fake_cmd_app

PORTAL_PORT = 9320
CHATS_PORT = 9321


def _serve(port: int) -> None:
    app = create_fake_cmd_app()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    uvicorn.Server(config).run()


def main() -> None:
    for port in (PORTAL_PORT, CHATS_PORT):
        threading.Thread(target=_serve, args=(port,), daemon=True).start()
    # Give both servers a moment to bind before the caller starts polling them.
    time.sleep(2)
    print(f"fake cmd up on 127.0.0.1:{PORTAL_PORT} + 127.0.0.1:{CHATS_PORT}", flush=True)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
