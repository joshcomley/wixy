# Live drawing client (the pen)

**ID**: 10kmhp
**Status**: done — PR #286 merged to main as e0eed7c (2026-09-26), after a clean Opus 5.5 audit
(4 rounds, 9 findings fixed). The phone toolbar's font-dependent third line, caught by CI on
Ubuntu, was fixed at the root before the audit (decisions/00176 #13).
**Workspace**: 00035
**Branch**: `cmd/workspace-00035-live-drawing-client`

## Mission
Build the client half of the Server chat's pen tool, per `spec/server-chat/07-live-drawing.md`
(Architect ruling, PR #282). Operator's words: a pen button; draw on the chat where you draw
it; it scrolls with the chat; it draws LIVE on the other person's screen; select a drawing and
delete it; pen colour and thickness; the other person can draw too.

## Roles
- Driver / delivery manager: session `6c42566b-9b01-46a7-bbc6-270c329c2fa2` (reviews; merges).
- Server builder: session `706bfbb5-359c-4aba-95bc-f4bd68aeee15`, branch
  `cmd/workspace-00029-live-drawing` (owns `wixy_server/**` drawing code, decisions/00175,
  livechat.md §18, Inv 53).
- This workspace owns `admin-ui/**`, `e2e/**`, `wixy_server/static/**` bundles,
  decisions/00176, livechat.md §19.

## Definition of done
1. `npm run typecheck`, all vitest, both builds with no bundle drift, and the FULL e2e suite green.
2. PR titled exactly `feat(server-chat): live drawing, client` (DRAFT while the server PR is
   unmerged). Every non-merge commit ends `Release-note: General bug fixes and improvements.`
3. Never merge from here: the driver reviews, and an Opus 5.5 audit is mandatory.

## Progress
- 2026-09-26: client built (039f2c5). Handover to a new session. Delete-while-create-unknown
  gap found in review and fixed red/green (decisions/00176 item 8). Docs + decision written.
- 2026-09-26: DRAFT PR #286 opened (typecheck clean; vitest 89 files / 2338 passed; builds
  no drift; full e2e 227/227 with the local GET fix). Driver notified.

- 2026-09-26: driver's ruling: #286 is the single merge target for the whole feature. Merged
  server PR #287's final head f4b7b93 (e19c619; only conflict livechat.md §18/§19, kept both;
  merged .py identical to #287). On the merged branch: both builds no drift; typecheck (admin
  + editor) clean; vitest 2338 (admin) + 249 (editor); full e2e 227/227; full pytest 2385
  passed. #287 is superseded (not merged separately).

## Remaining
1. #286 is ready for review: the driver does the joint review and the Opus 5.5 audit, then
   merges. Answer their findings here. Never merge from here.
2. If `main` moves before then: merge it, re-verify the same way, push.
