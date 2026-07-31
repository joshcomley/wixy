"""Whether a conversation's assistant is actively working right now — the
signal the conversation LIST (and `/api/admin/state`'s `chats` snapshot) uses
to pulse a row, so the site owner can tell a conversation is busy without
having to open it (decisions/00097, 00099).

Distinct from `chats.ChatRuntimeEntry.status` (pending/ready/failed — about
PROVISIONING a brand-new conversation) — this is about the ongoing back-and-
forth on an already-ready conversation, the same "working" fact the OPEN
conversation's own status strip already shows
(`admin-ui/src/chatPanel.ts:activityState`). Both read the IDENTICAL signal:
cmd's own `activity` field is a tri-state ENUM string ("working" | "idle" |
"dead", spec/06-ai-chat.md §"Status dot from `/status`"), never a timestamp —
`working` is a plain `activity == "working"` equality check, nothing time-
relative that the two sides could ever drift out of lockstep on. (Decisions/
00099 corrected an earlier version of this module that wrongly parsed
`activity` via `datetime.fromisoformat` and compared elapsed time against a
freshness window — since "working"/"idle" never parse as a valid datetime,
that ALWAYS evaluated `False` regardless of cmd's real state, invisible to
every test because the fake cmd server encoded the identical wrong
assumption; caught only by live verification against real cmd.)

TTL-cached per conversation (`_CACHE_TTL_S`) on `app.state` so the list's own
2s poll doesn't turn into one `client.status()` call to cmd per conversation
per poll tick — mirrors `routes_engine.EngineStatusCache`'s "one process-
lifetime cache slot, refreshed lazily on read, `time.monotonic()` for
staleness" convention, generalized here to one entry per conversation.

Every `client.status()` call is bounded by `_STATUS_TIMEOUT_S`, independent
of `CmdChatClient`'s own much more patient default (10s timeout x 3 retries
= up to 30s per call). But even a BOUNDED few seconds is too much to add to
`/api/admin/state` — a critical-path endpoint nearly every admin panel
depends on for its own instant render (CSS/RENDER doctrine) — so only ONE
caller ever triggers a live refresh: `working_for` (used by the dedicated
`GET .../conversations`, polled every 2s while the owner is actually
looking at the chat list — freshness matters there and the cost is
scoped to that screen). `/api/admin/state`'s own `chats` snapshot instead
calls the read-only `cached_working_for`, which NEVER awaits anything —
zero added latency, always. Its data goes stale only if nobody has viewed
the chat list in the last `cache_ttl_s`, which is an acceptable trade-off
(a quiet, correct-by-default `False`) for a field every OTHER panel's load
would otherwise pay for. Measured, not theoretical: an E2E run surfaced
first the UNBOUNDED version (2026-07-31, up to 30s per stale conversation
once its cmd session went away mid-suite) and then, after bounding it,
STILL surfaced that even a bounded couple of seconds shared across every
`/api/admin/state` call was enough to break unrelated tests' own timing
assumptions (a concurrent-edit race, a publish rev-conflict retry budget) —
this two-tier split is the fix that actually held.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import anyio

from wixy_server.ai.backend import AIBackend, AIBackendError, ConversationRef
from wixy_server.chats import ChatConversation

_CACHE_TTL_S = 5.0
_STATUS_TIMEOUT_S = 2.0
"""How long `working_for` waits for ANY ONE `client.status()` call before
giving up on it — deliberately much shorter than `CmdChatClient`'s own
10s-timeout/3-retry default (which is tuned for the chat STREAM, where
patience is correct — the owner is actively watching that one conversation).
This is a courtesy check for conversations the owner ISN'T necessarily even
looking at; a real, healthy, same-box cmd answers in low tens of
milliseconds, so 2s is generous slack, not a tight budget."""


def _is_working(activity: str | None) -> bool:
    """cmd's own tri-state enum, not a timestamp — see this module's own
    docstring for the bug this correction fixed (decisions/00099)."""
    return activity == "working"


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
    status_timeout_s: float = _STATUS_TIMEOUT_S

    def cached_working_for(self, conversations: list[ChatConversation]) -> dict[str, bool]:
        """The read-only twin of `working_for` — returns whatever is
        CURRENTLY cached for each conversation (default `False` for one
        never checked) and never awaits anything, so calling this costs
        nothing. For `/api/admin/state` only; see this module's own
        docstring for why that endpoint must never trigger a live check."""
        return {c.conv_id: self._entries.get(c.conv_id, (False, 0.0))[0] for c in conversations}

    async def working_for(
        self, client: AIBackend, conversations: list[ChatConversation]
    ) -> dict[str, bool]:
        """Returns `conv_id -> working` for every conversation passed in,
        refreshing whatever's missing or stale with a real `client.status()`
        call, fetched concurrently — a fresh conversation the caller polls
        every 2s costs at most one real cmd call per `cache_ttl_s`, not one
        per poll. The WHOLE batch resolves within `status_timeout_s`
        regardless of how many conversations are stale (concurrent, not
        sequential) or how unresponsive cmd is. For the dedicated
        conversation list ONLY — see this module's own docstring."""
        now_monotonic = time.monotonic()
        stale = [c for c in conversations if self._is_stale(c.conv_id, now_monotonic)]

        async def _refresh(conv: ChatConversation) -> None:
            working = False
            try:
                with anyio.move_on_after(self.status_timeout_s):
                    status = await client.status(ConversationRef(id=conv.session_id))
                    working = _is_working(status.activity)
            except AIBackendError:
                # cmd unreachable for this one conversation — never blocking
                # state (matches EngineStatusCache's own fallback reasoning):
                # read as "not working" rather than failing the whole list.
                pass
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
