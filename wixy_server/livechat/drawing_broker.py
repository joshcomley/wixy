"""In-process live-drawing relay (spec/server-chat/07-live-drawing.md §4).

Deliberately SEPARATE from `LiveChatNotifier`: the notifier carries no data and only says
"re-read the database" (its own docstring). A live drawing frame IS the data — in-progress
pen points, which can be handwriting — so it must never be persisted, logged, or held any
longer than it takes to hand it to each open stream's queue (Inv 40/46: chat content).

Same "anyio.Event swap" wake-up shape as `LiveChatNotifier` (`notifier.py`), applied per
connection instead of globally, plus a bounded `deque` per connection: `deque(maxlen=...)`
drops the OLDEST item itself on append past capacity, which is exactly the "a bounded queue
of 64 items; overflow drops the oldest, because live preview is lossy by design" the spec
asks for — no explicit lock needed, since `append`/the swap happen with no `await` in
between and there is exactly one producer-side call site (`publish`, run from whichever
request thread posts a live batch) and one consumer (that connection's own stream loop).
"""

from __future__ import annotations

from collections import deque

import anyio

from builder.jsontypes import JsonObject

QUEUE_MAX_FRAMES = 64
"""spec §4: "Each open /stream registers a bounded queue of 64 items.\""""


class LiveDrawingQueue:
    """One per open `/stream` connection."""

    def __init__(self) -> None:
        self._frames: deque[JsonObject] = deque(maxlen=QUEUE_MAX_FRAMES)
        self._event = anyio.Event()

    def push(self, frame: JsonObject) -> None:
        self._frames.append(frame)
        old_event, self._event = self._event, anyio.Event()
        old_event.set()

    def drain(self) -> list[JsonObject]:
        """Empties and returns every frame queued since the last drain, oldest first."""
        frames = list(self._frames)
        self._frames.clear()
        return frames

    @property
    def event(self) -> anyio.Event:
        """The event a waiter should capture BEFORE checking `drain()` is empty — the same
        no-`await`-in-between atomicity `LiveChatNotifier.wait` relies on."""
        return self._event


class DrawingBroker:
    """Registers one `LiveDrawingQueue` per open `/stream` connection and relays every
    live batch to ALL of them. The spec is explicit that this includes the drawer's OWN
    other devices/tabs — a client ignores a live frame for a drawing it is itself
    drawing, matched client-side by `drawingClientId`, not here."""

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

    def publish(self, frame: JsonObject) -> None:
        for queue in self._queues.values():
            queue.push(frame)

    @property
    def connection_count(self) -> int:
        return len(self._queues)
