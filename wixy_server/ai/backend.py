"""The AI backend interface (spec/independence/05 §1) — extracted from
`wixy_server.cmdchat.CmdChatClient`'s surface so `routes_chat.py` can run
against either backend Wixy supports: `cmd` (this module's `CmdAIBackend`,
today's code, behavior-identical) or `anthropic` (milestone 6, standalone-only,
the Claude Agent SDK on her own API key). `wixy_server.app.create_app` decides
which one to construct; `routes_chat.py` only ever sees the `AIBackend`
protocol, never a concrete backend type.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from wixy_server.cmdchat import (
    ChatMessage,
    ChatStatus,
    CmdChatClient,
    CmdChatError,
    ProvisioningOutcome,
    SendResult,
)


class AIBackendError(Exception):
    """A backend call failed — the same structured-error contract
    `wixy_server.cmdchat.CmdChatError` already provides (spec/06-ai-chat.md §1
    preamble: "structured errors surfaced to the UI, never a silent hang"), but
    backend-agnostic, so `routes_chat.py`'s `except` clauses don't need to know
    which concrete backend is active."""


@dataclass(frozen=True, slots=True)
class ConversationRef:
    """An opaque, backend-issued handle for one conversation (the spec's own
    `conv_ref`) — `routes_chat.py` persists `.id` exactly where it persists
    `session_id` today (`ChatConversation` is unchanged) and passes it back
    into every later backend call. A distinct type rather than a bare `str` so
    a future backend needing more than one field (e.g. a worker-container id
    alongside a conversation id) doesn't force every call site's signature to
    change."""

    id: str


class AIBackend(Protocol):
    """spec/independence/05 §1's four named methods (`create_conversation`,
    `send`, `read`, `status`), plus the two additional calls `routes_chat.py`'s
    existing behavior genuinely needs (readiness-tracking, handover-chain-
    following) and a lifecycle close — all already present in `CmdChatClient`
    today, just renamed/regrouped behind one shared shape both backends
    implement. `supports_handover_chains` is the spec's own named example
    capability flag: the `anthropic` backend (milestone 6) has no fleet
    handover concept at all, so `routes_chat.py` checks this before ever
    calling `get_chain`.
    """

    supports_handover_chains: bool

    async def create_conversation(
        self, preamble: str, first_message: str | None
    ) -> ConversationRef: ...

    async def send(
        self, conv_ref: ConversationRef, text: str, idempotency_key: str
    ) -> SendResult: ...

    async def read(
        self,
        conv_ref: ConversationRef,
        *,
        after: int | None = None,
        limit: int = 80,
        include_thinking: bool = False,
    ) -> list[ChatMessage]:
        """`after` (an already-seen message index) is genuine, working
        filtering on every backend — but `routes_chat.py`'s existing stream
        deliberately doesn't pass it yet (it does its own self-diffing today,
        spec/06 §1; changing that call pattern is out of scope for this
        milestone's behavior-identical extraction). Present now because a
        future backend with its own real transcript store (milestone 6's
        worker, a JSONL file) can serve it cheaply server-side, unlike `cmd`'s
        API, which has no such filter and falls back to a client-side filter
        of the same fetched batch (see `CmdAIBackend.read`)."""
        ...

    async def status(self, conv_ref: ConversationRef) -> ChatStatus: ...

    async def wait_until_ready(self, conv_ref: ConversationRef) -> ProvisioningOutcome: ...

    async def get_chain(self, conv_ref: ConversationRef) -> list[str]:
        """Only ever called when `supports_handover_chains` is `True` — a
        backend that sets the flag `False` may leave this unimplemented
        (raising is fine; `routes_chat.py` never reaches it)."""
        ...

    async def aclose(self) -> None: ...


class CmdAIBackend:
    """The `cmd` backend (`WIXY_AI_BACKEND=cmd`, the fleet default) — wraps an
    existing `CmdChatClient` unchanged; every method here is a straight
    passthrough (behavior-identical, spec/independence/05 §1) with
    `CmdChatError` translated to the backend-agnostic `AIBackendError`."""

    supports_handover_chains = True

    def __init__(self, client: CmdChatClient, *, cmd_project: str) -> None:
        self._client = client
        self._cmd_project = cmd_project

    async def create_conversation(
        self, preamble: str, first_message: str | None
    ) -> ConversationRef:
        prompt = preamble if not first_message else f"{preamble}\n\n---\n\n{first_message}"
        try:
            result = await self._client.new_chat(self._cmd_project, prompt)
        except CmdChatError as exc:
            raise AIBackendError(str(exc)) from exc
        return ConversationRef(id=result.session_id)

    async def send(self, conv_ref: ConversationRef, text: str, idempotency_key: str) -> SendResult:
        try:
            return await self._client.send_message(conv_ref.id, text, idempotency_key)
        except CmdChatError as exc:
            raise AIBackendError(str(exc)) from exc

    async def read(
        self,
        conv_ref: ConversationRef,
        *,
        after: int | None = None,
        limit: int = 80,
        include_thinking: bool = False,
    ) -> list[ChatMessage]:
        try:
            messages = await self._client.get_messages(
                conv_ref.id, limit=limit, include_thinking=include_thinking
            )
        except CmdChatError as exc:
            raise AIBackendError(str(exc)) from exc
        if after is None:
            return messages
        # cmd's own API has no "after" filter (only `before`, a different
        # direction) — filter the fetched batch client-side rather than
        # leaving `after` silently ignored.
        return [m for m in messages if m.index > after]

    async def status(self, conv_ref: ConversationRef) -> ChatStatus:
        try:
            return await self._client.get_status(conv_ref.id)
        except CmdChatError as exc:
            raise AIBackendError(str(exc)) from exc

    async def wait_until_ready(self, conv_ref: ConversationRef) -> ProvisioningOutcome:
        try:
            return await self._client.wait_until_ready(conv_ref.id)
        except CmdChatError as exc:
            raise AIBackendError(str(exc)) from exc

    async def get_chain(self, conv_ref: ConversationRef) -> list[str]:
        try:
            return await self._client.get_chain(conv_ref.id)
        except CmdChatError as exc:
            raise AIBackendError(str(exc)) from exc

    async def aclose(self) -> None:
        await self._client.aclose()
