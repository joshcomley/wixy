# Decision

**Status:** accepted

**Scope:** Server chat architecture, workspace #29.

## Symptom / context

The admin needs a private human-to-human chat that stays separate from the visitor site,
the site's draft media, and the existing AI chat. The server runs two blue/green slots that
share runtime storage.

## What was decided

- Store each project's Server chat under `Storage/projects/<slug>/server/`, in SQLite WAL
  (`server.db`). Use short per-call connections so both slots can operate on the same DB.
- Deliver live updates with a fetch-based SSE stream backed by persisted `events`; poll the
  database periodically because an in-process notifier cannot wake the sibling slot.
- Mint a 12-hour HMAC unlock token bound to the Cloudflare Access email. Keep it in browser
  memory and send it only in `X-Wixy-Server-Token`; sign media URLs separately for native
  media elements.
- Wixy stores no PIN state. Verify through cmd's loopback PIN service under app key
  `wixy-livechat`; unavailable verification fails closed. cmd owns registration and lockout.
- Keep the panel disguised as a real Server status page. Public routes, site builds,
  publishing, reports, and backups do not expose chat data.

## Why

The separate store and two-gate model limit accidental data exposure; persisted events plus
polling support blue/green overlap; cmd remains the sole PIN authority. Decisions 00149–00152
record the later delete/wipe and input-safety findings without changing this architecture.

## What to watch for

Do not put chat data or a PIN in the site repo, build output, logs, browser persistence, or
release notes. Review any new chat route against the CF Access gate and in-app token gate.
Implementation details and route contracts are in [`docs/ai/livechat.md`](../../docs/ai/livechat.md)
and [`docs/ai/contracts.md`](../../docs/ai/contracts.md).
