"""The redirects facility (spec/independence/01 §2.2, 03 §2) — a file/env-driven 301
map, served by `routes_public` before it attempts to resolve a build-dir file. Named
by env because the map's CONTENTS are deployment-specific data (her domain's retired
URLs), not engine code: `WIXY_REDIRECTS_FILE` names a JSON file; unset means no
redirects at all — the fleet ships none (01 §2.2), her deployment ships the
spec/07 §5 map.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

RedirectMap = dict[str, str]


class RedirectConfigError(Exception):
    """`WIXY_REDIRECTS_FILE` was set but couldn't be loaded as a redirect map."""


def load_redirects() -> RedirectMap:
    """Reads `WIXY_REDIRECTS_FILE`, a JSON object of `{"/old-path": "/new-target", ...}`
    (the target may be an absolute path on this site or a full external URL — both are
    valid `Location` header values, so no distinction is made here).

    Unset -> `{}` (the ordinary fleet case, and the default for any deployment that
    hasn't configured redirects). Set but unreadable/malformed -> raises loudly at
    startup rather than silently serving no redirects: this is operator-supplied
    config, and a typo'd path deserves the same fail-fast treatment
    `WIXY_DEV_NO_AUTH`-in-prod gets in `settings.py`, not a silent no-op.
    """
    raw_path = os.environ.get("WIXY_REDIRECTS_FILE")
    if not raw_path:
        return {}
    path = Path(raw_path)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RedirectConfigError(
            f"WIXY_REDIRECTS_FILE={raw_path!r} could not be read: {exc}"
        ) from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RedirectConfigError(
            f"WIXY_REDIRECTS_FILE={raw_path!r} is not valid JSON: {exc}"
        ) from exc
    if not isinstance(data, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in data.items()
    ):
        raise RedirectConfigError(
            f"WIXY_REDIRECTS_FILE={raw_path!r} must be a flat JSON object mapping "
            "string paths to string targets"
        )
    return data


def resolve_redirect(redirects: RedirectMap, request_path: str) -> str | None:
    """Exact-match lookup. `request_path` is the raw path as received (e.g.
    `/old-page`, or `/` for root) — returns the configured target, or `None` when
    nothing matches."""
    normalized = request_path if request_path.startswith("/") else f"/{request_path}"
    return redirects.get(normalized)
