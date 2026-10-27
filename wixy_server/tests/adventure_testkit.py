"""Shared helpers for the Adventure Time tests (workspace 00056). Not a `test_*.py` file, so pytest
never collects it; the store-, route-, pack- and bank-level test modules import from it."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.livechat.adventure_bank import AdventureBank, load_bank
from wixy_server.livechat.adventure_pack import AdventureResearcher, PackTiming
from wixy_server.livechat.models import AdventureLanding, AdventureRoundRow
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.tests.test_livechat_view_once import (
    TEST_PIN,
    UNLOCK_GUARD_HEADERS,
    _form_style_json,
)

BASE = "/api/admin/server"
FIXTURE_BANK_PATH = Path(__file__).parent / "fixtures" / "adventure_bank.json"

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
    timing: PackTiming | None = None,
    email: str = "a@example.com",
) -> Iterator[tuple[TestClient, dict[str, str]]]:
    """An app (with the small fixture bank unless told otherwise) and an unlocked token, closed on
    exit so each test's background tasks end with it."""
    app = create_app(
        storage_root=storage_root,
        wixy_repo_root=wixy_repo_root,
        pin_verifier=pin_verifier,
        transcriber=AsyncMock(),
        adventure_bank=bank if bank is not None else fixture_bank(),
        adventure_researcher=researcher,
        adventure_pack_timing=timing,
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
