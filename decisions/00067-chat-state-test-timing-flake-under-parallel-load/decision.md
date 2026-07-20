# `test_state_reflects_created_conversations` raced a shared 0.3s readiness timeout under heavy parallel load

## Symptom

A full local `pytest` run (750 items, the fixed `-n 4` cap, run while validating M7's
own new test files) failed once:

```
FAILED wixy_server/tests/test_routes_chat.py::TestStateChatsField::test_state_reflects_created_conversations
AssertionError: assert 'failed' == 'pending'
```

Re-running the SAME test in isolation (`pytest -o addopts="" wixy_server/tests/
test_routes_chat.py::TestStateChatsField::test_state_reflects_created_conversations`)
passed cleanly, immediately raising the obvious temptation to write this off as
"unrelated"/"a flake." Per this project's own testing discipline (a failing test is
failing regardless of author, "pre-existing"/"flake" is never an acceptable reason to
leave it red), it was root-caused and fixed instead, in this same PR (small fix, same
PR — the CLAUDE.md's own stated bar).

## Root cause

`test_state_reflects_created_conversations` (`wixy_server/tests/test_routes_chat.py`)
creates a conversation and, with NO polling or explicit wait, immediately asserts its
status is still `"pending"`:

```python
created = client.post("/api/admin/chat/conversations", json={"firstMessage": "hi"}).json()
state = client.get("/api/admin/state").json()
...
assert state["chats"][0]["status"] == "pending"
```

This relies on the shared `cmdchat_client` fixture's `readiness_timeout_s=0.3` (and a
background readiness-tracking task, `wixy_server.cmdchat.CmdChatClient.
wait_until_ready`, polling every `readiness_poll_interval_s=0.02` against
`anyio.current_time()`) not having elapsed by the time the immediate `GET
/api/admin/state` call is evaluated. That 0.3s value is deliberately SHORT so
`TestReadinessTimeout`-style tests in the SAME file (which explicitly WANT to observe
the timeout firing, and poll up to 3.0s waiting for it) don't have to wait long —
`test_state_reflects_created_conversations` reuses that same short-timeout fixture for
an entirely different purpose (observing the PRE-timeout state), an implicit
in-tension assumption the fixture's own docstring/design never called out.

Under light load, the real wall-clock gap between `POST` returning and the `GET`
evaluating is a few milliseconds — comfortably inside 300ms. Under this session's own
heavy parallel load (`-n 4`, 750 tests, including this PR's own 16 new
`test_backup_snapshot.py` tests — each spawning multiple real `git` subprocesses:
clone, checkout --orphan, commit, push, ls-remote, tag — genuinely CPU/IO-heavy
concurrent work), a co-running xdist worker's event loop can occasionally get starved
long enough that the wall-clock gap exceeds 300ms even though the actual logical work
between the two calls never changed. This is a real, reproducible race — not
non-determinism in the product code being tested (a conversation genuinely IS pending
immediately after creation; that fact is true), but in how the test observes it.

## Fix

`TestStateChatsField.test_state_reflects_created_conversations` now constructs its OWN
`CmdChatClient` directly (same `fake_cmd_state`/`create_fake_cmd_app`/
`_ws_connect_always_fails` the shared fixture already used) with `readiness_timeout_s=
30.0` instead of depending on the shared `cmdchat_client` fixture's tight 0.3s. This
makes "status is still pending immediately after creation" true BY CONSTRUCTION (30s
is far larger than any plausible test-machine scheduling delay) rather than true by
lucky timing — while leaving the SHARED `cmdchat_client` fixture's 0.3s value
completely untouched, so `TestReadinessTimeout`/`TestListConversations::
test_transitions_to_failed_with_reason_on_timeout` and every other test that
legitimately wants a fast timeout keeps its own short, fast-running behavior. A
test-local override, not a fixture-wide change — the narrowest fix that removes the
actual race.

Verified: the full `test_routes_chat.py` file (28 tests) still passes; the specific
test passes both standalone and as part of the full suite.

## What was considered and rejected

- **Widening the shared `cmdchat_client` fixture's `readiness_timeout_s`.** Would fix
  this test but forces every OTHER consumer of that fixture (the timeout-observing
  tests) to also wait longer / need their own poll-timeout bumped in lockstep — a
  wider, more invasive change touching pre-existing test code this PR has no actual
  reason to alter, for a fix that only ONE test actually needs.
- **Weakening the assertion to `status in ("pending", "failed")`.** Would hide a real
  future regression where status incorrectly flips to `"failed"` too early — papering
  over the flake by making the test less precise, not actually fixing it.
- **Marking the test flaky/xfail.** Explicitly forbidden by this project's own testing
  discipline ("NEVER disable/skip/xfail/delete a test to go green").
