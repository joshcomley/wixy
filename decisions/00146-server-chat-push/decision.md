# Decision

**Status:** accepted

**Scope:** Server-chat Web Push.

## Symptom / context

Push can reveal chat activity on a lock screen or in browser notifications, defeating the
disguise and PIN gate.

## What was decided

- Push is an explicit Android-only opt-in. Generate and retain the project's VAPID key pair
  in the private Server storage; protect subscription routes with the unlock token.
- Send payloadless pushes and let the installed service worker show fixed generic text. The
  Server service worker is registered only after opt-in and has no fetch handler.
- Exclude the sending device from a message's push dispatch. Never put sender, message text,
  attachment details, or other chat state in a push payload or visible notification.

## Why

Payloadless notifications keep message content out of push-provider storage and the OS
notification surface, while opt-in avoids registering a worker for users who do not want it.

## Reachability

The pre-delivery audit found that the toggle module existed but nothing mounted it, so the
opt-in could not be reached (finding F1). It is now mounted: each time the settings sheet
opens, `settingsSheet.ts` puts `pushToggle.ts` into the sheet's push slot, only on an
Android-capable browser (Android user agent with `PushManager`, `serviceWorker` and
`Notification`) and only once the chat has a display name; the sheet unmounts it on close, and
desktop and other browsers never see it. The worker is still registered only from the enable
click. `e2e/tests/server-push.spec.ts` proves both halves: a desktop browser shows no control,
and an Android browser enables and disables the subscription through the sheet.

## What to watch for

Any new push field or service-worker fetch handler can reveal activity or intercept unrelated
site requests. Keep the fixed text generic and update [`docs/ai/livechat.md`](../../docs/ai/livechat.md)
and [`docs/ai/invariants.md`](../../docs/ai/invariants.md) with any approved change.
