# Decision

**Status:** accepted

**Scope:** Server panel disguise, unlock flow, and lock behavior.

## Symptom / context

The chat must remain unobtrusive in an admin session and clear chat-shaped UI from the page
when it locks. The original multi-tap-only reveal was replaced before implementation.

## What was decided

- The nav presents real server status under the name **Server**. One tap inside the panel
  reveals an affordance; a separate PIN step opens the chat. The decoy itself has no
  multi-tap meaning.
- Inside the chat, two qualifying primary-button taps within 400 ms lock it. A gesture
  boundary may complete an existing run but cannot start one; an unmatched boundary tap
  clears the partial run. See [00148](../00148-server-chat-e2e-respects-the-multi-tap-window/decision.md)
  for the original e2e timing rule.
- Ten seconds without user input fades to the decoy. Panic, Escape, hidden-document,
  route-away, multi-tap, unauthorized, and expired-token causes lock immediately; the chat
  subtree is detached from the document and media/recording is stopped.
- A lock is final even while history is still loading: `chatView.ts` advances an attach epoch on
  every attach, detach and dispose, and every continuation, failure handler and stream callback
  checks it, so a lock can never be followed by a stream opening, and a late `locked` event or
  401 from a previous unlock cannot lock the next one (Inv 42).
- Incoming messages and programmatic scroll do not count as user activity. The unlock token
  and unlocked state are not restored after reload; localStorage display-name and device
  identity values remain.

## Why

Separating reveal from unlock reduces accidental exposure. Explicit lock causes and DOM
detachment make the lock fail closed; user-input-only activity prevents background updates
from extending visibility.

## What to watch for

Keep gesture-boundary classification in sync with controls that open sheets, menus, dialogs,
or lightboxes. Update the frontend tests and browser coverage when changing lock triggers or
timing; see [`docs/ai/livechat.md`](../../docs/ai/livechat.md).
