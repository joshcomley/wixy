# Canvas opens in the chat's second tab (gxq2d0)

Operator request (2026-10-30): canvases should open in the dynamic (game) tab, full screen; the inline
canvas stays in the chat with an Open button; still only Chat plus one tab.

Done: canvasPane.ts (own pen, registered in gameTabs as "canvas", itemChat false, FAB back to Chat, X
closes), surface-relative placement for canvas drawings (canvasPlacement, CANVAS_INSET_PX = 7), Open
button, open on start, offer on arrival (history baseline; never over a showing game). Tests: vitest
3682/3682; e2e full suite 283/283 including server-canvas.spec.ts. See decisions/00206.
