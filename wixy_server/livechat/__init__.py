"""The PIN-protected admin live-chat ("Server" panel) — spec/server-chat/00-brief.md.

Human<->human admin messaging, disguised behind a "Server" nav tab (R1/R2). Its own
storage and routes, entirely separate from `wixy_server.chats`/`cmdchat`/`draft/media`
(the AI assistant + site-content machinery) — see `docs/ai/livechat.md` for the full
picture.
"""

from __future__ import annotations
