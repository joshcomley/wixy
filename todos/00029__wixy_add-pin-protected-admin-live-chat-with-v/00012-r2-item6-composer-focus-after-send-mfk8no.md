# 00012 [mfk8no] Round 2 item 6: the input box loses focus after Send

## What
`send()` (admin-ui/src/server/thread.ts) calls `composer.setBusy(true)`, which disables the textarea; disabling a focused element drops its focus and
re-enabling never restores it, so the caret vanished after every Send. Fixed with `restoreComposerFocus()`, called after the send settles on the
success path (after the text is cleared), the failure path and the thrown-error path.

## Why
Operator-reported (round 2), item 6 of 6.

## Context+current-state
Branch cmd/workspace-00029-r2-composer-focus off main c55e8ba, built in my own worktree (...__dm/wixy). Red-first: new e2e
e2e/tests/server-composer-focus.spec.ts (Enter keeps the caret; clicking Send keeps it; a failed send keeps the text AND the caret; focus the user moved
to the settings gear during the send is NOT stolen back; desktop and 402px phone): the six focus tests failed with "Expected: focused, Received: inactive"
on the unfixed code, and all eight pass after. The guard only refocuses while focus is lost (body) or on the composer's own controls, so it never steals
focus from something the user chose. Caveat (honest limit): real Chromium at desktop and phone viewport; the Android soft keyboard re-appearing is
unverified on a device.

## Relevant files+commits
admin-ui/src/server/thread.ts, e2e/tests/server-composer-focus.spec.ts, wixy_server/static/admin/admin.js(.map)

## How to continue + acceptance
Acceptance: after sending (Enter or the Send button) the input keeps the caret, including after a failed send, without stealing focus from elsewhere.
