# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""The host gate of the public Adventure Time host (workspace 00065, spec/adventure-public/README.md
§2.1 / §2.6, Inv 61): the security boundary. Both directions, exhaustively — on the public host
ONLY the public routes exist (admin, `/api/admin/*`, `/internal/*`, the site, the version routes,
docs and sockets are a plain 404 / refused, whatever the path trick), on any other host the public
routes do not exist, and with the feature off the gate and the routes are simply absent.

The read-only cases share ONE app (`public`, module scoped): starting the app is the expensive part.
Traversal paths go straight through the ASGI interface (`asgi_request`): an HTTP client library
collapses `..` and `//` before sending, which would hide exactly what is being tested."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import cast

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from wixy_server.adventure_public.gate import AdventurePublicHostGate, normalise_host
from wixy_server.app import create_app
from wixy_server.settings import load_settings
from wixy_server.tests.adventure_public_testkit import (
    OTHER_HOST,
    PUBLIC_HOST,
    asgi_request,
    make_static_dir,
    module_public_client,
)
from wixy_server.tests.adventure_testkit import fixture_bank
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    _dev_no_auth,
    origin_repo,
    storage_root,
    wixy_repo_root,
)

OTHER = {"host": OTHER_HOST}
SITE_STATUSES = (404, 503)
"""What the main app's site answers for a path it has no page for: 404, or 503 while the site
checkout is not there (the case in a test)."""

CSP = (
    "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; frame-ancestors 'none'; "
    "base-uri 'none'; form-action 'none'"
)

# What the main app serves that must NEVER be reachable on the public host.
FORBIDDEN_PATHS = [
    "/admin",
    "/admin/",
    "/admin/pages",
    "/admin/edit/home",
    "/admin/static/admin.js",
    "/admin/static/uxer/anything",
    "/admin/guide/",
    "/admin/guide/index.html",
    "/admin/preview/index.html",
    "/admin/draft-media/x.jpg",
    "/admin/server-sw.js",
    "/admin/cookout-image/abc.webp",
    "/api/admin/state",
    "/api/admin/content",
    "/api/admin/media",
    "/api/admin/server/adventure/bank",
    "/api/admin/server/adventure/settings",
    "/api/admin/server/messages",
    "/api/admin/server/calls/ws",
    "/api/admin/server/live-voice/x",
    "/internal/health",
    "/internal/cookout/modes",
    "/healthz",
    "/api/version",
    "/api/version/notes",
    "/api/versions",
    "/uxer-style.json",
    "/.uxer-web-port",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/images/photo.jpg",
    "/about",
    "/index.html",
    "/site.css",
    "/site.js",
    "/theme.css",
    "/sitemap.xml",
    "/favicon.ico",
    "/api/bank/",  # a trailing slash is NOT a public route (no redirect)
    "/d",
    "/d/",
    "/api/pack",
    "/api/pack/",
    "/assets",
    "/assets/",
    "/media",
    "/media/",
]
TRAVERSAL_PATHS = [
    "/assets/../admin/admin.js",
    "/assets/%2e%2e/admin",
    "/assets/..%2fadmin",
    "/assets/..%2f..%2fadmin%2fadmin.js",
    "/assets/..\\admin",
    "/assets/.env",
    "/assets/%2e%2e%2f%2e%2e%2fsettings.py",
    "/assets/app.js/../../admin/admin.js",
    "/assets/sub/app.js",
    "/media/../admin",
    "/media/%2e%2e/%2e%2e/admin",
    "/media/00000000000000000000000000000000/../../../server.db",
    "/d/../admin",
    "/d/..%2fadmin",
    "/d/%2e%2e%2f%2e%2e%2fadmin",
    "//admin",
    "///api/admin/state",
    "/%2e%2e/admin",
    "/./admin",
    "/api/./admin/state",
    "/api/pack/../admin/state",
    "/api/pack/%2e%2e%2fadmin%2fstate",
    "/ADMIN",
    "/Api/Admin/State",
    "/admin%00",
    "/admin;x=1",
    "/admin?x=/",
    "/%61dmin",
    "/api/%61dmin/state",
]


@pytest.fixture(scope="module")
def public(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    root = tmp_path_factory.mktemp("adv-public-gate")
    with module_public_client(root, static_dir=make_static_dir(root)) as client:
        yield client


def _hardened(headers: dict[str, str]) -> None:
    assert headers["x-robots-tag"] == "noindex"
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert headers["content-security-policy"] == CSP


def _public_404(status: int, headers: dict[str, str], body: bytes) -> None:
    # The public application's own plain 404 — not the site's 404 page, not the main app's JSON.
    assert status == 404, body
    assert body == b"Not found"
    _hardened(headers)


def _any_code(client: TestClient) -> str:
    return str(next(iter(client.app.state.adventure_public.bank.by_code)))  # type: ignore[attr-defined]


class TestPublicHostServesOnlyThePublicRoutes:
    @pytest.mark.parametrize("path", FORBIDDEN_PATHS)
    def test_every_other_path_is_a_plain_404_with_the_hardening_headers(
        self, public: TestClient, path: str
    ) -> None:
        response = public.get(path)
        _public_404(response.status_code, dict(response.headers), response.content)

    @pytest.mark.parametrize("path", FORBIDDEN_PATHS + TRAVERSAL_PATHS)
    def test_the_same_through_the_raw_asgi_interface(self, public: TestClient, path: str) -> None:
        _public_404(*asgi_request(public.app, path, host=PUBLIC_HOST))

    @pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
    @pytest.mark.parametrize(
        "path",
        [
            "/admin",
            "/api/admin/server/unlock",
            "/api/admin/server/adventure",
            "/api/admin/state",
            "/api/admin/server/adventure/1/spin",
            "/internal/anything",
            "/api/version",
            "/",
        ],
    )
    def test_no_mutation_reaches_the_main_app(
        self, public: TestClient, method: str, path: str
    ) -> None:
        status, headers, body = asgi_request(
            public.app,
            path,
            host=PUBLIC_HOST,
            method=method,
            headers=[("origin", f"https://{PUBLIC_HOST}")],
        )
        # `/` is a public route (GET only: 405); every other path does not exist (404).
        assert status == (405 if path == "/" else 404), body
        assert body in (b"Not found", b"Method not allowed")
        _hardened(headers)

    @pytest.mark.parametrize(
        "host",
        [
            PUBLIC_HOST,
            PUBLIC_HOST.upper(),
            "Adventure.Example.Test",
            f"{PUBLIC_HOST}:443",
            f"{PUBLIC_HOST}:8443",
            f"{PUBLIC_HOST.upper()}:9380",
            f"{PUBLIC_HOST}.",
            f"{PUBLIC_HOST}.:443",
            f"  {PUBLIC_HOST}  ",
        ],
    )
    def test_the_host_is_matched_lower_cased_with_the_port_stripped(
        self, public: TestClient, host: str
    ) -> None:
        status, headers, body = asgi_request(public.app, "/", host=host)
        assert status == 200 and b"adventure-public-boot" in body
        _hardened(headers)
        for path in ("/admin", "/api/admin/state", "/internal/health"):
            _public_404(*asgi_request(public.app, path, host=host))

    def test_a_request_naming_the_public_host_in_any_host_header_is_confined_to_it(
        self, public: TestClient
    ) -> None:
        # Two `Host` headers, one of them the public host: ambiguity is never widened.
        status, headers, body = asgi_request(
            public.app,
            "/admin",
            host=OTHER_HOST,
            headers=[("host", PUBLIC_HOST)],
        )
        _public_404(status, headers, body)

    def test_a_forwarded_or_origin_header_cannot_change_which_host_a_request_is(
        self, public: TestClient
    ) -> None:
        # The Host header is the only authority: a spoofed forwarded host changes nothing.
        _public_404(
            *asgi_request(
                public.app,
                "/admin",
                host=PUBLIC_HOST,
                headers=[("x-forwarded-host", OTHER_HOST), ("origin", f"https://{OTHER_HOST}")],
            )
        )
        # ...and the public host's routes are not reachable by claiming it forwarded.
        status, headers, body = asgi_request(
            public.app, "/api/bank", host=OTHER_HOST, headers=[("x-forwarded-host", PUBLIC_HOST)]
        )
        assert status in SITE_STATUSES and body != b"Not found"
        assert "content-security-policy" not in headers

    def test_sockets_are_refused_on_the_public_host(self, public: TestClient) -> None:
        for path in (
            "/api/admin/server/calls/ws",
            "/api/admin/server/live-voice/listen",
            "/ws",
            "/",
        ):
            with pytest.raises(WebSocketDisconnect):
                with public.websocket_connect(path):
                    pass

    def test_every_public_route_answer_carries_the_hardening_headers(
        self, public: TestClient
    ) -> None:
        code = _any_code(public)
        for path in (
            "/",
            f"/d/{code}",
            "/d/zzzzzz",
            "/assets/app.js",
            "/assets/app.css",
            "/assets/adventure-world.json",
            "/assets/icon-192.png",
            "/assets/missing.js",
            "/api/bank",
            f"/api/pack/{code}",
            "/api/pack/zzzzzz",
            "/media/" + "0" * 32 + "/thumb.jpg",
            "/robots.txt",
            "/manifest.webmanifest",
        ):
            _hardened(dict(public.get(path).headers))
        bank = public.get("/api/bank")
        revalidated = public.get("/api/bank", headers={"If-None-Match": bank.headers["etag"]})
        assert revalidated.status_code == 304
        _hardened(dict(revalidated.headers))
        refused = public.post(f"/api/pack/{code}")  # no Origin: 403
        assert refused.status_code == 403
        _hardened(dict(refused.headers))


class TestOtherHostsDoNotGetThePublicRoutes:
    @pytest.mark.parametrize(
        "host",
        [
            OTHER_HOST,
            f"{PUBLIC_HOST}.evil.example",
            f"evil.{PUBLIC_HOST}",
            f"{PUBLIC_HOST}x",
            f"x{PUBLIC_HOST}",
            "127.0.0.1:9380",
            "localhost",
            "adventure.example.test.evil.example:443",
            "",
        ],
    )
    def test_the_public_routes_answer_404_there(self, public: TestClient, host: str) -> None:
        code = _any_code(public)
        for path in (
            "/api/bank",
            f"/api/pack/{code}",
            f"/d/{code}",
            "/assets/app.js",
            "/assets/adventure-world.json",
            "/media/" + "0" * 32 + "/thumb.jpg",
        ):
            status, headers, body = asgi_request(public.app, path, host=host)
            assert status in SITE_STATUSES, (host, path, status)
            assert "content-security-policy" not in headers  # not the public application
            assert body != b"Not found"  # not its plain 404
        status, headers, _ = asgi_request(
            public.app,
            f"/api/pack/{code}",
            host=host,
            method="POST",
            headers=[("origin", f"https://{PUBLIC_HOST}")],
        )
        assert status in (404, 405, 503)
        assert "content-security-policy" not in headers

    def test_a_malformed_host_whose_name_part_is_the_public_host_is_confined_to_it(
        self, public: TestClient
    ) -> None:
        # Not a valid Host header (userinfo after the port). The name before the first colon is the
        # public host, so the gate confines it: the safe direction, since that can only ever
        # narrow what the request may reach.
        _public_404(
            *asgi_request(public.app, "/admin", host="adventure.example.test:443@evil.example")
        )

    def test_the_sites_own_root_and_robots_and_manifest_are_still_the_sites(
        self, public: TestClient
    ) -> None:
        root = public.get("/", headers=OTHER)
        assert "adventure-public-boot" not in root.text
        assert "content-security-policy" not in root.headers
        robots = public.get("/robots.txt", headers=OTHER)
        assert robots.text != "User-agent: *\nDisallow: /\n"
        manifest = public.get("/manifest.webmanifest", headers=OTHER)
        assert "Adventure Time" not in manifest.text

    def test_the_admin_still_works_on_the_private_host(self, public: TestClient) -> None:
        admin = public.get("/admin", headers=OTHER)
        assert admin.status_code == 200 and "Wixy Admin" in admin.text
        assert "content-security-policy" not in admin.headers
        assert public.get("/api/version", headers=OTHER).status_code == 200


class TestFeatureOff:
    def test_with_no_host_set_nothing_is_mounted_and_no_gate_exists(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("WIXY_ADVENTURE_PUBLIC_HOST", raising=False)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        assert app.state.adventure_public is None
        assert all(cast(object, m.cls) is not AdventurePublicHostGate for m in app.user_middleware)

    def test_a_request_for_the_would_be_public_host_is_just_another_host(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("WIXY_ADVENTURE_PUBLIC_HOST", raising=False)
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, adventure_bank=fixture_bank()
        )
        with TestClient(app, base_url=f"https://{PUBLIC_HOST}") as client:
            for path in ("/api/bank", "/d/abcdef", "/assets/app.js", "/media/x/thumb.jpg"):
                response = client.get(path)
                assert response.status_code in SITE_STATUSES
                assert response.text != "Not found"
                assert "content-security-policy" not in response.headers
            assert "adventure-public-boot" not in client.get("/").text
            assert client.get("/admin").status_code == 200  # the admin is untouched

    def test_the_gate_is_the_outermost_middleware_when_the_feature_is_on(
        self, public: TestClient
    ) -> None:
        middleware = public.app.user_middleware  # type: ignore[attr-defined]
        assert cast(object, middleware[0].cls) is AdventurePublicHostGate
        assert len(middleware) >= 3  # admin auth + robots header sit INSIDE it


class TestSetting:
    def test_it_is_off_by_default(
        self, storage_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("WIXY_ADVENTURE_PUBLIC_HOST", raising=False)
        assert load_settings(storage_root).adventure_public_host == ""

    def test_it_is_read_from_the_environment_and_the_env_file(
        self, storage_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("WIXY_ADVENTURE_PUBLIC_HOST", raising=False)
        storage_root.mkdir(parents=True, exist_ok=True)
        (storage_root / ".env").write_text(
            "WIXY_ADVENTURE_PUBLIC_HOST=From-File.Example\n", encoding="utf-8"
        )
        assert load_settings(storage_root).adventure_public_host == "from-file.example"
        monkeypatch.setenv("WIXY_ADVENTURE_PUBLIC_HOST", "env.example")
        assert load_settings(storage_root).adventure_public_host == "env.example"

    @pytest.mark.parametrize(
        "bad",
        [
            "https://adventure.example",
            "adventure.example:8080",
            "adventure.example/path",
            "adventure example",
            "-bad.example",
            "bad-.example",
            "a..b",
            "adventure.example.",
            "under_score.example",
        ],
    )
    def test_a_value_that_is_not_a_bare_host_name_refuses_to_start(
        self, storage_root: Path, monkeypatch: pytest.MonkeyPatch, bad: str
    ) -> None:
        monkeypatch.setenv("WIXY_ADVENTURE_PUBLIC_HOST", bad)
        with pytest.raises(RuntimeError, match="WIXY_ADVENTURE_PUBLIC_HOST"):
            load_settings(storage_root)

    def test_the_standalone_edition_refuses_a_non_empty_value_at_start(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WIXY_EDITION", "standalone")
        monkeypatch.setenv("WIXY_ADVENTURE_PUBLIC_HOST", PUBLIC_HOST)
        with pytest.raises(RuntimeError, match="standalone"):
            load_settings(storage_root)
        with pytest.raises(RuntimeError, match="standalone"):
            create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        # An empty value on the standalone edition is the only valid one.
        monkeypatch.setenv("WIXY_ADVENTURE_PUBLIC_HOST", "")
        assert load_settings(storage_root).adventure_public_host == ""


class TestNormaliseHost:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Example.COM", "example.com"),
            ("example.com:8080", "example.com"),
            ("example.com.", "example.com"),
            ("example.com.:443", "example.com"),
            ("  example.com ", "example.com"),
            ("[::1]:8000", "[::1]"),
            ("", ""),
            (b"Example.com:1", "example.com"),
        ],
    )
    def test_it(self, raw: str | bytes, expected: str) -> None:
        assert normalise_host(raw) == expected
