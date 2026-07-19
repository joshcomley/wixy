"""The pluggable AI backend interface (spec/independence/05).

`backend.py` extracts `wixy_server.cmdchat`'s surface into a protocol
`routes_chat.py` consumes, so a second implementation (the `anthropic` backend,
milestone 6) can stand alongside the `cmd` backend without either routes_chat.py
or the tests knowing which one is active.
"""

__all__: list[str] = []
