# 00007 [m13uck] M7 WX — Editor v1 (text + links + lists)

## What
Admin shell (routing, top bar, pages panel incl. duplicate/delete + meta drawer), edit
iframe + overlay (selection chrome, text popovers plain/rich-lite, list toolbar),
postMessage protocol, op queue/coalesce/replay; E2E flows 1, 4, 8.

## Why
The core "click any text, edit live" experience — the first owner-facing acceptance
bullet (00 §"experience being bought" #1).

## Context / current state
Depends on 00006 (server core: draft overlay + preview renderer must exist) — DONE,
merged (wixy PRs #23-26).

Split into a 4-slice PR train (decisions/00015 explains why), matching M6's own
precedent:
- Slice 1 [DONE]: shared overlay<->shell postMessage protocol types
  (`admin-ui/src/protocol.ts` + `editor/src/protocol.ts`) + the shell-side op
  queue (`admin-ui/src/opQueue.ts`, PATCH coalesce @300ms, rev/409
  refetch+replay) — pure TS, vitest-tested, no DOM/iframe wiring yet. Also
  fixed a real cross-platform bundle-drift trap (`.gitattributes` added — see
  decisions/00016). decisions/00016. PR #(fill in when opened) merged.
- Slice 2 [not started]: editor overlay (`editor/` package) — selection chrome,
  hover outlines, per-binding-kind popovers, postMessage sender/receiver.
- Slice 3 [not started]: admin shell (`admin-ui/` package) — layout, hash routing,
  pages panel (Edit action; Duplicate/Delete explicitly deferred — see
  decisions/00015, no E2E flow in scope needs them and they need new backend
  page-ops surface M6 deliberately didn't build), edit-mode iframe host wired to
  slices 1-2, page settings drawer (`meta.*`).
- Slice 4 [not started]: full integration wiring, E2E 8 (concurrent editing) as a
  real Playwright test, CI green (tsc/vitest/esbuild/bundle-drift), closing decision.

## Relevant files
- spec/05-editor.md §1-2 (shell layout, edit mode, overlay<->shell protocol, selection
  chrome, page settings)
- spec/08-testing-acceptance.md §2 E2E flows 1, 4, 8

## How to continue + acceptance
Strict TS, no framework, esbuild-bundled, self-hosted assets. postMessage origin-checked
both directions. PATCH coalesced at 300ms; 409 -> refetch+replay. E2E 1 (text edit ->
publish -> live change -> history), 4 (collection add/reorder/delete), 8 (concurrent
tabs, no lost ops) passing.

## Links
PR: (fill in when opened)
