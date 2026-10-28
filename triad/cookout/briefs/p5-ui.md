# P5 UI — Cookout pane, card, Recipe book, menu, tab (spec parcel P4)

Read `common.md` first. Builder: **Opus 5.5** (the operator's explicit wish: Opus designs and implements
the Cookout UI). You are the SOLE owner of `admin-ui/src/server/cookout/*` (api.ts, model.ts,
cookoutGame.ts, cookoutCard.ts, recipeBook.ts, plus any start-sheet module you add there),
`admin-ui/src/server/gameTabs.ts`, `admin-ui/src/server/thread.ts` (⋯ menu), `admin-ui/src/server/chat.css`,
`admin-ui/src/server/api/messages.ts` (Message.cookout + wyrRefKind parsing), `admin-ui/tests/cookout/*.test.ts`,
`admin-ui/tests/serverGameTabs.test.ts`, and the rebuilt committed bundles under `wixy_server/static/admin/`.

Implement spec §5 (whole) against the §4.2 wire contract exactly — build against JSON fixtures written
from §4.2; the server lands in parallel. Copy structure from `admin-ui/src/server/adventure/*` and
`wyrGame.ts`; reuse `itemChat.ts` (mini chat) and the shared frame. `GameKey` gains `"cookout"`; opening
Cookout replaces any other open game in the second tab.

Make it genuinely delightful and phone-first: 360 px is the primary layout (verify with a real
narrow-viewport render, not just desktop); desktop gets a sensible wider layout. Tactile ingredient
cards, a satisfying blind reveal, appetising concept cards whose picture placeholders fill in, clear
"Writing recipe…" / "Banked ✓" states, and the Recipe book as a full-height screen like the Holiday bank.
Blind mode: the DOM never holds hidden ingredient data (it never arrives from the server anyway).
Idle-lock, gesture-boundary and panic-key rules as §5.

Tests: every §6 vitest item, discovered by the normal `npm test` (check `npm test -- --list`). Run
`npm run typecheck`, `npm test`, `npm run build` in `admin-ui/`; commit the bundles (LF). FINAL HANDOFF as
in `common.md`, plus 360 px and desktop screenshots of each state (paths in your build space).
