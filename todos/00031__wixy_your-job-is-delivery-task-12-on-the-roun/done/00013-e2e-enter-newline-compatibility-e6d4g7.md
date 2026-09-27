# 00013 [e6d4g7] Update E2E tests for Enter-to-newline behavior

## What changed

- Send-flow tests use the Send button; Enter remains covered as newline input.
- History-seeding tests use programmatic button clicks so repeated setup sends do not trigger the chat's multi-tap lock.
- Voice playback assertions target the current device's sent message instead of all shared-fixture messages.

## Outcome

- Focused Playwright coverage passed (5/5).
- Full E2E suite will run as the corrective PR's merge gate.

## Where shipped

Included in `fix/server-chat-e2e-newline-contract`.
