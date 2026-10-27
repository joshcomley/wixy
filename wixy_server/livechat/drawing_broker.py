"""In-process live relay (spec/server-chat/07-live-drawing.md §4; generalised for Adventure Time's
live swipe trail, spec/server-chat/08-adventure-time.md §3.5/§4.2).

Deliberately SEPARATE from `LiveChatNotifier`: the notifier carries no data and only says
"re-read the database" (its own docstring). A live frame IS the data — in-progress pen points,
which can be handwriting, or a finger's swipe — so it must never be persisted, logged, or held any
longer than it takes to hand it to each open stream's queue (Inv 40/46: chat content).

A frame carries the name of the SSE event it goes out as: live drawing frames are
`drawing_live` (the default, byte-identical to before this was generalised) and Adventure Time's
trail frames are `adventure_live`. The queue and the broker are otherwise unchanged and still named
for their first use.

Same "anyio.Event swap" wake-up shape as `LiveChatNotifier` (`notifier.py`), applied per
connection instead of globally, plus a bounded `deque` per connection: `deque(maxlen=...)`
drops the OLDEST item itself on append past capacity, which is exactly the "a bounded queue of 64
items; overflow drops the oldest, because live preview is lossy by design" the spec
asks for — no explicit lock needed, since `append`/the swap happen with no `await` in
between and there is exactly one producer-side call site per route (`publish`, run from whichever
request thread posts a live batch) and one consumer (that connection's own stream loop).
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import anyio

from builder.jsontypes import JsonObject

QUEUE_MAX_FRAMES = 64
"""spec §4: "Each open /stream registers a bounded queue of 64 items.\""""

DRAWING_LIVE_EVENT = "drawing_live"
"""The SSE event name of a live drawing batch (and the default for any frame)."""


@dataclass(frozen=True, slots=True)
class LiveFrame:
    """One relayed frame: the SSE `event` name it is sent as and its JSON `data`."""

    event: str
    data: JsonObject


class LiveDrawingQueue:
    """One per open `/stream` connection."""

    def __init__(self) -> None:
        self._frames: deque[LiveFrame] = deque(maxlen=QUEUE_MAX_FRAMES)
        self._event = anyio.Event()

    def push(self, frame: JsonObject, event: str = DRAWING_LIVE_EVENT) -> None:
        self._frames.append(LiveFrame(event=event, data=frame))
        old_event, self._event = self._event, anyio.Event()
        old_event.set()

    def drain_frames(self) -> list[LiveFrame]:
        """Empties and returns every frame queued since the last drain, oldest first, each with
        the SSE event name it goes out as — what the stream loop uses."""
        frames = list(self._frames)
        self._frames.clear()
        return frames

    def drain(self) -> list[JsonObject]:
        """Empties and returns the queued frames' data only, oldest first (event names dropped)."""
        return [frame.data for frame in self.drain_frames()]

    @property
    def event(self) -> anyio.Event:
        """The event a waiter should capture BEFORE checking `drain()` is empty — the same
        no-`await`-in-between atomicity `LiveChatNotifier.wait` relies on."""
        return self._event


class DrawingBroker:
    """Registers one `LiveDrawingQueue` per open `/stream` connection and relays every
    live frame to ALL of them. The spec is explicit that this includes the sender's OWN
    other devices/tabs — a client ignores a live frame it is itself producing, matched
    client-side by its own client id, not here."""

    def __init__(self) -> None:
        self._queues: dict[int, LiveDrawingQueue] = {}
        self._next_id = 0

    def register(self) -> tuple[int, LiveDrawingQueue]:
        conn_id = self._next_id
        self._next_id += 1
        queue = LiveDrawingQueue()
        self._queues[conn_id] = queue
        return conn_id, queue

    def unregister(self, conn_id: int) -> None:
        self._queues.pop(conn_id, None)

    def publish(self, frame: JsonObject, event: str = DRAWING_LIVE_EVENT) -> None:
        for queue in self._queues.values():
            queue.push(frame, event)

    @property
    def connection_count(self) -> int:
        return len(self._queues)
