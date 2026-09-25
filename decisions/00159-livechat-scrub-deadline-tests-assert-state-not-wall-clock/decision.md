# Decision

**Status:** accepted

**Scope:** `wixy_server/tests/test_routes_livechat.py`, `test_livechat_janitor.py` and
`test_livechat_store.py` (test-only; no product code changed).

## Symptom

`TestDeleteWipeRoutes::test_scrub_guard_wait_counts_against_request_deadline` failed once in a
full-suite run on the Delivery Manager's box (1805 passed, 1 failed) on a commit whose diff was
documentation and two comments. The commit's own CI run and the docs builder's local run passed.
The failure was the test's last timing assertion:

```
assert (461579.3124178 - 461577.5382736) < 0.5      # 1.774 s elapsed
```

## Root cause

The test held the store's scrub guard, called the delete route with its request deadline patched
to 0.05 s, and asserted `time.monotonic() - started_at < 0.5`. That bound is what failed, and it
never measured what the test is about. Measured on the same commit:

- run alone, 6 times: 0.061 to 0.073 s;
- 16 copies at once on the shared hub: 0.067 to 0.078 s;
- inside 3 runs of the four livechat test modules under `-n 4`: 0.075 to 0.080 s, of which the
  route's own work was the SQLite commit (about 5 ms), the storage cleanup (about 4 ms) and one
  thread hop (1 to 9 ms); the rest is the 50 ms deadline itself.

So the route needs about 10 ms of work and the assertion allowed 500 ms; the one failure needed a
1.7 s stall somewhere in the timed window (a thread start, the SQLite commit's disk sync, a
garbage-collection pause, another tenant's load). I could not reproduce that stall on demand in 25
measured runs, so its exact source is not identified. What is established is the defect in the
test: it turned any stall of the box into a failure of a product behaviour that was correct, and a
"returns within N ms" bound on a path containing thread hops and a database commit cannot be made
safe by choosing a bigger N. The surrounding waits had the same shape: `lock_entered.wait(2.0)` and
the `scrub_once(deadline_s=1.0)` calls that are expected to succeed inside a wall-clock deadline
that `LiveChatStore.scrub` checks before its first attempt, so a stall longer than the deadline
returns `False` without ever trying.

## What was decided

- The guard test no longer bounds any duration. The test holds the guard for 10 s (`hold_s`),
  far longer than any stall, and asserts two observables:
  1. the route answered while the test still held the guard (`hold_expired` and `lock_done` are
     unset when the response arrives), so the route stopped waiting at its own deadline instead
     of waiting the guard out;
  2. every wait the route made for the guard was bounded by that deadline: the `timeout_s` it
     passed to `scrub_guard` (recorded by a wrapper around the real method) is never `None` and
     never above the patched deadline. No call at all is also valid, because on a stalled machine
     the deadline can already be spent before the first wait.
- Mutation-checked: making the route wait for the guard with no timeout fails the test on (1);
  making it wait a fixed 5 s fails it on (2); the shipped route passes (6 of 6 runs).
- Every scrub the tests expect to succeed inside a deadline now uses
  `_SCRUB_SUCCESS_DEADLINE_S = 30.0` (five sites in `test_routes_livechat.py`, two in
  `test_livechat_janitor.py`, one in `test_livechat_store.py`). Success returns as soon as the WAL
  is truncated, so the number is spent only by a stall. Tests that expect a scrub to fail (the
  0.1 s ones in `test_livechat_store.py`, the reader-blocked route tests) hold a blocking reader
  open, so they fail on state however long the deadline is and were left alone.

## Why

The standing rule is that a failing test is failing regardless of cause and that the fix is at the
root, never a skip or a rerun. The root was a test that asserted the machine's speed. Widening the
number would only have moved the flake; asserting the observable removes it.

## What to watch for

- Do not put an absolute upper bound on elapsed time in a test of a route that touches SQLite or
  threads. If a deadline behaviour has to be tested, hold the contended resource for much longer
  than any stall and assert what the code did (which branch, what timeout it passed), as here.
- Other short waits remain in the livechat tests (`anyio.fail_after(1)` in
  `test_livechat_media_queue.py`, `fail_after(3.0)` in `test_routes_livechat.py`, both waiting for
  an event that should happen at once). They have not failed and were not changed; if one ever does,
  apply the same treatment (a very generous timeout on the wait, assert the event itself).
- Decision 00157 is the sibling: a test bug found the same way, from the same full-suite run.
