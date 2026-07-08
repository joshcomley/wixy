"""Scaffold smoke test — replaced by the real server test suite from milestone 6 onward."""

import wixy_server


def test_package_imports() -> None:
    assert wixy_server.__all__ == []
