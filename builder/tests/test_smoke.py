"""Scaffold smoke test — replaced by the real binding/injection/validate suite in milestone 2."""

import builder


def test_package_imports() -> None:
    assert builder.__all__ == []
