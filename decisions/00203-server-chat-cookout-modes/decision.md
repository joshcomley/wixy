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

## Decisions behind the mode design (spec 09c; added by the docs and e2e parcel)

**The `family` facet (not "more breads").** Every bread is in the one bank category `grains-bakery` and every cheese in
`dairy-eggs`, so the core's "two different categories" rule makes every bread or cheese pair impossible however long the list. The
draw gains `candidates=` (a pool replacing the role pool) and `facet="category"|"family"`: with `family` a pair needs two different
families (a sourdough against a bagel is the contrast the core rule wanted) and the least-shown tie-break counts families. Classic
never passes either, so it is byte-identical (golden-tested).

**The cap of two capped staples.** Butter is free in Toasted sandwich mode (it goes on the outside), salt, pepper and water stay
free, and at most TWO of plain flour, cooking oil, sugar and milk may be used (Classic: four). A toasted sandwich rarely needs
more than milk and flour (a bechamel) or oil (a skillet); two keeps the picks the stars, the "nothing fancy" rule. The staples
are mode data, and none of the eight can be offered as a pick in this mode, so "a picked staple does not count against the cap"
never arises.

**The activation barrier, with the review's reproduction.** The deployed v21 code accepts a database at a higher schema version and
ignores `mode`. Handed a Toasted sandwich round it reads the schedule with the Classic paired index `(turn - 1) // 2`, and
`produce` is a valid Classic role. The review reproduced it with the deployed v21 store: for the permitted schedule `bread,
produce, produce, cheese, cheese, main, main, finish`, a turn-3 pick handled by v21 COMMITS and draws turn 4 as two `produce`
items where the plan says `cheese` - a successful, wrong write the new process then serves. A finished round exposes other v21
write paths (a rescue swap of the bread draws by its bank role `base`, outside the bread list). Hence a barrier, not a tolerated
overlap: release with `WIXY_COOKOUT_MODES` absent, drain every process from the previous slot, then run `activate_modes.py
--enable toastie`, which checks and prints Devfleet, the active slot's schema (>= 22), the live database's `user_version` (>= 22),
no process under the other slot and `/options`. `test_cookout_modes_overlap.py` keeps the canary (v21's `_cx_commit_pick` from a
pinned git commit really mis-draws), so the barrier cannot be removed unnoticed. Rollback targets must be v22-or-later
(`--check-rollback <commit>`); every later release refuses unknown modes the same way, which is how Pizza will ship.

**Why dish words and bread names are not fatal checks.** The first draft rejected an answer for open-sandwich words and for a
missing bread name. Review showed both reject correct answers: "A closed sliced white bread toastie, never an open sandwich." keeps
the words `open sandwich`; "a closed ciabatta roll toastie with bruschetta-inspired tomato filling" keeps `bruschetta`; a model
writes "White bread toastie" for `sliced-white-bread` and "Ciabatta toastie" for `ciabatta-roll`, which `bank.mentions` does not
recognise. A token scan cannot read meaning. So the bread id is enforced in every idea (never omitted) and three different builds
are enforced, and the picture template always draws a closed, cut toasted sandwich; dish words are `Parsed.signals` for a person to
read in the trial report (never a rejection or a repair), and the UI shows the canonical bread name from the validated bread id on
every dish card instead of requiring it in prose.

**Picture judges (deviation from spec 8.4, recorded by the chef parcel).** Haiku proved unreliable on the spec question (7/12, then
9/12 clarified), so the 12 trial pictures were judged by Sol and Opus through cmd with the unchanged spec question (12/12 each; bar
11/12), after one template edit ("the cut faces turned toward the camera") ruled by the coordinator. See
`triad/cookout/modes/toastie-trial.md`.

**Also decided here.** The e2e fixture server enables the mode (`WIXY_COOKOUT_MODES=toastie`); production never does until the
activation tool runs. Every Server-chat commit in this work carries `Release-note: General bug fixes and improvements.` (R14a).
