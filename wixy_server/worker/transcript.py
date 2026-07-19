"""Per-conversation transcript persistence (spec/independence/05 §2: "the
worker persists conversations as JSONL compatible with the existing chat
panel's message model — the UI is backend-blind"). One JSON object per line,
in the SAME wire shape `WorkerMessage.to_json()` already produces (matching
`ChatMessage`, what `AnthropicAIBackend.read()` parses) — never a bespoke
format needing its own translation layer if something later needs to read it
back.

Durability only, not rehydration: a worker restart still loses the IN-MEMORY
`WorkerState` (`sdk_session_id`, `ready`/`failure` flags, idempotency
tracking — see `wixy_server.worker.state`'s own accepted-tradeoff docstring),
but a completed turn's message history survives the process restarting.
Written on its OWN dedicated volume/root (`WorkerSettings.transcripts_root`,
`docker-compose.yml`'s separate `worker-transcripts` volume) — deliberately
NOT inside `WorkerSettings.scratch_root` (the per-conversation git clone
itself): the agent has unrestricted Bash access inside that clone for the
rest of its turn (spec §3), and a broad `git add -A`/`git commit` (a common
enough agent habit) would otherwise risk committing the conversation
transcript straight into the owner's SITE REPO history. Keeping transcripts
on a wholly separate path makes that impossible, not just unlikely — the
agent's own clone directory never contains this file at all.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from wixy_server.worker.state import WorkerMessage

_TRANSCRIPT_FILENAME = "transcript.jsonl"


def transcript_path(transcripts_root: Path, conv_id: str) -> Path:
    return transcripts_root / conv_id / _TRANSCRIPT_FILENAME


def write_transcript(transcripts_root: Path, conv_id: str, messages: list[WorkerMessage]) -> None:
    """Rewrites the conversation's WHOLE transcript (not a true incremental
    append) — called after each turn completes (`wixy_server.worker.app`),
    so this is at most one extra file write per turn, not one per streamed
    message chunk, and every completed turn's messages land durably in one
    shot. Tmp-file-in-the-same-dir + `os.replace` (this codebase's own
    established atomicity convention, `builder.content.atomic_write_json`)
    so a concurrent reader (or a worker crash mid-write) never observes a
    truncated file — adapted here for raw JSONL text rather than a single
    JSON value, since `atomic_write_json` itself only handles the latter.
    """
    path = transcript_path(transcripts_root, conv_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "".join(json.dumps(message.to_json()) + "\n" for message in messages)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        tmp_path.write_text(text, encoding="utf-8")
        os.replace(tmp_path, path)
    finally:
        tmp_path.unlink(missing_ok=True)
