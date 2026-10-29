# ruff: noqa: F811  (pytest fixtures re-used from other test modules are rebound as parameters)
"""`GET /admin/cookout-img/{sha}.webp` (spec 09b section B.7) and the server's slot pin (B.6): a
manifest sha is served as an immutable, content-addressed `image/webp` with no unlock token,
anything else is a 404, the object search path has a fixed precedence, and the running server
writes, refreshes and retires its pin in the storage registry."""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import anyio
import pytest
from fastapi.testclient import TestClient

from wixy_server.livechat.cookout_pack import PackStore, StoreBusy, object_relpath
from wixy_server.livechat.cookout_visuals import (
    CookoutVisualsService,
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

    def _wait_for_pins(self, storage_root: Path) -> list[dict[str, object]]:
        """The pin is written by the first background tick, not before boot completes."""
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                pins = self._pins(storage_root)
            except OSError:
                pins = []
            if pins:
                return pins
            time.sleep(0.05)
        pytest.fail("the slot pin was never written")

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
            first = self._wait_for_pins(storage_root)
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


class FakeStore:
    """A `PackStore` stand-in recording calls; `fetch_started` / `release` let a test hold a
    download in flight."""

    def __init__(self, *, missing: bool = False, fetch_delay_s: float = 0.0) -> None:
        self.calls: list[str] = []
        self._missing = missing
        self._fetch_delay_s = fetch_delay_s
        self.fetch_started = threading.Event()

    def register_slot(self, manifest: object) -> str:
        self.calls.append("register")
        return "slot-fake"

    def refresh_slot(self, pin_id: str) -> None:
        self.calls.append("refresh")

    def retire_slot(self, pin_id: str) -> None:
        self.calls.append("retire")
        time.sleep(self._fetch_delay_s)

    def missing(self, manifest: object, search: object) -> frozenset[str]:
        return frozenset({"x"}) if self._missing else frozenset()

    def fetch(self, manifest: object, *, url: str | None = None) -> int:
        self.calls.append("fetch")
        self.fetch_started.set()
        time.sleep(self._fetch_delay_s)
        return 1

    def gc(self) -> int:
        self.calls.append("gc")
        return 0


def packed_visuals(images: Path) -> IngredientVisuals:
    from dataclasses import replace

    from wixy_server.livechat.cookout_pack import PackRef

    base = make_visuals(images, ["a"])
    manifest = replace(
        base.manifest,
        pack=PackRef(
            url="http://127.0.0.1:1/x.tar", sha256="0" * 64, bytes=1, objects=2, installed_bytes=1
        ),
    )
    return IngredientVisuals(FakeCatalogue({}), manifest, [images])  # type: ignore[arg-type]


class TestServiceLifecycle:
    def test_the_first_tick_registers_then_checks_for_missing_pictures_at_once(
        self, images: Path
    ) -> None:
        store = FakeStore(missing=True)
        service = CookoutVisualsService(packed_visuals(images), lambda: store)  # type: ignore[arg-type,return-value]
        service.tick()
        assert store.calls == ["register", "fetch", "gc"]  # pin first; gc only because pinned

    def test_a_heal_never_collects_without_its_own_pin(self, images: Path) -> None:
        class NoPin(FakeStore):
            def register_slot(self, manifest: object) -> str:
                raise StoreBusy("held")

        store = NoPin(missing=True)
        service = CookoutVisualsService(packed_visuals(images), lambda: store)  # type: ignore[arg-type,return-value]
        service.tick()
        assert "fetch" in store.calls and "gc" not in store.calls

    def test_a_bad_storage_root_degrades_instead_of_raising(self, images: Path) -> None:
        def broken() -> PackStore:
            raise OSError("not a directory")

        service = CookoutVisualsService(packed_visuals(images), broken)
        service.tick()
        service.retire()
        assert service.store is None

    def test_shutdown_during_a_heal_returns_promptly(self, images: Path) -> None:
        store = FakeStore(missing=True, fetch_delay_s=5.0)
        service = CookoutVisualsService(packed_visuals(images), lambda: store)  # type: ignore[arg-type,return-value]

        async def scenario() -> float:
            started = time.monotonic()
            async with anyio.create_task_group() as tg:
                tg.start_soon(service.run)
                while not store.fetch_started.is_set():
                    await anyio.sleep(0.02)
                tg.cancel_scope.cancel()
            return time.monotonic() - started

        assert anyio.run(scenario) < 2.0

    def test_retire_is_bounded_even_when_the_store_lock_is_stuck(self, images: Path) -> None:
        store = FakeStore(fetch_delay_s=5.0)
        service = CookoutVisualsService(packed_visuals(images), lambda: store)  # type: ignore[arg-type,return-value]
        service.pin_id = "slot-fake"

        async def scenario() -> float:
            started = time.monotonic()
            await service.aretire(timeout_s=0.3)
            return time.monotonic() - started

        assert anyio.run(scenario) < 2.0


class TestBootNeverWaitsOnTheStore:
    def test_boot_completes_while_another_process_holds_the_store_lock(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier, images: Path
    ) -> None:
        store_root = storage_root / "cookout-images"
        holder = PackStore(store_root, min_free_bytes=0, lock_timeout_s=5.0)
        with holder._locked():
            started = time.monotonic()
            with cookout_client(
                storage_root,
                wixy_repo_root,
                pin_verifier,
                cookout_visuals=make_visuals(images, ["a"]),
            ) as (client, _h, _):
                assert client.get("/healthz").status_code == 200
                assert time.monotonic() - started < 15

    def test_a_storage_root_that_cannot_hold_the_store_still_boots(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier, images: Path
    ) -> None:
        storage_root.mkdir(parents=True, exist_ok=True)
        (storage_root / "cookout-images").write_text("a file, not a directory")
        with cookout_client(
            storage_root,
            wixy_repo_root,
            pin_verifier,
            cookout_visuals=make_visuals(images, ["a"]),
        ) as (client, _h, _):
            assert client.get("/healthz").status_code == 200
