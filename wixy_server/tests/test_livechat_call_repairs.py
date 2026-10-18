"""Round-1 repair discriminators: H1 work ownership, M2 overflow transitions, M3 correlation."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from types import SimpleNamespace
from typing import Any

import pytest

from wixy_server.livechat.call_broker import CallBroker, CallCapacityError, CallWork, Peer
from wixy_server.livechat.call_protocol import PROTOCOL, CallAction, Invite
from wixy_server.livechat.tokens import ServerAuth, mint_unlock_token
from wixy_server.routes_livechat_calls import calls_socket

ORIGIN = "https://example.test"
EMAIL = "admin@example.test"
SECRET = b"s" * 32


class BlockedStore:
    """Grant lookups block after `free` fast calls; `live_result` models revocation."""

    def __init__(self, free: int = 0, live_result: bool = True) -> None:
        self.release = threading.Event()
        self.free = free
        self.live_result = live_result
        self.entered = 0
        self.live = 0
        self.lock = threading.Lock()

    def is_device_grant_live(self, **_: Any) -> bool:
        with self.lock:
            self.entered += 1
            call = self.entered
            self.live += 1
        try:
            if call > self.free:
                self.release.wait(10)
            return self.live_result or call == 1
        finally:
            with self.lock:
                self.live -= 1


class _Headers(dict[str, str]):
    def getlist(self, key: str) -> list[str]:
        return [self[key]] if key in self else []


class FakeSocket:
    def __init__(self, app: Any, token: str) -> None:
        self.app = app
        self.scope: dict[str, Any] = {"query_string": b"", "subprotocols": [PROTOCOL]}
        self.headers = _Headers({"origin": ORIGIN, "cf-access-authenticated-user-email": EMAIL})
        self.token = token
        self.closed: int | None = None
        self.sent: list[Any] = []
        self.authed = False

    async def accept(self, subprotocol: str | None = None) -> None:
        return None

    async def receive(self) -> dict[str, Any]:
        if self.authed:
            await asyncio.Event().wait()  # A quiet, connected client.
        self.authed = True
        text = json.dumps({"type": "auth", "v": 1, "token": self.token, "label": "X"})
        return {"type": "websocket.receive", "text": text}

    async def send_json(self, message: Any) -> None:
        self.sent.append(message)

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        self.closed = code


def _app(store: Any, broker: CallBroker) -> Any:
    return SimpleNamespace(
        state=SimpleNamespace(
            livechat_call_broker=broker,
            call_origins=frozenset({ORIGIN}),
            settings=SimpleNamespace(dev_no_auth=True),  # Isolates the grant path only.
            livechat_store=store,
            livechat_secret=SECRET,
        )
    )


def _token() -> str:
    token, _ = mint_unlock_token(SECRET, email=EMAIL, ttl_s=300, now=time.time(), grant_id="a" * 32)
    return token


def _drain(store: BlockedStore, broker: CallBroker) -> None:
    store.release.set()
    deadline = time.monotonic() + 5
    while (store.live or broker.admission_work.work or broker.refresh_work.work) and (
        time.monotonic() < deadline
    ):
        time.sleep(0.01)
    assert store.live == 0
    assert broker.admission_work.work == 0 and broker.refresh_work.work == 0


def test_cancelled_auth_cannot_orphan_unbounded_grant_workers() -> None:
    store, broker = BlockedStore(), CallBroker()
    app, token = _app(store, broker), _token()

    async def batches() -> list[int | None]:
        codes: list[int | None] = []
        for _ in range(5):
            sockets = [FakeSocket(app, token) for _ in range(4)]
            tasks = [asyncio.create_task(calls_socket(s)) for s in sockets]  # type: ignore[arg-type]
            await asyncio.sleep(0.2)
            for task in tasks:  # Native cancellation, as an outer timeout/shutdown delivers.
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            assert broker.pending == 0
            codes.extend(s.closed for s in sockets)
        return codes

    try:
        codes = asyncio.run(batches())
        assert store.live == 4 and store.entered == 4  # 20 cancelled auths, 4 real workers.
        assert broker.admission_work.work == 4
        assert 4401 not in codes  # Cancellation/busy never instructs the browser to lock.
        assert set(codes) <= {1001, 4429}
    finally:
        _drain(store, broker)


def test_internal_auth_timeout_keeps_permits_and_does_not_lock() -> None:
    store, broker = BlockedStore(), CallBroker()
    app, token = _app(store, broker), _token()

    async def batch() -> list[int | None]:
        sockets = [FakeSocket(app, token) for _ in range(4)]
        await asyncio.gather(*(calls_socket(s) for s in sockets))  # type: ignore[arg-type]
        late = FakeSocket(app, token)
        await calls_socket(late)  # type: ignore[arg-type]
        return [s.closed for s in sockets] + [late.closed]

    try:
        codes = asyncio.run(batch())  # The route's own 5 s deadline, not an outer cancel.
        assert codes == [4408, 4408, 4408, 4408, 4429]
        assert store.live == 4 and broker.pending == 0 and broker.admission_work.work == 4
    finally:
        _drain(store, broker)


@pytest.mark.parametrize(("live_result", "expected"), [(True, 4408), (False, 4401)])
def test_refresh_slow_is_not_revocation(live_result: bool, expected: int) -> None:
    # Call 1 = admission, call 2 = first refresh; the next refresh blocks (or revokes).
    store = BlockedStore(free=2, live_result=live_result)
    broker = CallBroker()
    socket = FakeSocket(_app(store, broker), _token())
    try:
        asyncio.run(asyncio.wait_for(calls_socket(socket), 8))  # type: ignore[arg-type]
        assert socket.closed == expected
        assert broker.connections == 0 and not broker.peers
    finally:
        _drain(store, broker)


def test_admission_saturation_cannot_starve_refresh_and_vice_versa() -> None:
    broker = CallBroker()
    gate = threading.Event()

    async def scenario() -> None:
        blocked = [asyncio.create_task(broker.admission_work.run(gate.wait)) for _ in range(4)]
        await asyncio.sleep(0.05)
        for task in blocked:
            task.cancel()
        with pytest.raises(CallCapacityError):
            await broker.admission_work.run(lambda: True)
        assert await broker.refresh_work.run(lambda: True) is True
        refresh = [asyncio.create_task(broker.refresh_work.run(gate.wait)) for _ in range(8)]
        await asyncio.sleep(0.05)
        with pytest.raises(CallCapacityError):
            await broker.refresh_work.run(lambda: True)
        broker.shutdown()
        with pytest.raises(CallCapacityError):
            await broker.admission_work.run(lambda: True)
        gate.set()
        await asyncio.gather(*refresh, return_exceptions=True)

    asyncio.run(scenario())
    deadline = time.monotonic() + 5
    while (broker.admission_work.work or broker.refresh_work.work) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert broker.admission_work.work == 0 and broker.refresh_work.work == 0


def test_job_cancelled_before_start_releases_its_permit() -> None:
    work = CallWork(1, "probe")
    gate = threading.Event()

    async def scenario() -> None:
        running = asyncio.create_task(work.run(gate.wait))
        await asyncio.sleep(0.05)
        work.capacity = 2  # Admit one queued job behind the single executor thread.
        queued = asyncio.create_task(work.run(lambda: True))
        await asyncio.sleep(0.05)
        queued.cancel()
        await asyncio.gather(queued, return_exceptions=True)
        assert work.work == 1  # The never-started job freed its permit; the running one did not.
        gate.set()
        await running

    asyncio.run(scenario())
    assert work.work == 0


def test_cancelled_admitted_route_is_not_a_protocol_or_auth_refusal() -> None:
    store, broker = BlockedStore(free=100), CallBroker()
    socket = FakeSocket(_app(store, broker), _token())

    async def scenario() -> None:
        task = asyncio.create_task(calls_socket(socket))  # type: ignore[arg-type]
        for _ in range(100):
            if broker.connections:
                break
            await asyncio.sleep(0.01)
        assert broker.connections == 1
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert socket.closed == 1001
        assert not broker.peers and broker.connections == 0

    try:
        asyncio.run(scenario())
    finally:
        _drain(store, broker)
        broker.shutdown()


def test_cancelled_access_verification_retains_actual_work_slots() -> None:
    broker = CallBroker()
    gate = threading.Event()
    count = [0]
    lock = threading.Lock()
    store = BlockedStore(free=100)
    app = _app(store, broker)
    app.state.settings.dev_no_auth = False

    def verify(_token: str) -> dict[str, Any]:
        with lock:
            count[0] += 1
        gate.wait(10)
        return {"email": EMAIL, "exp": time.time() + 300}

    app.state.call_access_verifier = verify

    async def scenario() -> None:
        for _ in range(3):
            sockets = [FakeSocket(app, _token()) for _ in range(4)]
            for socket in sockets:
                socket.headers["cf-access-jwt-assertion"] = "fixture-assertion"
            tasks = [asyncio.create_task(calls_socket(s)) for s in sockets]  # type: ignore[arg-type]
            await asyncio.sleep(0.1)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        assert count[0] == 4 and broker.admission_work.work == 4
        assert broker.pending == 0 and not broker.peers
        assert await broker.refresh_work.run(lambda: True)

    try:
        asyncio.run(scenario())
    finally:
        gate.set()
        _drain(store, broker)
        broker.shutdown()


def test_transition_depth_is_restored_if_eviction_cleanup_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    broker, (peer, _) = _peers()
    _fill(peer, 16)

    def broken_drop(_peer: Peer) -> None:
        raise RuntimeError("cleanup failed")

    monkeypatch.setattr(broker, "_drop", broken_drop)
    with pytest.raises(RuntimeError, match="cleanup failed"):
        broker.emit(peer, {"type": "ping"})
    assert broker.depth == 0


def _peers(count: int = 2) -> tuple[CallBroker, list[Peer]]:
    broker = CallBroker()
    auth = ServerAuth(EMAIL, int(time.time() + 300))
    peers = [Peer(auth, label, time.time() + 300) for label in "ABC"[:count]]
    for peer in peers:
        assert broker.add(peer)
    return broker, peers


def _fill(peer: Peer, count: int) -> None:
    peer.controls.clear()
    peer.controls.extend({"type": "ping"} for _ in range(count))


@pytest.mark.parametrize(("fill_a", "fill_b"), [(16, 14), (16, 0), (0, 16), (15, 15)])
def test_invite_overflow_is_a_clean_transition(fill_a: int, fill_b: int) -> None:
    broker, (a, b) = _peers()
    _fill(a, fill_a)
    _fill(b, fill_b)
    broker.command(a, Invite(type="invite", requestId="r", targetConnectionId=b.id))
    for peer in (a, b):
        if peer.closed:
            assert peer.id not in broker.peers
    if a.closed or b.closed:
        assert broker.call is None
        survivor = b if a.closed else a
        if not survivor.closed:
            assert not [m for m in survivor.controls if m["type"] in ("incoming", "outgoing")]


@pytest.mark.parametrize(("fill_a", "fill_b"), [(16, 14), (16, 0), (0, 16)])
def test_accept_overflow_is_a_clean_transition(fill_a: int, fill_b: int) -> None:
    broker, (a, b) = _peers()
    broker.command(a, Invite(type="invite", requestId="r", targetConnectionId=b.id))
    assert broker.call
    epoch = broker.call.id
    _fill(a, fill_a)
    _fill(b, fill_b)
    broker.command(b, CallAction(type="accept", callId=epoch))
    assert broker.call is None
    assert a.closed is (fill_a == 16) and b.closed is (fill_b >= 14)
    for peer in (a, b):
        stale = [m for m in peer.controls if m.get("callId") == epoch and m["type"] != "ended"]
        assert not stale
        if not peer.closed:
            ended = {"type": "ended", "callId": epoch, "reason": "disconnected"}
            assert ended in peer.controls


def test_connected_and_presence_overflow_are_clean_transitions() -> None:
    broker, (a, b) = _peers()
    broker.command(a, Invite(type="invite", requestId="r", targetConnectionId=b.id))
    assert broker.call
    epoch = broker.call.id
    broker.command(b, CallAction(type="accept", callId=epoch))
    broker.command(a, CallAction(type="ready", callId=epoch))
    _fill(a, 16)
    broker.command(b, CallAction(type="ready", callId=epoch))
    assert broker.call is None and a.closed and not b.closed
    assert not [m for m in b.controls if m.get("type") == "connected"]
    b.controls.extend({"type": "ping"} for _ in range(16 - len(b.controls)))
    auth = ServerAuth(EMAIL, int(time.time() + 300))
    c = Peer(auth, "C", time.time() + 300)
    assert broker.add(c)  # Presence to the full peer evicts it; no KeyError.
    assert b.closed and not c.closed and list(broker.peers) == [c.id]
    broker.shutdown()
    assert not broker.peers


@pytest.mark.parametrize("winner", ["a", "b"])
def test_crossing_invites_correlate_every_reply_and_keep_third_device_out(winner: str) -> None:
    broker, (a, b, c) = _peers(3)
    first, second = (a, b) if winner == "a" else (b, a)
    for peer in (a, b, c):
        peer.controls.clear()
    broker.command(first, Invite(type="invite", requestId="w", targetConnectionId=second.id))
    broker.command(second, Invite(type="invite", requestId="l", targetConnectionId=first.id))
    assert broker.call and broker.call.caller == first.id and broker.call.callee == second.id
    outgoing = [m for m in first.controls if m["type"] == "outgoing"]
    assert outgoing and outgoing[0]["requestId"] == "w"
    types = [m["type"] for m in second.controls]
    assert types.index("incoming") < types.index("unavailable")
    assert {"type": "unavailable", "requestId": "l"} in second.controls
    # The same-login third device sees only availability, never the call controls.
    assert {m["type"] for m in c.controls} <= {"presence"}
    broker.command(second, CallAction(type="accept", callId=broker.call.id))
    assert broker.call.state == "preparing"
