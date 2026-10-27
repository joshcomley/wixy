# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""The Adventure Time live swipe trail (workspace 00056, spec/server-chat/08-adventure-time.md
§3.5/§4.2, Inv 56): `POST /adventure/live` validates a frame, rate-limits it on the authenticated
identity with its OWN limiter, and relays it to every open stream as the SSE event
`adventure_live` — never stored, never given an `id:` line. The generalised broker keeps live
drawing byte-identical."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import anyio
import pytest

from builder.jsontypes import JsonObject
from wixy_server.livechat.drawing_broker import (
    DRAWING_LIVE_EVENT,
    DrawingBroker,
    LiveDrawingQueue,
)
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.tokens import ServerAuth
from wixy_server.livechat.transcription import SlidingWindowRateLimiter
from wixy_server.routes_livechat import _stream_events
from wixy_server.tests.adventure_testkit import BASE, create_round, unlocked_client
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    TEST_PIN,
    UNLOCK_GUARD_HEADERS,
    _dev_no_auth,
    _form_style_json,
    fake_cmd_state,
    origin_repo,
    pin_verifier,
    storage_root,
    wixy_repo_root,
)

_AUTH = ServerAuth(email="", exp=int(time.time()) + 3600)
_SECRET = b"x" * 32


def _frame(**over: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "anchorSeq": 1,
        "clientId": "trail-client-0001",
        "axis": "lng",
        "rotation": [12.5, -15.0],
        "points": [[0.1, -0.2, 0], [0.12, -0.18, 16.7], [0.2, -0.1, 33.4]],
        "frame": 0,
        "end": False,
    }
    body.update(over)
    return body


def _live(client: Any, headers: dict[str, str], body: dict[str, Any]) -> Any:
    return client.post(f"{BASE}/adventure/live", json=body, headers=headers)


async def _next_frame(generator: Any, *, timeout_s: float = 2.0) -> dict[str, Any]:
    with anyio.fail_after(timeout_s):
        raw = await generator.__anext__()
    frame: dict[str, Any] = {"id": None, "event": None, "data": None}
    for line in raw.rstrip("\n").split("\n"):
        if line.startswith("id: "):
            frame["id"] = int(line[len("id: ") :])
        elif line.startswith("event: "):
            frame["event"] = line[len("event: ") :]
        elif line.startswith("data: "):
            frame["data"] = json.loads(line[len("data: ") :])
    return frame


class TestValidation:
    def test_a_valid_frame_is_accepted(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            response = _live(client, h, _frame())
            assert response.status_code == 200 and response.json() == {"ok": True}

    def test_boundary_values_are_accepted(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            body = _frame(
                clientId="c" * 64,
                anchorSeq=2**53 - 1,
                frame=10_000_000,
                axis="lat",
                rotation=[1e6, -1e6],
                points=[[3, -3, 0], [-3.0, 3.0, 600000]] + [[0, 0, 1]] * 30,
                end=True,
            )
            assert len(body["points"]) == 32
            assert _live(client, h, body).status_code == 200

    def test_an_end_frame_may_carry_no_points(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            assert _live(client, h, _frame(points=[], end=True)).status_code == 200

    @pytest.mark.parametrize(
        "over",
        [
            {"clientId": "short"},
            {"clientId": "c" * 65},
            {"anchorSeq": 0},
            {"anchorSeq": -1},
            {"anchorSeq": 2**53},
            {"frame": -1},
            {"frame": 10_000_001},
            {"axis": "up"},
            {"axis": ""},
            {"rotation": [1.0]},
            {"rotation": [1.0, 2.0, 3.0]},
            {"rotation": [1e6 + 1, 0]},
            {"rotation": [0, -1e6 - 1]},
            {"points": [[0, 0, 0]] * 33},
            {"points": [[0, 0]]},
            {"points": [[0, 0, 0, 0]]},
            {"points": [[3.01, 0, 0]]},
            {"points": [[0, -3.01, 0]]},
            {"points": [[0, 0, -1]]},
            {"points": [[0, 0, 600001]]},
            {"points": [["0", 0, 0]]},
            {"points": [[0, None, 0]]},
            {"points": "none"},
            {"end": "yes"},
            {"end": 1},
            {"anchorSeq": "1"},
            {"anchorSeq": True},
            {"frame": 1.5},
            {"extra": 1},
        ],
    )
    def test_out_of_bounds_or_malformed_frames_are_refused(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        over: dict[str, Any],
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            response = _live(client, h, _frame(**over))
            assert response.status_code == 422, (over, response.text)

    @pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
    def test_non_finite_numbers_are_refused(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        literal: str,
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            for rotation, points in (
                (f"[{literal}, 0]", "[]"),
                ("[0, 0]", f"[[{literal}, 0, 0]]"),
                ("[0, 0]", f"[[0, 0, {literal}]]"),
            ):
                raw = (
                    '{"anchorSeq":1,"clientId":"trail-client-0001","axis":"lng",'
                    f'"rotation":{rotation},"points":{points},"frame":0}}'
                )
                response = client.post(
                    f"{BASE}/adventure/live",
                    content=raw,
                    headers={**h, "Content-Type": "application/json"},
                )
                assert response.status_code == 422, (literal, rotation, points)

    def test_the_business_rules_answer_the_invalid_shape(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            response = _live(client, h, _frame(points=[[9, 0, 0]]))
            assert response.status_code == 422
            assert response.json()["error"] == "invalid"


class TestRateLimit:
    def test_it_has_its_own_30_a_second_budget_on_the_authenticated_identity(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            limiter = client.app.state.livechat_adventure_live_limiter  # type: ignore[attr-defined]
            assert isinstance(limiter, SlidingWindowRateLimiter)
            assert limiter is not client.app.state.livechat_drawing_live_limiter  # type: ignore[attr-defined]
            statuses = [
                _live(client, h, _frame(clientId=f"trail-client-{n:04d}", frame=n)).status_code
                for n in range(32)
            ]
            # Rotating the body's client id does not reset the budget (it is the identity's).
            assert statuses[:30] == [200] * 30
            assert statuses[30:] == [429, 429]

    def test_the_429_carries_retry_after(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            client.app.state.livechat_adventure_live_limiter = SlidingWindowRateLimiter(  # type: ignore[attr-defined]
                max_events=1, window_s=60.0
            )
            assert _live(client, h, _frame()).status_code == 200
            limited = _live(client, h, _frame())
            assert limited.status_code == 429
            assert limited.json()["error"] == "rate_limited"
            assert int(limited.headers["Retry-After"]) >= 1

    def test_two_sessions_do_not_throttle_each_other_and_drawing_live_is_separate(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, first):
            second_token = client.post(
                f"{BASE}/unlock",
                content=_form_style_json(TEST_PIN),
                headers={**UNLOCK_GUARD_HEADERS, "Sec-Fetch-Site": "same-origin"},
            ).json()["token"]
            second = {"X-Wixy-Server-Token": second_token}
            assert second != first
            client.app.state.livechat_adventure_live_limiter = SlidingWindowRateLimiter(  # type: ignore[attr-defined]
                max_events=1, window_s=60.0
            )
            codes = (
                _live(client, first, _frame()).status_code,
                _live(client, second, _frame()).status_code,
                _live(client, first, _frame()).status_code,
            )
            assert codes == (200, 200, 429)
            # The drawing relay has its own limiter: spending one never spends the other.
            seq = create_round(client, first).json()["message"]["seq"]
            drawing = client.post(
                f"{BASE}/drawings/live",
                json={
                    "drawingClientId": "draw-client-0001",
                    "anchorSeq": seq,
                    "columnWidth": 600,
                    "strokeId": "stroke-id-0001",
                    "batch": 0,
                    "color": "#000000",
                    "width": 4,
                    "points": [[1, 2]],
                },
                headers=first,
            )
            assert drawing.status_code in (200, 422)  # reached validation: not rate-limited
            assert drawing.status_code != 429

    def test_body_ids_never_become_limiter_keys_so_the_table_stays_bounded(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            assert _live(client, h, _frame()).status_code == 200
            # Body ids never become limiter keys: one identity, one key.
            limiter = client.app.state.livechat_adventure_live_limiter  # type: ignore[attr-defined]
            for n in range(5):
                _live(client, h, _frame(clientId=f"trail-client-{n:04d}"))
            assert len(limiter._events) == 1


class TestRelay:
    def test_a_frame_reaches_every_registered_stream_as_adventure_live(self) -> None:
        broker = DrawingBroker()
        _a, queue_a = broker.register()
        _b, queue_b = broker.register()
        frame: JsonObject = {"anchorSeq": 1, "clientId": "trail-client-0001", "frame": 0}
        broker.publish(frame, "adventure_live")
        for queue in (queue_a, queue_b):
            [live] = queue.drain_frames()
            assert live.event == "adventure_live" and live.data == frame
            assert queue.drain_frames() == []

    def test_a_drawing_frame_is_still_drawing_live_by_default(self) -> None:
        broker = DrawingBroker()
        _id, queue = broker.register()
        broker.publish({"batch": 0})
        queue.push({"batch": 1})
        events = [(f.event, f.data) for f in queue.drain_frames()]
        assert events == [(DRAWING_LIVE_EVENT, {"batch": 0}), ("drawing_live", {"batch": 1})]

    def test_drain_still_returns_just_the_data_for_older_callers(self) -> None:
        queue = LiveDrawingQueue()
        queue.push({"a": 1}, "adventure_live")
        queue.push({"b": 2})
        assert queue.drain() == [{"a": 1}, {"b": 2}]

    def test_the_queue_stays_bounded_and_drops_the_oldest_across_event_names(self) -> None:
        queue = LiveDrawingQueue()
        for n in range(70):
            queue.push({"n": n}, "adventure_live" if n % 2 else "drawing_live")
        frames = queue.drain_frames()
        assert len(frames) == 64 and frames[0].data == {"n": 6} and frames[-1].data == {"n": 69}

    def test_the_route_relays_the_validated_frame_with_end_and_nothing_else(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            broker: DrawingBroker = client.app.state.livechat_drawing_broker  # type: ignore[attr-defined]
            _id, queue = broker.register()
            assert _live(client, h, _frame(rotation=[10, 20], end=True)).status_code == 200
            [live] = queue.drain_frames()
            assert live.event == "adventure_live"
            assert live.data == {
                "anchorSeq": 1,
                "clientId": "trail-client-0001",
                "axis": "lng",
                "rotation": [10.0, 20.0],
                "points": [[0.1, -0.2, 0.0], [0.12, -0.18, 16.7], [0.2, -0.1, 33.4]],
                "frame": 0,
                "end": True,
            }

    def test_a_refused_frame_is_never_relayed(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            broker: DrawingBroker = client.app.state.livechat_drawing_broker  # type: ignore[attr-defined]
            _id, queue = broker.register()
            assert _live(client, h, _frame(points=[[9, 9, 9]])).status_code == 422
            assert _live(client, {}, _frame()).status_code == 401
            assert queue.drain_frames() == []

    def test_a_frame_is_never_stored(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        sentinel = 0.123456789
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
            seq = create_round(client, h).json()["message"]["seq"]
            events_before = store.events_after(0)
            row_before = store.get_adventure_round(anchor_seq=seq)
            for n in range(5):
                response = _live(
                    client,
                    h,
                    _frame(
                        anchorSeq=seq,
                        frame=n,
                        points=[[sentinel, sentinel, 1]],
                        rotation=[sentinel * 1000, 0],
                    ),
                )
                assert response.status_code == 200
            assert store.events_after(0) == events_before
            assert store.get_adventure_round(anchor_seq=seq) == row_before
            db = store._db_path
            raw = db.read_bytes()
            wal = Path(f"{db}-wal")
            if wal.exists():
                raw += wal.read_bytes()
            assert b"0.123456789" not in raw and b"123.456789" not in raw
            # The route doesn't even need the round to exist: it is only a relay.
            assert _live(client, h, _frame(anchorSeq=987654)).status_code == 200


class TestStream:
    @pytest.mark.asyncio
    async def test_the_stream_sends_adventure_live_with_no_id_line(self, tmp_path: Path) -> None:
        store = LiveChatStore(tmp_path / "server.db")
        queue = LiveDrawingQueue()
        queue.push({"anchorSeq": 1, "clientId": "trail-client-0001", "frame": 3}, "adventure_live")
        gen = _stream_events(store, LiveChatNotifier(), _SECRET, _AUTH, after=0, live_queue=queue)
        try:
            frame = await _next_frame(gen)
        finally:
            await gen.aclose()
        assert frame["event"] == "adventure_live"
        assert frame["id"] is None
        assert frame["data"]["frame"] == 3

    @pytest.mark.asyncio
    async def test_adventure_and_drawing_frames_interleave_in_order_without_moving_the_cursor(
        self, tmp_path: Path
    ) -> None:
        store = LiveChatStore(tmp_path / "server.db")
        store.create_message(
            client_id="trail-stream-msg-1",
            sender="Josh",
            device_id="d" * 8,
            by_email=None,
            text="one",
            attachment_ids=(),
            now=1000.0,
        )
        queue = LiveDrawingQueue()
        queue.push({"batch": 0}, "drawing_live")
        queue.push({"frame": 1}, "adventure_live")
        queue.push({"batch": 2})
        gen = _stream_events(store, LiveChatNotifier(), _SECRET, _AUTH, after=0, live_queue=queue)
        try:
            received = [await _next_frame(gen) for _ in range(4)]
        finally:
            await gen.aclose()
        assert [f["event"] for f in received] == [
            "drawing_live",
            "adventure_live",
            "drawing_live",
            "message",
        ]
        assert [f["id"] for f in received] == [None, None, None, 1]

    @pytest.mark.asyncio
    async def test_a_frame_pushed_while_the_loop_waits_wakes_it_promptly(
        self, tmp_path: Path
    ) -> None:
        store = LiveChatStore(tmp_path / "server.db")
        queue = LiveDrawingQueue()
        gen = _stream_events(store, LiveChatNotifier(), _SECRET, _AUTH, after=0, live_queue=queue)
        received: list[dict[str, Any]] = []

        async def consume() -> None:
            received.append(await _next_frame(gen, timeout_s=1.0))

        try:
            async with anyio.create_task_group() as tg:
                tg.start_soon(consume)
                await anyio.sleep(0.2)  # the loop is now waiting on its wake-up events
                queue.push({"frame": 9}, "adventure_live")
        finally:
            await gen.aclose()
        assert [f["event"] for f in received] == ["adventure_live"]
