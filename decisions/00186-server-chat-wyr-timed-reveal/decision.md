# Symptom
Reveal previously let each player press at any time. The operator wants both people present for the result: the first tap starts a 30-second countdown, the other must join in time, and the countdown should be tappable from the normal chat round card.

# Decided
- **One server-owned deadline.** Keep the existing per-player Reveal flags and add nullable `wyr_rounds.reveal_deadline` (schema v17). After SQLite `BEGIN IMMEDIATE` acquires its write lock, the first press samples the server clock and sets its flag and `now + 30s`. Queueing behind another writer cannot consume reveal time. A different player can complete the reveal only when `now < reveal_deadline`; the mutation sets both flags, changes state to `revealed`, and clears the deadline atomically.
- **No background timer.** Expired/legacy requests are inactive in reads. The next Reveal mutation resets both flags and starts a fresh window for that caller. Repeated taps by the first player do not extend the deadline. All races serialize in the store transaction.
- **One wire deadline.** The viewer-filtered WYR view includes `revealDeadline` in Unix seconds only while active. Existing `message_updated` notification and `{state, rev}` summary cause every client to refresh. The answer fields remain gated exclusively by `state == "revealed"` (Inv 54).
- **The ordinary round card is the invitation.** Show a live countdown/progress bar there while the window is active. Tapping it opens that round's WYR tab through the existing anchor sequence; do not create a fake message or duplicate Reveal controls in the card.
- **Erasure stays attached to the round.** Deadline lives on the cascading `wyr_rounds` row, so deleting the anchor or wiping the chat removes it with the rest of the game state.

# Ruling
Concurrency consult `46333e22-6ac0-4ac0-9312-5fbc5956739d` recommended reusing the existing Reveal flags with one server-owned deadline, resetting expiry atomically on mutation, and navigating from the existing round card. It found no architecture stop.

# Enforced by
`wixy_server/tests/test_livechat_wyr.py`, `admin-ui/tests/serverWyr.test.ts`, and `admin-ui/tests/serverWyrGame.test.ts`.
