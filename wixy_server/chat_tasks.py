"""The `wixy-tasks` protocol: an assistant reply may embed a fenced

```wixy-tasks
{"tasks": [...]}
```

block — a live progress list the site owner sees while the assistant works,
instead of only a generic "Assistant is working…" strip. The instruction to
the model lives in `templates/chat_preamble.md`; this module is the
SERVER-side half — extract the block(s) and strip them out of what the owner
sees, mirroring `preamble.py`'s own compose/strip pairing (a raw JSON block
in a non-developer's chat is exactly the kind of internal-plumbing leak
decisions/00093 already fixed once, for the preamble itself).

Runs downstream of `_owner_visible` in `routes_chat.py:_stream_events` (per
that function's own note on ordering: strip what the owner must never see at
all first, then extract structured protocol out of what remains) — a
`wixy-tasks` block only ever appears in an ASSISTANT message, never inside
the preamble-bearing first USER message, so the two never interact.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Literal

TaskStatus = Literal["pending", "doing", "done"]

_VALID_STATUSES = frozenset(("pending", "doing", "done"))

# Tolerates leading indentation before the fence (a model may nest it under a
# list item) and CRLF line endings; the JSON body is captured non-greedily so
# multiple blocks in one message are found as separate matches, not one blob.
_FENCE_RE = re.compile(r"[ \t]*```wixy-tasks[ \t]*\r?\n(.*?)\r?\n[ \t]*```[ \t]*\r?\n?", re.DOTALL)


@dataclass(frozen=True, slots=True)
class TaskItem:
    label: str
    status: TaskStatus


def _parse_block(raw_json: str) -> list[TaskItem] | None:
    """`None` for anything that doesn't cleanly parse into the exact expected
    shape — a malformed block is still stripped by the caller (it's internal
    protocol noise regardless), it just doesn't produce a task list."""
    try:
        data = json.loads(raw_json)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    tasks_raw = data.get("tasks")
    if not isinstance(tasks_raw, list) or not tasks_raw:
        return None
    tasks: list[TaskItem] = []
    for item in tasks_raw:
        if not isinstance(item, dict):
            return None
        label = item.get("label")
        status = item.get("status")
        if not isinstance(label, str) or label.strip() == "":
            return None
        if status not in _VALID_STATUSES:
            return None
        tasks.append(TaskItem(label=label, status=status))
    return tasks


def extract_tasks(text: str) -> tuple[str, list[TaskItem] | None]:
    """Strips every ```wixy-tasks fenced block out of `text` and returns
    `(cleaned_text, tasks)` — `tasks` is the LAST block's parsed items if at
    least one block parsed cleanly, else `None` (including when a block was
    present but malformed: it's still removed from `cleaned_text`, the owner
    never sees raw protocol JSON either way). Blank-line runs the removed
    block(s) leave behind are collapsed, and the result is stripped of
    leading/trailing whitespace, so the surrounding prose reads naturally
    with the block gone."""
    matches = list(_FENCE_RE.finditer(text))
    if not matches:
        return text, None

    last_valid: list[TaskItem] | None = None
    for match in matches:
        parsed = _parse_block(match.group(1))
        if parsed is not None:
            last_valid = parsed

    cleaned = _FENCE_RE.sub("", text)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned, last_valid
