# ruff: noqa: F811  (fixtures re-used from test_livechat_view_once are rebound as parameters)
"""Cookout game modes on the server (workspace 00058, spec 09c §5 and §8.2): the v21 -> v22
migration from a REAL v21 database, the Toasted sandwich draft through the store (turn plan, kinds,
skips, Open/Blind redaction, starters by kind, twist adjustments), the Classic regression golden,
the unknown-mode guards, and the HTTP gate (`TestRoutes`). The overlap with a still-running v21
process is `test_cookout_modes_overlap.py`."""

from __future__ import annotations

import dataclasses
import json
import random
import shutil
import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from wixy_server.livechat import store as store_module
from wixy_server.livechat.cookout_bank import CookoutBank, load_cookout_bank_or_empty
from wixy_server.livechat.cookout_game import (
    CookoutSetup,
    EncoreSpec,
    cookout_view_json,
    current_turn,
)
from wixy_server.livechat.cookout_modes import CookoutModes, default_modes
from wixy_server.livechat.reactions import reactor_key
from wixy_server.livechat.store import (
    CookoutBadStateError,
    CookoutInvalidError,
    LiveChatStore,
)
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    _dev_no_auth,
    fake_cmd_state,
    origin_repo,
    pin_verifier,
    storage_root,
    wixy_repo_root,
)
from wixy_server.tests.test_routes_livechat_cookout import (
    cookout_client,
    create,
    post,
    store_of,
    view,
)

FIXTURES = Path(__file__).parent / "fixtures"
ROSE, JOSH = "Rose", "Josh"

pytestmark = pytest.mark.filterwarnings("ignore")


@pytest.fixture(scope="module")
def bank() -> CookoutBank:
    return load_cookout_bank_or_empty()


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "server" / "server.db"


@pytest.fixture
def store(db_path: Path) -> LiveChatStore:
    return LiveChatStore(db_path)


_MOVE = iter(range(1, 10**7))


def mid() -> str:
    return f"modes-move-{next(_MOVE):07d}"


def toastie() -> Any:
    mode = default_modes().mode("toastie")
    assert mode is not None
    return mode


def start(
    store: LiveChatStore,
    bank: CookoutBank,
    *,
    mode: str = "toastie",
    blind: bool = False,
    cid: str = "modes-client-0001",
    setup: CookoutSetup = CookoutSetup(),  # noqa: B008
    seed: int = 1,
    sender: str = ROSE,
) -> int:
    message, created = store.create_cookout_round(
        client_id=cid,
        sender=sender,
        device_id="device-1234",
        by_email=None,
        blind=blind,
        bank=bank,
        mode_id=mode,
        setup=setup,
        rng=random.Random(seed),
        now=10.0,
    )
    assert created
    return message.seq


def data_of(store: LiveChatStore, seq: int) -> Any:
    data = store.cookout_view_data(anchor_seq=seq)
    assert data is not None
    return data


def live(store: LiveChatStore, seq: int) -> Any:
    data = data_of(store, seq)
    cur = current_turn(data.round, data.turns)
    assert cur is not None and cur.row is not None
    return cur


def join(store: LiveChatStore, bank: CookoutBank, seq: int, rng_seed: int = 2) -> None:
    store.join_cookout(
        anchor_seq=seq, sender=JOSH, email=None, bank=bank, rng=random.Random(rng_seed), now=20.0
    )


def pick_live(
    store: LiveChatStore, bank: CookoutBank, seq: int, *, index: int = 0, seed: int = 3
) -> str:
    cur = live(store, seq)
    name = ROSE if cur.player == 1 else JOSH
    chosen = cur.row.offers[-1][index]["id"]
    store.pick_cookout(
        anchor_seq=seq,
        sender=name,
        email=None,
        move_id=mid(),
        turn=cur.turn,
        offer=len(cur.row.offers) - 1,
        ingredient_id=chosen,
        bank=bank,
        runner_available=True,
        rng=random.Random(seed + cur.turn),
    )
    return str(chosen)


def view_json(store: LiveChatStore, bank: Any, seq: int, viewer: str | None) -> dict[str, Any]:
    data = data_of(store, seq)
    return dict(
        cookout_view_json(
            data.round,
            data.turns,
            data.recipes,
            data.attachments,
            bank,
            viewer_key=reactor_key(viewer) if viewer else None,
            viewer_email=None,
            signer=None,
            generations=data.generations,
            all_recipes=data.all_recipes,
            photo_attachments=data.photo_attachments,
            encore_title=data.encore_title,
        )
    )


def finish_toastie(store: LiveChatStore, bank: CookoutBank, seq: int) -> None:
    join(store, bank, seq)
    while data_of(store, seq).round.state == "picking":
        pick_live(store, bank, seq)


def raw(db_path: Path, sql: str, *args: object) -> list[tuple[Any, ...]]:
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


# -- migration ---------------------------------------------------------------------------------


def _strip_mode_fields(node: Any, *, top: bool = True) -> Any:
    """Remove what schema v22 ADDS to a Classic view (`mode`, `kind`, `build`) so the rest can be
    compared to the pre-modes golden."""
    if isinstance(node, dict):
        out = {}
        for key, value in node.items():
            if key in ("kind", "build") or (top and key == "mode"):
                continue
            out[key] = _strip_mode_fields(value, top=False)
        return out
    if isinstance(node, list):
        return [_strip_mode_fields(v, top=False) for v in node]
    return node


class TestMigrationFromRealV21:
    def test_the_fixture_really_is_a_v21_database_with_every_round_state(self) -> None:
        conn = sqlite3.connect(FIXTURES / "livechat_v21.db")
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 21
            columns = {r[1] for r in conn.execute("PRAGMA table_info(cookout_rounds)")}
            assert "mode" not in columns
            states = {r[0] for r in conn.execute("SELECT state FROM cookout_rounds")}
            assert states == {"picking", "finished", "abandoned"}
            assert (
                conn.execute(
                    "SELECT COUNT(*) FROM cookout_recipes WHERE state = 'banked'"
                ).fetchone()[0]
                == 1
            )
            assert (
                conn.execute("SELECT COUNT(*) FROM cookout_rounds WHERE generation = 2").fetchone()[
                    0
                ]
                == 1
            )
        finally:
            conn.close()

    def test_migrating_adds_the_mode_column_keeps_every_row_and_serves_classic(
        self, tmp_path: Path
    ) -> None:
        copy = tmp_path / "v21.db"
        shutil.copy(FIXTURES / "livechat_v21.db", copy)
        before = raw(copy, "SELECT * FROM cookout_rounds ORDER BY anchor_message_seq")
        turns_before = raw(copy, "SELECT * FROM cookout_turns ORDER BY anchor_message_seq, turn")
        migrated = LiveChatStore(copy)
        migrated.list_messages(before=None, limit=1)
        assert raw(copy, "PRAGMA user_version") == [(22,)]
        assert {r[0] for r in raw(copy, "SELECT mode FROM cookout_rounds")} == {"classic"}
        after = raw(copy, "SELECT * FROM cookout_rounds ORDER BY anchor_message_seq")
        # every pre-existing column of every round is untouched (the new column sits last)
        assert [row[: len(before[0])] for row in after] == before
        assert raw(copy, "SELECT * FROM cookout_turns ORDER BY anchor_message_seq, turn") == (
            turns_before
        )
        # every round's view equals the pre-modes golden once the new fields are set aside
        golden = json.loads((FIXTURES / "livechat_v21_views.json").read_text(encoding="utf-8"))
        bank = load_cookout_bank_or_empty()
        for key, expected in golden.items():
            seq_text, viewer = key.split(":", 1)
            got = view_json(migrated, bank, int(seq_text), None if viewer == "None" else viewer)
            assert got["mode"]["id"] == "classic"
            assert json.loads(json.dumps(_strip_mode_fields(got))) == expected, key
        summaries = {m.seq: m.cookout for m in migrated.list_messages(before=None, limit=50)[0]}
        assert all(s is not None and s.mode == "classic" for s in summaries.values())

    def test_rerunning_the_migration_is_a_no_op(self, tmp_path: Path) -> None:
        copy = tmp_path / "v21.db"
        shutil.copy(FIXTURES / "livechat_v21.db", copy)
        LiveChatStore(copy).list_messages(before=None, limit=1)
        assert raw(copy, "PRAGMA user_version") == [(22,)]
        first = raw(copy, "SELECT * FROM cookout_rounds ORDER BY anchor_message_seq")
        LiveChatStore(copy).list_messages(before=None, limit=1)
        assert raw(copy, "SELECT * FROM cookout_rounds ORDER BY anchor_message_seq") == first
        assert raw(copy, "PRAGMA user_version") == [(22,)]

    def test_a_retried_migration_that_already_added_the_column_skips_the_alter(
        self, tmp_path: Path
    ) -> None:
        copy = tmp_path / "v21.db"
        shutil.copy(FIXTURES / "livechat_v21.db", copy)
        conn = sqlite3.connect(copy)
        conn.execute("ALTER TABLE cookout_rounds ADD COLUMN mode TEXT NOT NULL DEFAULT 'classic'")
        conn.commit()
        conn.close()
        LiveChatStore(copy).list_messages(before=None, limit=1)
        assert raw(copy, "PRAGMA user_version") == [(22,)]

    def test_the_schema_version_constant(self) -> None:
        assert store_module._LATEST_SCHEMA_VERSION == 22


# -- Classic is today's game, byte for byte ----------------------------------------------------


class TestClassicRegression:
    def test_a_seeded_classic_round_deals_exactly_what_the_pre_modes_code_dealt(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        golden = json.loads((FIXTURES / "livechat_classic_golden.json").read_text("utf-8"))
        rng = random.Random(909)
        message, _ = store.create_cookout_round(
            client_id="golden-client-01",
            sender=ROSE,
            device_id="golden-device",
            by_email=None,
            blind=False,
            bank=bank,
            rng=rng,
        )
        seq = message.seq
        store.join_cookout(anchor_seq=seq, sender=JOSH, email=None, bank=bank, rng=rng)
        n = 0
        for step in range(10):
            cur = live(store, seq)
            name = ROSE if cur.player == 1 else JOSH
            other = JOSH if cur.player == 1 else ROSE
            row = cur.row
            common: dict[str, Any] = {
                "anchor_seq": seq,
                "sender": name,
                "email": None,
                "turn": cur.turn,
            }

            def mv() -> str:
                nonlocal n
                n += 1
                return f"golden-move-{n:04d}"

            if step == 1:
                store.skip_cookout(**common, move_id=mv(), offer=0, bank=bank, rng=rng)
                row = live(store, seq).row
            if step == 2:
                pair = row.offers[-1]
                store.chaos_cookout(
                    **common,
                    move_id=mv(),
                    offer=len(row.offers) - 1,
                    option_ids=(pair[0]["id"], pair[1]["id"]),
                    bank=bank,
                    rng=rng,
                )
                row = live(store, seq).row
            if step == 3:
                store.veto_cookout(
                    anchor_seq=seq,
                    sender=other,
                    email=None,
                    move_id=mv(),
                    turn=cur.turn,
                    offer=len(row.offers) - 1,
                    ingredient_id=row.offers[-1][0]["id"],
                    bank=bank,
                    rng=rng,
                )
                row = live(store, seq).row
            if step == 4:
                pair = row.offers[-1]
                store.lucky_cookout(
                    **common,
                    move_id=mv(),
                    offer=len(row.offers) - 1,
                    option_ids=(pair[0]["id"], pair[1]["id"]),
                    bank=bank,
                    runner_available=True,
                    rng=rng,
                )
                continue
            store.pick_cookout(
                **common,
                move_id=mv(),
                offer=len(row.offers) - 1,
                ingredient_id=row.offers[-1][0]["id"],
                bank=bank,
                runner_available=True,
                rng=rng,
            )
        data = data_of(store, seq)
        got = {
            "roleSchedule": list(data.round.role_schedule),
            "turns": [
                {
                    "turn": t.turn,
                    "offers": [[a["id"], b["id"]] for a, b in t.offers],
                    "choice": t.choice_id,
                    "replaced": [e["snap"]["id"] for e in t.replaced],
                    "lucky": t.lucky,
                }
                for t in data.turns
            ],
        }
        assert got == golden
        assert data.round.mode == "classic" and len(data.round.role_schedule) == 5


# -- Toasted sandwich: the draft ---------------------------------------------------------------


class TestToastieDraft:
    def test_the_first_pair_is_two_breads_of_different_families(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        seq = start(store, bank)
        data = data_of(store, seq)
        assert data.round.mode == "toastie" and len(data.round.role_schedule) == 8
        assert data.round.role_schedule[0] == "bread" and data.round.role_schedule[-1] == "finish"
        pair = data.turns[0].offers[0]
        mode = toastie()
        assert all(mode.kind_of(s["id"]) == "bread" for s in pair)
        assert pair[0]["family"] != pair[1]["family"]

    def test_eight_turns_alternate_four_picks_each_and_the_kinds_follow_the_plan(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        kinds: list[str] = []
        for _ in range(8):
            cur = live(store, seq)
            assert cur.player == (1 if cur.turn % 2 == 1 else 2)
            chosen = pick_live(store, bank, seq)
            kinds.append(toastie().kind_of(chosen) or "?")
        data = data_of(store, seq)
        assert data.round.state == "finished"
        assert kinds[0] == "bread" and kinds[-1] == "finish"
        assert kinds[1] == kinds[2] and kinds[3] == kinds[4] and kinds[5] == kinds[6]
        assert {kinds[1], kinds[3], kinds[5]} == {"cheese", "main", "produce"}
        picks_by_player = [t.player for t in data.turns]
        assert picks_by_player.count(1) == 4 and picks_by_player.count(2) == 4
        # each filling kind was offered to BOTH players
        assert sum(1 for t in data.turns if t.player == 1 and kinds[t.turn - 1] == "cheese") == 1

    def test_every_turn_including_the_bread_has_two_skips_and_a_pair_of_the_turns_kind(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        for _ in range(2):
            cur = live(store, seq)
            store.skip_cookout(
                anchor_seq=seq,
                sender=ROSE,
                email=None,
                move_id=mid(),
                turn=1,
                offer=len(cur.row.offers) - 1,
                bank=bank,
                rng=random.Random(5),
            )
        row = live(store, seq).row
        assert len(row.offers) == 3
        assert all(toastie().kind_of(s["id"]) == "bread" for pair in row.offers for s in pair)
        from wixy_server.livechat.store import CookoutSkipExhaustedError

        with pytest.raises(CookoutSkipExhaustedError):
            store.skip_cookout(
                anchor_seq=seq,
                sender=ROSE,
                email=None,
                move_id=mid(),
                turn=1,
                offer=2,
                bank=bank,
            )

    def test_the_last_pick_finishes_the_round_with_one_transition_and_one_job(
        self, store: LiveChatStore, bank: CookoutBank, db_path: Path
    ) -> None:
        seq = start(store, bank)
        finish_toastie(store, bank, seq)
        round_ = data_of(store, seq).round
        assert round_.state == "finished" and round_.concepts == "pending"
        assert store.cookout_pending_concepts() == [(seq, 1, None)]
        finished_events = [
            r
            for r in raw(db_path, "SELECT type FROM events WHERE message_seq = ?", seq)
            if r[0] == "message_updated"
        ]
        assert finished_events  # the pick that finished the round emitted its update

    def test_a_player_two_turn_is_not_drawn_until_they_join(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        seq = start(store, bank)
        pick_live(store, bank, seq)
        data = data_of(store, seq)
        assert len(data.turns) == 1  # turn 2 (Player 2) not drawn
        cur = current_turn(data.round, data.turns)
        assert cur is not None and cur.waiting_for_join
        join(store, bank, seq)
        assert len(data_of(store, seq).turns) == 2
        assert live(store, seq).player == 2

    def test_the_view_describes_the_mode_the_kinds_and_pick_kinds(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        v = view_json(store, bank, seq, ROSE)
        assert v["mode"] == {
            "id": "toastie",
            "label": "Toasted sandwich",
            "emoji": "🥪",
            "turns": 8,
            "picksPerPlayer": 4,
            "kinds": [
                {"id": k.id, "label": k.label, "prompt": k.prompt} for k in toastie().kinds.values()
            ],
            "anchorKind": "bread",
        }
        assert v["current"]["role"] == "bread" and v["current"]["turn"] == 1
        pick_live(store, bank, seq)
        v = view_json(store, bank, seq, ROSE)
        assert v["players"][0]["picks"][0]["kind"] == "bread"
        assert v["players"][0]["pickCount"] == 1
        assert v["current"]["role"] in {"cheese", "main", "produce"}

    def test_the_chaos_shelf_is_not_offered_on_the_bread_turn(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        v = view_json(store, bank, seq, ROSE)
        assert v["current"]["canChaos"] is False and v["current"]["canLucky"] is True
        row = live(store, seq).row
        pair = row.offers[-1]
        with pytest.raises(CookoutBadStateError):
            store.chaos_cookout(
                anchor_seq=seq,
                sender=ROSE,
                email=None,
                move_id=mid(),
                turn=1,
                offer=0,
                option_ids=(pair[0]["id"], pair[1]["id"]),
                bank=bank,
            )
        # ... and works on a filling turn
        pick_live(store, bank, seq)
        row = live(store, seq).row
        pair = row.offers[-1]
        store.chaos_cookout(
            anchor_seq=seq,
            sender=JOSH,
            email=None,
            move_id=mid(),
            turn=2,
            offer=0,
            option_ids=(pair[0]["id"], pair[1]["id"]),
            bank=bank,
            rng=random.Random(8),
        )
        new = live(store, seq).row.offers[-1]
        kind = toastie().kind_for_turn(data_of(store, seq).round.role_schedule, 2)
        assert all(toastie().kind_of(s["id"]) == kind for s in new)

    def test_veto_and_lucky_dip_work_on_the_bread_turn(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        seq = start(store, bank)
        join(store, bank, seq)
        row = live(store, seq).row
        store.veto_cookout(
            anchor_seq=seq,
            sender=JOSH,
            email=None,
            move_id=mid(),
            turn=1,
            offer=0,
            ingredient_id=row.offers[-1][0]["id"],
            bank=bank,
            rng=random.Random(4),
        )
        row = live(store, seq).row
        assert all(toastie().kind_of(s["id"]) == "bread" for s in row.offers[-1])
        pair = row.offers[-1]
        store.lucky_cookout(
            anchor_seq=seq,
            sender=ROSE,
            email=None,
            move_id=mid(),
            turn=1,
            offer=0,
            option_ids=(pair[0]["id"], pair[1]["id"]),
            bank=bank,
            runner_available=True,
            rng=random.Random(1),
        )
        assert data_of(store, seq).turns[0].lucky is True

    def test_blind_play_hides_the_partners_bread_until_all_eight_are_in(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        seq = start(store, bank, blind=True)
        join(store, bank, seq)
        bread = pick_live(store, bank, seq)
        bread_name = bank.ingredient(bread).name  # type: ignore[union-attr]
        josh = view_json(store, bank, seq, JOSH)
        assert bread not in json.dumps(josh) and bread_name not in json.dumps(josh)
        assert josh["players"][0]["picks"] is None and josh["players"][0]["pickCount"] == 1
        # the mover's (Josh's) own table is visible to Josh, but Rose sees no role or options
        rose = view_json(store, bank, seq, ROSE)
        assert rose["current"]["role"] is None and rose["current"]["options"] is None
        for _ in range(7):
            pick_live(store, bank, seq)
        final = view_json(store, bank, seq, JOSH)
        assert final["revealed"] is True and len(final["basket"]) == 8
        assert final["basket"][0]["kind"] == "bread" and final["basket"][0]["id"] == bread


# -- starters by kind --------------------------------------------------------------------------


def a_bread(bank: CookoutBank, family_not: str = "") -> Any:
    return next(i for i in toastie().kinds["bread"].candidates if i.rarity == "everyday")


def a_filling(kind: str, skip: int = 0) -> Any:
    return [i for i in toastie().kinds[kind].candidates if i.rarity == "everyday"][skip]


class TestToastieStarters:
    def test_a_fridge_bread_fills_turn_one_and_the_partner_is_next(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        bread = a_bread(bank)
        seq = start(store, bank, setup=CookoutSetup(fridge_seed_id=bread.id))
        data = data_of(store, seq)
        assert data.turns[0].seed is not None and data.turns[0].choice_id == bread.id
        assert len(data.turns) == 1  # Player 2 turn waits for Join
        v = view_json(store, bank, seq, ROSE)
        assert v["starters"][0]["kind"] == "bread" and v["setup"]["fridgeRaid"] is True

    def test_a_non_bread_fridge_seed_is_refused(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        with pytest.raises(CookoutInvalidError, match="bread"):
            start(store, bank, setup=CookoutSetup(fridge_seed_id=a_filling("cheese").id))

    def test_an_unknown_game_is_refused_and_a_disallowed_twist_too(
        self, store: LiveChatStore, bank: CookoutBank, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with pytest.raises(CookoutInvalidError):
            start(store, bank, mode="pizza")
        mode = toastie()
        narrowed = dataclasses.replace(mode, twists=mode.twists - {"stars"})
        monkeypatch.setattr(
            store_module,
            "default_modes",
            lambda: CookoutModes((default_modes().default, narrowed)),
        )
        with pytest.raises(CookoutInvalidError, match="twist"):
            start(store, bank, setup=CookoutSetup(stars=True))

    def test_a_filling_starter_sits_on_turn_two_and_turn_one_is_still_the_bread(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        # a leftovers/remix encore needs a source round; use the store's seed path through a remix
        source = _finished_with_concepts(store, bank, cid="modes-src-0001", seed=3)
        picked = store.get_cookout_round(source)["picked_ids"]  # type: ignore[index]
        filling = next(i for i in picked if toastie().kind_of(i) != "bread")
        store.bank_cookout_concept(
            anchor_seq=source,
            sender=ROSE,
            email=None,
            concept_id="a",
            move_id=mid(),
            generation=1,
            runner_available=True,
        )
        assert store.set_cookout_recipe_run(source, "a", "run-r", expected_generation=1)
        assert store.finish_cookout_recipe(
            source,
            "a",
            "run-r",
            "banked",
            expected_generation=1,
            recipe_json=json.dumps({"serves": 2, "prepMinutes": 5, "cookMinutes": 5}),
        )
        seq = start(
            store,
            bank,
            cid="modes-client-0002",
            setup=CookoutSetup(
                encore=EncoreSpec(
                    from_seq=source,
                    generation=1,
                    concept_id="a",
                    kind="remix",
                    seed_ids=(filling,),
                )
            ),
        )
        data = data_of(store, seq)
        assert [t.turn for t in data.turns] == [1, 2]
        assert data.turns[0].choice_id is None and data.turns[0].seed is None
        assert data.turns[1].seed is not None and data.turns[1].choice_id == filling
        kind = toastie().kind_of(filling)
        sched = data.round.role_schedule
        assert sched[0] == "bread" and sched[1] == kind and sched[2] == kind
        # Player 2 joins; turn 1 is picked, then turn 3 (Slot 1) is dealt at once
        join(store, bank, seq)
        assert len(data_of(store, seq).turns) == 2
        pick_live(store, bank, seq)
        turns = data_of(store, seq).turns
        assert [t.turn for t in turns] == [1, 2, 3] and turns[2].choice_id is None
        assert live(store, seq).turn == 3 and live(store, seq).player == 1

    def test_an_encore_across_game_modes_is_refused(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        source = _finished_with_concepts(store, bank, cid="modes-src-0002", seed=4)
        picked = store.get_cookout_round(source)["picked_ids"]  # type: ignore[index]
        with pytest.raises(CookoutInvalidError, match="different game"):
            start(
                store,
                bank,
                mode="classic",
                cid="modes-client-0003",
                setup=CookoutSetup(
                    encore=EncoreSpec(
                        from_seq=source,
                        generation=1,
                        concept_id="a",
                        kind="remix",
                        seed_ids=(picked[1],),
                    )
                ),
            )


def _finished_with_concepts(store: LiveChatStore, bank: CookoutBank, *, cid: str, seed: int) -> int:
    seq = start(store, bank, cid=cid, seed=seed)
    finish_toastie(store, bank, seq)
    row = store.get_cookout_round(seq)
    assert row is not None
    ids = row["basket_ids"]
    assert store.set_cookout_concepts_run(seq, "run-c", expected_generation=1)
    concepts = [
        {
            "id": c,
            "title": f"Toastie {c}",
            "vibe": "v",
            "dishType": "sandwich",
            "technique": "grill",
            "build": "pressed",
            "description": "d",
            "pickedIngredientIds": ids,
            "stapleIds": [],
            "omitted": [],
        }
        for c in ("a", "b", "c")
    ]
    assert store.finish_cookout_concepts(
        seq,
        "run-c",
        "ready",
        expected_generation=1,
        concepts_json=json.dumps({"concepts": concepts}),
    )
    return seq


class TestToastieAfterTheDraft:
    def test_the_chef_read_names_the_mode_and_the_bread(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        seq = start(store, bank)
        assert store.get_cookout_round(seq)["bread_id"] is None  # type: ignore[index]
        finish_toastie(store, bank, seq)
        row = store.get_cookout_round(seq)
        assert row is not None and row["mode"] == "toastie"
        bread = data_of(store, seq).turns[0].choice_id
        assert row["bread_id"] == bread and row["basket_ids"][0] == bread

    def test_a_classic_round_has_no_bread_id(self, store: LiveChatStore, bank: CookoutBank) -> None:
        seq = start(store, bank, mode="classic", cid="modes-client-0009")
        row = store.get_cookout_round(seq)
        assert row is not None and row["mode"] == "classic" and row["bread_id"] is None

    def test_concepts_carry_the_build_and_the_view_resolves_its_label(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        seq = _finished_with_concepts(store, bank, cid="modes-client-0004", seed=6)
        v = view_json(store, bank, seq, ROSE)
        assert v["concepts"]["data"][0]["build"] == {"id": "pressed", "label": "Pressed"}

    def test_the_rescue_swap_of_the_bread_deals_two_breads_and_forbids_the_old_one(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        seq = _finished_with_concepts(store, bank, cid="modes-client-0005", seed=7)
        bread = data_of(store, seq).turns[0].choice_id
        store.propose_cookout_swap(
            anchor_seq=seq,
            sender=ROSE,
            email=None,
            move_id=mid(),
            ingredient_id=str(bread),
            bank=bank,
            rng=random.Random(9),
        )
        pair = data_of(store, seq).round.swap_pair
        assert pair is not None
        assert all(toastie().kind_of(s["id"]) == "bread" for s in pair)
        assert pair[0]["family"] != pair[1]["family"]
        store.choose_cookout_swap(
            anchor_seq=seq,
            sender=JOSH,
            email=None,
            move_id=mid(),
            ingredient_id=pair[0]["id"],
            runner_available=True,
        )
        row = store.get_cookout_round(seq)
        assert row is not None
        assert row["bread_id"] == pair[0]["id"] and row["forbidden_ids"] == [bread]

    def test_the_rescue_swap_of_a_cheese_deals_two_cheeses(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        seq = _finished_with_concepts(store, bank, cid="modes-client-0006", seed=8)
        ids = store.get_cookout_round(seq)["basket_ids"]  # type: ignore[index]
        cheese = next(i for i in ids if toastie().kind_of(i) == "cheese")
        store.propose_cookout_swap(
            anchor_seq=seq,
            sender=JOSH,
            email=None,
            move_id=mid(),
            ingredient_id=cheese,
            bank=bank,
            rng=random.Random(10),
        )
        pair = data_of(store, seq).round.swap_pair
        assert pair is not None and all(toastie().kind_of(s["id"]) == "cheese" for s in pair)

    def test_the_wildcard_is_drawn_from_the_filling_pools_only(
        self, store: LiveChatStore, bank: CookoutBank
    ) -> None:
        for seed in range(12):
            db = store  # the same store; a new round per seed
            seq = start(
                db,
                bank,
                cid=f"modes-wild-{seed:04d}",
                setup=CookoutSetup(wildcard=True),
                seed=seed,
            )
            finish_toastie(db, bank, seq)
            db.wildcard_cookout(
                anchor_seq=seq,
                sender=ROSE,
                email=None,
                move_id=mid(),
                lift=True,
                bank=bank,
                runner_available=True,
                rng=random.Random(seed),
            )
            wild = data_of(db, seq).round.wildcard_snap
            assert wild is not None
            kind = toastie().kind_of(wild["id"])
            assert kind in {"cheese", "main", "produce", "finish"}
            assert store.get_cookout_round(seq)["wildcard_id"] == wild["id"]  # type: ignore[index]


# -- unknown-mode guards -----------------------------------------------------------------------


class TestUnknownModeGuards:
    def _pizza(self, store: LiveChatStore, db_path: Path, bank: CookoutBank) -> int:
        seq = start(store, bank, mode="classic", cid="modes-pizza-0001")
        join(store, bank, seq)
        conn = sqlite3.connect(db_path)
        conn.execute("UPDATE cookout_rounds SET mode = 'pizza'")
        conn.commit()
        conn.close()
        return seq

    def test_every_interpreting_mutation_answers_bad_state_and_writes_nothing(
        self, store: LiveChatStore, db_path: Path, bank: CookoutBank
    ) -> None:
        seq = self._pizza(store, db_path, bank)
        before = raw(db_path, "SELECT * FROM cookout_rounds")
        cur = live(store, seq)
        row = cur.row
        pair = row.offers[-1]
        common: dict[str, Any] = {"anchor_seq": seq, "sender": ROSE, "email": None}
        calls: list[Callable[[], object]] = [
            lambda: store.skip_cookout(**common, move_id=mid(), turn=cur.turn, offer=0, bank=bank),
            lambda: store.pick_cookout(
                **common,
                move_id=mid(),
                turn=cur.turn,
                offer=0,
                ingredient_id=pair[0]["id"],
                bank=bank,
                runner_available=True,
            ),
            lambda: store.lucky_cookout(
                **common,
                move_id=mid(),
                turn=cur.turn,
                offer=0,
                option_ids=(pair[0]["id"], pair[1]["id"]),
                bank=bank,
                runner_available=True,
            ),
            lambda: store.chaos_cookout(
                **common,
                move_id=mid(),
                turn=cur.turn,
                offer=0,
                option_ids=(pair[0]["id"], pair[1]["id"]),
                bank=bank,
            ),
            lambda: store.veto_cookout(
                anchor_seq=seq,
                sender=JOSH,
                email=None,
                move_id=mid(),
                turn=cur.turn,
                offer=0,
                ingredient_id=pair[0]["id"],
                bank=bank,
            ),
            lambda: store.star_cookout(
                **common, ingredient_id=pair[0]["id"], runner_available=True
            ),
            lambda: store.wildcard_cookout(
                **common, move_id=mid(), lift=True, bank=bank, runner_available=True
            ),
            lambda: store.vote_cookout(**common, generation=1, concept_id="a"),
            lambda: store.propose_cookout_swap(
                **common, move_id=mid(), ingredient_id=pair[0]["id"], bank=bank
            ),
            lambda: store.choose_cookout_swap(
                **common, move_id=mid(), ingredient_id=pair[0]["id"], runner_available=True
            ),
            lambda: store.cancel_cookout_swap(**common),
            lambda: store.bank_cookout_concept(
                **common,
                concept_id="a",
                move_id=mid(),
                generation=1,
                runner_available=True,
            ),
        ]
        for call in calls:
            with pytest.raises(CookoutBadStateError, match="newer server"):
                call()
        assert raw(db_path, "SELECT * FROM cookout_rounds") == before

    def test_background_reads_never_return_the_round_and_it_is_served_read_only(
        self, store: LiveChatStore, db_path: Path, bank: CookoutBank
    ) -> None:
        seq = self._pizza(store, db_path, bank)
        conn = sqlite3.connect(db_path)
        conn.execute(
            "UPDATE cookout_rounds SET state = 'finished', concepts = 'pending', images = 'pending'"
        )
        conn.execute(
            "INSERT INTO cookout_recipes (anchor_message_seq, generation, concept_id, state, "
            "requested_by, created_at, updated_at) VALUES (?, 1, 'a', 'pending', 'Rose', 1, 1)",
            (seq,),
        )
        conn.commit()
        conn.close()
        assert store.cookout_pending_concepts() == []
        assert store.cookout_pending_recipes() == []
        assert store.cookout_stale_pictures(stale_before=1e12) == []
        assert store.claim_cookout_pictures(seq, stale_before=None) == ("gone", 0)
        v = view_json(store, bank, seq, ROSE)
        assert v["mode"]["id"] == "pizza" and v["mode"]["kinds"] == []
        assert v["current"] is None or (
            v["current"]["canChaos"] in (None, False)
            and v["current"]["canLucky"] in (None, False)
            and v["current"]["canVeto"] in (None, False)
        )

    def test_an_unknown_round_is_abandoned_by_abandon_and_never_blocks_a_new_game(
        self, store: LiveChatStore, db_path: Path, bank: CookoutBank
    ) -> None:
        seq = self._pizza(store, db_path, bank)
        store.abandon_cookout(anchor_seq=seq, sender=ROSE, email=None)
        assert data_of(store, seq).round.state == "abandoned"
        message, created = store.create_cookout_round(
            client_id="modes-after-pizza",
            sender=ROSE,
            device_id="device-1234",
            by_email=None,
            blind=False,
            bank=bank,
            mode_id="toastie",
            rng=random.Random(1),
        )
        assert created
        assert {
            r[0] for r in raw(db_path, "SELECT state FROM cookout_rounds WHERE mode = 'pizza'")
        } == {"abandoned"}
        assert data_of(store, message.seq).round.state == "picking"

    def test_a_player_seat_probe_still_works_on_an_unknown_round(
        self, store: LiveChatStore, db_path: Path, bank: CookoutBank
    ) -> None:
        seq = self._pizza(store, db_path, bank)
        assert store.cookout_player_slot(anchor_seq=seq, sender=ROSE, email=None) == 1


# -- HTTP: the activation gate, options, ingredient search -------------------------------------


@pytest.fixture
def real_bank() -> CookoutBank:
    return load_cookout_bank_or_empty()


@pytest.fixture
def clean_modes_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.delenv("WIXY_COOKOUT_MODES", raising=False)
    yield


class TestRoutes:
    def test_with_the_setting_absent_toastie_is_unavailable_and_unlisted(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: Any, real_bank: Any,
        clean_modes_env: None,
    ) -> None:  # fmt: skip
        with cookout_client(storage_root, wixy_repo_root, pin_verifier, bank=real_bank) as (
            client,
            h,
            _,
        ):
            options = client.get("/api/admin/server/cookout/options", headers=h).json()
            assert [m["id"] for m in options["modes"]] == ["classic"]
            response = post(
                client, h, "/cookout", clientId="gate-client-0001", deviceId="device-1234",
                sender=ROSE, mode="toastie",
            )  # fmt: skip
            assert response.status_code == 503 and response.json() == {"error": "game_unavailable"}
            assert (
                client.get(
                    "/api/admin/server/cookout/ingredients?q=bread&mode=toastie", headers=h
                ).status_code
                == 503
            )
            bad = post(
                client, h, "/cookout", clientId="gate-client-0002", deviceId="device-1234",
                sender=ROSE, mode="pizza",
            )  # fmt: skip
            assert bad.status_code == 422
            # nothing was written: no message, no round
            assert store_of(client).list_messages(before=None, limit=10)[0] == []

    def test_with_the_setting_on_creation_works_and_the_options_list_both(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: Any, real_bank: Any,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:  # fmt: skip
        monkeypatch.setenv("WIXY_COOKOUT_MODES", "toastie, nonsense")
        with cookout_client(storage_root, wixy_repo_root, pin_verifier, bank=real_bank) as (
            client,
            h,
            _,
        ):
            options = client.get("/api/admin/server/cookout/options", headers=h).json()
            assert [m["id"] for m in options["modes"]] == ["classic", "toastie"]
            toast = options["modes"][1]
            assert toast["turns"] == 8 and toast["picksPerPlayer"] == 4
            assert toast["fridgeKinds"] == ["bread"] and "chaos" in toast["twists"]
            assert toast["intro"][1].startswith("{starter}")
            response = post(
                client, h, "/cookout", clientId="gate-client-0003", deviceId="device-1234",
                sender=ROSE, mode="toastie",
            )  # fmt: skip
            assert response.status_code == 201, response.text
            msg = response.json()["message"]
            assert msg["cookout"]["mode"] == "toastie"
            v = view(client, h, msg["seq"], ROSE)
            assert v["mode"]["id"] == "toastie" and v["current"]["role"] == "bread"
            found = client.get(
                "/api/admin/server/cookout/ingredients?q=sourdough&mode=toastie", headers=h
            ).json()["ingredients"]
            assert found and all(toastie().kind_of(i["id"]) == "bread" for i in found)
            everything = client.get(
                "/api/admin/server/cookout/ingredients?q=cheddar", headers=h
            ).json()["ingredients"]
            assert everything and any(toastie().kind_of(i["id"]) != "bread" for i in everything)

    def test_clearing_the_setting_leaves_an_existing_round_playable(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: Any, real_bank: Any,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:  # fmt: skip
        monkeypatch.setenv("WIXY_COOKOUT_MODES", "toastie")
        with cookout_client(storage_root, wixy_repo_root, pin_verifier, bank=real_bank) as (
            client,
            h,
            _,
        ):
            response = post(
                client, h, "/cookout", clientId="gate-client-0004", deviceId="device-1234",
                sender=ROSE, mode="toastie",
            )  # fmt: skip
            seq = response.json()["message"]["seq"]
            # the operator clears the setting: the existing round must keep working
            settings = client.app.state.settings  # type: ignore[attr-defined]
            client.app.state.settings = dataclasses.replace(  # type: ignore[attr-defined]
                settings, cookout_enabled_modes=frozenset()
            )
            assert post(client, h, f"/cookout/{seq}/join", sender=JOSH).status_code == 200
            v = view(client, h, seq, ROSE)
            cur = v["current"]
            picked = post(
                client, h, f"/cookout/{seq}/pick", sender=ROSE, moveId="route-move-9000001",
                turn=cur["turn"], offer=cur["offerIndex"], ingredientId=cur["options"][0]["id"],
            )  # fmt: skip
            assert picked.status_code == 200, picked.text
            options = client.get("/api/admin/server/cookout/options", headers=h).json()
            assert [m["id"] for m in options["modes"]] == ["classic"]

    def test_classic_creation_over_http_is_unchanged(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: Any, clean_modes_env: None
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h)
            v = view(client, h, seq, "Josh")
            assert v["mode"]["id"] == "classic" and v["mode"]["turns"] == 10
            assert v["mode"]["anchorKind"] is None
            msgs = client.get("/api/admin/server/messages", headers=h).json()["messages"]
            assert msgs[-1]["cookout"]["mode"] == "classic"
