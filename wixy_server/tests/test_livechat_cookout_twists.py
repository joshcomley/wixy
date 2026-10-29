"""Cookout twists, store level (workspace 00058, spec/server-chat/09a-cookout-twists.md): the
final undeployed-v21 schema shape, starters (fridge raid, leftover encore), the drafting twists
(lucky dip, chaos shelf, partner veto), the chef gate (wildcard cloche, secret stars), the dinner
vote, the rescue swap and its generations, "We cooked it!", generation fencing of requests and
jobs, Blind-mode redaction of every new field and two-connection races.

The core game behaves identically when no twist is used — `test_livechat_cookout.py` still runs
unchanged against the same store. The ingredient bank is the deterministic `FakeBank` there."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from wixy_server.livechat.cookout_game import CookoutSetup, EncoreSpec, cookout_view_json
from wixy_server.livechat.models import AttachmentResult, CookoutRoundRow
from wixy_server.livechat.reactions import reactor_key
from wixy_server.livechat.store import (
    CookoutBadStateError,
    CookoutExhaustedError,
    CookoutInvalidError,
    CookoutNotPlayerError,
    CookoutNotYourTurnError,
    CookoutRecipePendingError,
    CookoutTokenUsedError,
    LiveChatStore,
)
from wixy_server.tests.adventure_testkit import run_concurrently
from wixy_server.tests.test_livechat_cookout import (
    FakeBank,
    _Signer,
    canned_concepts,
    data_of,
    events,
    join,
    live_of,
    move_id,
    pick,
    raw,
    skip,
    start,
)

JOSH, ROSE = "Josh", "Rose"


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "server" / "server.db"


@pytest.fixture
def store(db_path: Path) -> LiveChatStore:
    return LiveChatStore(db_path)


@pytest.fixture
def bank() -> FakeBank:
    return FakeBank()


_CIDS = iter(f"twist-client-{n:06d}" for n in range(1, 10_000))


def open_round(
    store: LiveChatStore, bank: FakeBank, *, blind: bool = False, setup: CookoutSetup | None = None
) -> int:
    message, created = store.create_cookout_round(
        client_id=next(_CIDS),
        sender=JOSH,
        device_id="device-1234",
        by_email=None,
        blind=blind,
        bank=bank,
        setup=setup or CookoutSetup(),
        now=10.0,
    )
    assert created
    return message.seq


def pl(slot: int) -> str:
    return JOSH if slot == 1 else ROSE


def finish_picks(store: LiveChatStore, bank: FakeBank, seq: int, *, runner: bool = True) -> None:
    """Join Rose (if needed) and make every remaining pick, taking the first option each time."""
    if store.cookout_player_slot(anchor_seq=seq, sender=ROSE, email=None) is None:
        join(store, bank, seq, ROSE)
    while data_of(store, seq).round.state == "picking":
        cur = live_of(store, seq)
        pick(store, bank, seq, pl(cur.player), runner=runner)


def basket_of(store: LiveChatStore, seq: int) -> list[str]:
    return list(store.get_cookout_round(seq)["basket_ids"])  # type: ignore[index]


def make_ready(store: LiveChatStore, seq: int, run: str = "run-1") -> list[str]:
    """Land `ready` concepts for the round's CURRENT generation."""
    generation = data_of(store, seq).round.generation
    basket = basket_of(store, seq)
    assert store.set_cookout_concepts_run(seq, run, expected_generation=generation)
    assert store.finish_cookout_concepts(
        seq,
        run,
        "ready",
        expected_generation=generation,
        concepts_json=canned_concepts(basket),
        pictures_pending=True,
    )
    return basket


def ready_round(store: LiveChatStore, bank: FakeBank, setup: CookoutSetup | None = None) -> int:
    seq = open_round(store, bank, setup=setup)
    finish_picks(store, bank, seq)
    make_ready(store, seq)
    return seq


def bank_it(store: LiveChatStore, seq: int, concept: str = "a", **kw: Any) -> Any:
    kw.setdefault("generation", None)
    return store.bank_cookout_concept(
        anchor_seq=seq,
        sender=JOSH,
        email=None,
        concept_id=concept,
        move_id=kw.pop("mv", None) or move_id(),
        runner_available=True,
        **kw,
    )


RECIPE = json.dumps(
    {"serves": 2, "prepMinutes": 10, "cookMinutes": 20, "ingredients": [], "steps": ["Cook."]}
)


def bank_recipe(
    store: LiveChatStore, seq: int, concept: str = "a", *, generation: int | None = None
) -> None:
    """Bank a concept and land its recipe (`banked`)."""
    if generation is None:
        generation = data_of(store, seq).round.generation
    bank_it(store, seq, concept, generation=generation)
    assert store.set_cookout_recipe_run(
        seq, concept, f"rr-{seq}-{generation}-{concept}", expected_generation=generation
    )
    assert store.finish_cookout_recipe(
        seq,
        concept,
        f"rr-{seq}-{generation}-{concept}",
        "banked",
        expected_generation=generation,
        recipe_json=RECIPE,
    )


def view(store: LiveChatStore, bank: FakeBank, seq: int, viewer: str | None) -> dict[str, Any]:
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
            signer=_Signer(),
            generations=data.generations,
            all_recipes=data.all_recipes,
            photo_attachments=data.photo_attachments,
            encore_title=data.encore_title,
        )
    )


def rnd(store: LiveChatStore, seq: int) -> CookoutRoundRow:
    row: CookoutRoundRow = data_of(store, seq).round
    return row


def lucky(store: LiveChatStore, bank: FakeBank, seq: int, who: str, **kw: Any) -> Any:
    live = live_of(store, seq)
    offer = len(live.row.offers) - 1
    ids = tuple(s["id"] for s in live.row.offers[offer])
    return store.lucky_cookout(
        anchor_seq=seq,
        sender=who,
        email=None,
        move_id=kw.pop("mv", None) or move_id(),
        turn=kw.pop("turn", live.turn),
        offer=kw.pop("offer", offer),
        option_ids=kw.pop("option_ids", ids),
        bank=bank,
        runner_available=kw.pop("runner", True),
        **kw,
    )


def chaos(store: LiveChatStore, bank: FakeBank, seq: int, who: str, **kw: Any) -> Any:
    live = live_of(store, seq)
    offer = len(live.row.offers) - 1
    ids = tuple(s["id"] for s in live.row.offers[offer])
    return store.chaos_cookout(
        anchor_seq=seq,
        sender=who,
        email=None,
        move_id=kw.pop("mv", None) or move_id(),
        turn=kw.pop("turn", live.turn),
        offer=kw.pop("offer", offer),
        option_ids=kw.pop("option_ids", ids),
        bank=bank,
        **kw,
    )


def veto(
    store: LiveChatStore, bank: FakeBank, seq: int, who: str, index: int = 0, **kw: Any
) -> Any:
    live = live_of(store, seq)
    offer = len(live.row.offers) - 1
    return store.veto_cookout(
        anchor_seq=seq,
        sender=who,
        email=None,
        move_id=kw.pop("mv", None) or move_id(),
        turn=kw.pop("turn", live.turn),
        offer=kw.pop("offer", offer),
        ingredient_id=kw.pop("ingredient", live.row.offers[offer][index]["id"]),
        bank=bank,
        **kw,
    )


def star(store: LiveChatStore, seq: int, who: str, ingredient: str, runner: bool = True) -> Any:
    return store.star_cookout(
        anchor_seq=seq, sender=who, email=None, ingredient_id=ingredient, runner_available=runner
    )


def own_picks(store: LiveChatStore, seq: int, slot: int) -> list[str]:
    return [t.choice_id for t in data_of(store, seq).turns if t.player == slot and t.choice_id]


def wildcard(
    store: LiveChatStore, bank: FakeBank, seq: int, *, lift: bool, mv: str | None = None
) -> Any:
    return store.wildcard_cookout(
        anchor_seq=seq,
        sender=JOSH,
        email=None,
        move_id=mv or move_id(),
        lift=lift,
        bank=bank,
        runner_available=True,
    )


def vote(store: LiveChatStore, seq: int, who: str, concept: str, generation: int = 1) -> Any:
    return store.vote_cookout(
        anchor_seq=seq, sender=who, email=None, generation=generation, concept_id=concept
    )


def propose(
    store: LiveChatStore, bank: FakeBank, seq: int, ingredient: str, who: str = JOSH
) -> Any:
    return store.propose_cookout_swap(
        anchor_seq=seq,
        sender=who,
        email=None,
        move_id=move_id(),
        ingredient_id=ingredient,
        bank=bank,
    )


def choose(
    store: LiveChatStore, seq: int, ingredient: str, who: str = ROSE, runner: bool = True
) -> Any:
    return store.choose_cookout_swap(
        anchor_seq=seq,
        sender=who,
        email=None,
        move_id=move_id(),
        ingredient_id=ingredient,
        runner_available=runner,
    )


def swap_done(store: LiveChatStore, bank: FakeBank, seq: int, out: str | None = None) -> str:
    """Propose and choose a swap; returns the swapped-in ingredient id."""
    target = out or basket_of(store, seq)[0]
    round_, _ = propose(store, bank, seq, target)
    assert round_.swap_pair is not None
    chosen = str(round_.swap_pair[0]["id"])
    choose(store, seq, chosen)
    return chosen


# -- schema ---------------------------------------------------------------------------------------


class TestSchemaFinalShape:
    def columns(self, db_path: Path, table: str) -> dict[str, tuple[Any, ...]]:
        return {r[1]: r for r in raw(db_path, f"PRAGMA table_info({table})")}

    def test_the_round_table_carries_every_twist_column_with_its_default(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        store.list_messages(before=None, limit=1)
        cols = self.columns(db_path, "cookout_rounds")
        for name, default in (
            ("style_spun", "0"),
            ("wildcard", "'off'"),
            ("stars", "0"),
            ("generation", "1"),
            ("bank_move_ids", "'[]'"),
            ("swap_state", "'none'"),
            ("swap_seen", "'[]'"),
            ("swap_move_ids", "'[]'"),
        ):
            assert cols[name][4] == default, name
        for name in (
            "style", "challenge", "wildcard_snap", "wildcard_move_id", "star1_id", "star2_id",
            "vote1", "vote2", "swap_by", "swap_out_id", "swap_pair", "swap_in", "encore_kind",
            "encore_from_seq", "encore_generation", "encore_concept_id",
        ):  # fmt: skip
            assert name in cols, name
        assert raw(db_path, "PRAGMA user_version") == [(22,)]

    def test_recipes_are_keyed_by_generation_with_both_indexes(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        store.list_messages(before=None, limit=1)
        cols = self.columns(db_path, "cookout_recipes")
        pk = sorted((c[5], c[1]) for c in cols.values() if c[5])
        assert [name for _, name in pk] == ["anchor_message_seq", "generation", "concept_id"]
        for name in ("cooked_at", "cooked_by", "rating1", "rating2", "photo_message_seq"):
            assert name in cols
        names = {r[0] for r in raw(db_path, "SELECT name FROM sqlite_master")}
        assert {"idx_cookout_recipes_banked", "idx_cookout_recipes_photo"} <= names
        assert "cookout_generations" in names

    def test_foreign_key_actions(self, store: LiveChatStore, db_path: Path) -> None:
        store.list_messages(before=None, limit=1)

        def actions(table: str) -> dict[str, str]:
            return {fk[3]: fk[6] for fk in raw(db_path, f"PRAGMA foreign_key_list({table})")}

        assert actions("cookout_recipes")["photo_message_seq"] == "SET NULL"
        assert actions("cookout_recipes")["anchor_message_seq"] == "CASCADE"
        assert actions("cookout_rounds")["encore_from_seq"] == "SET NULL"
        assert actions("cookout_generations")["anchor_message_seq"] == "CASCADE"

    def test_reopening_is_a_no_op(self, db_path: Path, bank: FakeBank) -> None:
        first = LiveChatStore(db_path)
        seq = start(first, bank)
        before = raw(db_path, "SELECT * FROM cookout_rounds")
        LiveChatStore(db_path)
        assert raw(db_path, "SELECT * FROM cookout_rounds") == before
        assert data_of(first, seq).round.generation == 1

    def test_a_raw_sql_message_delete_cascades_and_unlinks_every_cookout_row(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        """What the overlapping v20 process would do: it knows no Cookout code, so the foreign keys
        alone must erase or unlink."""
        seq = ready_round(store, bank)
        bank_recipe(store, seq)
        photo_seq = photo_message(store, db_path, seq, "att-raw-1")
        assert store.mark_cookout_cooked(
            anchor_seq=seq, sender=JOSH, email=None, generation=1, concept_id="a", cooked=True
        )[1]
        store.link_cookout_photo(
            anchor_seq=seq,
            sender=JOSH,
            email=None,
            generation=1,
            concept_id="a",
            message_seq=photo_seq,
            attachment_id="att-raw-1",
        )
        conn = sqlite3.connect(str(db_path))
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("DELETE FROM attachments WHERE message_seq = ?", (photo_seq,))
        conn.execute("DELETE FROM messages WHERE seq = ?", (photo_seq,))
        conn.commit()
        assert raw(db_path, "SELECT photo_message_seq FROM cookout_recipes") == [(None,)]
        conn.execute("DELETE FROM messages WHERE seq = ?", (seq,))
        conn.commit()
        conn.close()
        for table in ("cookout_rounds", "cookout_turns", "cookout_recipes", "cookout_generations"):
            assert raw(db_path, f"SELECT COUNT(*) FROM {table}") == [(0,)], table


def photo_message(
    store: LiveChatStore,
    db_path: Path,
    anchor: int,
    att_id: str,
    *,
    ready: bool = True,
    extra: tuple[str, ...] = (),
    view_once: bool = False,
) -> int:
    """A mini-chat message carrying photo attachment(s) (`att_id` first, then `extra`)."""
    ids = [att_id, *extra]
    for a in ids:
        store.create_attachment(att_id=a, kind="photo", now=5.0)
    message, _ = store.create_message(
        client_id=f"photo-msg-{att_id}"[:64].ljust(16, "0"),
        sender=ROSE,
        device_id="device-1234",
        by_email=None,
        text=None,
        attachment_ids=ids,
        wyr_anchor_seq=anchor,
        now=6.0,
    )
    if ready:
        conn = sqlite3.connect(str(db_path))
        conn.execute(
            "UPDATE attachments SET status = 'ready', renditions = '[\"thumb\",\"full\"]' "
            "WHERE message_seq = ?",
            (message.seq,),
        )
        conn.commit()
        conn.close()
    if view_once:
        conn = sqlite3.connect(str(db_path))
        conn.execute("UPDATE messages SET view_once_s = 5 WHERE seq = ?", (message.seq,))
        conn.commit()
        conn.close()
    return message.seq


# -- core unchanged -------------------------------------------------------------------------------


class TestCoreUnchanged:
    def test_a_twist_free_round_has_off_values_everywhere(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        r = rnd(store, seq)
        assert (r.style, r.challenge, r.wildcard, r.stars, r.generation) == (
            None, None, "off", False, 1,
        )  # fmt: skip
        assert (r.swap_state, r.encore_kind, r.vote1, r.star1_id) == ("none", None, None, None)
        v = view(store, bank, seq, JOSH)
        assert v["setup"] == {
            "style": None, "styleSpun": False, "challenge": None, "wildcard": False,
            "stars": False, "fridgeRaid": False, "encore": None,
        }  # fmt: skip
        assert v["starters"] == [] and v["gate"] == {"waitingFor": []}
        assert v["stars"]["enabled"] is False and v["wildcard"]["state"] == "off"
        assert v["swap"]["state"] == "none" and v["generations"] == []
        assert bank.calls[0]["rarity_mode"] == "normal"

    def test_a_twist_free_round_finishes_straight_into_stage_one(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        finish_picks(store, bank, seq)
        r = rnd(store, seq)
        assert r.state == "finished" and r.concepts == "pending" and r.wildcard == "off"
        assert len(basket_of(store, seq)) == 10
        assert store.get_cookout_round(seq)["picked_ids"] == basket_of(store, seq)  # type: ignore[index]

    def test_the_ai_read_carries_the_new_keys_with_off_values(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        finish_picks(store, bank, seq)
        data = store.get_cookout_round(seq)
        assert data is not None
        assert data["star_ids"] == [] and data["wildcard_id"] is None
        assert data["forbidden_ids"] == [] and data["style"] is None
        assert data["challenge"] is None and data["generation"] == 1


# -- starters -------------------------------------------------------------------------------------


class TestStarters:
    def test_a_fridge_seed_is_turn_one_and_the_round_waits_at_turn_two_for_the_join(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seed = bank.items[10]  # a base-role item
        seq = open_round(store, bank, setup=CookoutSetup(fridge_seed_id=seed.id))
        turns = data_of(store, seq).turns
        assert len(turns) == 1 and turns[0].choice_id == seed.id and turns[0].offers == ()
        assert turns[0].seed_source == "fridge" and turns[0].seed is not None
        v = view(store, bank, seq, ROSE)
        assert v["current"]["waitingForJoin"] is True and v["current"]["turn"] == 2
        assert [s["id"] for s in v["starters"]] == [seed.id] and v["starters"][0]["via"] == "seed"
        assert v["setup"]["fridgeRaid"] is True
        join(store, bank, seq)
        assert len(data_of(store, seq).turns) == 2  # Turn 2 drawn on Join
        assert live_of(store, seq).turn == 2

    def test_the_role_schedule_starts_with_the_seeds_role(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        for role in ("protein", "produce", "accent"):
            seed = next(i for i in bank.items if i.role == role)
            seq = open_round(store, bank, setup=CookoutSetup(fridge_seed_id=seed.id))
            assert rnd(store, seq).role_schedule[0] == role

    def test_a_starter_is_in_every_later_draws_exclusions_but_not_its_categories(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seed = bank.items[0]
        seq = open_round(store, bank, setup=CookoutSetup(fridge_seed_id=seed.id))
        join(store, bank, seq)
        call = bank.calls[-1]
        assert seed.id in call["seen_ids"] and seed.family in call["offered_families"]
        assert seed.family in call["picked_families"]
        assert call["player_offered_categories"] == ()

    def test_a_starter_counts_towards_the_players_five_picks(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank, setup=CookoutSetup(fridge_seed_id=bank.items[0].id))
        finish_picks(store, bank, seq)
        r = rnd(store, seq)
        assert r.state == "finished"
        picks = view(store, bank, seq, JOSH)["players"]
        assert [p["pickCount"] for p in picks] == [5, 5]

    def test_an_unknown_fridge_seed_is_invalid_and_leaves_nothing_behind(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        with pytest.raises(CookoutInvalidError):
            open_round(store, bank, setup=CookoutSetup(fridge_seed_id="nope-nope"))
        assert raw(db_path, "SELECT COUNT(*) FROM cookout_rounds") == [(0,)]

    def finished_source(
        self, store: LiveChatStore, bank: FakeBank, *, banked: bool = False
    ) -> tuple[int, list[str]]:
        seq = ready_round(store, bank)
        if banked:
            bank_recipe(store, seq)
        return seq, basket_of(store, seq)

    def encore(self, seq: int, kind: str, ids: tuple[str, ...], concept: str = "a") -> EncoreSpec:
        return EncoreSpec(seq, 1, concept, kind, ids)  # type: ignore[arg-type]

    def test_a_leftovers_encore_seeds_two_turns_and_draws_turn_three_at_once(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        src, basket = self.finished_source(store, bank)
        left = basket[8:]  # canned concepts omit picked[8:]
        seq = open_round(
            store, bank, setup=CookoutSetup(encore=self.encore(src, "leftovers", tuple(left)))
        )
        turns = data_of(store, seq).turns
        assert [(t.turn, t.seed_source) for t in turns[:2]] == [(1, "encore"), (2, "encore")]
        assert live_of(store, seq).turn == 3 and live_of(store, seq).row is not None
        v = view(store, bank, seq, JOSH)
        assert v["setup"]["encore"]["kind"] == "leftovers"
        assert v["setup"]["encore"]["fromSeq"] == src
        assert v["setup"]["encore"]["fromTitle"] == "Dish A"
        assert [s["id"] for s in v["starters"]] == list(left)

    def test_fridge_plus_encore_is_fridge_on_turn_one_and_one_encore_seed_on_turn_two(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        src, basket = self.finished_source(store, bank)
        fridge = next(i for i in bank.items if i.id not in basket and i.role == "base")
        seq = open_round(
            store,
            bank,
            setup=CookoutSetup(
                fridge_seed_id=fridge.id, encore=self.encore(src, "leftovers", (basket[9],))
            ),
        )
        sources = [(t.seed_source, t.choice_id) for t in data_of(store, seq).turns[:2]]
        assert sources == [("fridge", fridge.id), ("encore", basket[9])]
        assert live_of(store, seq).turn == 3

    def test_encore_validation(self, store: LiveChatStore, bank: FakeBank) -> None:
        src, basket = self.finished_source(store, bank)
        fridge = next(i for i in bank.items if i.id not in basket and i.role == "base")
        bad: list[CookoutSetup] = [
            CookoutSetup(encore=self.encore(src, "leftovers", (basket[0],))),  # not omitted
            CookoutSetup(encore=self.encore(src, "leftovers", tuple(basket[7:10]))),  # three
            CookoutSetup(encore=self.encore(src, "leftovers", (basket[9], basket[9]))),  # dup
            CookoutSetup(encore=self.encore(src, "remix", (basket[0],))),  # not banked
            CookoutSetup(encore=self.encore(9999, "leftovers", (basket[9],))),  # no source
            CookoutSetup(encore=self.encore(src, "leftovers", (basket[9],), concept="z")),
            CookoutSetup(
                fridge_seed_id=fridge.id, encore=self.encore(src, "leftovers", tuple(basket[8:]))
            ),  # fridge + two encore seeds
            CookoutSetup(encore=EncoreSpec(src, 2, "a", "leftovers", (basket[9],))),  # no gen 2
        ]
        for setup in bad:
            with pytest.raises(CookoutInvalidError):
                open_round(store, bank, setup=setup)

    def test_a_remix_needs_a_banked_recipe_and_its_own_ingredients(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        src, basket = self.finished_source(store, bank, banked=True)
        seq = open_round(
            store, bank, setup=CookoutSetup(encore=self.encore(src, "remix", (basket[0],)))
        )
        assert data_of(store, seq).turns[0].choice_id == basket[0]
        with pytest.raises(CookoutInvalidError):  # an omitted ingredient is not part of the remix
            open_round(
                store, bank, setup=CookoutSetup(encore=self.encore(src, "remix", (basket[9],)))
            )

    def test_encore_is_validated_after_the_replay_check_and_survives_a_deleted_source(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        src, basket = self.finished_source(store, bank)
        setup = CookoutSetup(encore=self.encore(src, "leftovers", (basket[9],)))
        message, created = store.create_cookout_round(
            client_id="encore-replay-00001",
            sender=JOSH,
            device_id="device-1234",
            by_email=None,
            blind=False,
            bank=bank,
            setup=setup,
        )
        assert created
        store.delete_message(seq=src, now=50.0)
        again, created = store.create_cookout_round(
            client_id="encore-replay-00001",
            sender=JOSH,
            device_id="device-1234",
            by_email=None,
            blind=False,
            bank=bank,
            setup=setup,
        )
        assert created is False and again.seq == message.seq

    def test_deleting_the_source_nulls_the_link_and_bumps_the_rev(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        src, basket = self.finished_source(store, bank)
        seq = open_round(
            store, bank, setup=CookoutSetup(encore=self.encore(src, "leftovers", (basket[9],)))
        )
        rev = rnd(store, seq).rev
        store.delete_message(seq=src, now=50.0)
        r = rnd(store, seq)
        assert (r.encore_from_seq, r.encore_generation, r.encore_concept_id) == (None, None, None)
        assert r.encore_kind is None and r.rev == rev + 1
        assert events(db_path, seq)[-1] == "message_updated"
        assert view(store, bank, seq, JOSH)["setup"]["encore"] is None

    def test_an_archived_generation_can_seed_an_encore(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        src, basket = self.finished_source(store, bank)
        swap_done(store, bank, src)
        spec = EncoreSpec(src, 1, "a", "leftovers", (basket[9],))
        seq = open_round(store, bank, setup=CookoutSetup(encore=spec))
        assert data_of(store, seq).turns[0].choice_id == basket[9]


# -- drafting twists ------------------------------------------------------------------------------


class TestLuckyDip:
    def test_the_coin_commits_one_of_the_two_options_exactly_as_a_pick(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        ids = [s["id"] for s in live_of(store, seq).row.offers[0]]
        round_, changed = lucky(store, bank, seq, JOSH)
        assert changed
        turn1 = data_of(store, seq).turns[0]
        assert turn1.choice_id in ids and turn1.lucky is True and turn1.pick_move_id
        assert round_.state == "picking"
        assert [p["via"] for p in view(store, bank, seq, JOSH)["players"][0]["picks"]] == ["lucky"]

    def test_both_faces_of_the_coin_occur(self, store: LiveChatStore, bank: FakeBank) -> None:
        import random

        seen = set()
        for n in range(12):
            seq = open_round(store, bank)
            ids = [s["id"] for s in live_of(store, seq).row.offers[0]]
            lucky(store, bank, seq, JOSH, rng=random.Random(n))
            seen.add(ids.index(data_of(store, seq).turns[0].choice_id))
        assert seen == {0, 1}

    def test_the_replay_is_a_no_op_and_shares_the_pick_move_id(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        live = live_of(store, seq)
        ids = tuple(s["id"] for s in live.row.offers[0])
        lucky(store, bank, seq, JOSH, mv="lucky-move-0001")
        rev = rnd(store, seq).rev
        _, changed = store.lucky_cookout(
            anchor_seq=seq, sender=JOSH, email=None, move_id="lucky-move-0001", turn=1, offer=0,
            option_ids=ids, bank=bank, runner_available=True,
        )  # fmt: skip
        assert changed is False and rnd(store, seq).rev == rev
        with pytest.raises(CookoutBadStateError):  # that move id on another turn
            join(store, bank, seq)
            store.lucky_cookout(
                anchor_seq=seq, sender=JOSH, email=None, move_id="lucky-move-0001", turn=3,
                offer=0, option_ids=ids, bank=bank, runner_available=True,
            )  # fmt: skip

    def test_stale_option_ids_and_other_refusals(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        join(store, bank, seq)
        with pytest.raises(CookoutBadStateError):
            lucky(store, bank, seq, JOSH, option_ids=("base-00", "base-01"))
        with pytest.raises(CookoutBadStateError):
            lucky(store, bank, seq, JOSH, offer=1)
        with pytest.raises(CookoutNotYourTurnError):
            lucky(store, bank, seq, ROSE)
        with pytest.raises(CookoutNotPlayerError):
            lucky(store, bank, seq, "Stranger")

    def test_a_lucky_tenth_pick_finishes_the_round_like_a_pick(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        join(store, bank, seq)
        for _ in range(9):
            pick(store, bank, seq, pl(live_of(store, seq).player))
        round_, _ = lucky(store, bank, seq, ROSE)
        assert round_.state == "finished" and round_.concepts == "pending"


class TestChaosShelf:
    def test_both_options_become_an_exotic_pair_in_place_and_the_old_pair_is_kept(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        old = [s["id"] for s in live_of(store, seq).row.offers[0]]
        chaos(store, bank, seq, JOSH)
        row = data_of(store, seq).turns[0]
        assert len(row.offers) == 1 and row.chaos_offer == 0
        new = row.offers[0]
        assert all(bank.ingredient(s["id"]).rarity == "exotic" for s in new)  # type: ignore[union-attr]
        assert new[0]["category"] != new[1]["category"]
        assert [(e["by"], e["snap"]["id"]) for e in row.replaced] == [
            ("chaos", old[0]), ("chaos", old[1])
        ]  # fmt: skip
        v = view(store, bank, seq, JOSH)["current"]
        assert v["chaosPair"] is True and v["offerIndex"] == 0 and v["skipsRemaining"] == 2

    def test_the_replaced_pair_still_counts_as_offered_for_the_next_draws(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        old = [s["id"] for s in live_of(store, seq).row.offers[0]]
        chaos(store, bank, seq, JOSH)
        skip(store, bank, seq, JOSH)
        assert set(old) <= bank.calls[-1]["seen_ids"]

    def test_once_per_player_per_round_and_the_token_is_derived(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        join(store, bank, seq)
        chaos(store, bank, seq, JOSH)
        pick(store, bank, seq, JOSH)
        _, changed = chaos(store, bank, seq, ROSE)  # the partner has their own token
        assert changed
        pick(store, bank, seq, ROSE)
        with pytest.raises(CookoutTokenUsedError):  # Josh's next turn
            chaos(store, bank, seq, JOSH)
        v = view(store, bank, seq, JOSH)
        assert v["you"]["chaosUsed"] is True
        assert [p["chaosUsed"] for p in v["players"]] == [True, True]

    def test_replay_and_staleness(self, store: LiveChatStore, bank: FakeBank) -> None:
        seq = open_round(store, bank)
        live = live_of(store, seq)
        ids = tuple(s["id"] for s in live.row.offers[0])
        chaos(store, bank, seq, JOSH, mv="chaos-move-00001")
        rev = rnd(store, seq).rev
        _, changed = store.chaos_cookout(
            anchor_seq=seq, sender=JOSH, email=None, move_id="chaos-move-00001", turn=1, offer=0,
            option_ids=ids, bank=bank,
        )  # fmt: skip
        assert changed is False and rnd(store, seq).rev == rev
        with pytest.raises(CookoutBadStateError):
            chaos(store, bank, seq, JOSH, option_ids=ids, mv=move_id())  # the old pair is gone

    def test_no_exotic_pair_is_exhausted_and_spends_nothing(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        bank.exhausted = True
        with pytest.raises(CookoutExhaustedError):
            chaos(store, bank, seq, JOSH)
        bank.exhausted = False
        assert data_of(store, seq).turns[0].chaos_offer is None
        _, changed = chaos(store, bank, seq, JOSH)
        assert changed

    def test_on_the_final_pair_and_skipping_a_chaos_pair_costs_a_skip(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        skip(store, bank, seq, JOSH)
        skip(store, bank, seq, JOSH)  # final pair, no skips left
        chaos(store, bank, seq, JOSH)
        assert live_of(store, seq).row.chaos_offer == 2
        assert view(store, bank, seq, JOSH)["current"]["skipsRemaining"] == 0

    def test_skipping_after_chaos_deals_a_normal_pair(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        chaos(store, bank, seq, JOSH)
        skip(store, bank, seq, JOSH)
        assert bank.calls[-1]["rarity_mode"] == "normal"
        assert view(store, bank, seq, JOSH)["current"]["chaosPair"] is False
        assert pick(store, bank, seq, JOSH)[1]
        via = view(store, bank, seq, JOSH)["players"][0]["picks"][0]["via"]
        assert via == "pick"

    def test_a_chaos_pick_is_tagged_chaos(self, store: LiveChatStore, bank: FakeBank) -> None:
        seq = open_round(store, bank)
        chaos(store, bank, seq, JOSH)
        pick(store, bank, seq, JOSH)
        assert view(store, bank, seq, JOSH)["players"][0]["picks"][0]["via"] == "chaos"


class TestPartnerVeto:
    def start(self, store: LiveChatStore, bank: FakeBank, *, blind: bool = False) -> int:
        seq = open_round(store, bank, blind=blind)
        join(store, bank, seq)
        return seq

    def test_the_partner_sweeps_one_option_and_a_legal_replacement_takes_its_place(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.start(store, bank)
        before = live_of(store, seq).row.offers[0]
        veto(store, bank, seq, ROSE, index=0)
        row = data_of(store, seq).turns[0]
        after = row.offers[0]
        assert len(row.offers) == 1 and after[1] == before[1] and after[0]["id"] != before[0]["id"]
        assert after[0]["category"] != after[1]["category"]
        assert after[0]["family"] != after[1]["family"]
        assert [(e["by"], e["position"], e["snap"]["id"]) for e in row.replaced] == [
            ("veto", 0, before[0]["id"])
        ]
        assert row.veto_offer == 0
        cur = view(store, bank, seq, JOSH)["current"]
        assert cur["vetoed"]["snap"]["id"] == before[0]["id"] and cur["skipsRemaining"] == 2

    def test_once_per_player_and_only_by_the_other_player(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.start(store, bank)
        with pytest.raises(CookoutBadStateError):
            veto(store, bank, seq, JOSH)  # your own table
        veto(store, bank, seq, ROSE)
        pick(store, bank, seq, JOSH)
        veto(store, bank, seq, JOSH)  # Rose's turn: Josh may now veto
        pick(store, bank, seq, ROSE)
        with pytest.raises(CookoutTokenUsedError):  # Josh's turn again: Rose has spent hers
            veto(store, bank, seq, ROSE)
        v = view(store, bank, seq, JOSH)
        assert v["you"]["vetoUsed"] is True and [p["vetoUsed"] for p in v["players"]] == [
            True,
            True,
        ]

    def test_veto_is_refused_in_blind_mode_and_the_view_never_offers_it(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.start(store, bank, blind=True)
        with pytest.raises(CookoutBadStateError):
            veto(store, bank, seq, ROSE)
        assert view(store, bank, seq, ROSE)["current"]["canVeto"] is None
        assert view(store, bank, seq, JOSH)["current"]["canVeto"] is None

    def test_can_veto_is_computed_for_the_viewer_only(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.start(store, bank)
        assert view(store, bank, seq, ROSE)["current"]["canVeto"] is True
        assert view(store, bank, seq, JOSH)["current"]["canVeto"] is False
        assert view(store, bank, seq, None)["current"]["canVeto"] is False
        veto(store, bank, seq, ROSE)
        assert view(store, bank, seq, ROSE)["current"]["canVeto"] is False

    def test_replay_stale_and_exhausted(self, store: LiveChatStore, bank: FakeBank) -> None:
        seq = self.start(store, bank)
        before = live_of(store, seq).row.offers[0]
        veto(store, bank, seq, ROSE, mv="veto-move-000001", ingredient=before[0]["id"])
        _, changed = store.veto_cookout(
            anchor_seq=seq, sender=ROSE, email=None, move_id="veto-move-000001", turn=1, offer=0,
            ingredient_id=before[0]["id"], bank=bank,
        )  # fmt: skip
        assert changed is False
        with pytest.raises(CookoutBadStateError):  # the swept option is no longer on the table
            veto(store, bank, seq, ROSE, ingredient=before[0]["id"])
        seq2 = self.start(store, bank)
        bank.exhausted = True
        with pytest.raises(CookoutExhaustedError):
            veto(store, bank, seq2, ROSE)
        bank.exhausted = False
        assert data_of(store, seq2).turns[0].veto_offer is None  # the token was not spent

    def test_picking_the_swept_option_is_bad_state_and_the_one_that_stayed_is_fine(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.start(store, bank)
        before = live_of(store, seq).row.offers[0]
        veto(store, bank, seq, ROSE, index=0)
        with pytest.raises(CookoutBadStateError):
            pick(store, bank, seq, JOSH, ingredient=before[0]["id"])
        with pytest.raises(CookoutInvalidError):  # genuinely never offered stays 422
            pick(store, bank, seq, JOSH, ingredient="protein-00")
        _, changed = pick(store, bank, seq, JOSH, ingredient=before[1]["id"])
        assert changed

    def test_a_veto_after_the_pick_is_stale(self, store: LiveChatStore, bank: FakeBank) -> None:
        seq = self.start(store, bank)
        stale_turn = live_of(store, seq)
        ingredient = stale_turn.row.offers[0][0]["id"]
        pick(store, bank, seq, JOSH)
        with pytest.raises(CookoutBadStateError):
            store.veto_cookout(
                anchor_seq=seq, sender=ROSE, email=None, move_id=move_id(), turn=1, offer=0,
                ingredient_id=ingredient, bank=bank,
            )  # fmt: skip

    def test_lucky_dip_after_a_veto_is_stale_unless_it_names_the_new_table(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.start(store, bank)
        old_ids = tuple(s["id"] for s in live_of(store, seq).row.offers[0])
        veto(store, bank, seq, ROSE)
        with pytest.raises(CookoutBadStateError):
            lucky(store, bank, seq, JOSH, option_ids=old_ids)
        _, changed = lucky(store, bank, seq, JOSH)
        assert changed

    def test_a_veto_on_a_chaos_pair_draws_an_exotic_replacement(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.start(store, bank)
        chaos(store, bank, seq, JOSH)
        veto(store, bank, seq, ROSE)
        assert bank.calls[-1]["rarity_mode"] == "exotic"
        row = data_of(store, seq).turns[0]
        assert all(bank.ingredient(s["id"]).rarity == "exotic" for s in row.offers[0])  # type: ignore[union-attr]

    def test_veto_then_chaos_replaces_both_current_options(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.start(store, bank)
        veto(store, bank, seq, ROSE)
        chaos(store, bank, seq, JOSH)
        row = data_of(store, seq).turns[0]
        assert [e["by"] for e in row.replaced] == ["veto", "chaos", "chaos"]

    def test_the_replacement_keeps_an_everyday_in_the_pair(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.start(store, bank)
        chaos(store, bank, seq, JOSH)
        skip(store, bank, seq, JOSH)  # normal pair again
        veto(store, bank, seq, ROSE)
        pair = data_of(store, seq).turns[0].offers[-1]
        rarities = {bank.ingredient(s["id"]).rarity for s in pair}  # type: ignore[union-attr]
        assert "everyday" in rarities


# -- the chef gate: wildcard cloche and secret stars -----------------------------------------------


def finish_gated(store: LiveChatStore, bank: FakeBank, setup: CookoutSetup) -> int:
    seq = open_round(store, bank, setup=setup)
    finish_picks(store, bank, seq)
    return seq


class TestWildcardCloche:
    def test_the_tenth_pick_offers_the_cloche_and_holds_the_chef_back(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = finish_gated(store, bank, CookoutSetup(wildcard=True))
        r = rnd(store, seq)
        assert (r.state, r.wildcard, r.concepts) == ("finished", "offered", "none")
        assert store.cookout_pending_concepts() == []
        v = view(store, bank, seq, JOSH)
        assert v["gate"] == {"waitingFor": ["wildcard"]} and v["revealed"] is True
        assert v["wildcard"] == {"state": "offered", "ingredient": None}
        assert store.get_cookout_round(seq)["basket_ids"] == []  # type: ignore[index]

    def test_lifting_adds_an_eleventh_ingredient_and_starts_the_chef_once(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = finish_gated(store, bank, CookoutSetup(wildcard=True))
        round_, changed = wildcard(store, bank, seq, lift=True)
        assert changed and round_.wildcard == "lifted" and round_.concepts == "pending"
        data = store.get_cookout_round(seq)
        assert data is not None and len(data["basket_ids"]) == 11
        assert data["wildcard_id"] == round_.wildcard_snap["id"]
        assert data["picked_ids"] == data["basket_ids"]
        assert store.cookout_pending_concepts() == [(seq, 1, None)]
        v = view(store, bank, seq, ROSE)
        assert v["wildcard"]["ingredient"]["id"] == data["wildcard_id"]
        assert [b["via"] for b in v["basket"]][-1] == "wildcard" and len(v["basket"]) == 11
        assert v["basket"][-1]["turn"] is None

    def test_the_wildcard_is_new_non_everyday_and_from_an_unpicked_family(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = finish_gated(store, bank, CookoutSetup(wildcard=True))
        round_, _ = wildcard(store, bank, seq, lift=True)
        wild = round_.wildcard_snap
        assert wild is not None and bank.ingredient(wild["id"]).rarity != "everyday"  # type: ignore[union-attr]
        offered = {s["id"] for t in data_of(store, seq).turns for p in t.offers for s in p}
        assert wild["id"] not in offered

    def test_declining_starts_the_chef_with_ten(self, store: LiveChatStore, bank: FakeBank) -> None:
        seq = finish_gated(store, bank, CookoutSetup(wildcard=True))
        round_, changed = wildcard(store, bank, seq, lift=False)
        assert changed and round_.wildcard == "declined" and round_.concepts == "pending"
        data = store.get_cookout_round(seq)
        assert data is not None and len(data["basket_ids"]) == 10 and data["wildcard_id"] is None

    def test_replays_and_the_opposite_outcome(self, store: LiveChatStore, bank: FakeBank) -> None:
        seq = finish_gated(store, bank, CookoutSetup(wildcard=True))
        wildcard(store, bank, seq, lift=True, mv="cloche-move-0001")
        rev = rnd(store, seq).rev
        assert wildcard(store, bank, seq, lift=True, mv="cloche-move-0001")[1] is False
        assert wildcard(store, bank, seq, lift=True)[1] is False  # same outcome, new move
        with pytest.raises(CookoutBadStateError):
            wildcard(store, bank, seq, lift=False)
        assert rnd(store, seq).rev == rev

    def test_no_drawable_wildcard_is_exhausted_and_the_cloche_stays_offered(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = finish_gated(store, bank, CookoutSetup(wildcard=True))
        bank.exhausted_wildcard = True
        with pytest.raises(CookoutExhaustedError):
            wildcard(store, bank, seq, lift=True)
        assert rnd(store, seq).wildcard == "offered"
        assert wildcard(store, bank, seq, lift=False)[0].concepts == "pending"

    def test_a_non_player_and_an_unarmed_round_are_refused(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = finish_gated(store, bank, CookoutSetup(wildcard=True))
        with pytest.raises(CookoutNotPlayerError):
            store.wildcard_cookout(
                anchor_seq=seq, sender="Nobody", email=None, move_id=move_id(), lift=True,
                bank=bank, runner_available=True,
            )  # fmt: skip
        plain = finish_gated(store, bank, CookoutSetup())
        with pytest.raises(CookoutBadStateError):
            wildcard(store, bank, plain, lift=True)

    def test_a_runnerless_server_marks_the_dishes_unavailable_after_the_answer(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank, setup=CookoutSetup(wildcard=True))
        finish_picks(store, bank, seq, runner=False)
        round_, _ = store.wildcard_cookout(
            anchor_seq=seq, sender=ROSE, email=None, move_id=move_id(), lift=False, bank=bank,
            runner_available=False,
        )  # fmt: skip
        assert round_.concepts == "unavailable"


class TestSecretStars:
    def setup_round(self, store: LiveChatStore, bank: FakeBank, **kw: Any) -> int:
        seq = open_round(store, bank, setup=CookoutSetup(stars=True, **kw))
        join(store, bank, seq)
        return seq

    def play_to_turn_ten(self, store: LiveChatStore, bank: FakeBank, seq: int) -> None:
        while live_of(store, seq).turn < 10:
            pick(store, bank, seq, pl(live_of(store, seq).player))

    def test_stars_set_while_picking_leave_no_gate(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.setup_round(store, bank)
        for _ in range(2):
            pick(store, bank, seq, pl(live_of(store, seq).player))
        star(store, seq, JOSH, own_picks(store, seq, 1)[0])
        star(store, seq, ROSE, own_picks(store, seq, 2)[0])
        self.play_to_turn_ten(store, bank, seq)
        r = pick(store, bank, seq, ROSE)[0]
        assert r.state == "finished" and r.concepts == "pending"  # no gate at all
        assert view(store, bank, seq, JOSH)["stars"]["revealed"] is True

    def test_without_stars_the_gate_waits_and_names_who_is_missing(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.setup_round(store, bank)
        finish_picks(store, bank, seq)
        r = rnd(store, seq)
        assert r.concepts == "none"
        assert view(store, bank, seq, JOSH)["gate"] == {"waitingFor": ["stars"]}
        msg = next(m for m in store.list_messages(before=None, limit=5)[0] if m.seq == seq)
        assert msg.cookout is not None and msg.cookout.waiting == ("stars",)

    def test_the_second_star_after_turn_ten_reveals_and_locks_in_one_transition(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.setup_round(store, bank)
        finish_picks(store, bank, seq)
        mine, hers = own_picks(store, seq, 1)[0], own_picks(store, seq, 2)[0]
        r, _ = star(store, seq, JOSH, mine)
        assert r.concepts == "none"
        v = view(store, bank, seq, ROSE)
        assert v["stars"]["partnerChosen"] is True and v["stars"]["partner"] is None
        assert v["stars"]["revealed"] is False
        r, _ = star(store, seq, ROSE, hers)
        assert r.concepts == "pending"  # the second star cleared the gate
        v = view(store, bank, seq, ROSE)
        assert v["stars"]["revealed"] is True and v["stars"]["partner"] == mine
        assert v["stars"]["mine"] == hers
        assert store.get_cookout_round(seq)["star_ids"] == sorted([mine, hers])  # type: ignore[index]
        with pytest.raises(CookoutBadStateError):
            star(store, seq, JOSH, own_picks(store, seq, 1)[1])  # locked
        assert star(store, seq, JOSH, mine)[1] is False  # same id: idempotent, no event

    def test_a_star_can_change_until_the_lock(self, store: LiveChatStore, bank: FakeBank) -> None:
        seq = self.setup_round(store, bank)
        finish_picks(store, bank, seq)
        first, second = own_picks(store, seq, 1)[:2]
        star(store, seq, JOSH, first)
        star(store, seq, JOSH, second)
        assert rnd(store, seq).star1_id == second

    def test_stars_lock_even_while_the_cloche_is_unanswered_then_one_chef_job(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = finish_gated(store, bank, CookoutSetup(stars=True, wildcard=True))
        mine, hers = own_picks(store, seq, 1)[0], own_picks(store, seq, 2)[0]
        star(store, seq, JOSH, mine)
        r, _ = star(store, seq, ROSE, hers)
        assert r.concepts == "none"
        v = view(store, bank, seq, JOSH)
        assert v["stars"]["revealed"] is True and v["gate"] == {"waitingFor": ["wildcard"]}
        with pytest.raises(CookoutBadStateError):
            star(store, seq, JOSH, own_picks(store, seq, 1)[1])
        round_, _ = wildcard(store, bank, seq, lift=True)
        assert round_.concepts == "pending" and store.cookout_pending_concepts() == [(seq, 1, None)]
        data = store.get_cookout_round(seq)
        assert data is not None and data["star_ids"] == sorted([mine, hers])
        assert len(data["basket_ids"]) == 11

    def test_the_cloche_first_then_the_stars_starts_on_the_last_answer(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = finish_gated(store, bank, CookoutSetup(stars=True, wildcard=True))
        assert wildcard(store, bank, seq, lift=False)[0].concepts == "none"
        star(store, seq, JOSH, own_picks(store, seq, 1)[0])
        assert rnd(store, seq).concepts == "none"
        r, _ = star(store, seq, ROSE, own_picks(store, seq, 2)[0])
        assert r.concepts == "pending"

    def test_only_your_own_picks_and_only_in_a_starred_round(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.setup_round(store, bank)
        finish_picks(store, bank, seq)
        with pytest.raises(CookoutInvalidError):
            star(store, seq, JOSH, own_picks(store, seq, 2)[0])  # the partner's pick
        with pytest.raises(CookoutInvalidError):
            star(store, seq, JOSH, "nothing-here")
        with pytest.raises(CookoutNotPlayerError):
            star(store, seq, "Nobody", own_picks(store, seq, 1)[0])
        plain = finish_gated(store, bank, CookoutSetup())
        with pytest.raises(CookoutBadStateError):
            star(store, plain, JOSH, own_picks(store, plain, 1)[0])

    def test_a_starter_can_be_starred_and_a_wildcard_cannot(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seed = bank.items[0]
        seq = finish_gated(
            store, bank, CookoutSetup(stars=True, wildcard=True, fridge_seed_id=seed.id)
        )
        assert star(store, seq, JOSH, seed.id)[1] is True
        wildcard(store, bank, seq, lift=True)  # concepts do not start: ROSE has no star yet
        assert rnd(store, seq).concepts == "none"

    def test_an_abandoned_round_never_reveals_stars_and_refuses_new_ones(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.setup_round(store, bank)
        pick(store, bank, seq, JOSH)
        star(store, seq, JOSH, own_picks(store, seq, 1)[0])
        store.abandon_cookout(anchor_seq=seq, sender=JOSH, email=None)
        v = view(store, bank, seq, ROSE)
        assert v["stars"]["revealed"] is False and v["stars"]["partner"] is None
        with pytest.raises(CookoutBadStateError):
            star(store, seq, ROSE, "x")

    def test_blind_mode_keeps_the_partners_star_out_of_every_response(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank, blind=True, setup=CookoutSetup(stars=True))
        join(store, bank, seq)
        finish_picks(store, bank, seq)
        mine, hers = own_picks(store, seq, 1)[0], own_picks(store, seq, 2)[0]
        star(store, seq, ROSE, hers)
        v = view(store, bank, seq, JOSH)
        assert v["stars"]["partnerChosen"] is True
        assert hers not in json.dumps(v["stars"])
        assert v["stars"]["mine"] is None
        star(store, seq, JOSH, mine)
        assert view(store, bank, seq, JOSH)["stars"]["partner"] == hers


# -- the dinner vote ------------------------------------------------------------------------------


class TestDinnerVote:
    def test_votes_are_secret_changeable_then_revealed_and_locked_together(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        vote(store, seq, JOSH, "a")
        v = view(store, bank, seq, ROSE)["vote"]
        assert v == {
            "you": None, "partnerVoted": True, "revealed": False, "votes": None, "match": None,
        }  # fmt: skip
        assert "votes" not in json.dumps(view(store, bank, seq, None)["vote"]).replace(
            '"votes": null', ""
        )
        vote(store, seq, JOSH, "b")  # change before the partner votes
        assert vote(store, seq, ROSE, "b")[1] is True
        v = view(store, bank, seq, JOSH)["vote"]
        assert v["revealed"] is True and v["votes"] == {"1": "b", "2": "b"} and v["match"] == "b"
        with pytest.raises(CookoutBadStateError):
            vote(store, seq, JOSH, "c")
        assert vote(store, seq, JOSH, "b")[1] is False

    def test_a_mismatch_reveals_both_votes_with_no_match(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        vote(store, seq, JOSH, "a")
        vote(store, seq, ROSE, "c")
        v = view(store, bank, seq, JOSH)["vote"]
        assert v["votes"] == {"1": "a", "2": "c"} and v["match"] is None
        msg = next(m for m in store.list_messages(before=None, limit=5)[0] if m.seq == seq)
        assert msg.cookout is not None and msg.cookout.dinner_decided is False

    def test_the_card_summary_flags_a_decided_dinner_without_naming_it(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        vote(store, seq, JOSH, "c")
        vote(store, seq, ROSE, "c")
        msg = next(m for m in store.list_messages(before=None, limit=5)[0] if m.seq == seq)
        assert msg.cookout is not None and msg.cookout.dinner_decided is True
        from wixy_server.livechat.models import message_json

        wire = json.dumps(message_json(msg, _Signer())["cookout"])
        assert '"c"' not in wire

    def test_refusals(self, store: LiveChatStore, bank: FakeBank) -> None:
        seq = ready_round(store, bank)
        with pytest.raises(CookoutNotPlayerError):
            vote(store, seq, "Nobody", "a")
        with pytest.raises(CookoutInvalidError):
            vote(store, seq, JOSH, "z")
        with pytest.raises(CookoutBadStateError):
            vote(store, seq, JOSH, "a", generation=2)
        open_seq = open_round(store, bank)
        with pytest.raises(CookoutBadStateError):
            vote(store, open_seq, JOSH, "a")

    def test_a_vote_changes_nothing_else(self, store: LiveChatStore, bank: FakeBank) -> None:
        seq = ready_round(store, bank)
        before = rnd(store, seq)
        vote(store, seq, JOSH, "a")
        after = rnd(store, seq)
        assert after.concepts == before.concepts and store.cookout_pending_recipes() == []
        assert after.rev == before.rev + 1


# -- the rescue swap and generations ---------------------------------------------------------------


class TestRescueSwap:
    def test_propose_deals_a_pair_for_the_partner_to_choose_from(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        target = basket_of(store, seq)[3]
        round_, changed = propose(store, bank, seq, target)
        assert changed and round_.swap_state == "proposed" and round_.swap_by == 1
        assert round_.swap_out_id == target and round_.swap_pair is not None
        seen = {s["id"] for t in data_of(store, seq).turns for p in t.offers for s in p}
        pair = {s["id"] for s in round_.swap_pair}
        assert not pair & seen and len(pair) == 2 and len(round_.swap_seen) == 2
        a, b = round_.swap_pair
        assert a["category"] != b["category"] and a["family"] != b["family"]
        role = bank.ingredient(target).role  # type: ignore[union-attr]
        assert all(bank.ingredient(i).role == role for i in pair)  # type: ignore[union-attr]
        v = view(store, bank, seq, ROSE)["swap"]
        assert v["state"] == "proposed" and v["by"] == 1 and v["out"]["id"] == target
        assert len(v["pair"]) == 2 and v["available"] is False

    def test_only_the_other_player_chooses_and_choosing_archives_the_dishes(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        basket = basket_of(store, seq)
        vote(store, seq, JOSH, "a")
        vote(store, seq, ROSE, "b")
        target = basket[3]
        round_, _ = propose(store, bank, seq, target)
        assert round_.swap_pair is not None
        chosen = round_.swap_pair[1]
        with pytest.raises(CookoutNotYourTurnError):
            choose(store, seq, chosen["id"], who=JOSH)
        with pytest.raises(CookoutBadStateError):
            choose(store, seq, "not-in-the-pair")
        before_pictures = rnd(store, seq).pictures
        round_, changed = choose(store, seq, chosen["id"])
        assert changed and round_.generation == 2 and round_.swap_state == "done"
        assert round_.swap_in is not None and round_.swap_in["id"] == chosen["id"]
        assert (round_.concepts, round_.concepts_json, round_.images) == ("pending", None, "none")
        assert round_.vote1 is None and round_.vote2 is None and round_.pictures == {}
        [gen] = data_of(store, seq).generations
        assert gen.generation == 1 and gen.basket == tuple(basket)
        assert (gen.vote1, gen.vote2) == ("a", "b") and gen.pictures == before_pictures
        assert json.loads(gen.concepts_json)["concepts"][0]["id"] == "a"
        expected = [chosen["id"] if i == target else i for i in basket]
        assert basket_of(store, seq) == expected
        assert store.get_cookout_round(seq)["forbidden_ids"] == [target]  # type: ignore[index]
        assert store.cookout_pending_concepts() == [(seq, 2, None)]

    def test_cancel_keeps_the_dishes_and_the_swap_unused(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        round_, _ = propose(store, bank, seq, basket_of(store, seq)[0])
        first_pair = {s["id"] for s in round_.swap_pair}
        round_, changed = store.cancel_cookout_swap(anchor_seq=seq, sender=ROSE, email=None)
        assert changed and round_.swap_state == "none" and round_.swap_pair is None
        assert store.cancel_cookout_swap(anchor_seq=seq, sender=ROSE, email=None)[1] is False
        round_, _ = propose(store, bank, seq, basket_of(store, seq)[0], who=ROSE)
        assert not {s["id"] for s in round_.swap_pair} & first_pair
        choose(store, seq, round_.swap_pair[0]["id"], who=JOSH)
        with pytest.raises(CookoutBadStateError):
            store.cancel_cookout_swap(anchor_seq=seq, sender=ROSE, email=None)

    def test_one_swap_per_round_and_refusals(self, store: LiveChatStore, bank: FakeBank) -> None:
        seq = ready_round(store, bank)
        basket = basket_of(store, seq)
        with pytest.raises(CookoutInvalidError):
            propose(store, bank, seq, "not-in-the-basket")
        with pytest.raises(CookoutNotPlayerError):
            propose(store, bank, seq, basket[0], who="Nobody")
        propose(store, bank, seq, basket[0])
        with pytest.raises(CookoutBadStateError):
            propose(store, bank, seq, basket[1])
        choose(store, seq, rnd(store, seq).swap_pair[0]["id"])  # type: ignore[index]
        with pytest.raises(CookoutBadStateError):
            propose(store, bank, seq, basket[1])
        unfinished = open_round(store, bank)
        with pytest.raises(CookoutBadStateError):
            propose(store, bank, unfinished, "base-00")

    def test_a_starred_ingredient_cannot_be_sent_back(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank, setup=CookoutSetup(stars=True))
        finish_picks(store, bank, seq)
        mine = own_picks(store, seq, 1)[0]
        star(store, seq, JOSH, mine)
        star(store, seq, ROSE, own_picks(store, seq, 2)[0])
        make_ready(store, seq)
        with pytest.raises(CookoutInvalidError):
            propose(store, bank, seq, mine)
        assert view(store, bank, seq, JOSH)["swap"]["available"] is True

    def test_a_pending_recipe_blocks_propose_and_choose(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        basket = basket_of(store, seq)
        bank_it(store, seq, "a", generation=1)  # pending
        with pytest.raises(CookoutRecipePendingError):
            propose(store, bank, seq, basket[0])
        assert view(store, bank, seq, JOSH)["swap"]["available"] is False
        seq2 = ready_round(store, bank)
        round_, _ = propose(store, bank, seq2, basket_of(store, seq2)[0])
        bank_attempt = pytest.raises(CookoutBadStateError)
        with bank_attempt:
            bank_it(store, seq2, "a", generation=1)  # banking is frozen while proposed
        with pytest.raises(CookoutBadStateError):
            store.retry_cookout_recipe(seq2, "a", generation=1)
        choose(store, seq2, round_.swap_pair[0]["id"])

    def test_a_recipe_retry_during_a_proposal_leaves_no_pending_row_and_no_job(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        bank_it(store, seq, "a", generation=1)
        assert store.set_cookout_recipe_run(seq, "a", "r1", expected_generation=1)
        assert store.finish_cookout_recipe(
            seq, "a", "r1", "failed", expected_generation=1, error="boom"
        )
        propose(store, bank, seq, basket_of(store, seq)[0])
        with pytest.raises(CookoutBadStateError):
            store.retry_cookout_recipe(seq, "a", generation=1)
        assert store.cookout_pending_recipes() == []
        assert store.cookout_recipe_state(seq, "a", 1) == "failed"

    def test_unfinished_recipe_saves_are_dropped_and_banked_ones_stay_with_generation_one(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = ready_round(store, bank)
        bank_recipe(store, seq, "a")
        bank_it(store, seq, "b", generation=1)
        assert store.set_cookout_recipe_run(seq, "b", "rb", expected_generation=1)
        assert store.finish_cookout_recipe(
            seq, "b", "rb", "failed", expected_generation=1, error="x"
        )
        swap_done(store, bank, seq)
        assert raw(db_path, "SELECT generation, concept_id, state FROM cookout_recipes") == [
            (1, "a", "banked")
        ]
        assert rnd(store, seq).bank_move_ids  # the ledger outlives the dropped rows
        assert len(rnd(store, seq).bank_move_ids) == 2

    def test_generation_two_pictures_use_ordinals_three_to_five(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = ready_round(store, bank)
        _, gen = store.claim_cookout_pictures(seq, stale_before=None, now=2.0)
        store.store_cookout_pictures(
            seq, gen, {"a": ("p1", 1), "b": ("p2", 1), "c": ("p3", 1)}, None, all_done=True
        )
        swap_done(store, bank, seq)
        make_ready(store, seq, "run-2")
        _, gen2 = store.claim_cookout_pictures(seq, stale_before=None, now=3.0)
        store.store_cookout_pictures(
            seq, gen2, {"a": ("q1", 1), "b": ("q2", 1), "c": ("q3", 1)}, None, all_done=True
        )
        rows = raw(db_path, "SELECT id, ordinal FROM attachments ORDER BY ordinal")
        assert rows == [("p1", 0), ("p2", 1), ("p3", 2), ("q1", 3), ("q2", 4), ("q3", 5)]
        v = view(store, bank, seq, JOSH)
        assert [g["generation"] for g in v["generations"]] == [1]

    def test_the_earlier_dishes_view_and_the_basket_with_the_swapped_in_item(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        basket = basket_of(store, seq)
        bank_recipe(store, seq, "a")
        chosen = swap_done(store, bank, seq, basket[2])
        make_ready(store, seq, "run-2")
        v = view(store, bank, seq, JOSH)
        assert v["generation"] == 2 and v["swap"]["state"] == "done"
        assert v["swap"]["out"]["id"] == basket[2] and v["swap"]["in"]["id"] == chosen
        [old] = v["generations"]
        assert [i["id"] for i in old["basket"]] == basket
        assert [c["id"] for c in old["concepts"]] == ["a", "b", "c"]
        assert old["recipes"]["a"]["state"] == "banked" and old["recipes"]["b"]["state"] == "none"
        assert v["recipes"]["a"]["state"] == "none" and v["recipes"]["a"]["generation"] == 2
        slot = next(b for b in v["basket"] if b["id"] == chosen)
        assert slot["via"] == "swap" and slot["turn"] == 3

    def test_a_swapped_wildcard_keeps_the_basket_at_eleven(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = finish_gated(store, bank, CookoutSetup(wildcard=True))
        wildcard(store, bank, seq, lift=True)
        make_ready(store, seq)
        wild = rnd(store, seq).wildcard_snap["id"]  # type: ignore[index]
        chosen = swap_done(store, bank, seq, wild)
        basket = basket_of(store, seq)
        assert len(basket) == 11 and basket[-1] == chosen and wild not in basket
        data = store.get_cookout_round(seq)
        assert data is not None and data["wildcard_id"] is None and data["forbidden_ids"] == [wild]

    def test_a_starter_can_be_swapped_and_uses_the_banks_role(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seed = bank.items[40]  # a protein-role item
        seq = ready_round(store, bank, CookoutSetup(fridge_seed_id=seed.id))
        round_, _ = propose(store, bank, seq, seed.id)
        assert {bank.ingredient(s["id"]).role for s in round_.swap_pair} == {seed.role}  # type: ignore[union-attr,union-attr]

    def test_swapping_a_pickable_staple_forbids_it_in_generation_two(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        target = basket_of(store, seq)[0]
        swap_done(store, bank, seq, target)
        assert store.get_cookout_round(seq)["forbidden_ids"] == [target]  # type: ignore[index]

    def test_the_swap_works_without_a_runner_and_marks_the_new_dishes_unavailable(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        round_, _ = propose(store, bank, seq, basket_of(store, seq)[0])
        round_, _ = choose(store, seq, round_.swap_pair[0]["id"], runner=False)
        assert round_.concepts == "unavailable" and store.cookout_pending_concepts() == []

    def test_replays_of_propose_and_choose_are_no_ops(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        target = basket_of(store, seq)[0]
        store.propose_cookout_swap(
            anchor_seq=seq, sender=JOSH, email=None, move_id="swap-propose-001",
            ingredient_id=target, bank=bank,
        )  # fmt: skip
        rev = rnd(store, seq).rev
        again = store.propose_cookout_swap(
            anchor_seq=seq, sender=JOSH, email=None, move_id="swap-propose-001",
            ingredient_id=target, bank=bank,
        )  # fmt: skip
        assert again[1] is False and rnd(store, seq).rev == rev
        pair = rnd(store, seq).swap_pair
        assert pair is not None
        for _ in range(2):
            out = store.choose_cookout_swap(
                anchor_seq=seq, sender=ROSE, email=None, move_id="swap-choose-0001",
                ingredient_id=pair[0]["id"], runner_available=True,
            )  # fmt: skip
        assert out[1] is False and rnd(store, seq).generation == 2


class TestArchivedVotes:
    def test_a_one_sided_archived_vote_is_never_serialised_to_anyone(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        vote(store, seq, JOSH, "b")
        swap_done(store, bank, seq)
        for viewer in (JOSH, ROSE, None):
            v = view(store, bank, seq, viewer)
            assert v["generations"][0]["vote"] == {"votes": None, "match": None}
            assert v["vote"] is None  # generation 2 is not ready yet
        make_ready(store, seq, "run-2")
        for viewer in (JOSH, ROSE, None):
            v = view(store, bank, seq, viewer)
            assert v["vote"]["you"] is None and v["vote"]["partnerVoted"] is False
            wire = json.dumps(v["generations"][0]["vote"])
            assert '"b"' not in wire
        _, _ = vote(store, seq, JOSH, "c", generation=2)

    def test_a_both_voted_archive_reveals_its_result(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        vote(store, seq, JOSH, "b")
        vote(store, seq, ROSE, "b")
        swap_done(store, bank, seq)
        v = view(store, bank, seq, ROSE)["generations"][0]["vote"]
        assert v == {"votes": {"1": "b", "2": "b"}, "match": "b"}


class TestGenerationIdentity:
    def swapped(self, store: LiveChatStore, bank: FakeBank) -> int:
        seq = ready_round(store, bank)
        swap_done(store, bank, seq)
        make_ready(store, seq, "run-2")
        return seq

    def test_a_generation_one_vote_bank_and_retries_are_refused_without_a_trace(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = self.swapped(store, bank)
        before = rnd(store, seq)
        n_events = len(events(db_path, seq))
        with pytest.raises(CookoutBadStateError):
            vote(store, seq, JOSH, "a", generation=1)
        for generation in (1, None):  # None on a generation-2 round is also refused
            with pytest.raises(CookoutBadStateError):
                bank_it(store, seq, "a", generation=generation)
            with pytest.raises(CookoutBadStateError):
                store.retry_cookout_concepts(seq, generation=generation)
            with pytest.raises(CookoutBadStateError):
                store.retry_cookout_pictures(seq, generation=generation)
            with pytest.raises(CookoutBadStateError):
                store.retry_cookout_recipe(seq, "a", generation=generation)
        after = rnd(store, seq)
        assert after.rev == before.rev and after.vote1 is None
        assert len(events(db_path, seq)) == n_events
        assert store.cookout_pending_recipes() == []

    def test_generation_free_requests_still_work_on_a_generation_one_round(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        assert bank_it(store, seq, "a", generation=None)[1] is True

    def test_a_recorded_bank_replays_after_the_swap_without_a_job(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        bank_it(store, seq, "b", generation=1, mv="bank-move-b-0001")  # pending, then dropped
        assert store.set_cookout_recipe_run(seq, "b", "rb", expected_generation=1)
        store.finish_cookout_recipe(seq, "b", "rb", "failed", expected_generation=1, error="x")
        swap_done(store, bank, seq)
        make_ready(store, seq, "run-2")
        rev = rnd(store, seq).rev
        round_, changed = bank_it(store, seq, "b", generation=1, mv="bank-move-b-0001")
        assert changed is False and round_.rev == rev and store.cookout_pending_recipes() == []
        # A genuinely new generation-two Bank succeeds.
        assert bank_it(store, seq, "b", generation=2)[1] is True
        assert store.cookout_pending_recipes() == [(seq, 2, "b", None)]

    def test_a_late_generation_one_job_can_neither_claim_finish_nor_fail_generation_two(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        target = basket_of(store, seq)[0]
        round_, _ = propose(store, bank, seq, target)
        choose(store, seq, round_.swap_pair[0]["id"])
        # Generation 2's concepts are pending; the slow generation-1 spawn arrives now.
        assert not store.set_cookout_concepts_run(seq, "late", expected_generation=1)
        assert not store.finish_cookout_concepts(
            seq, None, "failed", expected_generation=1, error="late"
        )
        assert not store.finish_cookout_concepts(
            seq, None, "ready", expected_generation=1, concepts_json="{}"
        )
        assert rnd(store, seq).concepts == "pending"
        assert store.set_cookout_concepts_run(seq, "run-g2", expected_generation=2)

    def test_recipe_job_writes_name_their_own_generation(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        bank_recipe(store, seq, "a")  # generation 1 banked
        swap_done(store, bank, seq)
        make_ready(store, seq, "run-2")
        bank_it(store, seq, "a", generation=2)  # generation 2 pending, same concept id
        assert not store.set_cookout_recipe_run(seq, "a", "x", expected_generation=1)
        assert not store.finish_cookout_recipe(
            seq, "a", None, "failed", expected_generation=1, error="x"
        )
        assert store.set_cookout_recipe_run(seq, "a", "ok", expected_generation=2)
        assert store.cookout_recipe_state(seq, "a", 1) == "banked"
        assert store.cookout_recipe_state(seq, "a", 2) == "pending"

    def test_a_retry_choose_race_never_leaves_a_pending_recipe_in_an_archived_generation(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = LiveChatStore(db_path), LiveChatStore(db_path)
        seq = ready_round(a, bank)
        bank_it(a, seq, "a", generation=1)
        assert a.set_cookout_recipe_run(seq, "a", "r1", expected_generation=1)
        a.finish_cookout_recipe(seq, "a", "r1", "failed", expected_generation=1, error="x")
        round_, _ = propose(a, bank, seq, basket_of(a, seq)[0])
        pair = round_.swap_pair[0]["id"]
        results = run_concurrently(
            lambda: a.retry_cookout_recipe(seq, "a", generation=1),
            lambda: choose(b, seq, pair),
        )
        assert any(not isinstance(r, Exception) for r in results)
        if rnd(a, seq).generation == 2:  # the choose won: nothing pending in generation 1
            assert all(s != (seq, 1, "a", None) for s in a.cookout_pending_recipes())
            assert a.cookout_recipe_state(seq, "a", 1) is None


# -- We cooked it! (T4) ----------------------------------------------------------------------------


def cook(store: LiveChatStore, seq: int, generation: int = 1, concept: str = "a", **kw: Any) -> Any:
    return store.mark_cookout_cooked(
        anchor_seq=seq, sender=kw.pop("who", JOSH), email=None, generation=generation,
        concept_id=concept, cooked=kw.pop("cooked", True),
    )  # fmt: skip


def rate(store: LiveChatStore, seq: int, who: str, rating: int | None, generation: int = 1) -> Any:
    return store.rate_cookout_recipe(
        anchor_seq=seq, sender=who, email=None, generation=generation, concept_id="a",
        rating=rating,
    )  # fmt: skip


def link(
    store: LiveChatStore,
    seq: int,
    message_seq: int | None,
    attachment_id: str | None,
    generation: int = 1,
) -> Any:
    return store.link_cookout_photo(
        anchor_seq=seq, sender=JOSH, email=None, generation=generation, concept_id="a",
        message_seq=message_seq, attachment_id=attachment_id,
    )  # fmt: skip


class TestWeCookedIt:
    def banked(self, store: LiveChatStore, bank: FakeBank) -> int:
        seq = ready_round(store, bank)
        bank_recipe(store, seq, "a")
        return seq

    def test_marking_cooked_is_idempotent_and_unmarking_clears_everything(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = self.banked(store, bank)
        assert cook(store, seq)[1] is True and cook(store, seq)[1] is False
        rate(store, seq, JOSH, 4)
        rate(store, seq, ROSE, 5)
        msg = photo_message(store, db_path, seq, "att-t4-1")
        link(store, seq, msg, "att-t4-1")
        slot = view(store, bank, seq, JOSH)["recipes"]["a"]["cooked"]
        assert slot["cookedBy"] == JOSH and slot["ratings"] == {"1": 4, "2": 5}
        assert slot["photo"]["attachmentId"] == "att-t4-1" and slot["photoMessageSeq"] == msg
        cooked_msg = next(m for m in store.list_messages(before=None, limit=9)[0] if m.seq == seq)
        assert cooked_msg.cookout is not None and cooked_msg.cookout.cooked_count == 1
        assert cook(store, seq, cooked=False)[1] is True
        assert cook(store, seq, cooked=False)[1] is False
        assert raw(
            db_path,
            "SELECT cooked_at, cooked_by, rating1, rating2, photo_message_seq, "
            "photo_attachment_id FROM cookout_recipes",
        ) == [(None,) * 6]

    def test_ratings_are_per_slot_need_cooked_and_are_validated(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.banked(store, bank)
        with pytest.raises(CookoutBadStateError):
            rate(store, seq, JOSH, 3)  # not cooked yet
        cook(store, seq)
        rate(store, seq, JOSH, 3)
        assert rate(store, seq, JOSH, 3)[1] is False
        rate(store, seq, ROSE, 5)
        slot = view(store, bank, seq, ROSE)["recipes"]["a"]["cooked"]
        assert slot["ratings"] == {"1": 3, "2": 5}
        rate(store, seq, JOSH, None)
        assert view(store, bank, seq, ROSE)["recipes"]["a"]["cooked"]["ratings"]["1"] is None
        for bad in (0, 6, -1):
            with pytest.raises(CookoutInvalidError):
                rate(store, seq, JOSH, bad)
        with pytest.raises(CookoutNotPlayerError):
            rate(store, seq, "Nobody", 3)

    def test_an_unbanked_or_unknown_recipe_is_bad_state(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = self.banked(store, bank)
        with pytest.raises(CookoutBadStateError):
            cook(store, seq, concept="b")
        with pytest.raises(CookoutBadStateError):
            cook(store, seq, generation=2)
        bank_it(store, seq, "c", generation=1)  # pending, not banked
        with pytest.raises(CookoutBadStateError):
            cook(store, seq, concept="c")

    def test_the_chooser_offers_one_entry_per_message_with_the_ready_photo(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = self.banked(store, bank)
        two = photo_message(store, db_path, seq, "att-two-a", extra=("att-two-b",))
        # failed-first / ready-second: the ready one is offered
        failed_first = photo_message(store, db_path, seq, "att-ff-a", extra=("att-ff-b",))
        conn = sqlite3.connect(str(db_path))
        conn.execute("UPDATE attachments SET status = 'failed' WHERE id = 'att-ff-a'")
        conn.commit()
        conn.close()
        pending = photo_message(store, db_path, seq, "att-pend", ready=False)
        photo_message(store, db_path, seq, "att-once", view_once=True)
        listed = store.cookout_round_photos(anchor_seq=seq)
        by_message = {m.seq: a.id for m, a in listed}
        assert by_message == {two: "att-two-a", failed_first: "att-ff-b"}
        assert pending not in by_message
        assert [m.seq for m, _ in listed] == sorted(by_message, reverse=True)

    def test_the_linked_attachment_is_exactly_the_one_named_even_after_readiness_changes(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = self.banked(store, bank)
        cook(store, seq)
        msg = photo_message(store, db_path, seq, "att-race-a", extra=("att-race-b",))
        conn = sqlite3.connect(str(db_path))
        conn.execute("UPDATE attachments SET status = 'processing' WHERE id = 'att-race-a'")
        conn.commit()
        [(_, offered)] = store.cookout_round_photos(anchor_seq=seq)
        assert offered.id == "att-race-b"
        conn.execute(  # the earlier photo finishes processing between the GET and the POST
            "UPDATE attachments SET status = 'ready', renditions = '[\"thumb\",\"full\"]' "
            "WHERE id = 'att-race-a'"
        )
        conn.commit()
        conn.close()
        link(store, seq, msg, offered.id)
        assert raw(db_path, "SELECT photo_attachment_id FROM cookout_recipes") == [("att-race-b",)]

    def test_stale_and_invalid_links_are_bad_state_and_link_nothing(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = self.banked(store, bank)
        cook(store, seq)
        good = photo_message(store, db_path, seq, "att-good")
        other_msg = photo_message(store, db_path, seq, "att-other")
        not_ready = photo_message(store, db_path, seq, "att-nr", ready=False)
        once = photo_message(store, db_path, seq, "att-vo", view_once=True)
        other_round = ready_round(store, bank)
        foreign = photo_message(store, db_path, other_round, "att-foreign")
        for message, att in (
            (good, "att-other"),  # wrong message
            (good, "att-missing"),
            (not_ready, "att-nr"),
            (once, "att-vo"),
            (foreign, "att-foreign"),  # another round's chat
            (99999, "att-good"),
        ):
            with pytest.raises(CookoutBadStateError):
                link(store, seq, message, att)
        assert raw(db_path, "SELECT photo_message_seq FROM cookout_recipes") == [(None,)]
        link(store, seq, good, "att-good")
        assert link(store, seq, good, "att-good")[1] is False
        with pytest.raises(CookoutInvalidError):
            link(store, seq, good, None)
        with pytest.raises(CookoutInvalidError):
            link(store, seq, None, "att-good")
        assert link(store, seq, None, None)[1] is True  # unlink
        assert link(store, seq, None, None)[1] is False
        _ = other_msg

    def test_deleting_the_linked_message_unlinks_and_bumps_the_rev(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = self.banked(store, bank)
        cook(store, seq)
        msg = photo_message(store, db_path, seq, "att-del")
        link(store, seq, msg, "att-del")
        rev = rnd(store, seq).rev
        store.delete_message(seq=msg, now=70.0)
        assert raw(
            db_path, "SELECT photo_message_seq, photo_attachment_id FROM cookout_recipes"
        ) == [(None, None)]
        assert rnd(store, seq).rev == rev + 1
        assert events(db_path, seq)[-1] == "message_updated"
        assert view(store, bank, seq, JOSH)["recipes"]["a"]["cooked"]["photo"] is None

    def test_t4_works_on_generation_one_after_a_swap_and_leaves_generation_two_alone(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = self.banked(store, bank)
        swap_done(store, bank, seq)
        make_ready(store, seq, "run-2")
        bank_recipe(store, seq, "a", generation=2)
        gen2_before = raw(db_path, "SELECT * FROM cookout_recipes WHERE generation = 2")
        rev = rnd(store, seq).rev
        cook(store, seq, 1)
        rate(store, seq, JOSH, 5, generation=1)
        msg = photo_message(store, db_path, seq, "att-g1")
        link(store, seq, msg, "att-g1", generation=1)
        cook(store, seq, 1, cooked=False)
        assert raw(db_path, "SELECT * FROM cookout_recipes WHERE generation = 2") == gen2_before
        assert rnd(store, seq).rev == rev + 4  # one event per real change
        v = view(store, bank, seq, JOSH)
        assert v["recipes"]["a"]["cooked"] is None
        assert v["generations"][0]["recipes"]["a"]["state"] == "banked"

    def test_the_recipe_book_lists_both_generations_with_their_own_dishes(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = self.banked(store, bank)
        cook(store, seq)
        rate(store, seq, JOSH, 4)
        swap_done(store, bank, seq)
        make_ready(store, seq, "run-2")
        bank_recipe(store, seq, "a", generation=2)
        book = store.list_cookout_bank()
        assert [(b.recipe.generation, b.recipe.concept_id) for b in book] == [(2, "a"), (1, "a")]
        old = next(b for b in book if b.recipe.generation == 1)
        assert old.generation_row is not None and old.generation_row.generation == 1
        assert next(b for b in book if b.recipe.generation == 2).generation_row is None


# -- Blind-mode redaction -----------------------------------------------------------------------


class TestBlindRedaction:
    def test_chaos_pair_veto_and_flags_never_reach_the_partner(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank, blind=True)
        join(store, bank, seq)
        chaos(store, bank, seq, JOSH)
        table = [s["id"] for s in live_of(store, seq).row.offers[0]]
        mine = view(store, bank, seq, JOSH)
        theirs = view(store, bank, seq, ROSE)
        assert mine["current"]["chaosPair"] is True and mine["current"]["canChaos"] is False
        assert mine["you"]["chaosUsed"] is True and mine["current"]["canLucky"] is True
        for key in ("chaosPair", "vetoed", "canChaos", "canLucky", "canVeto", "options"):
            assert theirs["current"][key] is None, key
        assert theirs["players"][0]["chaosUsed"] is None and theirs["history"] == []
        assert not any(i in json.dumps(theirs) for i in table)
        pick(store, bank, seq, JOSH)
        assert view(store, bank, seq, ROSE)["players"][0]["picks"] is None
        assert view(store, bank, seq, ROSE)["players"][0]["chaosUsed"] is None

    def test_everything_is_revealed_once_finished_but_history_stays_per_player(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank, blind=True)
        join(store, bank, seq)
        chaos(store, bank, seq, JOSH)
        finish_picks(store, bank, seq)
        v = view(store, bank, seq, ROSE)
        assert v["players"][0]["chaosUsed"] is True and len(v["players"][0]["picks"]) == 5
        assert [h["player"] for h in v["history"]] == [2] * 5
        assert v["players"][0]["picks"][0]["via"] == "chaos"

    def test_a_blind_abandon_reveals_nothing_new(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank, blind=True, setup=CookoutSetup(stars=True))
        join(store, bank, seq)
        chaos(store, bank, seq, JOSH)
        pick(store, bank, seq, JOSH)
        star(store, seq, JOSH, own_picks(store, seq, 1)[0])
        store.abandon_cookout(anchor_seq=seq, sender=JOSH, email=None)
        v = view(store, bank, seq, ROSE)
        assert v["basket"] is None and v["players"][0]["picks"] is None
        assert v["players"][0]["chaosUsed"] is None and v["stars"]["partner"] is None

    def test_dinner_votes_stay_hidden_in_open_mode_too(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        vote(store, seq, ROSE, "c")
        v = view(store, bank, seq, JOSH)["vote"]
        assert v["you"] is None and v["votes"] is None and v["partnerVoted"] is True

    def test_starters_are_public_in_blind_mode(self, store: LiveChatStore, bank: FakeBank) -> None:
        seed = bank.items[0]
        seq = open_round(store, bank, blind=True, setup=CookoutSetup(fridge_seed_id=seed.id))
        v = view(store, bank, seq, ROSE)
        assert [s["id"] for s in v["starters"]] == [seed.id]
        assert v["players"][0]["picks"] is None and v["history"] == []


# -- races ---------------------------------------------------------------------------------------


class TestTwoConnectionRaces:
    def two(self, db_path: Path) -> tuple[LiveChatStore, LiveChatStore]:
        return LiveChatStore(db_path), LiveChatStore(db_path)

    def test_veto_versus_pick_exactly_one_outcome_per_option(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = self.two(db_path)
        seq = open_round(a, bank)
        join(a, bank, seq)
        swept = live_of(a, seq).row.offers[0][0]["id"]
        results = run_concurrently(
            lambda: veto(b, bank, seq, ROSE, ingredient=swept),
            lambda: pick(a, bank, seq, JOSH, ingredient=swept),
        )
        outcomes = [isinstance(r, Exception) for r in results]
        assert outcomes.count(False) == 1  # a veto before the pick sweeps it; else veto is stale
        if isinstance(results[1], Exception):
            assert isinstance(results[1], CookoutBadStateError)

    def test_veto_versus_lucky_dip_the_dip_goes_stale_or_wins(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = self.two(db_path)
        seq = open_round(a, bank)
        join(a, bank, seq)
        ids = tuple(s["id"] for s in live_of(a, seq).row.offers[0])
        results = run_concurrently(
            lambda: veto(b, bank, seq, ROSE, ingredient=ids[0]),
            lambda: lucky(a, bank, seq, JOSH, option_ids=ids),
        )
        assert sum(isinstance(r, Exception) for r in results) <= 1
        failed = [r for r in results if isinstance(r, Exception)]
        assert all(isinstance(f, CookoutBadStateError) for f in failed)

    def test_chaos_versus_veto_both_apply_or_one_goes_stale(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = self.two(db_path)
        seq = open_round(a, bank)
        join(a, bank, seq)
        ids = tuple(s["id"] for s in live_of(a, seq).row.offers[0])
        results = run_concurrently(
            lambda: chaos(a, bank, seq, JOSH, option_ids=ids),
            lambda: veto(b, bank, seq, ROSE, ingredient=ids[0]),
        )
        assert all(
            not isinstance(r, Exception) or isinstance(r, CookoutBadStateError) for r in results
        )
        row = data_of(a, seq).turns[0]
        assert len(row.offers) == 1 and len(row.replaced) in (1, 2, 3)

    def test_lucky_replay_versus_pick_one_committed_choice(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = self.two(db_path)
        seq = open_round(a, bank)
        ids = tuple(s["id"] for s in live_of(a, seq).row.offers[0])
        results = run_concurrently(
            lambda: lucky(a, bank, seq, JOSH, mv="same-move-000001", option_ids=ids),
            lambda: lucky(b, bank, seq, JOSH, mv="same-move-000001", option_ids=ids),
        )
        assert sorted(isinstance(r, tuple) and r[1] for r in results) == [False, True]
        assert sum(1 for t in data_of(a, seq).turns if t.choice_id) == 1

    def test_a_star_racing_the_tenth_pick_starts_exactly_one_chef_job(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = self.two(db_path)
        seq = open_round(a, bank, setup=CookoutSetup(stars=True))
        join(a, bank, seq)
        for _ in range(9):
            pick(a, bank, seq, pl(live_of(a, seq).player))
        star(a, seq, JOSH, own_picks(a, seq, 1)[0])
        star(a, seq, ROSE, own_picks(a, seq, 2)[0])  # the gate is already clear
        results = run_concurrently(
            lambda: pick(a, bank, seq, ROSE),
            lambda: star(b, seq, ROSE, own_picks(b, seq, 2)[0]),
        )
        assert not any(
            isinstance(r, Exception) and not isinstance(r, CookoutBadStateError) for r in results
        )
        assert a.cookout_pending_concepts() == [(seq, 1, None)]

    def test_wildcard_lift_versus_decline_one_answer_wins(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = self.two(db_path)
        seq = finish_gated(a, bank, CookoutSetup(wildcard=True))
        results = run_concurrently(
            lambda: wildcard(a, bank, seq, lift=True),
            lambda: wildcard(b, bank, seq, lift=False),
        )
        assert sum(isinstance(r, CookoutBadStateError) for r in results) == 1
        assert rnd(a, seq).wildcard in ("lifted", "declined")
        assert a.cookout_pending_concepts() == [(seq, 1, None)]

    def test_the_two_votes_reveal_together_whatever_the_order(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = self.two(db_path)
        seq = ready_round(a, bank)
        run_concurrently(lambda: vote(a, seq, JOSH, "a"), lambda: vote(b, seq, ROSE, "b"))
        r = rnd(a, seq)
        assert (r.vote1, r.vote2) == ("a", "b")

    def test_swap_choose_versus_cancel_one_wins(self, db_path: Path, bank: FakeBank) -> None:
        a, b = self.two(db_path)
        seq = ready_round(a, bank)
        round_, _ = propose(a, bank, seq, basket_of(a, seq)[0])
        pair = round_.swap_pair[0]["id"]
        results = run_concurrently(
            lambda: choose(b, seq, pair),
            lambda: a.cancel_cookout_swap(anchor_seq=seq, sender=JOSH, email=None),
        )
        final = rnd(a, seq)
        assert final.swap_state in ("done", "none")
        if final.swap_state == "done":
            assert isinstance(results[1], CookoutBadStateError)
            assert final.generation == 2
        else:
            assert isinstance(results[0], CookoutBadStateError) and final.generation == 1

    def test_swap_choose_versus_bank_never_banks_an_archived_dish(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = self.two(db_path)
        seq = ready_round(a, bank)
        round_, _ = propose(a, bank, seq, basket_of(a, seq)[0])
        pair = round_.swap_pair[0]["id"]
        results = run_concurrently(
            lambda: choose(b, seq, pair), lambda: bank_it(a, seq, "a", generation=1)
        )
        final = rnd(a, seq)
        if final.generation == 2:
            assert a.cookout_pending_recipes() in ([], [(seq, 1, "a", None)])
            # the bank either landed before the choose (then choose is refused) or lost
            assert not (a.cookout_pending_recipes() and isinstance(results[0], tuple))
        else:
            assert isinstance(results[0], Exception)

    def test_swap_choose_versus_a_late_picture_store_is_fenced(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = self.two(db_path)
        seq = ready_round(a, bank)
        _, gen = a.claim_cookout_pictures(seq, stale_before=None, now=2.0)
        round_, _ = propose(a, bank, seq, basket_of(a, seq)[0])
        pair = round_.swap_pair[0]["id"]
        choose(b, seq, pair)
        assert a.store_cookout_pictures(
            seq, gen, {"a": ("late-1", 1), "b": ("late-2", 1), "c": ("late-3", 1)}, None,
            all_done=True,
        ) is False  # fmt: skip
        assert rnd(a, seq).pictures == {}

    def test_cooked_versus_unmark_ends_in_a_consistent_state(
        self, db_path: Path, bank: FakeBank
    ) -> None:
        a, b = self.two(db_path)
        seq = ready_round(a, bank)
        bank_recipe(a, seq, "a")
        cook(a, seq)
        run_concurrently(
            lambda: cook(a, seq, who=JOSH, cooked=False), lambda: rate(b, seq, ROSE, 5)
        )
        cooked_at, rating2 = raw(db_path, "SELECT cooked_at, rating2 FROM cookout_recipes")[0]
        assert (cooked_at is None) == (rating2 is None)


# -- erasure -------------------------------------------------------------------------------------


class TestErasure:
    def test_wipe_clears_the_generations_table_too(
        self, store: LiveChatStore, bank: FakeBank, db_path: Path
    ) -> None:
        seq = ready_round(store, bank)
        swap_done(store, bank, seq)
        assert raw(db_path, "SELECT COUNT(*) FROM cookout_generations") == [(1,)]
        store.wipe(now=99.0)
        for table in ("cookout_rounds", "cookout_turns", "cookout_recipes", "cookout_generations"):
            assert raw(db_path, f"SELECT COUNT(*) FROM {table}") == [(0,)], table

    def test_the_card_summary_carries_only_counts_and_flags(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        from wixy_server.livechat.models import message_json

        seq = ready_round(store, bank)
        vote(store, seq, JOSH, "a")
        swap_done(store, bank, seq)
        msg = next(m for m in store.list_messages(before=None, limit=5)[0] if m.seq == seq)
        wire: Any = message_json(msg, _Signer())["cookout"]
        assert wire is not None
        assert wire["generation"] == 2 and wire["swap"] == "done" and wire["waiting"] == []
        blob = json.dumps(wire)
        assert "Zed" not in blob and "base-" not in blob and '"a"' not in blob
        assert set(wire) == {
            "state", "blind", "pickedCount", "concepts", "bankedCount", "rev", "generation",
            "waiting", "swap", "dinnerDecided", "cookedCount",
        }  # fmt: skip

    def test_attachment_results_import_is_used(self) -> None:
        assert AttachmentResult is not None


class TestSkipNamesThePair:
    def test_a_skip_naming_the_pre_veto_or_pre_chaos_pair_is_stale_and_draws_nothing(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        join(store, bank, seq)
        old = tuple(s["id"] for s in live_of(store, seq).row.offers[0])
        veto(store, bank, seq, ROSE)
        calls = len(bank.calls)
        rev = rnd(store, seq).rev

        def do_skip(ids: tuple[str, str] | None) -> Any:
            return store.skip_cookout(
                anchor_seq=seq, sender=JOSH, email=None, move_id=move_id(), turn=1, offer=0,
                bank=bank, option_ids=ids,
            )  # fmt: skip

        with pytest.raises(CookoutBadStateError):
            do_skip(old)
        assert len(bank.calls) == calls and rnd(store, seq).rev == rev
        chaos(store, bank, seq, JOSH)
        with pytest.raises(CookoutBadStateError):
            do_skip(old)
        new = tuple(s["id"] for s in live_of(store, seq).row.offers[0])
        assert do_skip((new[1], new[0]))[1] is True  # order-free
        assert len(live_of(store, seq).row.offers) == 2


class TestFollowUpRulings:
    def test_l1_the_swept_banner_goes_when_chaos_replaces_the_table_afterwards(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        join(store, bank, seq)
        veto(store, bank, seq, ROSE)
        assert view(store, bank, seq, JOSH)["current"]["vetoed"] is not None
        chaos(store, bank, seq, JOSH)
        assert view(store, bank, seq, JOSH)["current"]["vetoed"] is None
        assert view(store, bank, seq, ROSE)["current"]["vetoed"] is None

    def test_l1_chaos_then_veto_still_shows_the_banner(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = open_round(store, bank)
        join(store, bank, seq)
        chaos(store, bank, seq, JOSH)
        veto(store, bank, seq, ROSE)
        assert view(store, bank, seq, JOSH)["current"]["vetoed"] is not None

    def test_l2_banking_a_pending_or_banked_dish_is_idempotent_while_a_swap_is_proposed(
        self, store: LiveChatStore, bank: FakeBank
    ) -> None:
        seq = ready_round(store, bank)
        bank_it(store, seq, "a", generation=1)  # pending
        bank_recipe(store, seq, "b")  # banked
        with pytest.raises(CookoutRecipePendingError):
            propose(store, bank, seq, basket_of(store, seq)[0])  # pending blocks the proposal
        assert store.set_cookout_recipe_run(seq, "a", "ra", expected_generation=1)
        assert store.finish_cookout_recipe(
            seq, "a", "ra", "banked", expected_generation=1, recipe_json=RECIPE
        )
        propose(store, bank, seq, basket_of(store, seq)[0])
        rev = rnd(store, seq).rev
        for concept in ("a", "b"):
            assert bank_it(store, seq, concept, generation=1)[1] is False
        assert rnd(store, seq).rev == rev
        with pytest.raises(CookoutBadStateError):  # a genuinely new dish stays refused
            bank_it(store, seq, "c", generation=1)
