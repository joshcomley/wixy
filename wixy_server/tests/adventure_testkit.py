"""Shared helpers for the Adventure Time tests (workspace 00056). Not a `test_*.py` file, so pytest
never collects it; the store-, route-, pack- and bank-level test modules import from it."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import anyio
import anyio.to_thread
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.livechat.adventure_bank import AdventureBank, load_bank
from wixy_server.livechat.adventure_pack import (
    AdventureResearcher,
    PackTiming,
    ResearchError,
    ResearchRun,
)
from wixy_server.livechat.adventure_pictures import (
    AdventurePictureFinder,
    FoundPicture,
    PicturePlan,
)
from wixy_server.livechat.models import AdventureLanding, AdventureRoundRow
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.tests.fake_cmd import CANNED_ADVENTURE_PACK
from wixy_server.tests.fake_open_web import make_image
from wixy_server.tests.test_livechat_view_once import (
    TEST_PIN,
    UNLOCK_GUARD_HEADERS,
    _form_style_json,
)

BASE = "/api/admin/server"
FIXTURE_BANK_PATH = Path(__file__).parent / "fixtures" / "adventure_bank.json"
FAST = PackTiming(poll_interval_s=0.02, spawn_gap_s=0.0, give_up_s=30.0, early_retry_s=0.0)
"""Pacing for tests that drive the pack job through a fake researcher: poll fast, no spawn gap, and
(early_retry_s=0) no early retry unless a test asks for one."""


@dataclass
class FakeRunPlan:
    """How one fake research run behaves: each poll reports the next of `statuses` (the last one
    repeats), and a `completed` poll carries `response_text`."""

    statuses: list[str] = field(default_factory=lambda: ["completed"])
    response_text: str | None = None
    poll_errors: int = 0
    """The first this-many polls raise `ResearchError` (cmd not answering)."""


class FakeResearcher:
    """A programmable `AdventureResearcher`: records every start / cancel and plays back the plans
    in order (a run beyond the plans completes with the canned pack). It never talks to cmd."""

    def __init__(
        self,
        plans: list[FakeRunPlan] | None = None,
        *,
        start_errors: list[Exception | None] | None = None,
    ) -> None:
        self.plans = list(plans or [])
        self.start_errors = list(start_errors or [])
        self.started: list[tuple[str, Path]] = []
        self.start_times: list[float] = []
        self.cancelled: list[str] = []
        self.polls: dict[str, int] = {}
        self._plans_by_run: dict[str, FakeRunPlan] = {}
        self.in_flight = 0
        self.max_in_flight = 0
        self._live: set[str] = set()

    def adopt(self, run_id: str, plan: FakeRunPlan | None = None) -> None:
        """Know a run that was started by an earlier process (a restart resumes polling it)."""
        self._plans_by_run[run_id] = plan if plan is not None else FakeRunPlan()
        self.polls[run_id] = 0
        self._live.add(run_id)

    async def start(self, *, prompt: str, cwd: Path) -> str:
        if self.start_errors:
            error = self.start_errors.pop(0)
            if error is not None:
                raise error
        run_id = f"fake-run-{len(self.started) + 1}"
        self.started.append((prompt, cwd))
        self.start_times.append(time.monotonic())
        plan = self.plans.pop(0) if self.plans else FakeRunPlan()
        self._plans_by_run[run_id] = plan
        self.polls[run_id] = 0
        self._live.add(run_id)
        self.max_in_flight = max(self.max_in_flight, len(self._live))
        return run_id

    async def poll(self, run_id: str) -> ResearchRun:
        plan = self._plans_by_run[run_id]
        count = self.polls[run_id]
        self.polls[run_id] = count + 1
        if count < plan.poll_errors:
            raise ResearchError("cmd is not answering")
        status = plan.statuses[min(count - plan.poll_errors, len(plan.statuses) - 1)]
        if status in ("completed", "error", "timeout", "cancelled"):
            self._live.discard(run_id)
        text = None
        if status == "completed":
            text = (
                plan.response_text
                if plan.response_text is not None
                else json.dumps(CANNED_ADVENTURE_PACK)
            )
        return ResearchRun(run_id=run_id, status=status, response_text=text)

    async def cancel(self, run_id: str) -> None:
        self.cancelled.append(run_id)
        self._live.discard(run_id)


class FakePictureFinder:
    """A programmable `AdventurePictureFinder`: returns `pictures` (real JPEGs) after it is
    released, records every plan it was given, and can be held mid-hunt (`hold=True`, then
    `release.set()`) so a test can reject, delete or stop the app while pictures are in flight. It
    never touches the network."""

    def __init__(
        self,
        pictures: list[FoundPicture] | None = None,
        *,
        hold: bool = False,
        error: Exception | None = None,
    ) -> None:
        self.pictures = pictures if pictures is not None else sample_pictures(3)
        self.error = error
        self.release = threading.Event()
        if not hold:
            self.release.set()
        self.plans: list[PicturePlan] = []
        self.started = threading.Event()
        self.wanted_after_release: list[bool] = []

    async def find(
        self, plan: PicturePlan, *, still_wanted: Callable[[], Awaitable[bool]]
    ) -> list[FoundPicture]:
        self.plans.append(plan)
        self.started.set()
        while not self.release.is_set():  # cancellable, unlike a blocking wait in a thread
            await anyio.sleep(0.01)
        self.wanted_after_release.append(await still_wanted())
        if self.error is not None:
            raise self.error
        return list(self.pictures)


def sample_pictures(count: int, *, hero: int = 2, label: str = "Photo") -> list[FoundPicture]:
    """`count` finished pictures: the first `hero` are `hero:N`, the rest `food:N` item slots."""
    pictures: list[FoundPicture] = []
    for index in range(count):
        slot = f"hero:{index}" if index < hero else f"food:{index - hero}"
        pictures.append(
            FoundPicture(
                slot=slot,
                jpeg=make_image(900 + index * 20, 700, seed=index, exif=False),
                credit=f"{label} {index}, CC BY 4.0",
                page=f"https://commons.example.org/wiki/File:{label}_{index}.jpg",
                caption=f"Caption {index}" if index % 2 == 0 else None,
                keys=frozenset({f"sha256:{label}-{index}"}),
            )
        )
    return pictures


# A spin that satisfies every bound: 1800 degrees in 4 s.
SPIN_FROM = 12.5
SPIN_DELTA = 1800.0
SPIN_DURATION_MS = 4000.0


def fixture_bank() -> AdventureBank:
    return load_bank(FIXTURE_BANK_PATH)


def landing_for(
    unit: str = "AAA", *, sea: bool = False
) -> tuple[AdventureLanding, tuple[str, ...]]:
    """A landing in `unit` with a few neighbours as the country candidates."""
    candidates = tuple(dict.fromkeys((unit, "AAA", "BBB", "CCC", "EEE")))
    landing = AdventureLanding(
        point=(5.0, 6.0), sea=sea, land=(7.0, 8.0), centre=(9.0, 10.0), land_unit=unit
    )
    return landing, candidates


def result_body(unit: str = "AAA", *, sea: bool = False) -> dict[str, Any]:
    """The wire `result` of a lat spin landing in `unit`."""
    landing, candidates = landing_for(unit, sea=sea)
    return {**landing.to_json(), "candidates": list(candidates)}


def start_round(store: LiveChatStore, cid: str = "adv-client-0001", sender: str = "Josh") -> int:
    message, created = store.create_adventure_round(
        client_id=cid, sender=sender, device_id="device-1234", by_email=None, now=10.0
    )
    assert created is True
    return message.seq


def to_country(
    store: LiveChatStore,
    seq: int,
    *,
    unit: str = "AAA",
    at: float = 100.0,
    duration_ms: float = SPIN_DURATION_MS,
) -> AdventureRoundRow:
    """Drive a round to the country roulette: lng spin at `at`, lat spin at `at`. The country
    roulette then starts at `at + duration/1000 + 5`."""
    store.spin_adventure(
        anchor_seq=seq,
        sender="Josh",
        axis="lng",
        from_deg=SPIN_FROM,
        delta_deg=SPIN_DELTA,
        duration_ms=duration_ms,
        now=at,
    )
    landing, candidates = landing_for(unit)
    row, changed = store.spin_adventure(
        anchor_seq=seq,
        sender="Rose",
        axis="lat",
        from_deg=-15.0,
        delta_deg=-SPIN_DELTA,
        duration_ms=duration_ms,
        landing=landing,
        candidates=candidates,
        now=at,
    )
    assert changed is True and row.state == "country"
    return row


def roulette_open(row: AdventureRoundRow) -> float:
    """A `now` at which the round's current roulette accepts a stop."""
    at = row.dest_roulette_at if row.state == "destination" else row.country_roulette_at
    assert at is not None
    return at + 0.5


def stop_country(
    store: LiveChatStore,
    bank: AdventureBank,
    seq: int,
    choice: str,
    row: AdventureRoundRow,
    *,
    sender: str = "Josh",
    pack_available: bool = True,
) -> AdventureRoundRow:
    updated, changed = store.stop_adventure(
        anchor_seq=seq,
        sender=sender,
        stage="country",
        choice=choice,
        bank=bank,
        pack_available=pack_available,
        now=roulette_open(row),
    )
    assert changed is True
    return updated


def stop_destination(
    store: LiveChatStore,
    bank: AdventureBank,
    seq: int,
    choice: str,
    row: AdventureRoundRow,
    *,
    sender: str = "Rose",
    pack_available: bool = True,
) -> AdventureRoundRow:
    updated, changed = store.stop_adventure(
        anchor_seq=seq,
        sender=sender,
        stage="destination",
        choice=choice,
        bank=bank,
        pack_available=pack_available,
        now=roulette_open(row),
    )
    assert changed is True
    return updated


def to_chosen(
    store: LiveChatStore,
    bank: AdventureBank,
    seq: int,
    *,
    unit: str = "AAA",
    destination: str | None = None,
    pack_available: bool = True,
) -> AdventureRoundRow:
    """Drive a round all the way to `chosen` (the unit's first remaining destination unless
    `destination` is given)."""
    row = to_country(store, seq, unit=unit)
    row = stop_country(store, bank, seq, unit, row, pack_available=pack_available)
    if row.state == "chosen":
        return row
    choice = destination if destination is not None else (row.dest_candidates or ())[0]
    return stop_destination(store, bank, seq, choice, row, pack_available=pack_available)


@contextmanager
def unlocked_client(
    storage_root: Path,
    wixy_repo_root: Path,
    pin_verifier: CmdPinVerifier,
    *,
    bank: AdventureBank | None = None,
    researcher: AdventureResearcher | None = None,
    no_researcher: bool = False,
    timing: PackTiming | None = None,
    email: str = "a@example.com",
    picture_finder: AdventurePictureFinder | None = None,
) -> Iterator[tuple[TestClient, dict[str, str]]]:
    """An app (with the small fixture bank and a `FakeResearcher` unless told otherwise — a test
    never reaches a real cmd) and an unlocked token, closed on exit so each test's background
    tasks end with it. `no_researcher=True` builds the app with none, as the standalone edition
    does: the caller must have set `WIXY_EDITION=standalone` so `create_app`'s default is none.
    `picture_finder` injects the holiday pack's picture sources; without one a pack has no
    pictures (an injected researcher never gets the production, network-facing finder)."""
    if no_researcher:
        assert os.environ.get("WIXY_EDITION") == "standalone", "no_researcher needs standalone"
        resolved: AdventureResearcher | None = None
    else:
        resolved = researcher if researcher is not None else FakeResearcher()
    app = create_app(
        storage_root=storage_root,
        wixy_repo_root=wixy_repo_root,
        pin_verifier=pin_verifier,
        transcriber=AsyncMock(),
        adventure_bank=bank if bank is not None else fixture_bank(),
        adventure_researcher=resolved,
        adventure_pack_timing=timing if timing is not None else FAST,
        adventure_picture_finder=picture_finder,
    )
    client = TestClient(app, cookies={"CF_Authorization": "dummy"})
    client.__enter__()
    try:
        resp = client.post(
            f"{BASE}/unlock",
            content=_form_style_json(TEST_PIN),
            headers={
                **UNLOCK_GUARD_HEADERS,
                "Sec-Fetch-Site": "same-origin",
                "CF-Access-Authenticated-User-Email": email,
            },
        )
        assert resp.status_code == 200, resp.text
        yield (
            client,
            {
                "X-Wixy-Server-Token": resp.json()["token"],
                "CF-Access-Authenticated-User-Email": email,
            },
        )
    finally:
        client.__exit__(None, None, None)


def post(client: TestClient, headers: dict[str, str], path: str, **body: Any) -> Any:
    return client.post(f"{BASE}{path}", json=body, headers=headers)


def get_view(client: TestClient, headers: dict[str, str], seq: int) -> dict[str, Any]:
    response = client.get(f"{BASE}/adventure/{seq}", headers=headers)
    assert response.status_code == 200, response.text
    view: dict[str, Any] = response.json()
    return view


def open_roulette(client: TestClient, seq: int, which: str) -> None:
    """Make a round's country (`"country"`) or destination (`"destination"`) roulette start now,
    instead of waiting out the real 5 s / 3.5 s: rewrite its stored start time."""
    column = "country_roulette_at" if which == "country" else "dest_roulette_at"
    store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
    conn = sqlite3.connect(str(store._db_path))
    try:
        conn.execute(
            f"UPDATE adv_rounds SET {column} = ? WHERE anchor_message_seq = ?",
            (time.time() - 5.0, seq),
        )
        conn.commit()
    finally:
        conn.close()


def route_to_country(
    client: TestClient, headers: dict[str, str], seq: int, unit: str = "AAA"
) -> dict[str, Any]:
    """Drive a created round through both spins over the routes and open the country roulette."""
    first = post(client, headers, f"/adventure/{seq}/spin", **spin_body("Josh", "lng"))
    assert first.status_code == 200, first.text
    second = post(
        client,
        headers,
        f"/adventure/{seq}/spin",
        **spin_body("Rose", "lat", frm=-15.0, delta=-SPIN_DELTA, result=result_body(unit)),
    )
    assert second.status_code == 200, second.text
    open_roulette(client, seq, "country")
    return get_view(client, headers, seq)


def route_to_chosen(
    client: TestClient,
    headers: dict[str, str],
    seq: int,
    unit: str = "AAA",
    destination: str | None = None,
) -> dict[str, Any]:
    """Drive a created round all the way to `chosen` over the routes."""
    route_to_country(client, headers, seq, unit)
    stopped = post(
        client, headers, f"/adventure/{seq}/stop", sender="Josh", stage="country", choice=unit
    )
    assert stopped.status_code == 200, stopped.text
    view: dict[str, Any] = stopped.json()
    if view["state"] == "chosen":
        return view
    open_roulette(client, seq, "destination")
    choice = destination if destination is not None else view["destination"]["candidates"][0]["id"]
    final = post(
        client,
        headers,
        f"/adventure/{seq}/stop",
        sender="Rose",
        stage="destination",
        choice=choice,
    )
    assert final.status_code == 200, final.text
    chosen: dict[str, Any] = final.json()
    return chosen


def wait_for_pack(
    client: TestClient, headers: dict[str, str], seq: int, state: str, *, timeout_s: float = 10.0
) -> dict[str, Any]:
    """Poll the view until its pack reaches `state`."""
    deadline = time.monotonic() + timeout_s
    view = get_view(client, headers, seq)
    while view["pack"]["state"] != state:
        if time.monotonic() > deadline:
            raise AssertionError(f"pack never became {state}: {view['pack']}")
        time.sleep(0.02)
        view = get_view(client, headers, seq)
    return view


def create_round(
    client: TestClient, headers: dict[str, str], cid: str = "adv-route-0001", sender: str = "Josh"
) -> Any:
    return post(client, headers, "/adventure", clientId=cid, sender=sender, deviceId="device-1234")


def spin_body(
    sender: str = "Josh",
    axis: str = "lng",
    *,
    frm: float = SPIN_FROM,
    delta: float = SPIN_DELTA,
    duration: float = SPIN_DURATION_MS,
    result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "sender": sender,
        "axis": axis,
        "from": frm,
        "delta": delta,
        "durationMs": duration,
    }
    if result is not None:
        body["result"] = result
    return body


def wait_for(predicate: Callable[[], bool], *, timeout_s: float = 10.0, what: str = "") -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {what or 'the condition'}")


def run_concurrently(*calls: Callable[[], Any]) -> list[Any]:
    """Run each call on its own thread, released together by a barrier; return each call's result
    or the exception it raised, in call order."""
    barrier = threading.Barrier(len(calls))
    results: list[Any] = [None] * len(calls)

    def _worker(index: int, call: Callable[[], Any]) -> None:
        barrier.wait()
        try:
            results[index] = call()
        except Exception as exc:
            results[index] = exc

    threads = [threading.Thread(target=_worker, args=(i, c)) for i, c in enumerate(calls)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results
