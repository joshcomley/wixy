# P3 server — game state, schema v21, routes (spec parcel P2)

Read `common.md` first. Builder: Sonnet 5.5. You are the SOLE owner of `wixy_server/livechat/store.py`,
`wixy_server/livechat/models.py`, `wixy_server/livechat/cookout_game.py`,
`wixy_server/routes_livechat_cookout.py`, `wixy_server/app.py`, `wixy_server/tests/test_livechat_cookout.py`
(+ any new `wixy_server/tests/test_routes_livechat_cookout.py`).

Implement:

- Spec §1 (whole) and §1.4 serialisation (`_write_txn`, clock after lock, notify after commit) and
  idempotency.
- §4.1 schema v21: additive migration from a real v20 DB; v20 never edited; `_LATEST_SCHEMA_VERSION = 21`.
- §4.2: every route, `require_server_token` FIRST, `Cache-Control: no-store` on personalised views, the
  error codes.
- §1.3 blind redaction in `cookout_view_json` (incl. nullable `current.role`).
- `Message.cookout` summary, `wyrRefKind = "cookout"`, `create_message(wyr_anchor_seq=)` accepting Cookout
  anchors; cascade + explicit `_wipe` deletes; Gallery exclusion + `finish_attachment` rev bump for
  Cookout attachments.
- EVERY store method in Appendix A.2 with the exact signatures. The AI builder codes against them in
  parallel — do not change them; if one is wrong, send me a BLOCKER.

The bank: use `CookoutBank` from `cookout_bank.py` (already on the feature branch). `draw_pair` /
`shuffle_role_schedule` land from the bank builder's checkpoint 2 — until then code against the frozen
A.1 signatures with a small fake in your tests.

The runner: depend only on the `CookoutRunner` Protocol (A.2); routes call `start_concepts` /
`start_pictures` / `start_recipe`; tests use a fake runner. **Do not build the real runner and do not wire
it into `create_app`** — `create_app` takes an optional `cookout_runner` parameter defaulting to None
(= concepts `unavailable`); the AI builder wires the real one later (I will hand `app.py` over to it after
your module merges).

Tests: every §6 server item — state machine, skip/pick/join/abandon, idempotent replays, 409s, blind
redaction on EVERY response incl. mutation responses, 401 on every route + revoked grant, two-connection
races per §6, migration v20→v21, cascade/wipe, `wyrSeq` for Cookout anchors, retries per §1/§3.5 store
semantics, `images_generation` fencing at the store level. FINAL HANDOFF as in `common.md`.
