# 00006 [jf18qo] Vitest test suite, TS strict types, bundle build & doc maintenance

## What
- Unit tests in `admin-ui/tests/pixelChat.test.ts`:
  - Pathfinding calculation with step-in and overhang blocks
  - Idle watchdog trigger and user activity reset
  - Teardown safety and event cleanup
  - Platform and collision logic
- Run `npm run typecheck` (strict TypeScript)
- Run `npm test` (vitest)
- Run `npm run build` to compile `admin-ui` into `wixy_server/static/admin/` (and ensure CRLF/LF hygiene)
- Write decision record `decisions/00179-pixel-art-chat-idle-interaction/`
- Update docs in `docs/ai/`

## Why
Ensures production readiness, zero regressions, and passes all CI gates.

## Relevant files
- `admin-ui/tests/pixelChat.test.ts`
- `decisions/00179-pixel-art-chat-idle-interaction/`
- `docs/ai/ai-chat.md`

## How to continue & acceptance
All tests pass, bundle is cleanly rebuilt, types strictly valid.
