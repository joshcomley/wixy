# P4 AI + pictures — concept/recipe runner and ComfyUI (spec parcel P3)

Read `common.md` first. Builder: Sonnet 5.5. You are the SOLE owner of:
`wixy_server/livechat/cookout_ai.py`, `wixy_server/livechat/cookout_images.py`,
`wixy_server/livechat/wyr_images.py`, `wixy_server/tests/fake_cmd.py`,
`wixy_server/tests/test_livechat_cookout_ai.py`, `wixy_server/tests/test_livechat_cookout_images.py`.

`wyr_images.py`: generalise to `generate_many(1..3)` over the existing graph VERBATIM
(`EmptyLatentImage`, `ConditioningZeroOut`, model config, 1024×1024). `generate_pair` keeps its signature
and raises `ImageGenerationError`; every existing WYR test unchanged and green.

Implement spec §3 (whole):

- Stage 1, one run for all three concepts via `CmdChatClient` (exact body, prompt, privacy).
- Deterministic validation §3.2 using `CookoutBank.find_contraband_ingredients` (bank builder's
  checkpoint 2 — code against the frozen A.1 signature with a fake until it lands) + one repair run with
  the violations named.
- Pictures §3.3: server-built prompt, `wyr_` prefix, shared limiter/demand, partial success,
  attempt-scoped `server/cookout-tmp/<token>/` cleanup in `finally`, `clear_cookout_scratch` at startup
  and in the 60 s sweep with the 900 s age threshold, `images_generation` fencing on every
  claim/store/fail.
- Stage 2 bank-it recipe §3.4; restarts/self-healing/standalone/privacy §3.5.
- `fake_cmd.py`: canned Cookout concept and recipe responses for tests and e2e.
- Export `CmdCookoutRunner` implementing the A.2 `CookoutRunner` Protocol, and a factory
  `build_cookout_runner(...)` mirroring how `app.py` builds the adventure pack runner.

Call ONLY the store methods in A.2 (the server builder implements them in parallel; use a fake store with
those signatures in your unit tests). Do NOT edit `store.py`, `models.py` or `app.py`.

Checkpoint 2 (separate FINAL HANDOFF, after the server module has merged): I will hand you `app.py` to wire
the real runner into `create_app` (fleet vs standalone edition, `WIXY_COMFY_*` settings) plus an
integration test. Checkpoint 1 tests: every §6 AI/picture item. FINAL HANDOFF as in `common.md`.
