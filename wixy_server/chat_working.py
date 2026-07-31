"""Whether a conversation's assistant is actively working right now — the
signal the conversation LIST (and `/api/admin/state`'s `chats` snapshot) uses
to pulse a row, so the site owner can tell a conversation is busy without
having to open it (decisions/00097).

Distinct from `chats.ChatRuntimeEntry.status` (pending/ready/failed — about
PROVISIONING a brand-new conversation) — this is about the ongoing back-and-
forth on an already-ready conversation, the same "working" fact the OPEN
conversation's own status strip already shows
(`admin-ui/src/chatPanel.ts:activityState`, `WORKING_FRESHNESS_MS = 10_000`).
`_FRESHNESS_S` below must stay in lockstep with that constant — both decide
"is this conversation working" from the same cmd `activity` timestamp, and a
list row disagreeing with the open conversation's own strip about the same
fact would be a visible bug, not just an inconsistency.

TTL-cached per conversation (`_CACHE_TTL_S`) on `app.state` so the list's own
2s poll doesn't turn into one `client.status()` call to cmd per conversation
per poll tick — mirrors `routes_engine.EngineStatusCache`'s "one process-
lifetime cache slot, refreshed lazily on read, `time.monotonic()` for
staleness" convention, generalized here to one entry per conversation.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import UTC, datetime

import anyio

from wixy_server.ai.backend import AIBackend, AIBackendError, ConversationRef
from wixy_server.chats import ChatConversation

_FRESHNESS_S = 10.0
_CACHE_TTL_S = 5.0


def _is_fresh(activity: str | None, now: datetime) -> bool:
    if activity is None:
        return False
    try:
        parsed = datetime.fromisoformat(activity)
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return (now - parsed).total_seconds() < _FRESHNESS_S


@dataclass
class WorkingCache:
    """One instance lives on `app.state` for the app's whole lifetime.
    `_entries: conv_id -> (working, cached_at_monotonic)`.

    `cache_ttl_s` defaults to the production value but is overridable —
    mirrors `routes_chat.StreamTiming`'s own "bundle the real timing
    constant so tests can shrink it instead of waiting on real wall-clock
    seconds" convention. A test that wants to observe a state change
    immediately after mutating the fake cmd's activity (rather than either
    waiting out 5 real seconds or racing the cache) sets this to `0`."""

    _entries: dict[str, tuple[bool, float]] = field(default_factory=dict)
    cache_ttl_s: float = _CACHE_TTL_S

    async def working_for(
        self, client: AIBackend, conversations: list[ChatConversation]
    ) -> dict[str, bool]:
        """Returns `conv_id -> working` for every conversation passed in.
        Only entries whose cache is missing or stale trigger a real
        `client.status()` call, fetched concurrently — a fresh conversation
        the caller polls every 2s costs at most one real cmd call per
        `cache_ttl_s`, not one per poll."""
        now_monotonic = time.monotonic()
        stale = [c for c in conversations if self._is_stale(c.conv_id, now_monotonic)]

        async def _refresh(conv: ChatConversation) -> None:
            try:
                status = await client.status(ConversationRef(id=conv.session_id))
                working = _is_fresh(status.activity, datetime.now(UTC))
            except AIBackendError:
                # cmd unreachable for this one conversation — never blocking
                # state (matches EngineStatusCache's own fallback reasoning):
                # read as "not working" rather than failing the whole list.
                working = False
            self._entries[conv.conv_id] = (working, now_monotonic)

        if stale:
            async with anyio.create_task_group() as tg:
                for conv in stale:
                    tg.start_soon(_refresh, conv)

        return {
            c.conv_id: self._entries.get(c.conv_id, (False, now_monotonic))[0]
            for c in conversations
        }

    def _is_stale(self, conv_id: str, now_monotonic: float) -> bool:
        entry = self._entries.get(conv_id)
        return entry is None or (now_monotonic - entry[1]) >= self.cache_ttl_s
