---
name: verify
description: Drive the deployed Wixy + Cottage Aesthetics instance (ca.cinnamons.uk) end to end
---

# Verifying the live wixy deployment

There is no dev-bypass against the real deployment: `/admin*` + `/api/admin/*`
always require a valid CF Access session, and `WIXY_DEV_NO_AUTH=1` refuses to
start while `WIXY_ENV=prod` (spec/04 §9). Use the CF Access **service token**
instead of a browser OTP login — no interactive login needed:

```python
import json, httpx
token = json.load(open(r"D:\Servers\Loom\Storage\cf_access_token.json", encoding="utf-8"))
hdrs = {"CF-Access-Client-Id": token["client_id"], "CF-Access-Client-Secret": token["client_secret"]}
httpx.get("https://ca.cinnamons.uk/api/admin/state", headers=hdrs)  # -> 200
```

This is Loom's own long-lived service token (id `9c1adc68-...`), additively
policy-attached to the "Wixy Admin (ca)" Access app (decisions/00042) — it is
NOT the token Wixy's own "Service token access" policy originally referenced
(`a3058d9d-...`, whose secret was never captured and is unrecoverable). Works
for `/admin` (the full HTML shell) and every `/api/admin/*` route the same way.

## Core admin API (spec/04 §8)

- `GET /api/admin/state` — draft rev/opCount, live version/sha, upstream
  aheadOfPublished, chat list.
- `GET /api/admin/content/{page}` — merged content + binding map.
- `PATCH /api/admin/draft` — `{"expectedRev": N, "ops": [{"file": "<slug>", "path": "dotted.key", "value": ...}]}` -> `{"rev": N+1}`.
- `POST /api/admin/publish` — `{"message": "...", "expectedRev": N}` -> `{"version", "sha"}` (synchronous — blocks until the whole pipeline finishes or fails).
- `GET /api/admin/publishes` — the ledger, newest first, `live: true` on the current one.
- `POST /api/admin/restore` — `{"version": N}` — does NOT rewind; appends a new ledger version (`action: "restore", of: N`) with that version's content, flips the pointer instantly.
- `POST /api/admin/chat/conversations` — `{"firstMessage": "..."}` -> spawns a real cmd chat (the site-owner AI lane). `GET .../conversations` for status (`pending|ready|failed`). `GET .../conversations/{id}/stream` is SSE (`data: {"type": "message"|"status"|"error", ...}`) — useful for watching a conversation work without polling.

## Flows worth driving

1. **Public site**: `curl https://ca.cinnamons.uk/` (200, no auth) vs
   `curl https://ca.cinnamons.uk/admin` (302, CF Access gate) vs the same with
   service-token headers (200, real HTML/JSON). A garbage token still 302s —
   confirmed the edge actually validates it, doesn't just check presence.
2. **Edit → publish → verify**: PATCH draft, POST publish, then re-fetch the
   *public* page with a cachebust query param (`?v=$(date +%s)`) to bypass the
   5-minute CDN TTL (spec/04 §3) and confirm the change is really live — don't
   trust the publish call's own 200.
3. **AI lane**: create a conversation with a real, small content-honesty ask.
   Its own ship cycle (branch → PR → CI → merge in cottage-aesthetics-preview)
   is real and can hit real infra bugs (see decisions/00043) — don't assume a
   parity-CI failure on a genuine content PR is the agent's fault; it may be a
   legitimate "rebaseline needed" case (spec/03 §5 point 3). Once merged, the
   upstream commit isn't live until Wixy's own publish runs — `POST /publish`
   with an empty-ops draft (`opCount: 0`) will still fetch+merge+build+swap the
   new upstream commit fine (publish's own preflight fetches regardless of the
   background watcher's 60s cadence or its `aheadOfPublished` display cache).

## Gotchas

- **The Glob tool under-reports files under `D:\Servers\Wixy`** (a deployment
  target outside this git worktree, not indexed the way the repo is). A
  `Glob` "No files found" for something like `Storage/projects/ca/locks/`
  is NOT reliable evidence the file is absent — check with a direct
  `pathlib.Path(...).exists()` / `Read` instead.
- **Kill-during-publish**: don't time it with a blind `sleep()` before killing
  the Wixy PID — poll for `Storage/projects/ca/locks/publish.lock` to actually
  *appear* first (it's written in ~1ms of the request landing), so the kill
  deterministically lands mid-pipeline instead of possibly landing before
  `run_publish` even started.
- Get Wixy's current PID from `curl http://127.0.0.1:9999/status` → the JSON's
  `services` key is a **list**, not a dict — `next(s for s in d["services"] if s["name"] == "Wixy")`.
- `gh` gives no output through this box's Bash/MSYS pty — always use the
  PowerShell tool for `gh`, per the fleet-wide convention.
