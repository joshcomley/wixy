# A canvas opens in the dynamic (second) tab

## Request (operator, 2026-10-30, workspace 60)
"It's a mistake to have it in line in the chat ... it should, like games, go into another tab. When you
start a canvas, it pops up a second tab ... full-screen canvas there. And there should be a button above
each canvas in the chat view ... that just opens it in the tab. So you can scroll up to an older canvas
and reload it ... But you still only have the two tabs: the game or the canvas ... and then the chat tab."

## Decided
- **The canvas is a registration in the existing game frame** (`gameTabs.ts`, `GameKey` += `"canvas"`),
  not a second frame: the frame already enforces "Chat plus ONE second tab" (`replaceOthers`), offering
  with a dot, dismissal, full-screen layout and the floating message. A canvas replaces a game and a game
  replaces a canvas, exactly as games replace each other.
- **Starter: open; other screens: offer.** Canvases already in the chat at load are history, never
  offered (`canvasBaseline`, taken once `historyLoaded`). A new canvas is NOT offered while a game tab
  is on screen (deliberately gentler than games: it would yank the person out of a game mid-move); it
  waits in the chat with its Open button.
- **No per-canvas chat.** `GameRegistration.itemChat: false` makes `chatTarget()` the main chat while the
  canvas shows; the FAB goes back to the Chat tab (`OverlayOptions.onFab`). A per-canvas chat would need a
  server change (game chats key on game rounds) and the operator asked to "go back to chat and chat".
- **The tab runs its own pen** (`canvasPane.ts` mounts a second `mountDrawingLayer` whose only anchor is
  the shown canvas, with the Draw surface hosted by the canvas frame). Everything the chat pen does
  (toolbar, live strokes, storing, undo/redo, Select and delete, zoom handling) is reused unchanged. Cost:
  while the tab is open, a change to that canvas's drawings is fetched by both pens (two
  `GET /messages/{seq}/drawings`); accepted for one message.
- **Canvas drawings are placed by the canvas SURFACE** (`canvasPlacement`): draw space is the canvas
  bubble at `columnWidth` with the surface `CANVAS_INSET_PX` (7 = border 1 + padding 6) inside. The inline
  canvas and the tab's canvas then agree exactly at any width, and the bubble can carry an Open row above
  the surface without moving anything. The inset keeps every drawing made inline before this change by
  the canvas's own sender exactly in place (scale 1, same origin; unit-tested).
- **The tab's canvas** is the largest 4:5 that fits the pane (never scrolled), with a visible edge;
  ✕ closes the tab (the canvas stays in the chat).

## Rejected
- Storing canvas drawings in a new "surface" space with a schema flag (`drawings.frame`): exact for all
  legacy drawings but a migration, an API change and two rendering modes forever, for a handful of
  doodles; the inset mapping keeps the owner-drawn ones exact with no schema change.
- A data migration rewriting legacy drawings into surface space: it would need the name-label height of
  each screen (font- and zoom-dependent), i.e. a guess written into stored chat content.
- Letting the canvas fill the screen's own shape: drawings would not map between two different phones.

## Honest limits / watch for
- Legacy drawings made inline on the OTHER person's canvas (whose bubble then had a name label above the
  surface) now sit that label's height (~20 px) higher than drawn.
- Any CSS change to the canvas bubble's border or padding must change `CANVAS_INSET_PX` with it.
- A selector like `.wx-srv-pen-button` now matches two elements while a canvas tab is open (the chat's
  and the tab's); scope selectors (the in-game rule hiding the header's pen buttons was narrowed to the
  header for exactly this reason).
- Tests: `admin-ui/tests/serverCanvas.test.ts` (Canvas tab), `serverGameTabs.test.ts` (no item chat),
  `serverGameFloat.test.ts` (FAB override), `server/drawingGeometry.test.ts` (placement, legacy exact),
  e2e `server-canvas.spec.ts` (two people, desktop + 390/360 phones) and the 90% zoom test in
  `server-drawing.spec.ts` (now drawing in the tab).
