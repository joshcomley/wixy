# Decision

**Status:** accepted

**Scope:** `admin-ui/src/chatComposer.ts` (a new opt-in `keepInputLive` mode, AI chat
unaffected), `admin-ui/src/server/thread.ts` (`send()` rewritten around it),
`admin-ui/src/server/settingsSheet.ts` (dialog focus target).

## Symptom

Operator report, after decisions/NEW's earlier composer-focus fix (PR #254) had already
shipped: sending a message still visibly flickers. His own diagnosis, verbatim: "it does keep
the text box focused, but because it temporarily defocuses the text box and hides it and then
refocuses it, you get this flicker... it should just never leave focus when you press send...
even if I mouse tap the send button." He also suspected the thread was not staying in sync
with the latest message during the flicker.

Separately: opening the settings sheet immediately focused the name text field, which pops a
phone's soft keyboard before the owner has chosen to edit anything.

## Root cause

PR #254 restored focus to the input *after* a send settled, but `send()` still called
`composer.setBusy(true)`, which sets `textarea.disabled = true` for the duration of the
request. Disabling a focused element unconditionally drops its focus (and, on a touch device,
closes the soft keyboard); the box's `wx-chat-input-empty`/busy row-height classes also
toggled during that window, resizing it. Restoring focus afterwards fixed the *end state* but
not the visible collapse-and-return in between — the actual bug the operator was describing.

Measured with a live `requestAnimationFrame` sampler (Playwright, the send response held open
500 ms so the in-flight frames are observable) at both a 1280×900 desktop and a 402×870 phone
viewport, for Enter, a mouse click on Send, and a touch tap on Send: on the old code, 31-32 of
each ~67-68 sampled frames showed the input unfocused, disabled, and the Send button disabled,
lasting the whole 500 ms hold.

The settings sheet's `nameInput.focus()` on `open()` was a separate instance of the same
class of problem: focusing a real `<input>` is what invites the platform's soft keyboard, even
though nothing about opening a dialog requires text entry yet.

## What was decided

- `chatComposer.ts` gained an opt-in `keepInputLive` mode (the AI chat composer omits it and
  keeps its existing disabled-while-busy behaviour unchanged): with it set, `setBusy` no
  longer disables the textarea or the Send button, and the Send button's `mousedown` is
  `preventDefault()`'d so clicking it never moves focus away from the input in the first
  place (pressing a button focuses it by default; cancelling `mousedown` keeps focus wherever
  it already was — a real tap reaches the same `mousedown` as its browser-synthesised
  compatibility event).
- The composer's text/attachments are lifted out synchronously via a new `takeDraft()` (clears
  the box at once, no busy state involved) and returned via `restoreDraft()` on a failed send
  or `discardDraft()` (revokes preview URLs) once the message is confirmed. The Server chat's
  `send()` was rewritten around this: the box empties the instant Send fires — the same
  "message sent" moment every chat app has — and never changes again while the network request
  is in flight, however long that takes. If the send fails, the typed text and any staged
  attachments come back.
- `settingsSheet.ts`'s dialog root is now `tabIndex = -1` and receives focus on `open()`
  instead of the name input — the exact pattern `pinPad.ts` already uses for the same reason
  (programmatically focusable so a screen reader still announces it and focus-trap/Escape
  handling keeps working, but nothing text-editable, so no keyboard). Tapping into the name
  field afterwards still focuses and edits it normally.

The "not in sync with the latest message" suspicion was checked directly: the sampler also
recorded the thread's scroll gap (`scrollHeight - scrollTop - clientHeight`) on every frame.
On the old code the gap reached 20 px during the flicker window (the disable/enable cycle
disturbed layout enough to un-pin the scroll momentarily) and settled to 0 once the response
landed; on the new code it goes to 0 in the same frame the box clears and stays there for the
rest of the send, so the operator's instinct was correct — it was the same root cause, not a
second bug.

## Why

Restoring a dropped state after the fact is not the same as never dropping it — the operator's
own framing ("it should just never leave focus") is the correct standard for a synchronous
interaction, and it happens to be simpler to implement than the restore-afterwards version it
replaces (no `restoreComposerFocus()` "was it lost, was it mine to restore" logic needed once
nothing disables the input in the first place).

## What to watch for

- `keepInputLive` is opt-in specifically so the AI chat's own disabled-while-busy composer
  behaviour is untouched; a future shared-composer change should keep that split unless the AI
  chat gets the same treatment deliberately.
- The regression suite that caught the stale assumption: `e2e/tests/server-composer-focus.spec.ts`'s
  "focus is not stolen back" test previously asserted the input became `disabled` while
  sending — updated to look for the optimistic echo bubble instead, since disabling never
  happens now.
