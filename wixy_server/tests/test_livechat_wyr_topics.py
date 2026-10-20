# ruff: noqa: F811  (pytest fixtures re-used from other test modules are rebound as parameters)
"""Would-you-rather TOPICS (workspace 00052): the stored choice (schema v19), the bank filter,
`GET/PUT /wyr/topics`, rounds drawn only from the chosen topics, and the picture pool painting
ahead for them."""

from __future__ import annotations

import random
import sqlite3
from pathlib import Path

import pytest

from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import _LATEST_SCHEMA_VERSION, LiveChatStore
from wixy_server.livechat.wyr_game import PoolOutcome, WyrDemand, pick_round, pool_step
from wixy_server.livechat.wyr_pool import WyrPool
from wixy_server.livechat.wyr_questions import (
    BANK_PATH,
    WyrQuestion,
    load_questions,
    questions_in_topics,
    topic_label,
    topic_summary,
)
from wixy_server.storage import ProjectPaths
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    _dev_no_auth,
    fake_cmd_state,
    origin_repo,
    pin_verifier,
    storage_root,
    wixy_repo_root,
)
from wixy_server.tests.test_livechat_wyr import (  # noqa: F401 - fixtures/helpers re-exported
    BASE,
    FakeGenerator,
    _client,
    _create,
    _png,
    _pool_off_by_default,
)

ROOMY = 100 * 1024 * 1024 * 1024


@pytest.fixture
def questions() -> tuple[WyrQuestion, ...]:
    return load_questions(BANK_PATH)


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    p = ProjectPaths(slug="test", root=tmp_path / "storage" / "projects" / "test")
    p.server_dir.mkdir(parents=True, exist_ok=True)
    return p


@pytest.fixture
def store(paths: ProjectPaths) -> LiveChatStore:
    return LiveChatStore(paths.server_db)


FOOD = ["food-meals", "food-sweet"]


class TestBank:
    def test_every_category_has_a_label_and_a_count(
        self, questions: tuple[WyrQuestion, ...]
    ) -> None:
        summary = topic_summary(questions)
        assert sum(count for _id, _label, count in summary) == len(questions)
        assert {category for category, _l, _c in summary} == {q.category for q in questions}
        assert all(label and label != category for category, label, _c in summary)
        assert topic_label("brand-new-thing") == "Brand new thing"

    def test_filter_keeps_only_the_chosen_topics_and_never_empties_the_game(
        self, questions: tuple[WyrQuestion, ...]
    ) -> None:
        food = questions_in_topics(questions, frozenset(FOOD))
        assert food and {q.category for q in food} == set(FOOD)
        assert questions_in_topics(questions, None) == questions
        assert questions_in_topics(questions, frozenset({"retired-topic"})) == questions


class TestStore:
    def test_choice_round_trips_and_none_means_every_topic(self, store: LiveChatStore) -> None:
        assert store.wyr_selected_topics() is None
        store.set_wyr_topics(FOOD)
        assert store.wyr_selected_topics() == frozenset(FOOD)
        store.set_wyr_topics(["food-meals", "food-meals"])
        assert store.wyr_selected_topics() == frozenset({"food-meals"})
        store.set_wyr_topics(None)
        assert store.wyr_selected_topics() is None

    def test_a_v18_database_gains_the_table(self, paths: ProjectPaths) -> None:
        LiveChatStore(paths.server_db).wyr_selected_topics()
        conn = sqlite3.connect(str(paths.server_db))
        try:
            conn.execute("DROP TABLE wyr_topics")
            conn.execute("PRAGMA user_version = 18")
            conn.commit()
        finally:
            conn.close()
        migrated = LiveChatStore(paths.server_db)
        assert migrated.wyr_selected_topics() is None
        migrated.set_wyr_topics(FOOD)
        assert _LATEST_SCHEMA_VERSION >= 19


class TestPicking:
    def test_rounds_come_only_from_the_chosen_topics_even_after_they_are_all_played(
        self, store: LiveChatStore, questions: tuple[WyrQuestion, ...]
    ) -> None:
        store.set_wyr_topics(["weather-seasons"])  # a small topic: 8 questions
        playable = questions_in_topics(questions, store.wyr_selected_topics())
        rng = random.Random(3)
        seen: set[str] = set()
        for n in range(len(playable) + 3):  # one more lap than the topic holds
            question, _pooled = pick_round(store, playable, None, rng)
            assert question is not None and question.category == "weather-seasons"
            seen.add(question.id)
            store.create_wyr_round(
                client_id=f"topic-round-{n:04d}",
                sender="Josh",
                device_id="device-1",
                by_email=None,
                question_id=question.id,
                images_pending=False,
                now=float(n),
            )
        assert seen == {q.id for q in playable}


class TestPool:
    def test_the_filler_paints_the_chosen_topics_first_and_judges_fullness_by_them(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        questions: tuple[WyrQuestion, ...],
    ) -> None:
        store.set_wyr_topics(FOOD)
        pool = WyrPool(paths.server_dir / "wyr-pool")
        by_id = {q.id: q for q in questions}
        # A pool already "full" of other topics must still be topped up for the chosen ones.
        off_topic = [q.id for q in questions if q.category not in FOOD][:3]
        generator = FakeGenerator()
        for question_id in off_topic:
            tmp = pool.begin(question_id)
            (tmp / "a.png").write_bytes(_png())
            (tmp / "b.png").write_bytes(_png())
            assert pool.commit(question_id, tmp)

        outcomes: list[PoolOutcome] = []
        for _ in range(4):
            outcomes.append(
                pool_step(
                    store=store,
                    paths=paths,
                    generator=generator,
                    pool=pool,
                    questions=questions,
                    target=3,
                    demand=WyrDemand(),
                    min_free_bytes=0,
                    rng=random.Random(5),
                    free_bytes=lambda: ROOMY,
                )
            )
        in_topic = {i for i in pool.ids() if by_id[i].category in FOOD}
        assert len(in_topic) == 3
        assert outcomes[-1] is PoolOutcome.FULL


class TestRoutes:
    def test_get_put_and_rounds_follow_the_topics(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, h = _client(storage_root, wixy_repo_root, pin_verifier, None, "a@example.com")
        try:
            initial = client.get(f"{BASE}/wyr/topics", headers=h)
            assert initial.status_code == 200, initial.text
            body = initial.json()
            assert body["all"] is True and all(t["selected"] for t in body["topics"])
            ids = {t["id"] for t in body["topics"]}
            assert set(FOOD) <= ids and all(t["count"] > 0 and t["label"] for t in body["topics"])

            put = client.put(f"{BASE}/wyr/topics", json={"topics": FOOD}, headers=h)
            assert put.status_code == 200, put.text
            chosen = {t["id"] for t in put.json()["topics"] if t["selected"]}
            assert chosen == set(FOOD) and put.json()["all"] is False

            seen_topics: set[str] = set()
            for n in range(6):
                created = _create(client, h, f"wyr-topic-route-{n:04d}")
                assert created.status_code == 201, created.text
                seq = created.json()["message"]["seq"]
                view = client.get(f"{BASE}/wyr/{seq}?as=Josh", headers=h).json()
                seen_topics.add(view["question"]["category"])
            assert seen_topics <= set(FOOD)

            everything = client.put(f"{BASE}/wyr/topics", json={"topics": sorted(ids)}, headers=h)
            assert everything.json()["all"] is True
            assert (
                client.put(f"{BASE}/wyr/topics", json={"topics": None}, headers=h).status_code
                == 200
            )
        finally:
            client.__exit__(None, None, None)

    def test_refuses_nothing_chosen_and_unknown_topics(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, h = _client(storage_root, wixy_repo_root, pin_verifier, None, "a@example.com")
        try:
            empty = client.put(f"{BASE}/wyr/topics", json={"topics": []}, headers=h)
            assert empty.status_code == 422 and empty.json()["error"] == "invalid"
            unknown = client.put(f"{BASE}/wyr/topics", json={"topics": ["nope"]}, headers=h)
            assert unknown.status_code == 422
            missing = client.put(f"{BASE}/wyr/topics", json={}, headers=h)
            assert missing.status_code == 422
            assert client.get(f"{BASE}/wyr/topics").status_code in (401, 403)
        finally:
            client.__exit__(None, None, None)
