"""In-memory conversation state the worker's FastAPI app (`wixy_server.worker.app`)
operates on (spec/independence/05 §2). One process, one dict — the worker is a
single-purpose, single-tenant service (her own droplet, her own conversations at a
time), unlike `wixy_server.chats`'s durable JSON-file store, which the MAIN server
process needs because it can restart independently of any in-flight conversation.
A worker restart losing in-flight conversation state is an accepted tradeoff (rare,
and re-sending the last message starts a fresh one) — not solved here, matching the
milestone's own "largest single milestone" scope discipline.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from builder.jsontypes import JsonObject


@dataclass(slots=True)
class WorkerMessage:
    index: int
    role: str  # user | assistant
    kind: str  # text | tool_use | tool_result | thinking | error
    text: str | None
    timestamp: str
    tool_name: str | None = None
    truncated: bool = False

    def to_json(self) -> JsonObject:
        return {
            "index": self.index,
            "role": self.role,
            "kind": self.kind,
            "text": self.text,
            "timestamp": self.timestamp,
            "toolName": self.tool_name,
            "truncated": self.truncated,
        }


@dataclass(slots=True)
class WorkerConversation:
    conv_id: str
    preamble: str
    sdk_session_id: str | None = None
    messages: list[WorkerMessage] = field(default_factory=list)
    ready: bool = False
    failure_reason: str | None = None
    failure_message: str | None = None
    activity: str | None = None
    total_cost_usd: float = 0.0
    idempotency_seen: dict[str, int] = field(default_factory=dict)

    def next_index(self) -> int:
        return len(self.messages)

    def append(self, message: WorkerMessage) -> None:
        self.messages.append(message)
        self.activity = message.timestamp


@dataclass(slots=True)
class WorkerState:
    conversations: dict[str, WorkerConversation] = field(default_factory=dict)
    next_id_n: int = 1
    # Month-to-date spend across every conversation (spec/independence/05 §2:
    # "the worker tracks spend... Settings -> AI card shows month-to-date
    # spend") — a single running total, reset externally by whatever process
    # notices the month rolled over (see wixy_server/worker/budget.py, a later
    # slice); tracked here now so `total_cost_usd` accumulation has somewhere
    # real to land as soon as conversations start producing cost.
    month_to_date_usd: float = 0.0

    def new_conversation(self, preamble: str) -> WorkerConversation:
        n = self.next_id_n
        self.next_id_n += 1
        conv = WorkerConversation(conv_id=f"anthropic-{n}", preamble=preamble)
        self.conversations[conv.conv_id] = conv
        return conv
