"""Cookout ingredient pictures on the wire (spec 09b section E.1, F.1): every snapshot in a view
carries `what`/`image`, `image` is null when its object file is missing or the id is not in the
manifest, `facts` ride only on picks once the round is past picking, staples and fridge search are
enriched, and - the Blind regression - enrichment can never put a partner's ingredient (id, name or
picture hash) into the viewer's view.

The catalogue is a tiny fake and the pictures are placeholder files in a temp directory, so no pack,
no network and no GPU is involved."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any, cast

import pytest

from wixy_server.livechat.cookout_catalogue import Catalogue, CatalogueEntry
from wixy_server.livechat.cookout_pack import ImageRef, PackManifest, object_relpath
from wixy_server.livechat.cookout_visuals import (
    IngredientVisuals,
    set_default_visuals,
)
from wixy_server.livechat.store import LiveChatStore
from wixy_server.tests.test_livechat_cookout import (
    FakeBank,
    all_text,
    bank,  # noqa: F401 - fixture re-exported
    data_of,
    db_path,  # noqa: F401 - fixture re-exported
    join,
    pick,
    play_all,
    start,
    store,  # noqa: F401 - fixture re-exported
    view_for,
)


def sha_of(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()


class FakeCatalogue:
    def __init__(self, entries: dict[str, CatalogueEntry]) -> None:
        self._entries = entries
        self.version = 1

    def get(self, ingredient_id: str) -> CatalogueEntry | None:
        return self._entries.get(ingredient_id)

    def __len__(self) -> int:
        return len(self._entries)


def entry_for(ingredient_id: str, *, facts: tuple[str, ...] = ()) -> CatalogueEntry:
    return CatalogueEntry(
        id=ingredient_id,
        what=f"What {ingredient_id} is, in plain words.",
        visual="a plain visual",
        presentation="whole",
        facts=facts,
        name_key="0" * 16,
    )


def write_object(images: Path, sha: str) -> None:
    path = images / object_relpath(sha)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"RIFF\x00\x00\x00\x00WEBP")


def manifest_for(ids: list[str]) -> PackManifest:
    return PackManifest(
        pack_version=1,
        pack=None,
        items={i: ImageRef(card=sha_of(f"card-{i}"), thumb=sha_of(f"thumb-{i}")) for i in ids},
        digest=sha_of("manifest"),
    )


def make_visuals(
    images: Path,
    ids: list[str],
    *,
    with_files: bool = True,
    facts: tuple[str, ...] = ("Fact one.", "Fact two."),
) -> IngredientVisuals:
    manifest = manifest_for(ids)
    if with_files:
        for ref in manifest.items.values():
            write_object(images, ref.card)
            write_object(images, ref.thumb)
    catalogue = FakeCatalogue({i: entry_for(i, facts=facts) for i in ids})
    return IngredientVisuals(cast(Catalogue, catalogue), manifest, [images])


@pytest.fixture
def images(tmp_path: Path) -> Path:
    return tmp_path / "images"


@pytest.fixture
def visuals_for_bank(images: Path, bank: FakeBank) -> Iterator[IngredientVisuals]:  # noqa: F811
    ids = [i.id for i in bank.items] + [s.id for s in bank.staples]
    visuals = make_visuals(images, ids)
    set_default_visuals(visuals)
    yield visuals
    set_default_visuals(None)


def snaps_in(view: dict[str, Any]) -> list[dict[str, Any]]:
    """Every ingredient snapshot (an object with `blurb`) anywhere in a view."""
    found: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if "blurb" in node and "emoji" in node:
                found.append(node)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(view)
    return found


class TestSnapExtras:
    def test_known_ingredient_gets_what_and_both_picture_urls(self, images: Path) -> None:
        visuals = make_visuals(images, ["a"])
        extras = visuals.snap_extras("a")
        assert extras["what"] == "What a is, in plain words."
        assert extras["image"] == {
            "card": f"/admin/cookout-img/{sha_of('card-a')}.webp",
            "thumb": f"/admin/cookout-img/{sha_of('thumb-a')}.webp",
        }

    def test_an_id_outside_the_manifest_and_catalogue_is_null_null(self, images: Path) -> None:
        visuals = make_visuals(images, ["a"])
        assert visuals.snap_extras("zzz") == {"what": None, "image": None}
        assert visuals.facts("zzz") is None

    def test_image_is_null_when_either_object_file_is_missing(self, images: Path) -> None:
        visuals = make_visuals(images, ["a", "b"])
        (images / object_relpath(sha_of("thumb-b"))).unlink()
        visuals.reload()
        assert visuals.snap_extras("a")["image"] is not None
        assert visuals.snap_extras("b")["image"] is None
        assert visuals.snap_extras("b")["what"] == "What b is, in plain words."

    def test_an_empty_search_path_has_no_images_but_keeps_the_text(self, images: Path) -> None:
        visuals = make_visuals(images / "nowhere", ["a"], with_files=False)
        assert visuals.snap_extras("a")["image"] is None
        assert visuals.snap_extras("a")["what"] is not None

    def test_a_self_heal_reload_brings_pictures_in_without_a_restart(self, images: Path) -> None:
        visuals = make_visuals(images, ["a"], with_files=False)
        assert visuals.snap_extras("a")["image"] is None
        ref = visuals.manifest.items["a"]
        write_object(images, ref.card)
        write_object(images, ref.thumb)
        visuals.reload()
        assert visuals.snap_extras("a")["image"] is not None

    def test_facts_are_a_copy_and_empty_facts_are_null(self, images: Path) -> None:
        visuals = make_visuals(images, ["a"])
        facts = visuals.facts("a")
        assert facts == ["Fact one.", "Fact two."]
        assert facts is not None
        facts.append("mutated")
        assert visuals.facts("a") == ["Fact one.", "Fact two."]
        assert make_visuals(images / "other", ["a"], facts=()).facts("a") is None

    def test_search_path_order_first_hit_wins(self, tmp_path: Path) -> None:
        first, second = tmp_path / "first", tmp_path / "second"
        manifest = manifest_for(["a"])
        ref = manifest.items["a"]
        write_object(second, ref.card)
        write_object(second, ref.thumb)
        write_object(first, ref.card)
        visuals = IngredientVisuals(cast(Catalogue, FakeCatalogue({})), manifest, [first, second])
        assert visuals.resolve_object(ref.card) == first / object_relpath(ref.card)
        assert visuals.resolve_object(ref.thumb) == second / object_relpath(ref.thumb)

    def test_resolve_object_refuses_unknown_and_malformed_shas(self, images: Path) -> None:
        visuals = make_visuals(images, ["a"])
        write_object(images, sha_of("not-in-manifest"))
        assert visuals.resolve_object(sha_of("not-in-manifest")) is None
        assert visuals.resolve_object("../../etc/passwd") is None
        assert visuals.resolve_object(sha_of("card-a").upper()) is None


class TestViewEnrichment:
    def test_every_snapshot_in_a_view_carries_what_and_image(
        self,
        store: LiveChatStore,  # noqa: F811
        bank: FakeBank,  # noqa: F811
        visuals_for_bank: IngredientVisuals,
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        pick(store, bank, seq, "Josh")
        view = view_for(store, bank, seq, "Rose")
        snaps = snaps_in(view)
        assert snaps
        for snap in snaps:
            assert snap["what"] == f"What {snap['id']} is, in plain words."
            assert snap["image"]["card"].startswith("/admin/cookout-img/")
            assert snap["image"]["thumb"].endswith(".webp")

    def test_without_any_pictures_every_snapshot_is_null_null_and_the_game_works(
        self,
        store: LiveChatStore,  # noqa: F811
        bank: FakeBank,  # noqa: F811
    ) -> None:
        set_default_visuals(None)
        seq = start(store, bank)
        view = view_for(store, bank, seq, "Josh")
        snaps = snaps_in(view)
        assert snaps and all(s["what"] is None and s["image"] is None for s in snaps)

    def test_a_snapshot_whose_picture_file_is_missing_falls_back_to_null(
        self,
        store: LiveChatStore,  # noqa: F811
        bank: FakeBank,  # noqa: F811
        images: Path,
        visuals_for_bank: IngredientVisuals,
    ) -> None:
        seq = start(store, bank)
        offered = view_for(store, bank, seq, "Josh")["current"]["options"][0]["id"]
        (images / object_relpath(sha_of(f"card-{offered}"))).unlink()
        visuals_for_bank.reload()
        options = view_for(store, bank, seq, "Josh")["current"]["options"]
        by_id = {o["id"]: o for o in options}
        assert by_id[offered]["image"] is None
        assert all(o["image"] is not None for i, o in by_id.items() if i != offered)

    def test_the_stored_snapshot_is_never_rewritten(
        self,
        store: LiveChatStore,  # noqa: F811
        bank: FakeBank,  # noqa: F811
        visuals_for_bank: IngredientVisuals,
    ) -> None:
        seq = start(store, bank)
        view_for(store, bank, seq, "Josh")
        stored = data_of(store, seq).turns[0].offers[-1][0]
        assert set(stored) == {"id", "name", "category", "emoji", "family", "blurb"}

    def test_facts_ride_only_on_picks_and_only_after_picking(
        self,
        store: LiveChatStore,  # noqa: F811
        bank: FakeBank,  # noqa: F811
        visuals_for_bank: IngredientVisuals,
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        pick(store, bank, seq, "Josh")
        picking = view_for(store, bank, seq, "Josh")
        assert picking["state"] == "picking"
        assert '"facts"' not in all_text(picking)
        play_rest = [("Josh" if t % 2 == 1 else "Rose") for t in range(2, 11)]
        for who in play_rest:
            pick(store, bank, seq, who)
        done = view_for(store, bank, seq, "Josh")
        assert done["state"] == "finished"
        picks = [p for player in done["players"] for p in player["picks"]]
        assert len(picks) == 10 and all(p["facts"] == ["Fact one.", "Fact two."] for p in picks)
        # facts ride only on players[].picks and the wildcard snap, not on the basket or starters
        assert all("facts" not in b for b in done["basket"])
        assert all("facts" not in s for s in done["starters"])
        # options and history snapshots are not picks: no facts
        assert all("facts" not in h_snap for h in done["history"] for h_snap in _history_snaps(h))

    def test_staples_carry_an_image(
        self,
        store: LiveChatStore,  # noqa: F811
        bank: FakeBank,  # noqa: F811
        visuals_for_bank: IngredientVisuals,
    ) -> None:
        seq = start(store, bank)
        staples = view_for(store, bank, seq, "Josh")["staples"]
        assert len(staples) == 8
        assert all(s["image"]["card"].startswith("/admin/cookout-img/") for s in staples)
        assert set(staples[0]) == {"id", "name", "image"}


def _history_snaps(history_entry: dict[str, Any]) -> list[dict[str, Any]]:
    return snaps_in({"h": history_entry})


class TestBlindRegression:
    """Inv 57 with pictures: a picture URL or hash is only ever attached to a snapshot the viewer's
    redacted view already contains, so the partner's ingredient never appears in any form."""

    def test_the_partners_ids_names_and_picture_hashes_appear_nowhere(
        self,
        store: LiveChatStore,  # noqa: F811
        bank: FakeBank,  # noqa: F811
        visuals_for_bank: IngredientVisuals,
    ) -> None:
        seq = start(store, bank, blind=True)
        join(store, bank, seq)
        for turn in range(1, 10):
            who = "Josh" if turn % 2 == 1 else "Rose"
            pick(store, bank, seq, who)
            self._assert_hidden(store, bank, seq, viewer="Josh", partner_slot=2)
            self._assert_hidden(store, bank, seq, viewer="Rose", partner_slot=1)
            self._assert_hidden(store, bank, seq, viewer=None, partner_slot=1)
            self._assert_hidden(store, bank, seq, viewer=None, partner_slot=2)

    @staticmethod
    def _assert_hidden(
        store: LiveChatStore,  # noqa: F811
        bank: FakeBank,  # noqa: F811
        seq: int,
        *,
        viewer: str | None,
        partner_slot: int,
    ) -> None:
        data = data_of(store, seq)
        if data.round.state != "picking":
            return
        view = view_for(store, bank, seq, viewer)
        text = json.dumps(view)
        viewer_slot = {"Josh": 1, "Rose": 2}.get(viewer or "")
        offered_to = {
            slot: {
                s["id"] for t in data.turns if t.player == slot for pair in t.offers for s in pair
            }
            for slot in (1, 2)
        }
        public = {t.seed["id"] for t in data.turns if t.seed is not None}
        allowed = (offered_to[viewer_slot] if viewer_slot else set()) | public
        for ingredient_id in offered_to[partner_slot] - allowed:
            item = bank.ingredient(ingredient_id)
            assert item is not None
            assert f'"{ingredient_id}"' not in text, (viewer, ingredient_id)
            assert item.name not in text, (viewer, item.name)
            assert sha_of(f"card-{ingredient_id}") not in text, (viewer, ingredient_id)
            assert sha_of(f"thumb-{ingredient_id}") not in text, (viewer, ingredient_id)


class TestFinishedRoundEnrichment:
    def test_the_revealed_basket_is_enriched_for_every_viewer(
        self,
        store: LiveChatStore,  # noqa: F811
        bank: FakeBank,  # noqa: F811
        visuals_for_bank: IngredientVisuals,
    ) -> None:
        seq = start(store, bank, blind=True)
        play_all(store, bank, seq)
        for viewer in ("Josh", "Rose", None):
            view = view_for(store, bank, seq, viewer)
            assert view["revealed"] is True and len(view["basket"]) == 10
            assert all(b["image"] is not None and b["what"] is not None for b in view["basket"])
