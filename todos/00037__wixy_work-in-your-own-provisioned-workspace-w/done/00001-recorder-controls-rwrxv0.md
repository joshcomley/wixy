# 00001 [rwrxv0] Recorder controls

## What

Move recording Cancel to the left as a cross icon and style Stop and Send in brand blue while it sends.

## Why

The prior controls put Cancel next to the send action and made them easy to confuse.

## Outcome

Replacement Builder preserved six uncommitted source/test changes, integrated main at d8912d2, and completed verification: typecheck, 192 unit tests, 13 desktop/mobile browser tests, bundle build, LF and whitespace checks. The operator requires approval of the exact candidate SHA before any PR or merge.

## Relevant files and commits

`admin-ui/src/server/chat.css`, `admin-ui/src/server/thread.ts`, their unit tests, `e2e/tests/server-media.spec.ts`, `e2e/tests/server-reactions.spec.ts`, and generated admin bundles.

## Delivery

Candidate committed on `cmd/workspace-00037` with the generic Server-chat release note and handed off for SHA-specific approval.
