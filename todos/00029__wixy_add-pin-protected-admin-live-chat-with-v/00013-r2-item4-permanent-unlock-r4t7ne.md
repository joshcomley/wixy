# 00013 [r4t7ne] Round 2 item 4: "Keep this device unlocked" + the two lock checkboxes

## What

Operator round-2 request (verbatim): "Button to permanent unlock, but you have to put the pin in
again." Then: "We need checkboxes for: - Lock when I change tab - Lock when I lock my screen."

Built from `spec/server-chat/03-permanent-unlock.md` §1-§8 (Architect ruling, §8 amended twice):
a per-device **device grant** (server: migration v7 `device_grants`, four `/api/admin/server`
routes, hourly janitor; client: `deviceGrant.ts`, `api/grants.ts`, panel + lock model + settings
sheet, `screenWatcher.ts` for the Idle Detection API). Rule: Inv 48. As-built choices:
`decisions/00161-server-chat-device-grants-and-lock-checkboxes-as-built/`. Tour: `docs/ai/livechat.md` §15.

## State

- Build space bs15 (`cmd/workspace-00029-bs15`), builder session `41f2ad09`; delivery task
  `ae636b89-b20e-4b08-9882-d37c89ef00c0`. The DM runs the opus-tier audit (new authentication
  surface) with the spec as acceptance criteria BEFORE merge; no merge on green CI alone.
- Migration number v7 is provisional: reactions and transcription also add migrations. Renumber at
  rebase by changing `_LATEST_SCHEMA_VERSION` in `wixy_server/livechat/store.py` (tests import it).
- **Owed, needs the operator's phone:** the on-device timing check (order of `visibilitychange` and
  Idle Detector events for a power-button lock, an app switch and a tab switch). Design fails closed
  without it (an unproven device keeps locking on every switch).
- Known limit: rotating the PIN at cmd does not revoke grants; "Sign out other devices" does
  (runbook "Server chat device grants").

## Bugs the tests found in the first draft (kept here so they are not re-introduced)

1. A reload fired `visibilitychange -> hidden`, which counted as a tab change and PAUSED the grant
   (default boxes ticked). Fixed: `pagehide` with `persisted === false` is an unload, not a switch.
   Only the Playwright reload test could see it.
2. A permission that reads "granted" while `IdleDetector.start()` rejects made an unbounded restart
   loop (the failure cleared the proof flag, which always announced, which restarted the watcher).
   Fixed: the flag announces only on a real change, and the refresh is single-flight.
3. A shield resolving while a renewal was already in flight stranded the chat behind the decoy.
   Fixed: `restoreAfterRenewal`, honoured by `adoptSession`.
