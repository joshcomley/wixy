# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""The public Adventure Time routes (workspace 00065, spec/adventure-public/README.md §2.3): the
page shell and its Open Graph tags, the assets (and ONLY the assets), the bank, a place's holiday
pack (read, start, retry), the pictures, robots and the manifest — with the exact JSON shapes the
client builds against. The host gate itself is `test_adventure_public_gate.py`.

Read-mostly cases share ONE app (`public`, module scoped; each test uses its own destination);
anything that needs a differently configured app builds its own."""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import re
import sqlite3
import time
from collections.abc import Iterator
from io import BytesIO
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from wixy_server.adventure_public.limits import PublicLimits
from wixy_server.adventure_public.runner import PUBLIC_FAILED_TEXT, PUBLIC_UNAVAILABLE_TEXT
from wixy_server.adventure_public.shell import MISSING_MESSAGE
from wixy_server.adventure_public.store import StartResult
from wixy_server.livechat.adventure_bank import parse_bank
from wixy_server.livechat.adventure_pack import sanitise_pack
from wixy_server.tests.adventure_public_testkit import (
    OTHER_HOST,
    PUBLIC_ORIGIN,
    code_of,
    get_pack,
    make_static_dir,
    module_public_client,
    public_client,
    request_pack,
    service,
    wait_for,
    wait_for_images,
    wait_for_state,
)
from wixy_server.tests.adventure_testkit import (
    FakePictureFinder,
    FakeResearcher,
    FakeRunPlan,
)
from wixy_server.tests.fake_cmd import CANNED_ADVENTURE_PACK
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    _dev_no_auth,
    origin_repo,
    storage_root,
    wixy_repo_root,
)

ADMIN_STATIC = Path(__file__).parents[1] / "static" / "admin"


@pytest.fixture(scope="module")
def static_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_static_dir(tmp_path_factory.mktemp("adv-public-static"))


@pytest.fixture(scope="module")
def researcher() -> FakeResearcher:
    return FakeResearcher()


@pytest.fixture(scope="module")
def public(
    tmp_path_factory: pytest.TempPathFactory, static_dir: Path, researcher: FakeResearcher
) -> Iterator[TestClient]:
    root = tmp_path_factory.mktemp("adv-public-routes")
    with module_public_client(
        root, static_dir=static_dir, researcher=researcher, finder=FakePictureFinder()
    ) as client:
        yield client


def boot_of(html: str) -> dict[str, Any]:
    match = re.search(
        r'<script type="application/json" id="adventure-public-boot">(.*?)</script>', html, re.S
    )
    assert match is not None, html
    boot: dict[str, Any] = json.loads(match.group(1))
    return boot


def meta(html: str, key: str) -> str | None:
    match = re.search(rf'<meta (?:property|name)="{re.escape(key)}" content="([^"]*)">', html)
    return match.group(1) if match else None


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:10]


class TestShell:
    def test_the_root_is_a_dark_phone_ready_page_with_the_boot_block(
        self, public: TestClient, static_dir: Path
    ) -> None:
        response = public.get("/")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/html")
        assert response.headers["cache-control"] == "no-cache"
        html = response.text
        assert '<meta name="viewport" content="width=device-width, initial-scale=1' in html
        assert '<meta name="color-scheme" content="dark">' in html
        assert "<title>Adventure Time</title>" in html
        assert '<div id="adventure-public-root">' in html
        assert 'rel="manifest" href="/manifest.webmanifest"' in html
        # The client bundle, fingerprinted from the file contents.
        assert f'href="/assets/app.css?v={digest(static_dir / "app.css")}"' in html
        assert f'src="/assets/app.js?v={digest(static_dir / "app.js")}"' in html
        boot = boot_of(html)
        assert boot["code"] is None
        assert boot["origin"] == PUBLIC_ORIGIN
        assert set(boot["assets"]) == {"world", "satellite", "atlas"}
        assert boot["assets"]["world"] == (
            f"/assets/adventure-world.json?v={digest(ADMIN_STATIC / 'adventure-world.json')}"
        )
        satellite = digest(ADMIN_STATIC / "adventure-satellite.webp")
        assert boot["assets"]["satellite"] == f"/assets/adventure-satellite.webp?v={satellite}"
        assert boot["assets"]["atlas"] == (
            f"/assets/adventure-atlas.webp?v={digest(ADMIN_STATIC / 'adventure-atlas.webp')}"
        )
        assert "missing" not in boot

    def test_it_loads_nothing_from_anywhere_but_itself(self, public: TestClient) -> None:
        html = public.get("/").text
        assert not re.search(r'(?:src|href)="https?://', html)
        assert "<script>" not in html  # no inline script (the CSP forbids it)

    def test_the_page_paints_at_once_from_its_inline_style(self, public: TestClient) -> None:
        html = public.get("/").text
        assert "background:#0b1020" in html and "color-scheme:dark" in html
        assert "Loading Adventure Time" in html

    def test_head_is_answered_too(self, public: TestClient) -> None:
        response = public.head("/")
        assert response.status_code == 200 and response.content == b""

    def test_a_changed_bundle_is_a_new_url_after_a_restart(
        self,
        tmp_path: Path,
        storage_root: Path,
        wixy_repo_root: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        static = make_static_dir(tmp_path)
        with public_client(storage_root, wixy_repo_root, monkeypatch, static_dir=static) as client:
            first = client.get("/").text
        (static / "app.js").write_bytes(b"/* a new build */\n")
        with public_client(storage_root, wixy_repo_root, monkeypatch, static_dir=static) as client:
            second = client.get("/").text
        assert first != second
        assert f"app.js?v={digest(static / 'app.js')}" in second

    def test_the_shell_still_renders_when_the_client_bundle_is_not_built_yet(
        self,
        tmp_path: Path,
        storage_root: Path,
        wixy_repo_root: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, static_dir=tmp_path / "nothing-here"
        ) as client:
            response = client.get("/")
            assert response.status_code == 200
            assert 'src="/assets/app.js"' in response.text  # bare URL: no fingerprint to read
            assert 'href="/assets/app.css"' in response.text
            assert client.get("/assets/app.js").status_code == 404


class TestPlacePage:
    def test_a_known_code_carries_its_open_graph_tags(self, public: TestClient) -> None:
        code = code_of(public, "BBB.one")
        response = public.get(f"/d/{code}")
        assert response.status_code == 200
        html = response.text
        assert "<title>Beta One — Adventure Time</title>" in html
        assert meta(html, "og:title") == "Beta One"
        assert meta(html, "og:description") == "Betaland · Rank one of Betaland."
        assert meta(html, "og:url") == f"{PUBLIC_ORIGIN}/d/{code}"
        assert meta(html, "og:type") == "website"
        assert meta(html, "og:site_name") == "Adventure Time"
        assert meta(html, "og:image") is None  # no pack yet: no picture
        assert meta(html, "twitter:card") == "summary"
        boot = boot_of(html)
        assert boot["code"] == code and boot["origin"] == PUBLIC_ORIGIN
        assert response.headers["cache-control"] == "no-cache"

    def test_the_image_is_the_first_hero_thumb_once_the_pack_is_ready(
        self, public: TestClient
    ) -> None:
        code = code_of(public, "BBB.two")
        assert meta(public.get(f"/d/{code}").text, "og:image") is None
        assert request_pack(public, code).status_code == 200
        view = wait_for_state(public, code, "ready")
        view = wait_for_images(public, code, "done")
        hero = view["pictures"]["hero"][0]["thumbUrl"]
        html = public.get(f"/d/{code}").text
        assert meta(html, "og:image") == f"{PUBLIC_ORIGIN}{hero}"
        assert meta(html, "twitter:image") == f"{PUBLIC_ORIGIN}{hero}"
        assert meta(html, "twitter:card") == "summary_large_image"

    def test_an_unknown_code_is_the_not_on_the_map_page_with_a_404(
        self, public: TestClient
    ) -> None:
        for path in (
            "/d/zzzzzz",
            "/d/abc",
            "/d/ABCDEF",
            "/d/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ):
            response = public.get(path)
            assert response.status_code == 404, path
            assert response.headers["content-type"].startswith("text/html")
            assert MISSING_MESSAGE in response.text.replace("&#x27;", "'")
            assert 'href="/">Spin the globe</a>' in response.text
            boot = boot_of(response.text)
            assert boot["code"] is None and boot["missing"] is True
            assert "og:title" not in response.text

    def test_a_destination_id_is_not_a_code(self, public: TestClient) -> None:
        assert public.get("/d/BBB.one").status_code == 404


class TestEscaping:
    def test_a_hostile_place_name_is_escaped_in_every_tag(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        hostile = '"><script>alert(1)</script> & <b>'
        bank = parse_bank(
            {
                "version": 1,
                "generated": "2026-10-28",
                "countries": {
                    "XXX": {
                        "name": hostile,
                        "advice": None,
                        "destinations": [
                            {
                                "id": "XXX.evil",
                                "name": hostile,
                                "region": "R",
                                "lat": 1.0,
                                "lng": 2.0,
                                "kind": "city",
                                "blurb": hostile,
                            }
                        ],
                    }
                },
            }
        )
        with public_client(storage_root, wixy_repo_root, monkeypatch, bank=bank) as client:
            code = code_of(client, "XXX.evil")
            html = client.get(f"/d/{code}").text
            assert "<script>alert(1)" not in html and "<b>" not in html
            assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html
            assert "&quot;&gt;" in html
            boot = boot_of(html)  # still parses: the boot block cannot be closed from outside
            assert boot["code"] == code


class TestAssets:
    def test_the_bundle_is_served_with_the_right_type(self, public: TestClient) -> None:
        js = public.get("/assets/app.js")
        assert js.status_code == 200 and js.content == b"/* stub bundle */\n"
        assert js.headers["content-type"].startswith("text/javascript")
        css = public.get("/assets/app.css")
        assert css.headers["content-type"].startswith("text/css")

    def test_a_fingerprinted_url_is_immutable_and_anything_else_revalidates(
        self, public: TestClient, static_dir: Path
    ) -> None:
        good = public.get(f"/assets/app.js?v={digest(static_dir / 'app.js')}")
        assert good.headers["cache-control"] == "public, max-age=31536000, immutable"
        assert public.get("/assets/app.js?v=deadbeef00").headers["cache-control"] == "no-cache"
        assert public.get("/assets/app.js").headers["cache-control"] == "no-cache"

    def test_the_shared_adventure_imagery_is_the_same_bytes_the_private_game_uses(
        self, public: TestClient
    ) -> None:
        world = public.get("/assets/adventure-world.json")
        assert world.status_code == 200
        assert world.content == (ADMIN_STATIC / "adventure-world.json").read_bytes()
        assert world.headers["content-type"].startswith("application/json")
        for name in ("adventure-satellite.webp", "adventure-atlas.webp"):
            response = public.get(f"/assets/{name}")
            assert response.status_code == 200 and response.headers["content-type"] == "image/webp"
            assert len(response.content) == (ADMIN_STATIC / name).stat().st_size
        fingerprint = digest(ADMIN_STATIC / "adventure-world.json")
        immutable = public.get(f"/assets/adventure-world.json?v={fingerprint}")
        assert immutable.headers["cache-control"] == "public, max-age=31536000, immutable"

    def test_the_home_screen_icons_are_real_pngs(self, public: TestClient) -> None:
        for name, size in (
            ("icon-192.png", 192),
            ("icon-512.png", 512),
            ("apple-touch-icon.png", 180),
        ):
            response = public.get(f"/assets/{name}")
            assert response.status_code == 200 and response.headers["content-type"] == "image/png"
            with Image.open(BytesIO(response.content)) as image:
                assert image.size == (size, size)

    @pytest.mark.parametrize(
        "name",
        [
            "admin.js",  # the ADMIN bundle is never served on the public host
            "admin.css",
            "admin.js.map",
            "adventure-destinations.json",  # in the admin directory but not a shared name
            "adventure-sample-pack.json",
            "adventure-preview.html",
            "server-sw.js",
            "call-worklet.js",
            "cookout-mode-classic.webp",
            "missing.js",
            ".env",
            "app.js.part",
            "sub",
            "adventure-world.json.bak",
            "ADVENTURE-WORLD.JSON",
        ],
    )
    def test_only_the_bundle_the_imagery_and_the_icons_are_assets(
        self, public: TestClient, name: str
    ) -> None:
        response = public.get(f"/assets/{name}")
        assert response.status_code == 404 and response.text == "Not found"

    def test_head_is_answered_for_assets(self, public: TestClient) -> None:
        response = public.head("/assets/app.js")
        assert response.status_code == 200


class TestRobotsAndManifest:
    def test_robots_disallows_everything(self, public: TestClient) -> None:
        response = public.get("/robots.txt")
        assert response.status_code == 200
        assert response.text == "User-agent: *\nDisallow: /\n"
        assert response.headers["content-type"].startswith("text/plain")

    def test_the_manifest_lets_it_be_added_to_a_home_screen(self, public: TestClient) -> None:
        response = public.get("/manifest.webmanifest")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/manifest+json")
        manifest = response.json()
        assert manifest["name"] == "Adventure Time" and manifest["start_url"] == "/"
        assert manifest["display"] == "standalone" and manifest["scope"] == "/"
        assert manifest["background_color"] == manifest["theme_color"] == "#0b1020"
        sources = {icon["src"]: icon["sizes"] for icon in manifest["icons"]}
        assert sources == {"/assets/icon-192.png": "192x192", "/assets/icon-512.png": "512x512"}
        for source in sources:
            assert public.get(source).status_code == 200


class TestBank:
    def test_it_is_the_public_bank_document(self, public: TestClient) -> None:
        response = public.get("/api/bank")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/json"
        document = response.json()
        assert set(document) == {"version", "countries"}
        first = document["countries"]["AAA"]["destinations"][0]
        assert set(first) == {"id", "code", "name", "region", "lat", "lng", "kind", "blurb"}
        assert first["code"] == code_of(public, "AAA.one")
        assert response.content == service(public).bank.body

    def test_it_is_revalidated_by_etag(self, public: TestClient) -> None:
        response = public.get("/api/bank")
        etag = response.headers["etag"]
        assert response.headers["cache-control"] == "no-cache"
        for header in (etag, f"W/{etag}", f'"nope", {etag}', "*"):
            again = public.get("/api/bank", headers={"If-None-Match": header})
            assert again.status_code == 304, header
            assert again.content == b"" and again.headers["etag"] == etag
        assert public.get("/api/bank", headers={"If-None-Match": '"stale"'}).status_code == 200

    def test_it_is_gzipped_when_asked_and_keeps_a_separate_etag(self, public: TestClient) -> None:
        plain = public.get("/api/bank", headers={"Accept-Encoding": "identity"})
        assert "content-encoding" not in plain.headers
        packed = public.get("/api/bank", headers={"Accept-Encoding": "gzip"})
        assert packed.headers["content-encoding"] == "gzip"
        assert packed.headers["vary"] == "Accept-Encoding"
        assert packed.headers["etag"] != plain.headers["etag"]
        assert packed.content == plain.content  # the client library has already unzipped it
        assert packed.num_bytes_downloaded < plain.num_bytes_downloaded
        assert gzip.decompress(service(public).bank.gzipped) == plain.content
        # The gzip variant revalidates against ITS etag, not the plain one's.
        assert (
            public.get(
                "/api/bank",
                headers={"Accept-Encoding": "gzip", "If-None-Match": packed.headers["etag"]},
            ).status_code
            == 304
        )

    def test_gzip_at_quality_zero_is_refused(self, public: TestClient) -> None:
        response = public.get("/api/bank", headers={"Accept-Encoding": "gzip;q=0, identity"})
        assert "content-encoding" not in response.headers


class TestPackRead:
    def test_an_unknown_code_is_a_json_404(self, public: TestClient) -> None:
        response = public.get("/api/pack/zzzzzz")
        assert response.status_code == 404 and response.json() == {"error": "not_found"}
        assert public.get("/api/pack/AAA.one").status_code == 404

    def test_a_place_nobody_asked_for_is_none_and_never_cached(self, public: TestClient) -> None:
        code = code_of(public, "AAA.six")
        response = public.get(f"/api/pack/{code}")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.json() == {
            "code": code,
            "destinationId": "AAA.six",
            "state": "none",
            "data": None,
            "error": None,
            "canRetry": True,
            "images": "done",
            "pictures": {"hero": [], "items": {}},
            "retryAfterS": None,
        }
        assert service(public).store.get("AAA.six") is None  # reading creates nothing


class TestPackStart:
    def test_a_ready_pack_has_the_researched_data_and_its_pictures(
        self, public: TestClient, researcher: FakeResearcher
    ) -> None:
        code = code_of(public, "AAA.one")
        started = request_pack(public, code)
        assert started.status_code == 200
        assert started.json()["state"] in ("pending", "ready")
        assert started.headers["cache-control"] == "no-store" or started.json()["state"] == "ready"
        view = wait_for_state(public, code, "ready")
        view = wait_for_images(public, code, "done")
        assert set(view) == {
            "code",
            "destinationId",
            "state",
            "data",
            "error",
            "canRetry",
            "images",
            "pictures",
            "retryAfterS",
        }
        assert view["code"] == code and view["destinationId"] == "AAA.one"
        assert view["data"] == sanitise_pack(CANNED_ADVENTURE_PACK)
        assert view["error"] is None and view["canRetry"] is False and view["retryAfterS"] is None
        pictures = view["pictures"]
        assert len(pictures["hero"]) == 2 and list(pictures["items"]) == ["food:0"]
        first = pictures["hero"][0]
        assert set(first) == {"thumbUrl", "fullUrl", "credit", "page", "caption"}
        assert re.fullmatch(r"/media/[0-9a-f]{32}/thumb\.jpg", first["thumbUrl"])
        assert re.fullmatch(r"/media/[0-9a-f]{32}/full\.jpg", first["fullUrl"])
        assert first["thumbUrl"].split("/")[2] == first["fullUrl"].split("/")[2]
        assert first["credit"] == "Photo 0, CC BY 4.0" and first["caption"] == "Caption 0"
        assert first["page"] == "https://commons.example.org/wiki/File:Photo_0.jpg"
        assert pictures["hero"][1]["caption"] is None
        # A settled pack may be cached for a short while; one still working never is.
        settled = public.get(f"/api/pack/{code}")
        assert settled.headers["cache-control"] == "public, max-age=60"
        # The research prompt named this destination only, from the public cwd.
        prompts = [(p, cwd) for p, cwd in researcher.started if "Alpha One" in p]
        assert len(prompts) == 1
        assert prompts[0][1] == service(public).store.db_path.parent / "research"

    def test_asking_again_never_researches_again(
        self, public: TestClient, researcher: FakeResearcher
    ) -> None:
        code = code_of(public, "AAA.two")
        for _ in range(3):
            assert request_pack(public, code).status_code == 200
        wait_for_state(public, code, "ready")
        before = len([p for p, _ in researcher.started if "Alpha Two" in p])
        assert before == 1
        again = request_pack(public, code)
        assert again.status_code == 200 and again.json()["state"] == "ready"
        assert len([p for p, _ in researcher.started if "Alpha Two" in p]) == 1

    def test_the_second_visitor_gets_the_cached_pack_at_once(
        self, public: TestClient, researcher: FakeResearcher
    ) -> None:
        code = code_of(public, "AAA.three")
        request_pack(public, code)
        wait_for_state(public, code, "ready")
        runs = len(researcher.started)
        other = public.post(
            f"/api/pack/{code}",
            headers={"Origin": PUBLIC_ORIGIN, "CF-Connecting-IP": "198.51.100.77"},
        )
        assert other.json()["state"] == "ready" and other.json()["data"] is not None
        assert len(researcher.started) == runs  # nothing new was researched

    @pytest.mark.parametrize(
        "origin",
        [
            None,
            "",
            "null",
            "http://adventure.example.test",
            f"https://{OTHER_HOST}",
            "https://evil.example",
            f"{PUBLIC_ORIGIN}/",
            f"{PUBLIC_ORIGIN}.evil.example",
            PUBLIC_ORIGIN.upper(),
        ],
    )
    def test_the_origin_must_be_the_public_origin(
        self, public: TestClient, researcher: FakeResearcher, origin: str | None
    ) -> None:
        code = code_of(public, "CCC.only")
        runs = len(researcher.started)
        headers = {} if origin is None else {"Origin": origin}
        response = public.post(f"/api/pack/{code}", headers=headers)
        assert response.status_code == 403 and response.json() == {"error": "forbidden"}
        assert len(researcher.started) == runs
        assert service(public).store.get("CCC.only") is None

    def test_an_unknown_code_is_a_404_even_with_the_right_origin(self, public: TestClient) -> None:
        response = request_pack(public, "zzzzzz")
        assert response.status_code == 404 and response.json() == {"error": "not_found"}

    def test_the_other_methods_are_not_allowed(self, public: TestClient) -> None:
        code = code_of(public, "AAA.one")
        for method in ("PUT", "DELETE", "PATCH"):
            response = public.request(
                method, f"/api/pack/{code}", headers={"Origin": PUBLIC_ORIGIN}
            )
            assert response.status_code == 405


@pytest.fixture(scope="module")
def sample(public: TestClient) -> dict[str, Any]:
    """A destination whose pack and pictures are all in."""
    code = code_of(public, "DDD.one")
    request_pack(public, code)
    wait_for_state(public, code, "ready")
    return wait_for_images(public, code, "done")


class TestMedia:
    def test_a_picture_is_served_with_immutable_caching(
        self, public: TestClient, sample: dict[str, Any]
    ) -> None:
        picture = sample["pictures"]["hero"][0]
        full = public.get(picture["fullUrl"])
        thumb = public.get(picture["thumbUrl"])
        assert full.status_code == thumb.status_code == 200
        assert full.headers["content-type"] == thumb.headers["content-type"] == "image/jpeg"
        assert full.headers["cache-control"] == "public, max-age=31536000, immutable"
        assert thumb.headers["cache-control"] == "public, max-age=31536000, immutable"
        with Image.open(BytesIO(full.content)) as big, Image.open(BytesIO(thumb.content)) as small:
            assert big.format == small.format == "JPEG"
            assert max(small.size) <= 480 < max(big.size)
            assert max(big.size) <= 1600
        assert full.content[:2] == b"\xff\xd8"

    @pytest.mark.parametrize(
        "path",
        [
            "/media/" + "0" * 32 + "/thumb.jpg",  # well formed, but nothing there
            "/media/" + "A" * 32 + "/thumb.jpg",  # not lower-case hex
            "/media/" + "0" * 31 + "/thumb.jpg",
            "/media/" + "0" * 33 + "/thumb.jpg",
            "/media/" + "g" * 32 + "/thumb.jpg",
            "/media/../thumb.jpg",
            "/media/x/thumb.jpg",
            "/media/" + "0" * 32 + "/thumb.png",
            "/media/" + "0" * 32 + "/original.jpg",
            "/media/" + "0" * 32 + "/",
        ],
    )
    def test_anything_else_is_a_404(self, public: TestClient, path: str) -> None:
        response = public.get(path)
        assert response.status_code == 404

    def test_a_real_id_with_the_wrong_file_name_is_a_404(
        self, public: TestClient, sample: dict[str, Any]
    ) -> None:
        picture_id = sample["pictures"]["hero"][0]["thumbUrl"].split("/")[2]
        assert public.get(f"/media/{picture_id}/thumb.jpg").status_code == 200
        assert public.get(f"/media/{picture_id}/full.png").status_code == 404
        assert public.get(f"/media/{picture_id}/other.jpg").status_code == 404

    def test_a_picture_on_disk_is_the_one_in_the_database(
        self, public: TestClient, sample: dict[str, Any]
    ) -> None:
        directory = service(public).pictures_dir
        for picture in [*sample["pictures"]["hero"], *sample["pictures"]["items"].values()]:
            picture_id = picture["thumbUrl"].split("/")[2]
            assert (directory / picture_id / "thumb.jpg").is_file()
            assert (directory / picture_id / "full.jpg").is_file()


class TestFailedPacks:
    def test_a_failed_pack_reads_failed_and_waits_ten_minutes_before_a_retry(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher([FakeRunPlan(statuses=["error"]), FakeRunPlan()])
        with public_client(storage_root, wixy_repo_root, monkeypatch, researcher=fake) as client:
            code = code_of(client, "AAA.one")
            request_pack(client, code)
            view = wait_for_state(client, code, "failed")
            assert view["error"] == PUBLIC_FAILED_TEXT
            assert view["data"] is None and view["canRetry"] is False
            assert 590 <= view["retryAfterS"] <= 600
            assert client.get(f"/api/pack/{code}").headers["cache-control"] == "no-store"
            # Asking before the time is up answers the stored failed view and starts nothing.
            answer = request_pack(client, code)
            assert answer.status_code == 200 and answer.json()["state"] == "failed"
            assert len(fake.started) == 1
            # The wait is over (the clock moved on): it may be asked for again and then succeeds.
            conn = sqlite3.connect(str(service(client).store.db_path))
            try:
                conn.execute("UPDATE packs SET next_try_at = ?", (time.time() - 1,))
                conn.commit()
            finally:
                conn.close()
            # The raw update stands in for the clock moving on: a write the store did not make
            # itself, so the settled-pack read cache is told (a real clock expires it by itself).
            service(client).store._invalidate("AAA.one")  # noqa: SLF001
            retryable = get_pack(client, code)
            assert retryable["state"] == "failed"
            assert retryable["canRetry"] is True and retryable["retryAfterS"] is None
            restarted = request_pack(client, code)
            assert restarted.status_code == 200
            wait_for_state(client, code, "ready")
            assert len(fake.started) == 2

    def test_with_no_researcher_a_pack_reads_failed_unavailable_and_cannot_retry(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(storage_root, wixy_repo_root, monkeypatch, no_researcher=True) as client:
            code = code_of(client, "AAA.one")
            for response in (get_pack_response(client, code), request_pack(client, code)):
                assert response.status_code == 200
                body = response.json()
                assert body["state"] == "failed" and body["error"] == PUBLIC_UNAVAILABLE_TEXT
                assert body["canRetry"] is False and body["data"] is None
            assert service(client).store.get("AAA.one") is None  # nothing was created


def run_id_of(client: TestClient, destination_id: str) -> str | None:
    row = service(client).store.get(destination_id)
    return row.run_id if row is not None else None


def get_pack_response(client: TestClient, code: str) -> Any:
    return client.get(f"/api/pack/{code}")


class TestRateLimits:
    def limits(self, **over: int) -> PublicLimits:
        return PublicLimits(**{"global_per_hour": 30, "per_ip_per_hour": 6, **over})

    def test_one_client_may_start_six_researches_an_hour_then_gets_a_429(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher()
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            researcher=fake,
            limits=self.limits(per_ip_per_hour=2),
        ) as client:
            headers = {"Origin": PUBLIC_ORIGIN, "CF-Connecting-IP": "203.0.113.5"}
            ids = ["AAA.one", "AAA.two", "AAA.three"]
            codes = [code_of(client, i) for i in ids]
            assert client.post(f"/api/pack/{codes[0]}", headers=headers).status_code == 200
            assert client.post(f"/api/pack/{codes[1]}", headers=headers).status_code == 200
            refused = client.post(f"/api/pack/{codes[2]}", headers=headers)
            assert refused.status_code == 429
            wait = int(refused.headers["retry-after"])
            assert 3590 <= wait <= 3600
            assert refused.json() == {"error": "rate_limited", "retryAfterS": wait}
            assert refused.headers["cache-control"] == "no-store"
            # Nothing was started for the refused one, and reading it still works (someone else's
            # request may be researching it).
            assert service(client).store.get(ids[2]) is None
            assert get_pack(client, codes[2])["state"] == "none"
            # A different client is not held back by this one's limit.
            other = client.post(
                f"/api/pack/{codes[2]}", headers={**headers, "CF-Connecting-IP": "203.0.114.6"}
            )
            assert other.status_code == 200
            # Asking again for a place already started is free: it counts for nothing.
            again = client.post(f"/api/pack/{codes[0]}", headers=headers)
            assert again.status_code == 200

    def test_all_clients_together_may_start_only_so_many_an_hour(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, limits=self.limits(global_per_hour=3)
        ) as client:
            ids = ["AAA.one", "AAA.two", "AAA.three", "AAA.four"]
            statuses = [
                client.post(
                    f"/api/pack/{code_of(client, dest)}",
                    headers={"Origin": PUBLIC_ORIGIN, "CF-Connecting-IP": f"203.0.113.{n}"},
                ).status_code
                for n, dest in enumerate(ids, start=1)
            ]
            assert statuses == [200, 200, 200, 429]

    def test_without_the_cloudflare_header_the_socket_peer_is_the_client(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, limits=self.limits(per_ip_per_hour=1)
        ) as client:
            first = client.post(
                f"/api/pack/{code_of(client, 'AAA.one')}", headers={"Origin": PUBLIC_ORIGIN}
            )
            second = client.post(
                f"/api/pack/{code_of(client, 'AAA.two')}", headers={"Origin": PUBLIC_ORIGIN}
            )
            assert (first.status_code, second.status_code) == (200, 429)

    def test_asking_again_for_a_place_already_started_costs_nothing(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, limits=self.limits(per_ip_per_hour=1)
        ) as client:
            code = code_of(client, "AAA.one")
            headers = {"Origin": PUBLIC_ORIGIN, "CF-Connecting-IP": "203.0.113.9"}
            assert client.post(f"/api/pack/{code}", headers=headers).status_code == 200
            assert client.post(f"/api/pack/{code}", headers=headers).status_code == 200
            # The client's one start is spent on the first place, so a different one is refused.
            other = client.post(f"/api/pack/{code_of(client, 'AAA.two')}", headers=headers)
            assert other.status_code == 429

    def test_a_start_that_loses_the_race_to_another_request_is_given_back(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, limits=self.limits(per_ip_per_hour=1)
        ) as client:
            store = service(client).store
            real = store.request_start
            lost = {"once": True}

            def request_start(destination_id: str, *, now: float | None = None) -> StartResult:
                if lost["once"]:
                    # Another request starts this very place between our look and our start.
                    lost["once"] = False
                    real(destination_id)
                return real(destination_id, now=now)

            monkeypatch.setattr(store, "request_start", request_start)
            headers = {"Origin": PUBLIC_ORIGIN, "CF-Connecting-IP": "203.0.113.9"}
            first = client.post(f"/api/pack/{code_of(client, 'AAA.one')}", headers=headers)
            assert first.status_code == 200  # it answers the pack the other request began
            # The lost start was given back, so the client's one slot is still free.
            second = client.post(f"/api/pack/{code_of(client, 'AAA.two')}", headers=headers)
            assert second.status_code == 200

    def test_the_address_is_never_logged(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        with caplog.at_level(logging.DEBUG):
            with public_client(
                storage_root, wixy_repo_root, monkeypatch, limits=self.limits(per_ip_per_hour=1)
            ) as client:
                headers = {"Origin": PUBLIC_ORIGIN, "CF-Connecting-IP": "203.0.113.123"}
                client.post(f"/api/pack/{code_of(client, 'AAA.one')}", headers=headers)
                client.post(f"/api/pack/{code_of(client, 'AAA.two')}", headers=headers)
                client.get("/", headers={"CF-Connecting-IP": "203.0.113.123"})
        assert "203.0.113.123" not in caplog.text

    def test_reads_are_never_limited(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with public_client(
            storage_root,
            wixy_repo_root,
            monkeypatch,
            limits=self.limits(per_ip_per_hour=1, global_per_hour=1),
        ) as client:
            code = code_of(client, "AAA.one")
            for _ in range(20):
                assert client.get(f"/api/pack/{code}").status_code == 200
                assert client.get("/api/bank").status_code == 200
                assert client.get(f"/d/{code}").status_code == 200


class TestRestartResumes:
    def test_a_pack_left_pending_is_resumed_by_the_next_process(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = FakeResearcher([FakeRunPlan(statuses=["running"] * 1000)])
        with public_client(storage_root, wixy_repo_root, monkeypatch, researcher=fake) as first:
            code = code_of(first, "AAA.one")
            request_pack(first, code)
            wait_for(lambda: len(fake.started) == 1, what="the run to start")
            wait_for(
                lambda: run_id_of(first, "AAA.one") == "fake-run-1", what="the run to be recorded"
            )
        # The first process is gone; the row still says pending, with its run id.
        row = service(first).store.get("AAA.one")
        assert row is not None and row.state == "pending" and row.run_id == "fake-run-1"
        second_fake = FakeResearcher()
        second_fake.adopt("fake-run-1")
        with public_client(
            storage_root, wixy_repo_root, monkeypatch, researcher=second_fake
        ) as second:
            view = wait_for_state(second, code, "ready")
            assert view["data"] is not None
            assert second_fake.started == []  # it polled the known run; it did not start another
