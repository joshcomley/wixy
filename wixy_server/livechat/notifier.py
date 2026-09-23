"""In-process SSE wake-up (spec/server-chat/00-brief.md §3: "Server fan-out uses an
in-process notifier plus a 2 s DB re-check, so a blue/green slot-swap overlap (two
processes, one SQLite file) can never strand a message").

Deliberately NOT cross-process: this only wakes `GET /stream` loops running in THIS
worker. The 2 s re-check timeout (`routes_livechat.py`'s stream loop, §3 step 3) is
what covers the other process in a slot-swap overlap — a message a sibling process
wrote is picked up within 2 s even though this notifier never fires for it. Tests
prove that fallback path directly (write via a second `LiveChatStore` instance,
confirm delivery without ever calling this notifier's `publish()`).
"""

from __future__ import annotations

import anyio


class LiveChatNotifier:
    """The "anyio.Event swap" pattern (§3 architecture diagram): each `publish()`
    swaps in a fresh `anyio.Event` and sets the old one, releasing every waiter that
    captured it. A waiter that calls `wait()` AFTER a publish simply waits on the
    new (unset) event — no missed-wakeup window, since capturing `self._event` and
    awaiting it happen with no `await` in between (cooperative scheduling: nothing
    can run `publish()` in the middle of that)."""

    def __init__(self) -> None:
        self._event = anyio.Event()

    def publish(self) -> None:
        old_event, self._event = self._event, anyio.Event()
        old_event.set()

    async def wait(self, *, timeout_s: float) -> None:
        """Returns when either `publish()` is next called, or `timeout_s` elapses —
        the stream loop treats both outcomes identically (re-check the DB either
        way), so this deliberately reports neither reason back to the caller."""
        event = self._event
        with anyio.move_on_after(timeout_s):
            await event.wait()
