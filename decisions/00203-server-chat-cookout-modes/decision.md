# 00203 - Cookout game modes: schema v22, the activation barrier, the scrub fix

**What.** A round has a game mode (`cookout_rounds.mode`, additive v22 column, default `'classic'`, no CHECK so a
future mode id never needs a migration). Modes are data (`livechat/cookout_modes.py`, A.1); `toastie` (Toasted
sandwich) is the second. Classic is byte-identical: the pinned `cookout_classic_golden.json` and a v21-vs-v22 overlap
test prove it.

**Why an activation barrier (spec 09c section 5.6).** A v21 process reading a Toasted round would draw its turns
with the Classic role order and corrupt it. So the mode ships DISABLED: `WIXY_COOKOUT_MODES` is absent, creation
of a non-Classic round answers 503 `game_unavailable`, and `tooling/cookout/activate_modes.py` flips it only when every
check passes (Devfleet, slot schema, DB version, no other-slot process, /options) and prints each check.

**Unknown modes.** A mode id this server does not know is refused on create; an unfinished round in an unknown mode
answers 409 `bad_state` ("this game needs a newer server") on every mutation, is skipped by the background SQL
(filtered on loaded mode ids), renders read-only, may still be abandoned, and never blocks a new game.

**Scrub fix (the 'database is locked' flake).** `scrub()` called `wal_checkpoint(TRUNCATE)`, which takes the WAL
writer lock BEFORE waiting for readers; with a stale reader each 250 ms slice starved a concurrent `BEGIN IMMEDIATE`.
Now `PASSIVE` runs first and TRUNCATE is only tried once PASSIVE reports the whole WAL checkpointed. Success is
unchanged: True only when TRUNCATE reports busy 0 and the -wal is empty, so the erasure guarantee (Inv 36 region)
stands; `test_livechat_store_locking.py` proves deleted text is absent from the db and the -wal with a concurrent
reader. Secondary defect: `_write_txn`/`_read_txn` rolled back unconditionally, masking the real error with
"no transaction is active"; they now roll back only `if conn.in_transaction`.

**Bounded.** A steady writer keeps the log ahead of the checkpoint, so PASSIVE alone could postpone erasure for
ever: after five PASSIVE misses in a row `scrub()` forces a TRUNCATE with a 50 ms busy wait (it holds the writer
lock only that long if a reader pins the WAL). **Activation check (d) fails closed:** an unreadable process list, or a
python/wixy process whose working directory cannot be read (psutil, a dev dependency), refuses; a relative-path v21
start is caught by its cwd.

**Watch for.** Never widen `scrub()`'s success condition. Never enable modes before `activate_modes.py` passes.
