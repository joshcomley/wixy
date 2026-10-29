"""One-process, one-pair voice relay. Mutations never await: ownership is atomic.

The event loop is the serialization boundary. Socket/database I/O is exclusively in
the route's bounded workers, never inside these state transitions.
"""

from __future__ import annotations

import asyncio
import functools
import threading
import time
from collections import deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Concatenate
from uuid import uuid4

from builder.jsontypes import JsonObject
from wixy_server.livechat.call_protocol import (
    LEASE_S,
    Ack,
    CallAction,
    Command,
    Invite,
    Lease,
    Mute,
    Pong,
    forward_frame,
    unpack_frame,
)
from wixy_server.livechat.tokens import ServerAuth


class CallCapacityError(RuntimeError):
    """Synchronous auth/grant work is at its fixed cap; fail closed without locking."""


class CallWork:
    """Fixed-capacity synchronous jobs whose permits are released by the job itself.

    A cancelled or timed-out awaiter never frees a permit while its thread still runs;
    a job cancelled before it starts frees it through the same done-callback. Its own
    executor keeps blocked call work off AnyIO's shared default thread limiter.
    """

    def __init__(self, capacity: int, name: str) -> None:
        self.capacity = capacity
        self.work = 0
        self.closed = False
        self.lock = threading.Lock()
        self.executor = ThreadPoolExecutor(capacity, thread_name_prefix=name)

    async def run[T](self, job: Callable[[], T]) -> T:
        with self.lock:
            if self.closed or self.work >= self.capacity:
                raise CallCapacityError("call work capacity")
            self.work += 1
        try:
            future = self.executor.submit(job)
        except BaseException:
            self.finished(None)
            raise
        future.add_done_callback(self.finished)
        return await asyncio.wrap_future(future)

    def finished(self, _future: object) -> None:
        with self.lock:
            self.work -= 1

    def close(self) -> None:
        """Queued jobs are cancelled; running synchronous calls cannot be interrupted
        and keep their permits (and the process's exit) until they return."""
        with self.lock:
            self.closed = True
        self.executor.shutdown(wait=False, cancel_futures=True)


def transition[**P, R](
    method: Callable[Concatenate[CallBroker, P], R],
) -> Callable[Concatenate[CallBroker, P], R]:
    """Queue overflow only marks a peer; membership changes after the outermost step."""

    @functools.wraps(method)
    def wrapper(self: CallBroker, /, *args: P.args, **kwargs: P.kwargs) -> R:
        self.depth += 1
        try:
            return method(self, *args, **kwargs)
        finally:
            try:
                if self.depth == 1:
                    while self.evicting:
                        self._drop(self.evicting.popleft())
            finally:
                self.depth -= 1

    return wrapper


@dataclass
class Budget:
    rate: float
    capacity: float
    tokens: float = -1
    at: float = field(default_factory=time.monotonic)

    def take(self, now: float) -> bool:
        if self.tokens < 0:
            self.tokens = self.capacity
        self.tokens = min(self.capacity, self.tokens + max(0, now - self.at) * self.rate)
        self.at = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True


@dataclass
class Peer:
    auth: ServerAuth
    label: str
    deadline: float
    id: str = field(default_factory=lambda: uuid4().hex)
    controls: deque[JsonObject] = field(default_factory=deque)
    media: deque[tuple[str, bytes]] = field(default_factory=lambda: deque(maxlen=5))
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    closed: bool = False
    # 50 playout acknowledgements + 10 leases + heartbeat and UI controls per second.
    controls_budget: Budget = field(default_factory=lambda: Budget(80, 100))
    media_budget: Budget = field(default_factory=lambda: Budget(55, 10))
    invites_budget: Budget = field(default_factory=lambda: Budget(0.1, 2))
    requests: deque[tuple[str, str, float]] = field(default_factory=lambda: deque(maxlen=32))
    pong_at: float = field(default_factory=time.monotonic)
    grant_until: float = float("inf")
    capture_leases: deque[tuple[int, float]] = field(default_factory=lambda: deque(maxlen=4))
    lease_counter: int = 0
    playout: tuple[int, float] = (0, 0)
    outstanding: dict[int, float] = field(default_factory=dict)
    sequence: int = -1
    sample: int = -480
    muted: bool = False
    fresh_at: float = field(default_factory=time.monotonic)
    last_terminal: str | None = None


@dataclass
class Call:
    caller: str
    callee: str
    request_id: str
    id: str = field(default_factory=lambda: uuid4().hex)
    state: str = "ringing"
    until: float = field(default_factory=lambda: time.monotonic() + 30)
    ready: set[str] = field(default_factory=set)

    def contains(self, peer: Peer) -> bool:
        return peer.id in (self.caller, self.callee)


class CallBroker:
    def __init__(self) -> None:
        self.peers: dict[str, Peer] = {}
        self.call: Call | None = None
        self.closed = False
        self.pending = 0
        # Route-owned slots include disconnected sockets still joining bounded DB
        # workers, so rapid reconnects cannot accumulate unlimited closing workers.
        self.connections = 0
        # Bounded identity table; do not evict live rate limits under a flood.
        self.admissions: dict[str, Budget] = {}
        self.depth = 0
        self.evicting: deque[Peer] = deque()
        # Separate owners: a slow Access/JWKS verifier cannot starve live calls' grant
        # refresh, and orphaned refreshes cannot block new admissions. Nominal 4 + 8.
        self.admission_work = CallWork(4, "wixy-call-admission")
        self.refresh_work = CallWork(8, "wixy-call-refresh")

    @transition
    def emit(self, peer: Peer, message: JsonObject) -> None:
        if peer.closed:
            return
        if len(peer.controls) >= 16:
            # Fail this socket now; unlink it once the enclosing transition completes.
            peer.closed = True
            peer.controls.clear()
            peer.wake.set()
            self.evicting.append(peer)
            return
        peer.controls.append(message)
        peer.wake.set()

    @transition
    def add(self, peer: Peer) -> bool:
        now = time.monotonic()
        if self.closed or len(self.peers) >= 8:
            return False
        if peer.auth.email not in self.admissions:
            if len(self.admissions) >= 128:
                expired = [k for k, v in self.admissions.items() if now - v.at > 60]
                for key in expired:
                    del self.admissions[key]
                if len(self.admissions) >= 128:
                    return False
            self.admissions[peer.auth.email] = Budget(0.2, 4)
        if not self.admissions[peer.auth.email].take(now):
            return False
        self.peers[peer.id] = peer
        self.emit(peer, {"type": "welcome", "connectionId": peer.id, "deadline": peer.deadline})
        self.presence()
        return not peer.closed

    @transition
    def presence(self) -> None:
        busy = (self.call.caller, self.call.callee) if self.call else ()
        for peer in list(self.peers.values()):
            self.emit(
                peer,
                {
                    "type": "presence",
                    "peers": [
                        {"id": p.id, "label": p.label, "available": p.id not in busy}
                        for p in self.peers.values()
                        if p.id != peer.id
                    ],
                },
            )

    def permitted(self, peer: Peer) -> bool:
        return (
            not peer.closed
            and self.peers.get(peer.id) is peer
            and time.time() < peer.deadline
            and time.monotonic() < peer.grant_until
        )

    @transition
    def finish(self, reason: str) -> None:
        call, self.call = self.call, None
        if call is None:
            return
        for key in (call.caller, call.callee):
            peer = self.peers.get(key)
            if peer:
                peer.last_terminal = call.id
                peer.media.clear()
                peer.outstanding.clear()
                peer.capture_leases.clear()
                peer.playout = (0, 0)
                peer.sequence, peer.sample, peer.muted = -1, -480, False
                # Invalidate already queued prepare/connected/lease controls too.
                peer.controls = deque(m for m in peer.controls if m.get("callId") != call.id)
                terminal: JsonObject = {"type": "ended", "callId": call.id, "reason": reason}
                if key == call.caller:
                    terminal["requestId"] = call.request_id
                self.emit(peer, terminal)
        self.presence()

    @transition
    def remove(self, peer: Peer) -> None:
        self._drop(peer)

    def _drop(self, peer: Peer) -> None:
        if self.peers.get(peer.id) is not peer:
            peer.closed = True
            peer.wake.set()
            return
        peer.closed = True
        del self.peers[peer.id]
        had_call = bool(self.call and self.call.contains(peer))
        if had_call:
            self.finish("disconnected")
        peer.media.clear()
        peer.outstanding.clear()
        peer.capture_leases.clear()
        peer.playout = (0, 0)
        peer.last_terminal = None
        peer.controls.clear()
        peer.wake.set()
        if not had_call:
            self.presence()

    @transition
    def shutdown(self) -> None:
        self.closed = True
        self.finish("unavailable")
        for peer in list(self.peers.values()):
            self.remove(peer)
        self.admission_work.close()
        self.refresh_work.close()

    @transition
    def command(self, peer: Peer, command: Command) -> None:
        now = time.monotonic()
        if not self.permitted(peer) or not peer.controls_budget.take(now):
            raise ValueError("control budget")
        if isinstance(command, Pong):
            peer.pong_at = now
            return
        if isinstance(command, Invite):
            for request, target, at in peer.requests:
                if request == command.requestId and now - at < 60:
                    if target != command.targetConnectionId:
                        raise ValueError("request reused")
                    return
            peer.requests.append((command.requestId, command.targetConnectionId, now))
            target_peer = self.peers.get(command.targetConnectionId)
            if (
                self.call
                or not target_peer
                or target_peer is peer
                or not self.permitted(target_peer)
                or not peer.invites_budget.take(now)
            ):
                # Correlated, so a crossing caller's loss never erases its incoming call.
                self.emit(peer, {"type": "unavailable", "requestId": command.requestId})
                return
            invited = self.call = Call(peer.id, target_peer.id, request_id=command.requestId)
            self.emit(
                peer,
                {
                    "type": "outgoing",
                    "callId": invited.id,
                    "peer": target_peer.label,
                    "requestId": command.requestId,
                },
            )
            self.emit(target_peer, {"type": "incoming", "callId": invited.id, "peer": peer.label})
            if not peer.closed and not target_peer.closed:
                self.presence()
            return
        call = self.call
        if call is not None and now >= call.until:
            self.finish("timeout")
            call = None
        # Terminal controls may already be in flight when the other side ends.
        # Only this socket's last former pair epoch is eligible; no new authority.
        harmless_terminal = isinstance(command, (Ack, Lease, Mute)) or (
            isinstance(command, CallAction)
            # `ready` crosses the other side's `failed`/`end` on the wire: this device finished
            # preparing audio a few ms after the pair had already ended. It is not an
            # ownership violation and must not close the (healthy) socket.
            and command.type in ("end", "decline", "failed", "ready")
        )
        if harmless_terminal and command.callId == peer.last_terminal:
            return
        if call is None or command.callId != call.id or not call.contains(peer):
            raise ValueError("call ownership")
        if isinstance(command, CallAction):
            if command.type in ("end", "failed"):
                self.finish("ended" if command.type == "end" else "audio_unavailable")
            elif command.type in ("accept", "decline"):
                if peer.id != call.callee or call.state != "ringing":
                    raise ValueError("answer role")
                if command.type == "decline":
                    self.finish("declined")
                else:
                    call.state, call.until = "preparing", now + 20
                    for key in (call.caller, call.callee):
                        self.emit(self.peers[key], {"type": "prepare", "callId": call.id})
            elif command.type == "ready":
                if call.state != "preparing" or peer.id in call.ready:
                    raise ValueError("ready state")
                call.ready.add(peer.id)
                if len(call.ready) == 2:
                    call.state, call.until = "connected", now + 7200
                    for key in (call.caller, call.callee):
                        self.peers[key].fresh_at = now
                        self.emit(self.peers[key], {"type": "connected", "callId": call.id})
            return
        if call.state != "connected":
            raise ValueError("not connected")
        if isinstance(command, Mute):
            peer.muted = command.muted
            receiver = self.other(peer)
            receiver.media.clear()
            self.emit(receiver, {"type": "muted", "callId": call.id, "muted": command.muted})
        elif isinstance(command, Lease):
            if command.lease <= peer.playout[0]:
                raise ValueError("lease replay")
            peer.playout = (command.lease, now + LEASE_S)
            peer.fresh_at = now
        elif isinstance(command, Ack):
            if command.sequence not in peer.outstanding:
                raise ValueError("ack replay")
            del peer.outstanding[command.sequence]

    def other(self, peer: Peer) -> Peer:
        assert self.call and self.call.contains(peer)
        return self.peers[self.call.callee if peer.id == self.call.caller else self.call.caller]

    def _media_other(self, peer: Peer, now: float) -> Peer | None:
        """One cached authority gate inside admission/dequeue's synchronous transition."""
        if not self.permitted(peer):
            self.remove(peer)
            return None
        call = self.call
        if call is None or call.state != "connected" or not call.contains(peer):
            return None
        other_id = call.callee if peer.id == call.caller else call.caller
        other = self.peers.get(other_id)
        if other is None:
            self.finish("disconnected")
            return None
        if not self.permitted(other):
            self.remove(other)
            return None
        if now >= call.until:
            self.finish("timeout")
            return None
        return other

    @transition
    def frame(self, peer: Peer, data: bytes) -> None:
        now = time.monotonic()
        epoch, seq, sample, lease = unpack_frame(data)
        if not self.permitted(peer):
            self.remove(peer)
            raise ValueError("media permission")
        if not peer.media_budget.take(now):
            raise ValueError("media permission")
        if epoch == peer.last_terminal:
            return  # Former-pair in-flight audio is discarded, never rerouted.
        call = self.call
        if (
            not self.permitted(peer)
            or not call
            or not call.contains(peer)
            or call.state != "connected"
            or epoch != call.id
            or peer.muted
        ):
            raise ValueError("media permission")
        receiver = self._media_other(peer, now)
        if receiver is None:
            return
        if seq <= peer.sequence or sample <= peer.sample or sample != seq * 480:
            raise ValueError("sample sequence")
        if seq - peer.sequence > 1000:
            raise ValueError("sample jump")
        peer.sequence, peer.sample = seq, sample
        if not any(n == lease and until > now for n, until in peer.capture_leases):
            return  # Stale TCP audio is discarded, never made fresh by receipt.
        if receiver.playout[1] <= now:
            return
        receiver.media.append((epoch, forward_frame(data, receiver.playout[0])))
        receiver.wake.set()

    @transition
    def next_media(self, peer: Peer) -> bytes | None:
        now = time.monotonic()
        call = self.call
        if self._media_other(peer, now) is None:
            peer.media.clear()
            return None
        assert call is not None
        if len(peer.outstanding) >= 5:
            return None
        while peer.media:
            epoch, data = peer.media.popleft()
            if epoch != call.id or peer.playout[1] <= now:
                continue
            seq = int.from_bytes(data[20:24], "big")
            peer.outstanding[seq] = now
            return data
        return None

    @transition
    def tick(self, peer: Peer) -> None:
        now = time.monotonic()
        if not self.permitted(peer) or now - peer.pong_at > 6:
            self.remove(peer)
            return
        call = self.call
        if not call or not call.contains(peer):
            return
        if now >= call.until:
            self.finish("timeout")
            return
        if any(now - sent > 0.5 for sent in peer.outstanding.values()):
            self.finish("connection_slow")
            return
        if call.state == "connected":
            if now - peer.fresh_at > 0.5:
                self.finish("connection_slow")
                return
            peer.lease_counter += 1
            peer.capture_leases.append((peer.lease_counter, now + LEASE_S))
            self.emit(peer, {"type": "capture", "callId": call.id, "lease": peer.lease_counter})
