# 00001 [w54r03] Engine D1: `visible` item convention in builder

## What
Add an optional boolean `visible` on collection list items. Absent = shown; only `false`
hides. Canonical storage: key exists ONLY when `false`.

## Why
Foundation for the "Show on site" toggle Purdi needs so all imported before/after posts can
land hidden by default and she switches them on herself.

## Context / current state
Not started as of sidecar creation. Planner-verified anchors (spot-verify on touch):
- `builder/bindings.py:28-36` — add `ATTR_ITEM_HIDDEN = "data-wx-item-hidden"` constant.
- `builder/bindings.py:130-165` `_expand_list` — in the per-item loop, after the
  `isinstance(item_value, dict)` guard, BEFORE `clone = copy.deepcopy(...)`: if
  `item_value.get("visible") is False` → publish mode: `continue`; preview mode: proceed,
  set `clone[ATTR_ITEM_HIDDEN] = "1"` before `_walk`, walk+append as normal (bindings still
  validate — `builder/validate.py:71` runs preview mode).
  **Do NOT use `data-wx-if` on the item root** — `_expand_list` appends the clone AFTER
  `_walk` returns, so publish-mode `el.extract()` on a detached clone is undone by the
  append, and `_evaluate_if` hard-fails on missing keys. Verified by planner as a dead end.
  Check must be exactly `is False`, never truthiness.
- `builder/schemas/gallery-slider.schema.json` + `gallery-tile.schema.json` — add
  `"visible": {"type": "boolean"}` to `properties` (NOT `required`). Both have
  `additionalProperties: false` — this one edit unblocks draft write gate (422 via
  `wixy_server/draft_validate.py:188` → `jsonschema_lite.py:85-88`), publish preflight
  (`routes_admin_api.py:813`/`973`), and materialize (`publisher.py:423-430`).
- Hidden items' images must still exist in `images/` — validate/build walk raw content refs,
  not rendered HTML. Don't optimize hidden items' files away.

## Relevant files
`builder/bindings.py`, `builder/schemas/gallery-slider.schema.json`,
`builder/schemas/gallery-tile.schema.json`, `builder/tests/test_bindings.py`,
`wixy_server/tests/test_preview.py`, `wixy_server/tests/test_draft_validate.py`.

## How to continue + acceptance
Write tests FIRST (publish-mode absence, preview-mode marker+bindings-still-checked,
validate catches broken binding on hidden item, determinism/byte-identical output when no
`visible` keys present, draft-write-gate accepts `visible:false/true`, rejects non-bool).
Do NOT add `visible` to the shared e2e mini-site fixture (`e2e/tests/collection-edit.spec.ts:
36-38` asserts a showcase count of 2). Then implement. `mypy`/`ruff`/`pytest` green (bare
`pytest`, `-n 4` cap — never `-n auto`).

## Links
Part of PR1 (engine). See sidecars 00002 [s1stlw], 00003 [4myclw], 00004 [vlgqe7]. Full brief
in the session that received the implementation brief from planner session
`75f673ab-803c-44ea-a863-edc04f1783e9`. New invariant to add to `docs/ai/invariants.md`
(sibling of Inv 10) — see sidecar 00004.
