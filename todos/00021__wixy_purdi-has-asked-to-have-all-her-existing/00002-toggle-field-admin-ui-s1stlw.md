# 00002 [s1stlw] Engine D2: `toggle` admin field kind (registry + admin UI)

## What
New `AdminFieldKind = "toggle"`; a "Show on site" switch in the Before & After section
editor cards + add-modal, writing/removing the `visible` key.

## Why
Gives Purdi the actual on/off switch in `/admin/section/before-after` per imported entity.

## Context / current state
Not started. Depends on 00001 [w54r03] (the `visible` convention) landing in the same PR.
Planner-verified anchors:
- `builder/config.py:22` `AdminFieldKind = Literal["image","text","choice"]` → add `"toggle"`;
  `:24` `_ADMIN_FIELD_KINDS` likewise. `wixy_server/routes_admin_api.py:175-216`
  `_admin_sections_snapshot` passes `kind` through verbatim — no other server change needed.
  Add a parse test alongside `builder/tests/test_config.py:209` (unknown kind skipped).
- `projects/ca.json` — append `{"key":"visible","kind":"toggle","label":"Show on site"}` to
  BOTH `gallery.sliders` and `gallery.tiles` collections' `fields` arrays. Old deployed
  engines drop unknown kinds silently (`config.py:130`) — deploy-safe within this PR.
- `admin-ui/src/api.ts:143` — extend `AdminField.kind` union with `"toggle"`.
- `admin-ui/src/sectionPanel.ts` — new `renderToggleField` beside `renderChoiceField`
  (`:253-280`), dispatched from `renderCard`'s field loop (`:302-305`). Checked =
  `item[field.key] !== false`. Uncheck → `commit(collection, updateItemField(items, index,
  field.key, false))`; re-check → `commit(collection, removeItemField(items, index,
  field.key))` (key removed, not set true).
  **F4 trap**: add-modal form-step dispatch at `:530-534` is a two-way ternary (text/choice)
  — convert to explicit switch or a toggle field renders as an empty `<select>`. Add-form
  toggle defaults ON (write the key only when OFF).
  Hidden-card styling: `item.visible === false` → `wx-section-card-hidden` class, ~0.55
  opacity + small "Hidden" chip. CSS block at `admin-ui/src/style.css:3129-3344`; closest
  existing pattern `.wx-field-row-checkbox` (`:1040-1044`). Real `<input type=checkbox>` +
  label, ≥36px tap targets.
- `admin-ui/src/sectionPanelModel.ts` — add `removeItemField(items, index, key)` beside
  `updateItemField` (`:75-82`); regression test that `visible` survives an unrelated
  `updateItemField` (panel already preserves unknown keys everywhere).

## Relevant files
`builder/config.py`, `projects/ca.json`, `admin-ui/src/api.ts`, `admin-ui/src/sectionPanel.ts`,
`admin-ui/src/sectionPanelModel.ts`, `admin-ui/src/style.css`,
`admin-ui/tests/sectionPanel.test.ts`, `admin-ui/tests/sectionPanelModel.test.ts`,
`builder/tests/test_config.py`.

## How to continue + acceptance
Vitest: toggle renders per card; uncheck emits whole array with `visible:false` on exactly
that item; re-check emits array with key REMOVED; add-modal default leaves no `visible` key;
`removeItemField` + unknown-key-preservation regression. `npm run typecheck && npm test &&
npm run build` in `admin-ui/`, commit rebuilt bundle (CI diffs `wixy_server/static`).

## Links
Part of PR1. Depends on 00001 [w54r03]. See 00003 [4myclw], 00004 [vlgqe7].
