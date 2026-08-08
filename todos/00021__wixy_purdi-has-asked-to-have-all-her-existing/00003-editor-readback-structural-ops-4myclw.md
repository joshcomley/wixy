# 00003 [4myclw] Engine D3: editor overlay read-back + structural ops for hidden items

## What
Make the editor overlay's whole-array DOM read-back preserve `visible:false` for hidden
items (marked `data-wx-item-hidden` in preview-mode DOM), and make structural list ops
(add/duplicate) handle the flag correctly. This is the SAME incident class as the
2026-07-28 `.cat` attr-read-back bug (decisions/00095) — without this fix, any inline
edit/reorder/etc on the gallery silently un-hides everything.

## Why
The editor iframe loads preview-mode HTML where hidden items ARE in the DOM (marked). The
overlay reconstructs whole arrays from the DOM using only the bindings map, which doesn't
know about `visible` — so it must be taught the marker explicitly.

## Context / current state
Not started. Depends on 00001 [w54r03] (marker attr defined in builder) and ideally lands in
the same PR as 00001/00002. Planner-verified anchors:
- `editor/src/contentModel.ts` `readListValue` (`:239-246`) — after `readItemValue(item,…)`,
  if item element `hasAttribute("data-wx-item-hidden")` → `value["visible"] = false`; else no
  key. Put the rule in `readListValue` (not `readItemValue`, reused elsewhere). Define the
  attr name as a module constant — now a hand-synced pair with `builder/bindings.py`
  (register under Inv 20 in docs).
- `editor/src/listOps.ts` `applyListStructuralOp` "add" (`:41-43`) — blank clone derives from
  items[0]; DELETE `visible` from the blanked clone (new item born shown even if item 0 is
  hidden). "duplicate" (`:45-51`) KEEPS it (intended — duplicating hidden stays hidden).
- `editor/src/overlay.ts` `applyStructuralDomChange` "add" (`:688-694`) — strip
  `data-wx-item-hidden` from the cloned DOM element too (keeps DOM/array views convergent).
- Ghost styling `editor/src/style.css`, mirror `data-wx-if` idiom at `:42-48`:
  `[data-wx-item-hidden] { opacity:.4; position:relative }` + `::after` "Hidden" badge —
  pseudo-element, NOT injected DOM node (would need to join `OVERLAY_CHROME_SELECTOR` in
  `editor/src/dom.ts:77`, Inv 23 / decisions-00073 incident class). Never `display:none`
  (breaks toolbar positioning / composer drafts).
- NO `protocol.ts` change needed (verified both copies md5-identical; `visible` rides inside
  opaque `JsonValue`). If you find yourself needing one, that's a BLOCKER — message planner.

## Relevant files
`editor/src/contentModel.ts`, `editor/src/listOps.ts`, `editor/src/overlay.ts`,
`editor/src/style.css`, `editor/tests/contentModel.test.ts`, `editor/tests/listOps.test.ts`,
`editor/tests/overlay.test.ts` (`describe("list item structural editing")`, `:1156+`).

## How to continue + acceptance
RED/GREEN discipline: write `overlay.test.ts` regression FIRST — a structural toolbar op
over a list containing a hidden item must emit an array that PRESERVES `visible:false`;
confirm it fails on current code, then fix, then confirm green. Also: marked item round-trips
`visible:false` (strict `toEqual` + sorted `Object.keys`); unmarked item emits NO key;
add-from-hidden-first drops the key; duplicate keeps it. `npm run typecheck && npm test &&
npm run build` in `editor/`, commit rebuilt bundle.

## Links
Part of PR1. Depends on 00001 [w54r03]. See 00002 [s1stlw], 00004 [vlgqe7].
