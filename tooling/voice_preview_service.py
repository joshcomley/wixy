"""Serve a frozen private acceptance candidate under the service supervisor."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True)
    runtime = parser.parse_args().runtime.resolve()
    deployment = json.loads((runtime / "deployment.json").read_text(encoding="utf-8"))
    candidate = Path(deployment["candidate"]).resolve()
    settings = json.loads((runtime / "settings.json").read_text(encoding="utf-8"))
    if not candidate.is_relative_to(runtime):
        raise RuntimeError("Preview candidate must be contained in its runtime directory")
    if not Path(settings["WIXY_STORAGE_ROOT"]).resolve().is_relative_to(runtime):
        raise RuntimeError("Preview storage must be contained in its runtime directory")
    for key in list(os.environ):
        if key.startswith("WIXY_"):
            del os.environ[key]
    os.environ.update(settings)
    sys.path.insert(0, str(candidate))

    import uvicorn

    from wixy_server.app import create_app
    from wixy_server.livechat.call_protocol import SERVER_OPTIONS

    app = create_app(storage_root=Path(settings["WIXY_STORAGE_ROOT"]), wixy_repo_root=candidate)
    if app.state.settings.dev_no_auth or app.state.settings.env != "prod":
        raise RuntimeError("Preview requires production authentication")
    if app.state.call_origins != frozenset({"https://wixy-call-test.cinnamons.uk"}):
        raise RuntimeError("Unexpected preview call origin")
    uvicorn.run(
        app, host="127.0.0.1", port=9488, log_level="warning", access_log=False, **SERVER_OPTIONS
    )


if __name__ == "__main__":
    main()
