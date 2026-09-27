# 00011 [j0p8as] Emoji reaction picker variants and recent choices

## What changed

- Extended the Server-chat reaction picker to include Care (`🥰`) and Celebrate (`🎉`) in the static list.
- Added visual up-arrow indicator for emojis with variants (`👍`, `❤️`, `🙏`).
- Implemented long-press and context menu variant popups allowing color selection; heart color choices are persisted in `localStorage` (`wx_srv_default_heart`) and update future opens.
- Added trailing ellipsis (`⋯`) button opening the full categorized emoji picker with search and category navigation.
- Added a recents row beneath the static list displaying the 5 most recent emojis outside the static list.
- Allowed unicode emojis on the server while preserving strict validation against non-emoji text and control characters.

## Outcome

- TypeScript typecheck passed cleanly (`npm run typecheck`).
- Focused and repository Vitest suites passed (2411/2411 tests).
- Python reactions and route tests passed (76/76 tests).
- Playwright E2E reactions suite passed (6/6 tests).
- Admin UI bundle rebuilt with LF line endings and no drift.

## Where shipped

Included in the Server-chat delivery PR from `cmd/workspace-00031-emoji-picker`.
