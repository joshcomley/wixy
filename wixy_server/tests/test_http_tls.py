"""One TLS context per process (decisions/00217): building an app no longer re-reads the certificate
bundle for every HTTP client, and certificate checking is exactly as strict as httpx's default."""

from __future__ import annotations

import ssl
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from wixy_server import http_tls
from wixy_server.app import create_app
from wixy_server.tests.live_voice_testkit import make_wixy_repo


def test_the_shared_context_verifies_certificates_and_host_names() -> None:
    context = http_tls.shared_ssl_context()
    assert context is http_tls.shared_ssl_context()
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True


def test_building_apps_makes_at_most_one_tls_context(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    made: list[object] = []
    real = ssl.create_default_context

    def counting(*args: Any, **kwargs: Any) -> ssl.SSLContext:
        made.append(args or kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(ssl, "create_default_context", counting)
    http_tls.shared_ssl_context.cache_clear()
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")
    for n in range(2):
        base = tmp_path / f"app{n}"
        base.mkdir()
        app = create_app(storage_root=base / "storage", wixy_repo_root=make_wixy_repo(base))
        with TestClient(app) as client:
            assert client.get("/api/version").status_code == 200
    http_tls.shared_ssl_context.cache_clear()
    assert len(made) <= 1, made
