"""First-serve bootstrap (spec/04-server.md §3, spec/07-hosting-deploy.md §1): the
server's own "publish zero" so `ca.cinnamons.uk` has something to serve from the moment
milestone 11's install runs, before the first human Publish (milestone 12). Idempotent —
a no-op once `live.json` already exists, so calling this on every server startup (as
`wixy_server.app`'s lifespan does, right after the upstream watcher's own initial fetch)
never repeats work or risks re-publishing over a real publish.

Does no git I/O of its own — assumes the checkout has already been fetched by the caller
(`wixy_server.watcher.fetch_once`, called just before this in the app's lifespan;
`install.py`'s own explicit `ensure_checkout`). If the checkout isn't ready yet, fails to
build, or the site checkout has no pages yet (an empty/malformed checkout, not a genuine
site — spec/04 §3's partially-migrated states are exactly this shape too, decisions/
00004), this silently no-ops rather than raising — the next successful fetch + the next
call picks it back up (spec/04 §3's "never a crash" posture, matching `fetch_once`'s own
established graceful-degradation shape). Callers that DO want failures surfaced loudly
(`install.py`, run interactively by an operator) check the return value instead of relying
on an exception.
"""

from __future__ import annotations

import logging

from builder.build import build_site
from builder.config import ProjectConfig
from builder.errors import BuildError
from wixy_server.checkout import CheckoutError, current_sha
from wixy_server.ledger import LedgerEntry, append_ledger
from wixy_server.live_pointer import load_live_pointer, save_live_pointer
from wixy_server.site_source import build_site_source
from wixy_server.storage import ProjectPaths

logger = logging.getLogger(__name__)

BOOTSTRAP_VERSION = 0


def bootstrap_if_needed(project: ProjectConfig, paths: ProjectPaths, now: str) -> bool:
    """Returns `True` if this call actually bootstrapped (built + published version 0),
    `False` for every no-op case (already bootstrapped, checkout not ready, or nothing
    buildable yet) — `install.py` uses this to report a clear outcome to the operator."""
    if load_live_pointer(paths) is not None:
        return False
    if not (paths.repo / ".git").exists():
        return False
    try:
        sha = current_sha(paths.repo)
        source = build_site_source(project, paths.repo)
        if not source.page_contents:
            return False  # not a real, buildable site yet (empty/pre-migration checkout)
        build_site(paths.repo, source, paths.build_dir(sha))
    except CheckoutError, BuildError:
        logger.exception("bootstrap build failed for project '%s'", project.slug)
        return False

    save_live_pointer(paths, sha, BOOTSTRAP_VERSION)
    append_ledger(
        paths,
        LedgerEntry(
            version=BOOTSTRAP_VERSION,
            sha=sha,
            when=now,
            message="bootstrap",
            source="bootstrap",
            changed={},
        ),
    )
    logger.info(
        "bootstrapped project '%s' at %s as version %d", project.slug, sha[:8], BOOTSTRAP_VERSION
    )
    return True
