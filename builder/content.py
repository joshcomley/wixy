"""Content JSON I/O + dotted-path resolution (spec/02-content-model.md §2-3).

Pure file/dict primitives — no knowledge of `data-wx-*` binding kinds (that lives in
`bindings.py`). Reused by `wixy_server`'s draft/publish machinery for the same
canonical-JSON-file contract.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from builder.jsontypes import JsonObject, JsonValue

GLOBAL_CONTENT_NAME = "_global"


def content_path(content_dir: Path, slug: str) -> Path:
    """The JSON file for a page slug, or `_global` (spec/02 §3)."""
    return content_dir / f"{slug}.json"


def load_json_object(path: Path) -> JsonObject:
    """Load a JSON file that must contain a top-level object (page/global content)."""
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a JSON object at the top level")
    return data


def write_json_canonical(path: Path, data: JsonValue) -> None:
    """Write JSON UTF-8, 2-space indent, keys sorted, trailing newline (spec/02 §3).

    Stable diffs + idempotent rebuilds: writing the same logical content twice produces
    byte-identical files.
    """
    text = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def atomic_write_json(path: Path, data: JsonValue) -> None:
    """`write_json_canonical`, but tmp-file-in-the-same-dir + `os.replace` so a
    concurrent reader never observes a partially-written file (spec/02 §8's own
    "written atomically (tmp + rename) on every accepted PATCH" requirement,
    factored out here since more than one runtime-state file needs the exact
    same guarantee — `wixy_server.overlay`'s `overlay.json` and
    `wixy_server.chats`'s `chats.json` alike). `write_json_canonical` itself
    stays non-atomic for callers writing fresh, not-concurrently-read output
    (e.g. a build dir) where the extra tmp-file dance buys nothing.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        write_json_canonical(tmp_path, data)
        os.replace(tmp_path, path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


_MISSING = object()


def dotted_get(data: JsonValue, path: str) -> tuple[bool, JsonValue]:
    """Resolve a dotted path (`hero.title`) against a JSON value.

    Returns `(found, value)`. Only walks through dict levels — a collection binding
    resolves the WHOLE array at its key (spec/02 §6/§8), so dotted paths never index
    into a list; hitting a list before the path is exhausted is "not found".
    """
    current: JsonValue = data
    if path == "":
        return True, current
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return False, None
        current = current[part]
    return True, current


def scan_image_refs(value: JsonValue, path: str = "") -> list[tuple[str, str]]:
    """Every dict that 'looks like an image object' (a string `src` + `alt`) — 02 §10.

    Recurses through the whole JSON tree without needing to know, from the template
    side, which specific keys are `data-wx-img`/`data-wx-bg` bindings.
    """
    found: list[tuple[str, str]] = []
    if isinstance(value, dict):
        src = value.get("src")
        if isinstance(src, str) and isinstance(value.get("alt"), str):
            found.append((path or "$", src))
        for key, sub_value in value.items():
            found.extend(scan_image_refs(sub_value, f"{path}.{key}" if path else key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(scan_image_refs(item, f"{path}[{index}]"))
    return found


def dotted_set(data: JsonObject, path: str, value: JsonValue) -> None:
    """Set a dotted path within a JSON object, creating intermediate dicts as needed."""
    parts = path.split(".")
    current: JsonObject = data
    for part in parts[:-1]:
        nxt = current.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            current[part] = nxt
        current = nxt
    current[parts[-1]] = value
