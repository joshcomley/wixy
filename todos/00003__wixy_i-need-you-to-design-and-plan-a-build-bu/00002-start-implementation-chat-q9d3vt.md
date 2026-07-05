# 00002 — Start the implementation chat [q9d3vt]

Blocked on: operator's explicit "go" (they said prepare only, don't start it yet).

When go is given:
1. `spec/KICKOFF-PROMPT.md` has the exact call — `POST 127.0.0.1:9320/api/project/wixy/new-chat`
   with `{"model": "claude-sonnet-5", "effort": "max", "prompt": <the opening prompt in that file>}`.
2. Confirm the 202 → session provisions (poll `GET /api/session/<id>`), chat visible in cmd.
3. Steward: answer peer questions to session c42ea1cb-a9d6-413d-bdcb-fc77fc49abba (or its
   handover successor) strictly per the consultation contract in KICKOFF-PROMPT.md.
