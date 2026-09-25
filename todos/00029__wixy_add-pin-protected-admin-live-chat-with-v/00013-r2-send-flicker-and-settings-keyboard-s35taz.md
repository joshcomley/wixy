# 00013 [s35taz] Round 2 follow-up: Send no longer disables/blurs/resizes the input at all; Settings no longer auto-pops the keyboard

## What
Two operator reports after the item-6 focus fix shipped (#254):
1. Sending still flickers - the box temporarily defocused/collapsed then came back. Root cause: send() disabled the textarea for the
   duration of the request (drops focus, resizes to the busy row height); the earlier fix only restored focus AFTER, masking rather
   than removing the flicker. Fixed with a new keepInputLive composer mode: never disables, Send's mousedown is prevented so a click/tap
   never moves focus, the box clears synchronously via takeDraft()/restoreDraft()/discardDraft() instead of a busy state.
2. Opening Settings auto-focused the name input, popping the phone keyboard uninvited. Fixed: the dialog root (tabIndex=-1, matching
   pinPad.ts's own pattern) takes focus instead of the text field.

## Why
Direct operator reports, in his own words: "it should just never leave focus when you press send... even if I mouse tap the send button";
"[focus] shouldn't bring the keyboard up unless I deliberately re-tap into the text box."

## Context+current-state
Branch cmd/workspace-00029-r2-focus-no-blur off main c55e8ba, built in my own worktree. Red-first: a new Playwright frame-sampler spec
(e2e/tests/server-send-no-flicker.spec.ts) records focus/disabled/size/thread-scroll-gap on every animation frame across a held-open
500ms send, at desktop and phone, via Enter/click/tap - all 5 cases failed on the pre-fix code (31-32 of ~67 frames unfocused/disabled,
thread gap up to 20px) and pass after (one legitimate instant clear-on-submit, then flat for the whole window). New vitest test for the
settings-sheet keyboard fix, confirmed red before / green after by stashing just that file. Updated a stale assertion in the earlier
server-composer-focus.spec.ts (it expected the input to become disabled while sending, which is no longer true by design). Full
regression: vitest 1308/1308, tsc clean, zero bundle drift, and every server-*.spec.ts e2e file green (80 tests). Recorded as decision 00162.

## Relevant files+commits
admin-ui/src/chatComposer.ts, admin-ui/src/server/thread.ts, admin-ui/src/server/settingsSheet.ts, admin-ui/tests/serverSettingsSheet.test.ts,
e2e/tests/server-send-no-flicker.spec.ts, e2e/tests/server-composer-focus.spec.ts, wixy_server/static/admin/admin.js(.map), decisions/00162

## How to continue + acceptance
Acceptance: across a slow send, the input never blurs/disables/resizes and the thread never drifts off the latest message; opening
Settings does not pop the keyboard; a deliberate tap on the name field still focuses and edits it.
