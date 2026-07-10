"""The publish ledger — the product-level history (spec/04-server.md §5-6):
`Storage/projects/<slug>/publishes.jsonl`, append-only, one JSON object per line,
fsync'd on every write. `git log` remains the forensic layer (04 §6) — this file
is what the history panel/restore/prune actually read; never re-derived from git
at request time (only git TAGS are the disaster-recovery fallback if this file is
ever lost, spec/04 §6 — that rebuild path is not implemented here, see this
slice's decision entry).

Two entry shapes share this file: spec/04 §5 step 5's publish shape
(`{version, sha, message, when, source, changed}`) and §6's restore shape
(`{action: "restore", of: version}`). Reconciled here into ONE `LedgerEntry`
with optional fields rather than a tagged union, so history/prune/"last N
versions" logic never needs to special-case which shape it's looking at — a
restore still consumes the next sequential `version` (spec/05 §5: "recorded as
a new version") and still names a `sha` (the SAME sha the restored version
already had — restore makes no new commit), but carries `action`/`of` instead
of `message`/`source`/`changed`.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Literal

from builder.jsontypes import JsonValue
from wixy_server.storage import ProjectPaths

PublishSource = Literal["editor", "upstream", "mixed", "bootstrap"]


@dataclass(frozen=True, slots=True)
class LedgerEntry:
    version: int
    sha: str
    when: str
    message: str | None = None
    source: PublishSource | None = None
    changed: dict[str, JsonValue] | None = None
    action: Literal["restore"] | None = None
    of: int | None = None

    def to_dict(self) -> dict[str, JsonValue]:
        data: dict[str, JsonValue] = {"version": self.version, "sha": self.sha, "when": self.when}
        if self.action is not None:
            data["action"] = self.action
            if self.of is not None:
                data["of"] = self.of
        else:
            data["message"] = self.message
            data["source"] = self.source
            data["changed"] = self.changed if self.changed is not None else {}
        return data


def _as_publish_source(value: JsonValue) -> PublishSource | None:
    if value == "editor":
        return "editor"
    if value == "upstream":
        return "upstream"
    if value == "mixed":
        return "mixed"
    if value == "bootstrap":
        return "bootstrap"
    return None


def _entry_from_dict(data: dict[str, JsonValue]) -> LedgerEntry | None:
    version = data.get("version")
    sha = data.get("sha")
    when = data.get("when")
    if not isinstance(version, int) or isinstance(version, bool):
        return None
    if not isinstance(sha, str) or not isinstance(when, str):
        return None

    action = data.get("action")
    if action == "restore":
        of = data.get("of")
        return LedgerEntry(
            version=version,
            sha=sha,
            when=when,
            action="restore",
            of=of if isinstance(of, int) and not isinstance(of, bool) else None,
        )

    message = data.get("message")
    source = data.get("source")
    changed = data.get("changed")
    return LedgerEntry(
        version=version,
        sha=sha,
        when=when,
        message=message if isinstance(message, str) else None,
        source=_as_publish_source(source),
        changed=changed if isinstance(changed, dict) else {},
    )


def read_ledger(paths: ProjectPaths) -> list[LedgerEntry]:
    """Every entry, oldest first (the file's own append order) — callers that want
    newest-first (spec/04 §6's history panel) reverse this themselves; oldest-first
    is the more natural order for `next_version`/prune to reason about."""
    if not paths.publishes_jsonl.exists():
        return []
    entries: list[LedgerEntry] = []
    for line in paths.publishes_jsonl.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        data = json.loads(stripped)
        if not isinstance(data, dict):
            continue
        entry = _entry_from_dict(data)
        if entry is not None:
            entries.append(entry)
    return entries


def append_ledger(paths: ProjectPaths, entry: LedgerEntry) -> None:
    """Append one line, fsync'd (spec/04 §6: "Ledger writes are append-only,
    fsync'd") — never a tmp+rename rewrite, since this file is never truncated or
    edited in place, only ever grown."""
    paths.publishes_jsonl.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(entry.to_dict(), sort_keys=True, ensure_ascii=False)
    with paths.publishes_jsonl.open("a", encoding="utf-8", newline="\n") as fp:
        fp.write(line + "\n")
        fp.flush()
        os.fsync(fp.fileno())


def find_version(paths: ProjectPaths, version: int) -> LedgerEntry | None:
    for entry in read_ledger(paths):
        if entry.version == version:
            return entry
    return None


def next_version(paths: ProjectPaths) -> int:
    """The version number the NEXT ledger entry (publish or restore alike) should
    take — one past the highest ever recorded, so numbers are never reused even
    after a restore re-visits an older SHA."""
    entries = read_ledger(paths)
    return max((e.version for e in entries), default=0) + 1
