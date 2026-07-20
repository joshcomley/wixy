"""The nightly state-backup process (spec/independence/06 §2) — a separate
service from the main `wixy_server` app, run as the `backup` compose service
(and, pre-cutover, an equivalent one-shot invocation via a hub-side scheduled
task against the fleet's own Storage — see `wixy_server.backup.__main__`'s
own docstring). Copies the residual droplet state a fresh git clone can't
reconstruct (spec's own words: "git already holds" the rest) into a checkout
of `<org>/ca-state-backup` and force-pushes a single-commit `snapshot` branch.
See `wixy_server.routes_system` for the main process's read side of the
status file this package writes.
"""

from __future__ import annotations
