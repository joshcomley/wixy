"""The `anthropic` AI backend's worker process (spec/independence/05 §2) — a
separate service from the main `wixy_server` app, run as the `worker` compose
service. See `wixy_server.worker.app` for the internal HTTP API it exposes and
`wixy_server.ai.anthropic_backend` for the client the main process uses to talk
to it.
"""

from __future__ import annotations
