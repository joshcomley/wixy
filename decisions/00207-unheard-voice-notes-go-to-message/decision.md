# Unheard voice notes: Go to message, and a Previous / Next bar

## Request (operator, 2026-10-30, workspace 60)
Purdy can't see an unheard voice note in context ("if I'm just saying 'thank you', she can't see what I'm
saying 'thank you' to"). Wanted: "go to message" on each one, which closes the pop-up and scrolls to it,
and a little overlay at the bottom, above the text box, with "go to next" / "previous" unlistened-to
message, so the notes become navigable in the chat.

## Decided
- **Go to message** on every item of the unread list: closes the list, reveals the note in the thread
  (`revealMessage`: centred and highlighted, the same reveal a quote's jump to its original uses).
- **The bar** (`.wx-srv-unheard-nav`) floats at the bottom of the thread, just above the composer:
  Previous · "2 of 3 unread voice notes" · Next · ✕. Steps go to the nearest unheard note before/after
  the current one, oldest first; buttons show only where there is somewhere to go. When the current note
  has been listened to, the label reads "N more unread voice notes" and stepping continues from where it
  was. The bar goes when nothing is left unheard, on ✕, and on every lock; the count tab hides meanwhile.
- **The bar is gesture-exempt** (`data-srv-gesture-exempt`, like the PIN pad's digits): Next is tapped in
  quick succession on purpose and must never lock (R3). Escape and the panic ✕ still lock at once.
- **A jump holds the thread while it scrolls.** Measured: 3 of 10 e2e runs, the note was off screen right
  after a jump, because a message arriving during the smooth scroll found the thread still "stuck to the
  bottom" and snapped it back. `revealMessage` now takes `threadScroll.hold()` until `scrollend` (or
  `REVEAL_HOLD_MAX_MS`, 1.2 s, if the browser never reports one); the scroll's own events then leave the
  thread un-stuck where it landed. 0 of 20 runs after. This also fixes the same race in a quote's jump.

## Rejected
- Instant (non-smooth) jumps to dodge the race: the scroll event that un-sticks the thread still comes a
  frame later, so a message in that frame snaps back all the same; the hold fixes the cause.

## Watch for
- Unheard notes are only ever loaded messages (`confirmedBySeq`), so a jump never needs to page history.
- e2e on a FRESH device must pin the heard store's `since` (the device starts counting at the first other
  person's message it sees, which races seeding); `server-unheard-nav.spec.ts` does.
- Tests: `admin-ui/tests/serverUnheard.test.ts` (Go to message, stepping, listened, ✕, lock, exemption),
  `serverChatCss.test.ts` (the bar's `[hidden]`), e2e `server-unheard-nav.spec.ts` (390/360 phones).
