# Milestone 6 slice 2: draft overlay store, theme dict round-trip, merged-content service

## Context

Second slice of the M6 PR train (decisions/00010 explains the slicing). This
slice implements spec/02 §8's draft overlay in full (load/save/PATCH with
rev/409/atomic writes) and the merged-content service that applies it onto a
loaded `SiteSource` (`content = repo @ origin/main ⊕ overlay`, overlay wins per
key). No FastAPI routes yet — those are slice 3+, once the preview renderer
needs to actually call these.

## Decisions

**1. `builder/theme.py` gained `theme_from_dict`/`theme_to_dict`, extracted
from `load_theme`'s existing body — a small builder-side refactor, not new
business logic.** The merged-content service needs to apply a `theme:
colors.clay` overlay op onto an in-memory theme, then hand a real `Theme`
object to `render_page`. `load_theme` only reads from a `Path`; there was no
way to parse an already-materialized dict (the merge result) without a round
trip through a temp file. `theme_from_dict` takes the same `data: JsonObject`
`load_theme` was already building internally, with `location` threaded through
for error messages instead of hardcoded to `str(path)`. All of `load_theme`'s
existing validation behavior is preserved unchanged (verified: the full
existing `test_theme.py` suite still passes, plus new round-trip tests).

**2. `merged_content.merge_overlay` operates on `SiteSource`'s raw JSON dicts
(`page_contents`/`global_content`) and a temporarily-unpacked theme dict, not
on `Theme`'s typed dataclass directly** — `dotted_set` (already used
everywhere else in this codebase for nested JSON mutation, per
`builder/content.py`'s own docstring: "Reused by `wixy_server`'s draft/publish
machinery for the same canonical-JSON-file contract") only operates on plain
`JsonObject` dicts. Converting `Theme` → dict → apply overlay ops → dict →
`Theme` is the natural shape given decision 1's new round-trip functions,
and keeps `merge_overlay` a single, uniform code path across all three
overlay-key namespaces (page slug / `_global` / `theme`) rather than
special-casing theme with dataclass field mutation.

**3. An overlay op targeting an unknown page slug (or `theme` when no
`theme.json` exists yet) is silently skipped, not raised.** Matches this
project's established "tolerate partial/stale migration state" posture
(wixy decisions/00004, from Milestone 3) — a page deleted upstream since the
draft was last touched, or a draft created before Milestone 5's theme
extraction landed, are both real states the merge must survive without
crashing; surfacing the dangling reference to the owner is the editor UI's
job (a later milestone), not this layer's.

**4. `apply_patch`/`discard_all` take `now: str` and (`apply_patch` only)
`by: str` as explicit caller-supplied parameters — never read the system
clock or a hardcoded `"editor"` string internally.** Keeps the module purely
testable (every test asserts exact timestamps/authors without mocking
`datetime`). `by` is NOT hardcoded to `"editor"` despite every example in
spec/02 §8 showing that value, because restore (milestone 9) also writes to
the overlay programmatically ("set the overlay to `diff(...)`") — a
system-initiated write on the owner's behalf, not literally typed by a human
in the editor UI; keeping `by` a parameter lets that caller supply whatever
value turns out to be right without touching this module again.

**5. `discard_all` still increments `rev`, even though spec/02 §8 doesn't
explicitly say so.** A discard is itself a content change (the overlay's ops
go from non-empty to empty) — allowing a stale PATCH to succeed against a
just-discarded overlay would silently resurrect content the owner just
cleared. Optimistic-concurrency correctness requires ANY state change to bump
`rev`, not just PATCH-shaped ones; tested explicitly
(`test_a_stale_patch_after_discard_all_still_conflicts`).

**6. `baseSha` is threaded through as an opaque string (set once via
`empty_overlay(base_sha)`/`load_overlay(..., default_base_sha=...)`,
otherwise untouched by every operation in this slice).** Spec/02 §8 doesn't
fully specify when `baseSha` should update after the overlay's initial
creation — the merge computation itself is always against LIVE
`origin/main` content regardless of `baseSha` (that's what "upstream edits...
flow into the draft automatically" means), so `baseSha` isn't load-bearing
for anything this slice implements. Left as a clean passthrough rather than
guessing at update semantics that would need unwinding later; whichever
future slice (publisher preflight, most likely) actually reads/updates it
meaningfully should make that call with fuller context.

## Verification

`python -m pytest` — 216 tests (up from 190), including a full round-trip test
(`load_overlay(save_overlay(...))` produces an identical `Overlay`) and
merge-service tests covering scalar ops, collection (whole-array) ops, global
ops, theme ops, unmigrated-theme tolerance, unknown-page tolerance, and
non-mutation of the original source. `mypy --strict` clean — required
switching several test assertions from chained dict subscripting to this
repo's already-established `dotted_get` convention (`JsonValue`'s recursive
union can't be narrowed through chained `__getitem__`, same reasoning
`test_validate.py`'s own docstring already documents). `ruff check`/`format
--check` clean.

## What to watch for

- The next slice (preview renderer) is where `merge_overlay`'s output
  actually gets handed to `render_page(..., mode="preview")` — this slice
  only proves the merge is correct in isolation.
- If a future slice determines `baseSha` DOES need active update logic
  (decision 6), that's new work in whichever module owns that flow, not a
  gap in this one — `Overlay`'s `base_sha` field and JSON round-trip already
  support carrying whatever value gets set.
