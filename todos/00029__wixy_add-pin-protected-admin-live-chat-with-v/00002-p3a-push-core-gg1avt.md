# 00002 [gg1avt] Build P3a push core and service worker

## What

Implement the frozen P3a module from `spec/server-chat/00-brief.md`: pure Python
VAPID key management and payloadless push request construction, plus the admin
service worker bundle and its strict TypeScript build configuration.

## Why

Provide the shared push primitives and generic, non-revealing browser notifications
for P3b's later dispatch/toggle wiring.

## Context + current state

P3a is Builder C in workspace #29, on `cmd/workspace-00029-bs3`, based on
`cmd/workspace-00029`. The public repository must contain zero PIN state or
literal. The frozen brief requires P-256/ES256 VAPID, endpoint host allowlisting,
payloadless requests, fixed generic notification text, and no service-worker fetch
handler. P1 may not yet be present; use its planned `ProjectPaths.server_vapid`
interface and keep integration mechanical.

## Relevant files + commits

- `spec/server-chat/00-brief.md` (frozen at `be57497`)
- `livechat/push.py` (new)
- `admin-ui/src/sw/serverSw.ts` and `admin-ui/tsconfig.sw.json` (new)
- `admin-ui/package.json` / build config and committed `wixy_server/static/admin/server-sw.js`

## How to continue + acceptance

Read §8 Push, §1 R12, §2 SSRF hardening, and §9 invariant 45. Implement strict
tests for JWT round-trip, exact request headers/body via MockTransport, 410 signal,
HTTP/foreign-host rejection, service-worker notification behavior/click routing,
and absence of a fetch listener. Run targeted tests, full pytest/vitest/typecheck,
build the SW bundle, commit with the required release-note trailer, and hand the
candidate SHA to the DM for explicit clearance before opening a PR.

## Links

- Module brief: `http://127.0.0.1:9321/intercomm/02ff639eb12c4b95bd487e40d416bcfa`
