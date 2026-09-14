# 00003 [0kgwh1] Build P3b push routes, dispatch hook, and toggle UI

## What

Implement P3b from `spec/server-chat/00-brief.md`: protected push subscription
routes, the post-message push dispatch hook with self-exclusion and failure
cleanup, the Android-only admin push toggle, and the service-worker route.

## Why

Complete the optional Android Web Push path using P3a's VAPID and payloadless
push primitives while preserving server-chat privacy and the frozen contracts.

## Context + current state

P3a is merged in PR #225. This task continues in Builder C's build space on
`cmd/workspace-00029-bs3`, synced from `cmd/workspace-00029`. The feature branch
contains P1's `livechat_message_hooks`, token protection, push store primitives,
and P3a's `push.py`/`sw.py`. Do not add PIN state or literals.

## Relevant files + commits

- `spec/server-chat/00-brief.md`, especially §§1 R12, 5.8, 8, and 11
- `wixy_server/routes_livechat.py`, `wixy_server/app.py`, and livechat store/hooks
- `wixy_server/livechat/push.py` and `sw.py` from P3a
- `admin-ui/src/server/` and `docs/ai/livechat.md`
- P3a PR #225, merged to `cmd/workspace-00029`

## How to continue + acceptance

Implement the frozen routes and `/admin/server-sw.js` route before the admin
catch-all. Append the dispatch hook to `app.state.livechat_message_hooks`; use
10-second HTTPX timeout and concurrency 4, excluding matching device IDs and
casefolded senders. Record successes/failures and delete after ten consecutive
failures; remove immediately on 404/410. Build and test the Android toggle's
gesture-safe enable/disable flow and capability detection, plus the specified
e2e coverage. Run mypy, ruff, bare pytest, strict frontend typecheck/vitest,
and rebuild committed bundles. Commit with the exact release-note trailer,
self-review, and obtain DM clearance before opening a PR against the feature
branch.

## Links

- Module brief: `http://127.0.0.1:9321/intercomm/5af0c5a1b55f49329d9f884bb10e4cb4`
