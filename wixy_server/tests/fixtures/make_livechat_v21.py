"""Generate `livechat_v21.db`: a REAL schema-v21 database written by the DEPLOYED v21 code.

Run it from a checkout of a pre-modes commit (where `_LATEST_SCHEMA_VERSION == 21`), e.g.

    git archive dc66d2ce wixy_server builder | tar -x -C /some/empty/dir
    cd /some/empty/dir && python make_livechat_v21.py <out.db>

It plays Cookout rounds through the v21 store API in every state the migration test needs:
open and blind picking, a round waiting for Player 2, finished with ready dishes and a banked
recipe, a rescue-swapped second generation, abandoned, and finished with the chef unavailable.
The seeded RNG keeps the file reproducible. Never run against a v22 tree (it asserts v21).
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path
from typing import Any

from wixy_server.livechat import store as store_module
from wixy_server.livechat.cookout_bank import load_cookout_bank_or_empty
from wixy_server.livechat.cookout_game import current_turn, slot_of
from wixy_server.livechat.reactions import reactor_key
from wixy_server.livechat.store import LiveChatStore

assert store_module._LATEST_SCHEMA_VERSION == 21, "run this against the v21 tree"

P1, P2 = "Rose", "Josh"
BANK = load_cookout_bank_or_empty()
RNG = random.Random(21)
_MOVE = [0]
_CLIENT = [0]


def move_id() -> str:
    _MOVE[0] += 1
    return f"fixture-move-{_MOVE[0]:04d}"


def new_round(store: LiveChatStore, *, blind: bool) -> int:
    _CLIENT[0] += 1
    message, _ = store.create_cookout_round(
        client_id=f"fixture-client-{_CLIENT[0]:04d}",
        sender=P1,
        device_id="fixture-device",
        by_email=None,
        blind=blind,
        bank=BANK,
        rng=RNG,
    )
    return message.seq


def play(store: LiveChatStore, seq: int, picks: int) -> None:
    """Make `picks` more picks, always the first option; Player 2 must already have joined."""
    for _ in range(picks):
        data = store.cookout_view_data(anchor_seq=seq)
        assert data is not None
        cur = current_turn(data.round, data.turns)
        assert cur is not None and cur.row is not None
        name = P1 if cur.player == 1 else P2
        assert slot_of(data.round, reactor_key(name), None) == cur.player
        store.pick_cookout(
            anchor_seq=seq,
            sender=name,
            email=None,
            move_id=move_id(),
            turn=cur.turn,
            offer=len(cur.row.offers) - 1,
            ingredient_id=cur.row.offers[-1][0]["id"],
            bank=BANK,
            runner_available=True,
            rng=RNG,
        )


def finish_round(store: LiveChatStore, seq: int) -> None:
    store.join_cookout(anchor_seq=seq, sender=P2, email=None, bank=BANK, rng=RNG)
    play(store, seq, 10)


def concepts_for(store: LiveChatStore, seq: int) -> str:
    row = store.get_cookout_round(seq)
    assert row is not None
    ids = list(row["basket_ids"])
    return json.dumps(
        {
            "concepts": [
                {
                    "id": cid,
                    "title": f"Fixture dish {cid.upper()}",
                    "vibe": "cosy",
                    "dishType": "bake",
                    "technique": "bake",
                    "description": f"A fixture dish using everything ({cid}).",
                    "pickedIngredientIds": ids,
                    "stapleIds": [],
                    "omitted": [],
                }
                for cid in ("a", "b", "c")
            ]
        }
    )


def make_ready(store: LiveChatStore, seq: int) -> None:
    row = store.get_cookout_round(seq)
    assert row is not None
    assert row["concepts"] == "pending", row["concepts"]
    store.set_cookout_concepts_run(seq, "run-fixture", expected_generation=row["generation"])
    assert store.finish_cookout_concepts(
        seq,
        "run-fixture",
        "ready",
        expected_generation=row["generation"],
        concepts_json=concepts_for(store, seq),
    )


def main(out: Path) -> None:
    if out.exists():
        out.unlink()
    store = LiveChatStore(out)

    # 1. finished, concepts unavailable (no chef on this server)
    first = new_round(store, blind=False)
    store.join_cookout(anchor_seq=first, sender=P2, email=None, bank=BANK, rng=RNG)
    for _ in range(10):
        play(store, first, 1)
    # (a chef was available above, so concepts are pending; leave this one `failed`)
    row = store.get_cookout_round(first)
    assert row is not None
    store.set_cookout_concepts_run(first, "run-failed", expected_generation=row["generation"])
    store.finish_cookout_concepts(
        first, "run-failed", "failed", expected_generation=row["generation"], error="no chef"
    )

    # 2. finished, ready dishes, one banked recipe, then a rescue swap (generation 2)
    ready = new_round(store, blind=True)
    finish_round(store, ready)
    make_ready(store, ready)
    row = store.get_cookout_round(ready)
    assert row is not None
    store.bank_cookout_concept(
        anchor_seq=ready,
        sender=P1,
        email=None,
        concept_id="a",
        move_id=move_id(),
        generation=1,
        runner_available=True,
    )
    store.set_cookout_recipe_run(ready, "a", "run-recipe", expected_generation=1)
    store.finish_cookout_recipe(
        ready,
        "a",
        "run-recipe",
        "banked",
        expected_generation=1,
        recipe_json=json.dumps(
            {
                "serves": 2,
                "prepMinutes": 10,
                "cookMinutes": 25,
                "ingredients": [{"id": i, "amount": "some"} for i in row["basket_ids"][:3]],
                "steps": ["Mix it.", "Bake it."],
            }
        ),
    )
    store.propose_cookout_swap(
        anchor_seq=ready,
        sender=P1,
        email=None,
        move_id=move_id(),
        ingredient_id=row["basket_ids"][0],
        bank=BANK,
        rng=RNG,
    )
    data = store.cookout_view_data(anchor_seq=ready)
    assert data is not None and data.round.swap_pair is not None
    store.choose_cookout_swap(
        anchor_seq=ready,
        sender=P2,
        email=None,
        move_id=move_id(),
        ingredient_id=data.round.swap_pair[0]["id"],
        runner_available=True,
    )

    # 3. abandoned (a picking round replaced by the next one)
    abandoned = new_round(store, blind=False)
    store.join_cookout(anchor_seq=abandoned, sender=P2, email=None, bank=BANK, rng=RNG)
    play(store, abandoned, 3)
    store.abandon_cookout(anchor_seq=abandoned, sender=P1, email=None)

    # 4. blind, waiting for Player 2 after the first pick
    waiting = new_round(store, blind=True)
    play_one = store.cookout_view_data(anchor_seq=waiting)
    assert play_one is not None
    play(store, waiting, 1)

    # 5. (last) an open round in progress is not possible while 4 is picking: 4 IS the picking one.
    print(f"rounds: failed={first} swapped={ready} abandoned={abandoned} waiting={waiting}")


def golden(db: Path, out: Path) -> None:
    """Write every round's view JSON (as each seat and as a stranger) read by the PRE-modes code,
    the migration test's golden. Run against the pre-modes tree (e.g. dc66d2ce), on a COPY of the
    database."""
    from wixy_server.livechat.cookout_game import cookout_view_json

    store = LiveChatStore(db)
    result: dict[str, object] = {}
    for seq in range(1, 5):
        data = store.cookout_view_data(anchor_seq=seq)
        assert data is not None
        for viewer in (P1, P2, None):
            result[f"{seq}:{viewer}"] = cookout_view_json(
                data.round,
                data.turns,
                data.recipes,
                data.attachments,
                BANK,
                viewer_key=reactor_key(viewer) if viewer else None,
                viewer_email=None,
                signer=None,
                generations=data.generations,
                all_recipes=data.all_recipes,
                photo_attachments=data.photo_attachments,
                encore_title=data.encore_title,
            )
    out.write_text(json.dumps(result, indent=1, sort_keys=True), encoding="utf-8", newline=chr(10))


def classic_golden(out: Path) -> None:
    """A seeded Classic round played through the PRE-modes code: the role schedule, every pair
    dealt (skips, a chaos shelf, a veto, a lucky dip included) and the picks. The modes release
    must deal exactly the same (spec 09c §1.3, §8.2 "Classic regression")."""
    import tempfile

    rng = random.Random(909)
    with tempfile.TemporaryDirectory() as tmp:
        store = LiveChatStore(Path(tmp) / "g.db")
        message, _ = store.create_cookout_round(
            client_id="golden-client-01",
            sender=P1,
            device_id="golden-device",
            by_email=None,
            blind=False,
            bank=BANK,
            rng=rng,
        )
        seq = message.seq
        store.join_cookout(anchor_seq=seq, sender=P2, email=None, bank=BANK, rng=rng)
        for step in range(10):
            data = store.cookout_view_data(anchor_seq=seq)
            assert data is not None
            cur = current_turn(data.round, data.turns)
            assert cur is not None and cur.row is not None
            name = P1 if cur.player == 1 else P2
            other = P2 if cur.player == 1 else P1
            row = cur.row
            common: dict[str, Any] = dict(anchor_seq=seq, sender=name, email=None, turn=cur.turn)
            if step == 1:
                store.skip_cookout(**common, move_id=move_id(), offer=0, bank=BANK, rng=rng)
                data = store.cookout_view_data(anchor_seq=seq)
                assert data is not None
                row = data.turns[-1]
            if step == 2:
                pair = row.offers[-1]
                store.chaos_cookout(
                    **common,
                    move_id=move_id(),
                    offer=len(row.offers) - 1,
                    option_ids=(pair[0]["id"], pair[1]["id"]),
                    bank=BANK,
                    rng=rng,
                )
                data = store.cookout_view_data(anchor_seq=seq)
                assert data is not None
                row = data.turns[-1]
            if step == 3:
                store.veto_cookout(
                    anchor_seq=seq,
                    sender=other,
                    email=None,
                    move_id=move_id(),
                    turn=cur.turn,
                    offer=len(row.offers) - 1,
                    ingredient_id=row.offers[-1][0]["id"],
                    bank=BANK,
                    rng=rng,
                )
                data = store.cookout_view_data(anchor_seq=seq)
                assert data is not None
                row = data.turns[-1]
            if step == 4:
                pair = row.offers[-1]
                store.lucky_cookout(
                    **common,
                    move_id=move_id(),
                    offer=len(row.offers) - 1,
                    option_ids=(pair[0]["id"], pair[1]["id"]),
                    bank=BANK,
                    runner_available=True,
                    rng=rng,
                )
                continue
            store.pick_cookout(
                **common,
                move_id=move_id(),
                offer=len(row.offers) - 1,
                ingredient_id=row.offers[-1][0]["id"],
                bank=BANK,
                runner_available=True,
                rng=rng,
            )
        data = store.cookout_view_data(anchor_seq=seq)
        assert data is not None
        result = {
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
    out.write_text(json.dumps(result, indent=1), encoding="utf-8", newline=chr(10))


if __name__ == "__main__":
    if sys.argv[1] == "--classic-golden":
        classic_golden(Path(sys.argv[2]))
    elif sys.argv[1] == "--golden":
        golden(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main(Path(sys.argv[1]))
