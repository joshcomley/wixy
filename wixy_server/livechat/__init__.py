"""The PIN-protected admin live-chat ("Server" panel) — spec/server-chat/00-brief.md.

Human<->human admin messaging, disguised behind a "Server" nav tab (R1/R2). Its own
storage and routes, entirely separate from `wixy_server.chats`/`cmdchat`/`draft/media`
(the AI assistant + site-content machinery) and the publish-lifecycle media pipeline
(`media.py`) — see `docs/ai/livechat.md` for the full picture; each submodule's own
docstring covers its slice.
"""

from __future__ import annotations
