# 00004 [h7pruc] P6b media wiring

## What

Integrate live-chat file picking, voice recording, and image/video/voice attachment rendering in the P5b composers and thread. Keep uploaded media available after lock/unlock, update the media/livechat operator docs, and commit rebuilt admin bundles with the implementation.

## Why

Complete the P6b parcel assigned by the workspace Delivery Manager for workspace 00029, â€œAdd PIN-protected admin live chat with voice notes.â€

## Context + current state

The assigned checkout is build space P6b under 00029__wixy_add-pin-protected-admin-live-chat-with-v__bs6/wixy, branch cmd/workspace-00029-bs6, based on cmd/workspace-00029. The checkout was clean at 9c1be36417da67d33d81509040bd0618e0c81c68; origin/cmd/workspace-00029 was fetched and merged before source inspection. This brought in the P2b media routes, P5b chat UI, and P6a media modules. The branch merge is a prerequisite integration commit, not P6b implementation.

The candidate cleared by the DM was `9ebcc492ea662f97b083e34338af7cae518b76d7` (PR #230). Review HIGH-1 found that the v1.5.2 gesture markers were inert. This follow-up makes `gestures.ts` consume `[data-srv-gesture-boundary]` and ignore non-primary buttons; a marked tap completes an existing run normally, then clears its unmatched run. The fix is committed locally but not pushed; PR #230 remains at the cleared candidate while two review findings are still pending. Verification after the fix: typecheck, focused 80 tests, full Vitest (1,070 passed), bundle build, and combined media/chat/lock Playwright (31 passed). Earlier unchanged Python verification remains green: ruff, mypy (206 sources), pytest (1,654 passed). P8 should mark its choice-flow controls as boundaries when it integrates the menu/confirm UI.

Delivery Manager brief: spec/server-chat/00-brief.md Â§10 P6b and Â§11 E2E matrix. Also read Â§6 frontend interfaces, Â§Â§5.5â€“5.6 upload/media contracts, and P2b/P5b/P6a implementations before changes. Full brief was delivered via Cmd-Chats intercomm b965f6eb7db64e798907e632eea93a00.

## Relevant files + commits

- spec/server-chat/00-brief.md
- admin-ui/src/server/chatComposer.ts, chatView.ts, 	hread.ts
- P6a modules: admin-ui/src/server/upload.ts,
ecorder.ts, mediaRender.ts
- P2b media routes: wixy_server/routes_livechat_media.py and associated client/API modules
- docs/ai/media.md, docs/ai/livechat.md
- Generated admin bundle under wixy_server/static/admin/

## How to continue + acceptance

1. Read the frozen brief sections named above and the relevant P2b/P5b/P6a modules.
2. Add paperclip image/video picker (image/*,video/*) and mic recorder to the chat composer extraButtons; picker must suspend until change or cancel.
3. Register P6a photo grid/lightbox, video, and voice renderers with P5b attachment rendering. Verify pending uploads survive a lock/unlock cycle. Mark the settings button and lightbox-opening photo buttons with `data-srv-gesture-boundary` per the frozen brief v1.5 R3 rule. Discard recordings shorter than 1s with the “Too short” hint per v1.5.2. Ensure `gestures.ts` consumes the boundary selector and ignores non-primary clicks.
4. Add server-media.spec.ts per Â§11 and update docs/ai/media.md / docs/ai/livechat.md as needed.
5. Rebuild the admin UI bundle. Verify mypy/ruff/tsc, full pytest and vitest, and the media E2E plus server-chat.spec.ts and server-lock.spec.ts as required by the brief.
6. Before final handoff, fetch and merge current origin/cmd/workspace-00029, resolve conflicts without manually merging admin.js, admin.css, or server-sw.js (take either side, then rebuild), and send the Delivery Manager candidate SHA, changes, verification evidence, deviations, and self-review findings. Do not open/merge a PR until the DM clears the exact candidate.

## Links

- Workspace 0ae788cb-70c8-4710-a411-88aa5445df15; the Delivery Manager assigned sequential P6b work in the `__bs6/wixy` checkout.
- Feature branch: cmd/workspace-00029; this builder branch: cmd/workspace-00029-bs6.

## Update 2026-09-24 — all DM review findings fixed; new handoff pending

- Latest feature base merged: `7d6584bfedaf409bef45f5d3e527df2b943ce0ce`; candidate integration commit: `615f3bd68d43b49fbd2e7b739be71bce5dcd5bcc`.
- Fixed all three HIGH findings and the bundled MEDIUM: gesture boundaries now affect tap handling; reattach refreshes signed attachment URLs; redraw/detach disposes active playback and releases its idle-lock suspension; failed or canceled pending uploads issue best-effort DELETE and user cancellation stays quiet.
- Full verification after these fixes passed: ruff, mypy (206 files), TypeScript typecheck, Vitest 1074/1074, pytest 1654/1654, bundle build, and combined media/chat/lock Playwright 31/31.
- Fixes are still uncommitted; create one stable candidate commit with the required `Release-note:` trailer, then send the DM a structured FINAL HANDOFF for that exact SHA. Do not push or update PR #230 until matching explicit clearance.

## Update 2026-09-24 — fix-forward review found stale rows on reattach

- DM/Sol identified that the signed-URL refresh merged current rows but retained deleted messages, then returned a cursor beyond the locked-time delete/wipe events. The old row could therefore reappear after unlock.
- `thread.attach()` now stages refreshed pages, reconciles rows in the covered loaded range only after a successful fetch, and removes stale rows before returning the fresh cursor. Added reattach tests for a deleted message and a wipe; both failed before the fix and pass after it.
- `docs/ai/livechat.md` now describes that reconciliation. Strict typecheck passed, full Vitest passed (1076/1076), build passed, and media/chat/lock Playwright passed (31/31). Full ruff/mypy/pytest is running; do not create the new candidate or hand it off until it completes and the final base is checked.
- PR #230 remains unchanged. Fix-forward candidate must receive fresh exact-SHA DM clearance before any push.

## Update 2026-09-24 — fix-forward committed and fully verified

- Candidate fix-forward commit: `aa817ed0202ad79c500acb0384e27fa01e18c4a8`; feature base remains `7d6584bfedaf409bef45f5d3e527df2b943ce0ce`, including `b1c394f`.
- Complete verification passed after the history reconciliation fix: ruff, mypy (206 files), pytest 1655/1655, strict TypeScript, Vitest 1076/1076, admin build, and combined media/chat/lock Playwright 31/31.
- The candidate is local and clean. New FINAL HANDOFF is next; wait for exact-SHA DM clearance before pushing or updating PR #230.
