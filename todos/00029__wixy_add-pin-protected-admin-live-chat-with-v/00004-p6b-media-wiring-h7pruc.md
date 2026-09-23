# 00004 [h7pruc] P6b media wiring

## What

Integrate live-chat file picking, voice recording, and image/video/voice attachment rendering in the P5b composers and thread. Keep uploaded media available after lock/unlock, update the media/livechat operator docs, and commit rebuilt admin bundles with the implementation.

## Why

Complete the P6b parcel assigned by the workspace Delivery Manager for workspace 00029, â€œAdd PIN-protected admin live chat with voice notes.â€

## Context + current state

The assigned checkout is build space P6b under 00029__wixy_add-pin-protected-admin-live-chat-with-v__bs6/wixy, branch cmd/workspace-00029-bs6, based on cmd/workspace-00029. The checkout was clean at 9c1be36417da67d33d81509040bd0618e0c81c68; origin/cmd/workspace-00029 was fetched and merged before source inspection. This brought in the P2b media routes, P5b chat UI, and P6a media modules. The branch merge is a prerequisite integration commit, not P6b implementation.

The feature branch was re-synced to `42c6d8595b323530cd552d9cb9bfbc5abb6b5d13` (brief v1.5) before this candidate. P6b is committed on `cmd/workspace-00029-bs6`; the exact candidate SHA is in the Delivery Manager handoff. Verification passed: `ruff check .`, `mypy` (206 source files), `pytest` (1,654 passed), admin UI typecheck and Vitest (1,066 passed), and combined media/chat/lock Playwright (30 passed). The v1.5 gesture-boundary attributes are present on the settings and photo-lightbox controls. The active P8 lane owns the separate `gestures.ts` consumer/primary-button behavior; coordinate that integration there rather than editing P8 files in this checkout.

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
3. Register P6a photo grid/lightbox, video, and voice renderers with P5b attachment rendering. Verify pending uploads survive a lock/unlock cycle. Mark the settings button and lightbox-opening photo buttons with `data-srv-gesture-boundary` per the frozen brief v1.5 R3 rule.
4. Add server-media.spec.ts per Â§11 and update docs/ai/media.md / docs/ai/livechat.md as needed.
5. Rebuild the admin UI bundle. Verify mypy/ruff/tsc, full pytest and vitest, and the media E2E plus server-chat.spec.ts and server-lock.spec.ts as required by the brief.
6. Before final handoff, fetch and merge current origin/cmd/workspace-00029, resolve conflicts without manually merging admin.js, admin.css, or server-sw.js (take either side, then rebuild), and send the Delivery Manager candidate SHA, changes, verification evidence, deviations, and self-review findings. Do not open/merge a PR until the DM clears the exact candidate.

## Links

- Workspace 0ae788cb-70c8-4710-a411-88aa5445df15; the Delivery Manager assigned sequential P6b work in the `__bs6/wixy` checkout.
- Feature branch: cmd/workspace-00029; this builder branch: cmd/workspace-00029-bs6.
