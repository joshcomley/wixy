# 00019 [500ggj] wixy: builder/cli.py dev-serve extensionless handler + tests

Full context: sidecar 00017.

## What

`builder/cli.py:cmd_serve` uses a bare `functools.partial(http.server.SimpleHTTPRequestHandler,
directory=...)`. Replace with a small subclass applying the same rule as routes_public.py's
fallback (no trailing-slash serving, `+ ".html"` fallback on miss), so `python -m builder
serve` matches prod/Pages behavior.

## How to continue

A focused test in `builder/tests/test_cli.py` if existing serve tests make that practical.
They may not exercise the real HTTP server — if so, keep the handler logic in a small
testable pure function and unit-test that directly instead of spinning up a server.
