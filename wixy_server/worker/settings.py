"""Worker-process settings (spec/independence/05 §2) — a separate, smaller
settings surface from `wixy_server.settings.Settings`: the worker is its own
process/container (docker-compose.yml's `worker` service, same image as `wixy`,
different `command:`), so it never touches most of the main server's own config
(CF Access, the site checkout, publish pipeline). `ANTHROPIC_API_KEY` itself is
read directly by the Agent SDK from `os.environ` (its own documented contract) —
not modeled here, so it never risks being logged via a settings repr/dataclass
field the way every other secret in this codebase is deliberately kept out of
`__repr__`-visible dataclasses too.

`site_repo_url`/`bot_pat` are read from the SAME `.env` values (WIXY_SITE_REPO,
WIXY_AI_BOT_PAT) `docker-compose.yml`'s shared `--env-file` substitutes into
BOTH the `wixy` and `worker` services — deliberately not passed from the main
server through the create-conversation wire call: one shared source (the
compose env file), not two copies that could drift. `site_repo_url` empty means
"not configured" (a valid, meaningful state — mirrors `Settings.engine_pat`'s
own "empty on fleet" precedent): `wixy_server.worker.app` skips workspace
provisioning entirely in that case, matching the module's pre-M6-slice-2
behavior exactly (used by every worker test that doesn't care about git).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

_DEFAULT_SCRATCH_ROOT = Path("/data/worker-scratch")


@dataclass(frozen=True, slots=True)
class WorkerSettings:
    port: int
    scratch_root: Path
    # spec §2: "WIXY_AI_MONTHLY_BUDGET_USD (default 40 ... USD because that's
    # what the SDK's usage reporting speaks)". `None` would mean "no cap" —
    # never actually valid per spec (a budget is always enforced), but kept
    # optional at the type level so a future test can exercise "unset" as its
    # own distinct, deliberately-invalid case rather than silently defaulting.
    monthly_budget_usd: float
    # Defaulted to "" (not configured — see module docstring), unlike every
    # field above: existing call sites constructing `WorkerSettings` directly
    # (every pre-M6-slice-2 test) predate these two fields and never pass
    # them — a required field here would break every one of them for no
    # behavioral reason, when "not configured" is already this module's own
    # meaningful, intentional empty state.
    site_repo_url: str = ""
    bot_pat: str = ""


def load_worker_settings(*, scratch_root: Path | None = None) -> WorkerSettings:
    return WorkerSettings(
        port=int(os.environ.get("WIXY_WORKER_PORT", "8100")),
        scratch_root=scratch_root if scratch_root is not None else _DEFAULT_SCRATCH_ROOT,
        monthly_budget_usd=float(os.environ.get("WIXY_AI_MONTHLY_BUDGET_USD", "40")),
        site_repo_url=os.environ.get("WIXY_SITE_REPO", ""),
        bot_pat=os.environ.get("WIXY_AI_BOT_PAT", ""),
    )
