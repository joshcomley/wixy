# 00002 [tq7nz4] Remove the transitional `spotlight` wire alias (due 2026-10-27)

## What
Delete the temporary old-name compatibility layer added with the spotlight -> tease rename (decisions/00172):
- `LEGACY_TEASE_WIRE_KEY` in `wixy_server/livechat/models.py` and its two uses (the `viewOnce` object in
  `message_json`, and the `POST /messages/{seq}/view-once/open` response in `wixy_server/routes_livechat.py`).
- The `spotlight: StrictBool | None` field on `SendViewOnceMessageIn` and the `or body.spotlight is True` in the send route.
- The tests that pin the alias (`test_stale_tab_sending_the_old_spotlight_key_still_gets_a_tease` and the extra
  `"spotlight"` entries in the exact-shape assertions in `wixy_server/tests/test_livechat_view_once.py`).
- The note in `docs/ai/contracts.md` and the "Deploy skew" paragraph in decisions/00172 (mark it removed, do not delete it).

## Why
A browser tab loaded before the rename keeps running the old bundle (stale bundles survive deploys for days,
decisions/00069). Without the alias, an old tab's send drops Tease (the recipient sees the FULL photo the sender meant
to tease) and an old tab receiving a Tease message shows the full photo too. The alias keeps them honouring the sender's
intent until they reload. After a month no such tab should exist, and leaving the old name in the wire contract forever
defeats the point of the rename.

## Context + current state
Added in the rename PR. Removal date 2026-10-27 is one month after the rename shipped (2026-09-26). If the rename shipped
later than that, move the date to ship-date + 30 days in the code comments, this sidecar and decisions/00172 together.

## Relevant files
wixy_server/livechat/models.py, wixy_server/routes_livechat.py, wixy_server/tests/test_livechat_view_once.py,
docs/ai/contracts.md, decisions/00172-rename-spotlight-to-tease/decision.md.

## How to continue + acceptance
1. `grep -rn "LEGACY_TEASE_WIRE_KEY\|spotlight" wixy_server admin-ui/src e2e` should list only the alias sites above.
2. Remove them, update the exact-shape test assertions back to `{"durationS": ..., "tease": ...}`, run bare `pytest`.
3. Acceptance: no `spotlight` string left in `wixy_server/` outside the v11 migration history and its migration test.

## Links
decisions/00172-rename-spotlight-to-tease/, decisions/00069 (stale-bundle incident).
