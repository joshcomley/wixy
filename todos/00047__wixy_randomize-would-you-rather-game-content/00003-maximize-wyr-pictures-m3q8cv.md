# 00003 [m3q8cv] Maximize pictures during Would You Rather choices

## What
Add a clear, accessible way to expand both WYR pictures so players can compare them at a larger size after the answer choices appear.

## Why
The game stage gives images whatever space remains after the answer controls and mini chat. On some screens this makes the pictures hard to inspect while choosing.

## Context + current state
`admin-ui/src/server/wyrGame.ts` currently renders one option picture at a time in a flex stage; the answer controls and mini chat share the same pane. The stage flips between A and B when tapped. The current timed-Reveal feature is locally complete and under review; this task expands the same delivery before its single PR/merge.

## Relevant files + commits
- `admin-ui/src/server/wyrGame.ts`
- `admin-ui/src/server/chat.css`
- `admin-ui/tests/serverWyrGame.test.ts`
- `docs/ai/livechat.md`

## How to continue + acceptance
1. Add a visible “Maximize pictures” control when image attachments are available.
2. Open both pictures in a native modal dialog at a substantially larger size with both option labels readable; the browser must contain keyboard focus and inert the covered page. Do not cover or mutate answers. Provide an obvious close/return action so players can tap their choice controls afterward.
3. Keep the existing two-option stage, chat, reveal countdown, and lock/round-close teardown behavior intact. Handle missing or still-painting pictures without showing a broken modal.
4. Add a UI regression test for opening/closing and labels, update the livechat guide, rebuild the committed admin bundle, and run the full relevant checks.

## Outcome
Implemented as a full-screen two-picture comparison with readable labels and a return-to-choices action. The control appears only when at least one picture is ready; missing options show a placeholder. Switching to Chat closes the view. Full admin-ui verification passed: 97 files, 2,560 tests, strict TypeScript checks, and rebuilt assets.

## Links
- Delivery record: `d9467436-71e0-40bc-a299-57b74edb5002`.
