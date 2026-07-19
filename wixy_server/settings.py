"""Runtime settings: `.env` + process environment (spec/04-server.md §2).

`Storage/.env` carries `WIXY_PORT`, the CF Access team domain + AUD
(`WIXY_CF_TEAM_DOMAIN`/`WIXY_CF_ACCESS_AUD` — the literal names spec/07-hosting-deploy.md
§5's secrets inventory gives; the JWT middleware, spec/04 §9, consumes these two), and
flags (`WIXY_DEV_NO_AUTH`, `WIXY_ENV`). Hand-rolled KEY=VALUE parsing rather than a
`python-dotenv` dependency — the format used here is a small, fixed subset (no
quoting/escaping/multiline needed for this project's values), consistent with this
repo's existing preference for hand-rolled parsers over new dependencies (see
`builder/theme.py`, `builder/jsonschema_lite.py`). Process environment variables
always win over `.env` file values, standard dotenv precedence.

The storage root itself can't live IN `.env` (that file lives inside the root it
would be naming) — it's resolved first, from `WIXY_STORAGE_ROOT` in the process
environment only (set by `launcher.py` at process start, spec/07), falling back to
the production default. Tests always override it explicitly.

Independence-phase additions (spec/independence/01 §2.2, 03 §2): `WIXY_EDITION`
(`fleet` default, or `standalone`) — which AI backend/feature set this process runs,
consumed from milestone 5 onward, but the field is added now so nothing downstream
needs a settings-schema change; and `WIXY_CONTAINERIZED` — set by the standalone
compose file only, gates `__main__.py`'s bind address (0.0.0.0 vs the fleet's
loopback-only default). Both follow the same `.env`-or-process-env precedence as
every other setting in this module (the standalone `/opt/wixy/.env` doctrine, 01 §3,
holds general `WIXY_*` config alongside secrets).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

_DEFAULT_STORAGE_ROOT = Path(r"D:\Servers\Wixy\Storage")


def resolve_storage_root() -> Path:
    override = os.environ.get("WIXY_STORAGE_ROOT")
    return Path(override) if override else _DEFAULT_STORAGE_ROOT


def parse_env_file(path: Path) -> dict[str, str]:
    """Parse a simple `KEY=VALUE` file — blank lines and `#`-comments ignored."""
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


_VALID_EDITIONS = ("fleet", "standalone")


@dataclass(frozen=True, slots=True)
class Settings:
    port: int
    env: str
    dev_no_auth: bool
    cf_access_team_domain: str
    cf_access_aud: str
    storage_root: Path
    slot: str | None
    edition: str
    containerized: bool


def load_settings(storage_root: Path) -> Settings:
    """Load settings given an already-resolved storage root (see `resolve_storage_root`)."""
    file_values = parse_env_file(storage_root / ".env")

    def _get(key: str, default: str = "") -> str:
        return os.environ.get(key, file_values.get(key, default))

    env = _get("WIXY_ENV", "dev")
    dev_no_auth = _get("WIXY_DEV_NO_AUTH", "0") in ("1", "true", "True")
    if dev_no_auth and env == "prod":
        raise RuntimeError(
            "WIXY_DEV_NO_AUTH is set while WIXY_ENV=prod — refusing to start "
            "(spec/04 §9: the auth bypass is dev/test only)"
        )

    edition = _get("WIXY_EDITION", "fleet")
    if edition not in _VALID_EDITIONS:
        raise RuntimeError(
            f"WIXY_EDITION={edition!r} is not valid — must be one of {_VALID_EDITIONS} "
            "(spec/independence/01 §2.2)"
        )
    containerized = _get("WIXY_CONTAINERIZED", "0") in ("1", "true", "True")

    return Settings(
        port=int(_get("WIXY_PORT", "8000")),
        env=env,
        dev_no_auth=dev_no_auth,
        cf_access_team_domain=_get("WIXY_CF_TEAM_DOMAIN"),
        cf_access_aud=_get("WIXY_CF_ACCESS_AUD"),
        storage_root=storage_root,
        # Deployment metadata, not an operator setting — process environment only,
        # set by launcher.py at process start from active.txt (spec/07 §1), same
        # precedent as WIXY_STORAGE_ROOT above. No `.env` fallback: `.env` lives
        # inside a Storage tree shared by both slots, so it can't know which one is
        # currently active.
        slot=os.environ.get("WIXY_SLOT"),
        edition=edition,
        containerized=containerized,
    )
