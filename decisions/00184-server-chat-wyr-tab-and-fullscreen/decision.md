# Ask (operator, 2026-10-16, after trying decisions/00182's card)
A game TAB: when a game starts, tabs ("Chat" and "WYR") appear at the bottom; the picture takes most of the screen and flips between the two options when tapped; a mini chat shows the card's last two messages; each card's chat is kept with the card and also persisted in the main chat; the main chat keeps a two-picture preview; closing the game closes the tab and with one tab left the bar disappears; the unlocked chat uses the whole screen; tapping a game-chat message opens a larger pop-up game chat with the card's history and the ordinary controls (voice notes, attachments), attachments showing as tiny tappable thumbnails in the mini chat.

# Decided
- **One composer, moved.** `thread.ts` owns a single `ChatComposer` wired to the recorder, upload, GIF-link and view-once machinery (~1,000 lines). A second instance for the pop-up would duplicate all of it, so `wyrGame.ts` asks the thread to RE-PARENT the one composer (`mountComposer(host)`) into the pop-up and back. Draft text, a recording in progress and staged attachments survive the move because the node is the same.
- **Where a message goes is decided at send time**: `game.chatTarget()` is the open round's seq while the WYR tab (or its pop-up) is the one in use, else null; the three send paths in `thread.ts` spread `wyrSeq` from it. Messages are ordinary messages (they appear in the main chat in order, tagged "WYR") that also carry `wyrRef` — the server half is decisions/00183.
- **Layout.** The game pane takes the thread's place (the thread wrapper is hidden — note `.wx-srv-thread-wrap[hidden]` needs its own `display:none` rule: the class's `display:flex` beats the attribute, which only a real browser shows; `serverChatCss.test.ts` now lists it), the tab bar sits under the composer, the pop-up is an absolutely positioned sheet over the thread view. The thread's scroll position is saved and restored around hiding it; the pen is abandoned if it was on.
- **The preview card has no answer controls.** Playing happens in the tab (`wyrControls.ts`, shared state-specific controls); the main-chat card (`wyrCard.ts`) is two thumbnails, one status line and an Open/Play button, so scrolling back still shows each round's context without three copies of the controls.
- **Tabs appear for rounds you didn't start, without taking over.** `syncWyrGame` offers the newest unfinished round (a dot on the WYR tab); the starter lands in the tab. Closing a round's tab remembers it (not re-offered until a new round or a tap on the card). A finished/skipped round from history never pops a tab.
- **Full screen.** `panel.ts` reports `onFullscreenChange(showChat)`; the shell toggles `wx-shell-srv-full` which hides the status bar, top bar, nav row, side nav and edit-bar host (CSS only), so `.wx-main` and the chat get the whole dynamic viewport. Locking or leaving the route restores them. The panic ✕ in the chat header is the way out (the nav is gone by design).
- **Mini chat** shows at most two items: confirmed card messages then optimistic echoes; attachments render as 28 px thumbnails / icons that open the pop-up. The pop-up renders messages with the thread's own embedded bubble renderer, updating incrementally so a playing voice note is never cut off.

# Why not
- A second composer / a simplified pop-up composer: would silently lose voice notes, attachments, GIF links or the draft the first time the two drifted.
- A separate message list for game chat that is NOT in the main chat: the operator wants both.
- Controls inside the main-chat card as well as in the tab: duplicated state and layout for no new capability.

# Watch for
- Anything that measures the thread while it is hidden (a hidden element has no layout): on return the thread calls `drawingLayer.relayout()` and re-sticks the scroll.
- The pop-up borrows the composer: any new code that holds a reference to the composer's PARENT (rather than the node) will break.
- `wyrSendFields()` must stay in every send path; a new path that forgets it silently sends game chat to the main chat only.
