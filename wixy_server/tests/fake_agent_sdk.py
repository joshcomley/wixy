"""A fake Agent SDK client (spec/independence/05 §4: "a fake Agent-SDK harness
(scripted tool-use episodes)") — implements `wixy_server.worker.agent_client.
AgentSDKClient`'s protocol so `wixy_server.worker`'s own tests run scripted
conversations without a real `ANTHROPIC_API_KEY` or any real, billed API calls.
Mirrors `fake_cmd.py`/`fake_github.py`/`fake_worker.py`'s own state-plus-factory
convention, adapted for a per-call SCRIPT rather than a shared state object,
since each Agent SDK query is its own bounded episode (a fixed list of messages
to yield, not an open-ended server session).

Not a `test_*.py` file — a reusable fixture module, imported by test files, never
collected by pytest itself.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass, field

from claude_agent_sdk import ClaudeAgentOptions

from wixy_server.worker.agent_client import AgentMessage, AgentSDKClient, AgentSDKClientFactory


@dataclass
class ScriptedEpisode:
    """One `create_fake_agent_sdk_client_factory(...)` call's worth of canned
    output — the messages `receive_response()` yields for the NEXT `query()`
    call. `raises`, if set, is raised from `__aenter__` instead (a connection/
    transport-level failure, distinct from an in-episode `ResultMessage(is_error
    =True)`, which `messages` itself can already express).

    `on_query`, if set, runs synchronously from `query()` before anything else
    — this fake never actually executes tools (it just yields canned
    transcript entries), so a test that needs to prove the WORKER correctly
    detects/pushes/PRs a real commit (spec/independence/05 §2's "the agent...
    branches" — i.e. the real thing `wixy_server.worker.workspace.head_sha`
    diffs against) uses this hook to make one for real in `options.cwd`,
    standing in for what the agent's own Bash-tool `git commit` would have
    done."""

    messages: Sequence[AgentMessage] = field(default_factory=list)
    raises: Exception | None = None
    on_query: Callable[[], None] | None = None


class FakeAgentSDKClient:
    """One instance per `factory(options)` call (matching `ClaudeSDKClient`'s
    own per-query-or-per-session construction) — pops the next scripted episode
    off the shared queue each time `query()` is called, so a multi-turn test
    (create, then send, then send again) gets a DIFFERENT canned response per
    turn, not the same one repeated."""

    def __init__(self, options: ClaudeAgentOptions, episodes: list[ScriptedEpisode]) -> None:
        self.options = options
        self._episodes = episodes
        self._current: ScriptedEpisode | None = None

    async def __aenter__(self) -> FakeAgentSDKClient:
        return self

    async def __aexit__(self, exc_type: object, exc_val: object, exc_tb: object) -> bool | None:
        return None

    async def query(self, prompt: str, session_id: str = "default") -> None:
        self._current = self._episodes.pop(0) if self._episodes else ScriptedEpisode()
        if self._current.on_query is not None:
            self._current.on_query()
        if self._current.raises is not None:
            raise self._current.raises

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        episode = self._current if self._current is not None else ScriptedEpisode()
        for message in episode.messages:
            yield message


def create_fake_agent_sdk_client_factory(
    episodes: list[ScriptedEpisode],
) -> tuple[list[FakeAgentSDKClient], AgentSDKClientFactory]:
    """Returns `(constructed_clients, factory)` — the factory to pass as
    `run_turn`'s/`create_worker_app`'s `client_factory`, and a list tests can
    inspect afterward (e.g. to assert `.options.cwd` or `.options.resume` on
    whichever client instance handled a given turn). `episodes` is SHARED and
    mutated (popped) across every constructed client, matching one script
    driving a whole multi-turn conversation across multiple `run_turn` calls.
    """
    constructed: list[FakeAgentSDKClient] = []

    def factory(options: ClaudeAgentOptions) -> AgentSDKClient:
        client = FakeAgentSDKClient(options, episodes)
        constructed.append(client)
        return client

    return constructed, factory
