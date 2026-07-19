## Symptom

Running the full `pytest` suite while working on independence-phase milestone 1
(unrelated to publish/kill-test code — config generalization, `/api/version`,
redirects) surfaced:

```
FAILED wixy_server/tests/test_kill_during_publish.py::test_a_real_process_kill_mid_publish_leaves_live_ledger_and_draft_untouched
TimeoutError: server never became ready at http://127.0.0.1:<port2>
```

Per the fleet rule, a failing test is never waved off as "pre-existing"/"unrelated" —
it was investigated to a real, evidenced conclusion before continuing M1. What started
as a routine "is this just flaky under load" investigation (matching the methodology
`decisions/00025` already established in this repo for that class of symptom) uncovered
a genuine, previously-undetected data-corruption bug in the publish pipeline — not just
a timing-sensitive test.

## Investigation (measured, hypotheses refuted with numbers — not theorized)

1. **Isolated run** (`pytest wixy_server/tests/test_kill_during_publish.py -n0`) —
   PASSED repeatedly, ~6.5-10.6s each. Deterministic and correct in isolation.
2. **Full suite, repeated** — failed 2 of 5 runs (~40%), always at the same point: the
   *second* (post-kill recovery) server process not answering `/api/admin/state`
   within the original 30s budget.
3. **First hypothesis — a TOCTOU race in `_free_port()`** (bind, close, hope nothing
   else grabs the port before the real subprocess binds it): refuted with a number. A
   targeted stress script ran the exact bind sequence 16-way concurrent × 5 rounds (80
   samples): zero collisions, every real `bind()` completed in 0.000-0.001s.
4. **Improved the test's diagnostics** (it swallowed the killed/recovery subprocesses'
   stdout+stderr via `DEVNULL`, so every prior failure was undebuggable by
   construction) and re-ran. The captured output revealed the REAL mechanism: the
   second server process was running and answering requests fine — but every single
   `GET /api/admin/state` was 500ing with `json.decoder.JSONDecodeError: Expecting
   value: line 1 column 1 (char 0)`, ~90 times in a row (once per poll iteration),
   never recovering.

## Root cause

`json.decoder.JSONDecodeError` on an EMPTY file, thrown from
`builder/content.py::load_json_object` while `wixy_server/site_source.py` ->
`builder/render.py::load_site_source` loaded `content/index.json` — the site repo
checkout's own content file, read by `/api/admin/state` on every single request via
`build_site_source`. The file existed but was 0 bytes / truncated.

Traced to `wixy_server/publisher.py::_apply_ops_to_file` (the "merging" stage of
`run_publish`, spec/04 §5 step 2): it called `write_json_canonical(target, data)` —
`builder/content.py`'s EXPLICITLY non-atomic writer (its own docstring: "stays
non-atomic for callers writing fresh, not-concurrently-read output... where the extra
tmp-file dance buys nothing"). That reasoning is **wrong** for this specific call site:
`content/*.json` files under `paths.repo` ARE concurrently read, by `/api/admin/state`
on every poll. `_materialize`'s `tree_lock()` wrapper (added for exactly this class of
concern, per its own comment: "admin state/content/preview reads never observe a
half-materialized checkout") only guards concurrent **threads within the same live
process** — it does nothing for a hard `Popen.kill()` landing mid-`write_text`, because
the process is stopped instantly (no `finally`, no lock release, no partial-write
awareness needed) and a **separate, freshly-started process** afterward has no
in-process lock to consult before reading whatever bytes are already on disk.

This directly contradicts the codebase's own stated design posture (spec's "never
crash," `test_kill_during_publish.py`'s own docstring: "the system self-heals from a
genuine kill... never crash... extended to never stay broken") and is a real production
risk, not merely a test artifact: a hard kill (OOM, crash, forced restart, host reboot)
landing during ANY publish with draft edits to materialize could leave the live site's
`/api/admin/state` — the endpoint the entire admin UI depends on to render anything —
permanently 500ing, with no self-recovery. For the INDEPENDENCE phase specifically, this
is disqualifying: the whole premise is a non-technical owner operating this without
Josh's help, and she would have no way to diagnose or fix a corrupted JSON file in a git
checkout on a server she's never opened a terminal on.

The codebase already has the right primitive for this — `builder/content.py::
atomic_write_json` (tmp-file-in-the-same-dir + `os.replace`), already used by
`wixy_server.overlay`'s `overlay.json` and `wixy_server.chats`'s `chats.json` for
exactly this guarantee. `_apply_ops_to_file` was simply never wired to it — a gap, not
a considered tradeoff.

## What was fixed

1. **`wixy_server/publisher.py::_apply_ops_to_file`** now calls `atomic_write_json`
   instead of `write_json_canonical`. One-line functional change; the import swap
   drops `write_json_canonical` (no longer used in this file) for `atomic_write_json`.
2. **`builder/tests/test_content.py::TestAtomicWrite`** (new, 6 tests): direct coverage
   of `atomic_write_json`'s own crash-safety contract — success case matches
   `write_json_canonical` byte-for-byte, no tmp file left behind on success, and (the
   guarantee this fix depends on) a write failure at any point leaves the real target
   completely untouched and leaves no tmp file behind, for both an existing and a
   brand-new target. `atomic_write_json` had ZERO test coverage before this — a real
   gap now closed.
3. **`wixy_server/tests/test_publisher.py::TestMaterializeCrashSafety`** (new): a
   RED/GREEN regression test at the actual integration point. Publishes once to
   establish real on-disk content, then monkeypatches `Path.write_text` to write only
   HALF of any text containing a marker string before raising — a faithful kill
   simulation (some bytes land, then nothing), filtered by CONTENT not filename so it
   fires identically whether the write lands on the real target (old, buggy) or a
   disposable tmp file (new, safe). **Confirmed RED against the pre-fix code**
   (temporarily reverted via `git stash` to verify): the assertion failed with the
   target file visibly truncated mid-JSON-key (`..."navO`). **Confirmed GREEN**
   against the fix.
4. **`wixy_server/tests/test_kill_during_publish.py`** (the original flaky test):
   `_start_server` now redirects to a real log file (not `DEVNULL`) — a `PIPE` was
   avoided deliberately (risks a classic deadlock if the child ever fills the OS pipe
   buffer with nobody draining it); `_wait_until_serving_state` now polls `proc.poll()`
   every iteration so a genuine crash fails FAST with captured output instead of
   silently burning the whole timeout; default timeout raised 30s -> 60s as realistic
   headroom for a cold subprocess start under full-suite `-n 4` xdist contention
   (proven benign in isolation — every isolated run completes in ~6-10s). This is a
   secondary, independently-justified improvement: even with the root cause fixed,
   `DEVNULL`'d subprocess output makes ANY future failure of this test undebuggable by
   construction.

## Verification

- `ruff check` / `ruff format --check` / `mypy --strict` clean on every changed file.
- All 19 pre-existing `test_publisher.py` tests pass unmodified (behavior-preserving in
  the success case — `TestAtomicWrite::test_matches_write_json_canonical_byte_for_byte`
  confirms the two writers produce byte-identical output).
- Full suite: 585 passed (0 pre-existing failures remaining — the Playwright chromium
  browser binary was also found missing for this workspace's pinned interpreter during
  the same investigation and installed, unrelated to this bug but needed for a genuinely
  green baseline).
- `test_kill_during_publish.py` itself: still passes in isolation, same ~6.7s as before
  (nothing about its own kill/recovery assertions changed) — if it or a similar test
  ever times out again post-fix, its own captured output is now part of the raised
  exception, so the next investigation starts with evidence instead of another
  stress-test detour.

## What to watch for

- **`_add_page`'s template write** (`publisher.py`, `target_template.write_text(...)`
  for a duplicated page's `.html`) has the same theoretical exposure (a kill mid-write
  truncates a page template) but a DIFFERENT, lower-severity failure mode: templates are
  parsed by html5lib, a deliberately forgiving parser (decisions/00001), so a truncated
  `.html` file is more likely to silently lose content than hard-crash every admin API
  request the way an empty JSON file does. Not reproduced, not fixed here — if this
  surfaces for real, apply the same atomic-write treatment (write to a tmp path in the
  same dir, `os.replace`).
- **`_copy_referenced_media`'s `target.write_bytes(...)`** (media file copy into
  `images/`) has the same theoretical exposure with an even lower-severity failure mode
  (a broken image, not a crash). Same disposition: not reproduced, not fixed here.
- If `test_kill_during_publish.py` (or `decisions/00025`'s parity tests) ever times out
  again post-fix with the process confirmed still running and no crash in the captured
  log, that's evidence the 60s budget itself is too tight on a more heavily loaded box
  (e.g., CI's `ubuntu-latest` runners typically have far fewer cores than this 32-core
  dev box) — raise it further, don't silently re-run and hope.
- The scratch port-race repro script that refuted the TOCTOU hypothesis was not
  committed (used only to get a number before moving to the real investigation) — if
  that question ever needs re-litigating, rebuild it from this entry's description.
- General lesson for this codebase: `write_json_canonical`'s docstring claims it's fine
  for "not-concurrently-read output" — before reaching for it at a NEW call site,
  confirm the target really is write-once/not-concurrently-read. This was the exact
  reasoning gap that let the bug in.
