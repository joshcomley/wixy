"""Adventure Time on an open URL (workspace 00065, spec/adventure-public/README.md).

The public, no-login, single-player game is served by the same process as the rest of wixy, on its
own host name (`WIXY_ADVENTURE_PUBLIC_HOST`), behind a host gate (`gate.py`) that confines that host
to the public routes and nothing else. Everything the public game stores lives HERE — its pack
cache (`store.py`, `public.db`) and its picture files — and never in `server.db` (Inv 61):

- `codes.py` — the public destination bank and the short code of every destination;
- `store.py` — the SQLite pack cache, one row per destination, shared by every visitor;
- `runner.py` — the research job (cmd, one run per destination, bounded retries);
- `pictures.py` — the picture job (Wikimedia Commons only);
- `limits.py` — the in-memory rate limits on starting research;
- `shell.py` — the HTML page shell, the asset table and the manifest;
- `gate.py` — the host gate (outermost ASGI middleware) and the response hardening headers;
- `service.py` — the object `create_app` builds, holding all of the above.

The routes are `wixy_server/routes_adventure_public.py`.
"""
