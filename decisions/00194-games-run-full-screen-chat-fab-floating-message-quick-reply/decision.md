# Full-screen game mode (WixiChat games)

## Symptom
The operator played Adventure Time on a phone: "too squeezed in". The chat header, a mini chat strip, the composer and the tab bar
all took space; the map was pinned at ~38 % with a tiny scroll window for the pack; the big Bank this / No thanks buttons took a row
(and "Bank this" was white text on light green, unreadable).

## Decided (operator's own words are the spec)
- **The mini strip is gone** (both games). itemChat keeps only the pop-up ("chat per destination"). A chat FAB (bottom-right of the
  pane), a floating message and a quick reply (`gameFloat.ts`) replace it.
- **A game tab hides the chat header and the composer** (`.wx-srv-in-game`); the Chat tab restores both. The composer is only
  hidden where it is at home; the pop-up and the quick reply re-parent it (`mountComposer`) and show it.
- **Call exception (Inv 55):** while the call controller is not idle (ringing, outgoing, connecting, connected, muted, a failure
  notice, the call dialog) the header stays visible in game mode (`.wx-srv-call-live`, `CallDeps.onLive`). Accept / Mute / End live in
  the header; hiding an incoming call's Answer would silently drop calls. R3 multi-tap and Escape are unchanged and are the only
  lock affordances left once the header's ✕ is hidden.
- **Targeting.** A floating message is the newest unseen message from the OTHER person, from the open item's chat or the main chat
  (main-chat ones carry a "Chat" label). Quick reply sends to the chat the message came from (item seq, or main = null); it overrides
  `gameTabs.chatTarget()` while open (`chatTargetNow()`), closes after a confirmed send (not while recording). "Seen" = pop-up
  showed it, the floating message was dismissed (it was on screen), or the quick reply opened on it. The Chat tab clears everything.
  Messages for items other than the open one are ignored.
- **Placement.** The FAB/float overlay lives in a positioned slot ABOVE the pane's pinned dock (Adventure: the body over the
  scrolling column; WYR: a reserved 64 px chat row), so it never covers the game's buttons; the pack column and Explore bar keep
  clear of it (bottom padding / right padding).
- **Scrolling pack.** In the landed pack state the map (`clamp(220px, 42dvh, 460px)`) and the pack are one scrolling column; the
  title row and dock stay pinned; the globe is `touch-action: pan-y` so a finger on the map scrolls. Explore map keeps its meaning
  (map fills the column, drags go to the map, `touch-action: none`). Spinning/roulette: nothing scrolls.
- **Yay / Nay** (operator, same day): the title row has no title text; Yay and Nay (left, only while a decision is possible) replace
  Bank this / No thanks and the big dock buttons; Yay is white on dark green (6.6:1), Nay the neutral chip; ≥ 44 px on phones; Options
  is a gear on phones so the row fits one line at 360 px. Nay's "Never show again?" question remains in the dock.

## Why
Operator feedback; frees the screen for the content while keeping the conversation one tap away and incoming messages visible.

## Watch for
- Anything new that must stay reachable in game mode must live in the pane's own title row (the header is hidden).
- Anything that sends must go through `chatTargetNow()` (not `gameTabs.chatTarget()` alone).
- A new overlay in a pane must not sit on the pane's own buttons: give it a reserved row or put it above the dock.
