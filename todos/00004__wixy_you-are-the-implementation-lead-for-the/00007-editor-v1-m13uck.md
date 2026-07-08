# 00007 [m13uck] M7 WX — Editor v1 (text + links + lists)

## What
Admin shell (routing, top bar, pages panel incl. duplicate/delete + meta drawer), edit
iframe + overlay (selection chrome, text popovers plain/rich-lite, list toolbar),
postMessage protocol, op queue/coalesce/replay; E2E flows 1, 4, 8.

## Why
The core "click any text, edit live" experience — the first owner-facing acceptance
bullet (00 §"experience being bought" #1).

## Context / current state
Depends on 00006 (server core: draft overlay + preview renderer must exist).

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
