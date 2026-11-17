"""The reset the suite's autouse fixture (conftest.py) runs around every test, so a test that
builds an app (`create_app` installs the Cookout visuals as the process default) never leaves
them for the next one."""

from __future__ import annotations

from collections.abc import Iterator

from wixy_server.livechat.cookout_visuals import set_default_visuals


def isolated_default_visuals() -> Iterator[None]:
    set_default_visuals(None)
    yield
    set_default_visuals(None)
