"""The narrow slice of `claude_agent_sdk.ClaudeSDKClient`'s real surface
`wixy_server.worker` actually drives (spec/independence/05 §2) — captured as a
`Protocol` + a factory type so tests inject `fake_agent_sdk.py`'s scripted double
instead of the real SDK (which needs a real `ANTHROPIC_API_KEY` and makes real,
billed API calls). The real `ClaudeSDKClient` satisfies this protocol structurally
(no adapter needed) — verified directly against the installed package's own
`inspect.signature()` output, not just its docs, since an early check of a summarized
docs page for a DIFFERENT `ResultMessage` claim (see decisions/00059) turned out to
be wrong.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import Protocol

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    RateLimitEvent,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    UserMessage,
)

AgentMessage = (
    UserMessage | AssistantMessage | SystemMessage | ResultMessage | StreamEvent | RateLimitEvent
)


class AgentSDKClient(Protocol):
    async def __aenter__(self) -> AgentSDKClient: ...

    # Matches ClaudeSDKClient's own real __aexit__ signature exactly (verified
    # via inspect.signature on the installed package) — the standard 3-arg
    # exception-info form returning bool, not the simplified *exc_info -> None
    # this repo's other backend clients use, because THIS is the one place
    # structural typing against the real SDK class matters (no adapter here).
    async def __aexit__(self, exc_type: object, exc_val: object, exc_tb: object) -> bool | None: ...

    async def query(self, prompt: str, session_id: str = "default") -> None: ...
    def receive_response(self) -> AsyncIterator[AgentMessage]: ...


AgentSDKClientFactory = Callable[[ClaudeAgentOptions], AgentSDKClient]


def real_agent_sdk_client(options: ClaudeAgentOptions) -> AgentSDKClient:
    return ClaudeSDKClient(options=options)
