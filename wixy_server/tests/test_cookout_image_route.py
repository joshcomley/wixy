# ruff: noqa: F811  (pytest fixtures re-used from other test modules are rebound as parameters)
"""`GET /admin/cookout-img/{sha}.webp` (spec 09b section B.7) and the server's slot pin (B.6): a
manifest sha is served as an immutable, content-addressed `image/webp` with no unlock token,
anything else is a 404, the object search path has a fixed precedence, and the running server
writes, refreshes and retires its pin in the storage registry."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wixy_server.livechat.cookout_pack import object_relpath
from wixy_server.livechat.cookout_visuals import (
    IngredientVisuals,
    load_visuals,
    search_path,
    set_default_visuals,
)
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.tests.test_cookout_visuals import (
    FakeCatalogue,
    make_visuals,
    manifest_for,
    sha_of,
    write_object,
)
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    _dev_no_auth,
    fake_cmd_state,
    origin_repo,
    pin_verifier,
    storage_root,
    wixy_repo_root,
)
from wixy_server.tests.test_routes_livechat_cookout import BASE, cookout_client

ROUTE = "/admin/cookout-img"


@pytest.fixture(autouse=True)
def _reset_default_visuals() -> Iterator[None]:
    yield
    set_default_visuals(None)


@pytest.fixture
def images(tmp_path: Path) -> Path:
    return tmp_path / "images"


def get(client: TestClient, sha: str, **headers: str) -> object:
    return client.get(f"{ROUTE}/{sha}.webp", headers=headers)


class TestImageRoute:
    def test_a_known_sha_is_served_as_immutable_webp_without_an_unlock_token(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier, images: Path
    ) -> None:
        visuals = make_visuals(images, ["a"])
        sha = sha_of("card-a")
        with cookout_client(
            storage_root, wixy_repo_root, pin_verifier, cookout_visuals=visuals
        ) as (client, _h, _):
            resp = client.get(f"{ROUTE}/{sha}.webp")  # no token headers at all
            assert resp.status_code == 200
            assert resp.headers["content-type"] == "image/webp"
            assert resp.headers["x-content-type-options"] == "nosniff"
            assert resp.headers["cache-control"] == "private, max-age=31536000, immutable"
            assert resp.headers["etag"] == f'"{sha}"'
            assert resp.content == (images / object_relpath(sha)).read_bytes()

    def test_if_none_match_gets_a_304_without_a_body(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier, images: Path
    ) -> None:
        visuals = make_visuals(images, ["a"])
        sha = sha_of("thumb-a")
        with cookout_client(
            storage_root, wixy_repo_root, pin_verifier, cookout_visuals=visuals
        ) as (client, _h, _):
            resp = client.get(f"{ROUTE}/{sha}.webp", headers={"If-None-Match": f'"{sha}"'})
            assert resp.status_code == 304 and resp.content == b""
            assert resp.headers["etag"] == f'"{sha}"'
            other = client.get(f"{ROUTE}/{sha}.webp", headers={"If-None-Match": '"nope"'})
            assert other.status_code == 200

    @pytest.mark.parametrize(
        "name",
        [
            "zz.webp",
            "ABCDEF.webp",
            f"{'a' * 64}.png",
            f"{'a' * 64}",
            f"{'a' * 63}.webp",
            f"{'a' * 65}.webp",
            f"{'A' * 64}.webp",
        ],
    )
    def test_malformed_names_are_404(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        images: Path,
        name: str,
    ) -> None:
        visuals = make_visuals(images, ["a"])
        with cookout_client(
            storage_root, wixy_repo_root, pin_verifier, cookout_visuals=visuals
        ) as (client, _h, _):
            assert client.get(f"{ROUTE}/{name}").status_code == 404

    def test_a_sha_not_in_the_manifest_is_404_even_if_a_file_exists(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier, images: Path
    ) -> None:
        visuals = make_visuals(images, ["a"])
        stray = sha_of("stray")
        write_object(images, stray)  # on disk, but no manifest names it: never probe-able
        with cookout_client(
            storage_root, wixy_repo_root, pin_verifier, cookout_visuals=visuals
        ) as (client, _h, _):
            assert client.get(f"{ROUTE}/{stray}.webp").status_code == 404

    def test_a_known_sha_whose_file_is_missing_is_404(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier, images: Path
    ) -> None:
        visuals = make_visuals(images, ["a"], with_files=False)
        with cookout_client(
            storage_root, wixy_repo_root, pin_verifier, cookout_visuals=visuals
        ) as (client, _h, _):
            assert client.get(f"{ROUTE}/{sha_of('card-a')}.webp").status_code == 404


class TestSearchPath:
    def test_order_is_images_dir_then_storage_then_baked(self, tmp_path: Path) -> None:
        storage, env_dir, baked = tmp_path / "s", tmp_path / "e", tmp_path / "b"
        assert search_path(storage, env_dir, baked) == [
            env_dir,
            storage / "cookout-images" / "objects",
            baked,
        ]
        assert search_path(storage, None, None) == [storage / "cookout-images" / "objects"]
        assert search_path(None, None, None) == []

    def test_the_first_directory_holding_a_file_wins_over_later_ones(self, tmp_path: Path) -> None:
        storage, env_dir, baked = tmp_path / "s", tmp_path / "e", tmp_path / "b"
        objects = storage / "cookout-images" / "objects"
        manifest = manifest_for(["a"])
        ref = manifest.items["a"]
        for directory in (env_dir, objects, baked):
            write_object(directory, ref.card)
            write_object(directory, ref.thumb)
        visuals = load_visuals(
            search_path(storage, env_dir, baked),
            manifest=manifest,
            catalogue=FakeCatalogue({}),  # type: ignore[arg-type]
        )
        assert visuals.resolve_object(ref.card) == env_dir / object_relpath(ref.card)
        (env_dir / object_relpath(ref.card)).unlink()
        visuals.reload()
        assert visuals.resolve_object(ref.card) == objects / object_relpath(ref.card)
        (objects / object_relpath(ref.card)).unlink()
        visuals.reload()
        assert visuals.resolve_object(ref.card) == baked / object_relpath(ref.card)

    def test_the_baked_directory_alone_is_enough(self, tmp_path: Path) -> None:
        baked = tmp_path / "baked"
        manifest = manifest_for(["a"])
        for sha in (manifest.items["a"].card, manifest.items["a"].thumb):
            write_object(baked, sha)
        visuals = IngredientVisuals(
            FakeCatalogue({}),  # type: ignore[arg-type]
            manifest,
            search_path(None, None, baked),
        )
        assert visuals.snap_extras("a")["image"] is not None


class TestFridgeSearchEnrichment:
    def test_fridge_search_results_carry_what_and_image(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier, images: Path
    ) -> None:
        from wixy_server.tests.test_livechat_cookout import FakeBank

        bank = FakeBank()
        ids = [i.id for i in bank.items] + [s.id for s in bank.staples]
        visuals = make_visuals(images, ids)
        with cookout_client(
            storage_root, wixy_repo_root, pin_verifier, bank=bank, cookout_visuals=visuals
        ) as (client, h, _):
            found = client.get(f"{BASE}/cookout/ingredients?q=zedbase0", headers=h).json()
            items = found["ingredients"]
            assert items
            for item in items:
                assert item["what"] == f"What {item['id']} is, in plain words."
                assert item["image"]["card"].endswith(".webp")


class TestSlotPin:
    def _pins(self, storage_root: Path) -> list[dict[str, object]]:
        pins = storage_root / "cookout-images" / "registry" / "pins"
        return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(pins.glob("*.json"))]

    def test_the_server_pins_its_manifest_refreshes_the_lease_and_retires_on_shutdown(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier, images: Path
    ) -> None:
        visuals = make_visuals(images, ["a"])
        with cookout_client(
            storage_root,
            wixy_repo_root,
            pin_verifier,
            cookout_visuals=visuals,
            cookout_visuals_refresh_s=0.05,
        ) as (_client, _h, _):
            first = self._pins(storage_root)
            assert len(first) == 1
            assert first[0]["kind"] == "slot" and first[0]["retiredAt"] is None
            assert first[0]["digest"] == visuals.manifest.digest
            lease = float(first[0]["leaseUntil"])  # type: ignore[arg-type]
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                now = float(self._pins(storage_root)[0]["leaseUntil"])  # type: ignore[arg-type]
                if now > lease:
                    break
                time.sleep(0.05)
            else:
                pytest.fail("the lease was never refreshed")
        after = self._pins(storage_root)
        assert len(after) == 1 and after[0]["retiredAt"] is not None
