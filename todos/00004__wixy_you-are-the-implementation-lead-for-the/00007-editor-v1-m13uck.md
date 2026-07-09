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
  decisions/00016). decisions/00016. PR #27 merged.
- Slice 2 [DONE]: editor overlay (`editor/src/overlay.ts` + `dom.ts` +
  `contentModel.ts` + `listOps.ts` + `opTargeting.ts` + `popovers.ts`) —
  selection chrome, hover outlines, per-binding-kind popovers, `data-wx-if`
  eye toggle, list item structural toolbar, postMessage sender/receiver, all
  wired into `editor/src/index.ts`'s self-starting entrypoint. Key finding:
  an item-scope edit must always re-emit the OUTERMOST enclosing list's whole
  array, never a nested list's own path (decisions/00017 decision 2) — the
  server's `dotted_get` never indexes into arrays at all. 85 tests. Manual
  browser verification not yet possible (no real end-to-end page to load
  until slice 3) — flagged in decisions/00017 decision 8, owed then.
  PR #28 merged.
- Slice 3 [DONE]: admin shell (`admin-ui/` package) — hash router, top bar,
  left nav, pages panel (Edit action; Duplicate/Delete explicitly deferred —
  see decisions/00015), edit-mode iframe host wired to slices 1-2 (device
  toolbar, the shell's own single `OpQueue`), page settings drawer (`meta.*`,
  incl. a minimal existing-media ogImage picker). Also root-cause fixed three
  real gaps browser verification finally surfaced: a missing `<base href="/">`
  on the preview route (M6 bug — relative site asset/link URLs resolved one
  directory too deep), missing internal/external link interception (spec/05
  §2, fell through the slice boundaries entirely), and the M7-slice-2
  `data-wx-if` eye toggle having no code that ever inserted one into a real
  page. Full decision log: decisions/00018 — includes the real-browser
  verification evidence (Playwright against a live dev server + the actual
  public CA repo, zero console/page errors end-to-end). PR #29 merged.
- Slice 4 [DONE]: `e2e/tests/concurrent-editing.spec.ts` — real E2E 8 (spec/08 §2)
  replacing `smoke.spec.ts`'s placeholder, run against a real full-stack fixture
  server (`e2e/fixture_server.py`, new: temp git repo from `builder/tests/
  fixtures/mini-site`, a real published build so preview assets don't 503, a
  real `wixy_server` on an ephemeral port). Two tabs edit different fields on
  the same page; tab A's PATCH is deterministically delayed via Playwright
  route interception so the rev-conflict/409/replay path is forced and proven,
  not left to timing luck. `.github/workflows/ci.yml`'s `e2e` job gained Python
  setup (it had none). Full rationale: decisions/00019. PR #(fill in when
  opened).

**Milestone 7 (Editor v1) is now fully DONE — all 4 slices merged.**

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
