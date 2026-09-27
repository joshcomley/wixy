# 00012 [sisnfe] Multiline Server-chat composer and voice-send layout

## What changed

- Server chat keeps Enter for newlines. Explicit line breaks and soft-wrapped text promote the draft above the controls into a full-width textarea; it grows to 180px, then scrolls internally. The shared AI composer retains Enter-to-send.
- Voice sending keeps the recording row visible, disables and grays its controls, and shows a centered accessible throbber until sending completes.

## Outcome

- TypeScript passed.
- Focused Vitest coverage passed (186/186).
- Focused Playwright coverage passed on a phone viewport (2/2).
- Admin bundle rebuilt from the final source.

## Where shipped

Included in the Server-chat delivery PR from `cmd/workspace-00031-multiline-voice-send`.
