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

## Current reachability

**PENDING-AUDIT-FIX F1:** the Android-only opt-in is the approved policy, but it is not
reachable at this candidate. The settings sheet leaves `pushSlot` empty and does not mount
the toggle module, so do not describe push opt-in as operational until F1 is merged and
verified.

## What to watch for

Any new push field or service-worker fetch handler can reveal activity or intercept unrelated
site requests. Keep the fixed text generic and update [`docs/ai/livechat.md`](../../docs/ai/livechat.md)
and [`docs/ai/invariants.md`](../../docs/ai/invariants.md) with any approved change.
