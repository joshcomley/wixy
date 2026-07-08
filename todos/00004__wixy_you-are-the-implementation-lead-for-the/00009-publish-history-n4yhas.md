# 00009 [n4yhas] M9 WX — Publish + history

## What
Publish pipeline (lock -> pull -> materialize overlay+media -> commit/push -> build ->
verify -> swap -> ledger), publish drawer (diff review + upstream commits + validate
surface), history panel, restore, prune; upstream watcher + draft-status chip; E2E 5, 6;
kill-during-publish test.

## Why
Owner-experience bullets #5 (Publish) and #6 (version history / restore) — the human
gate at the center of the whole architecture (spec 01 §2).

## Context / current state
Depends on 00006 (server core) and 00008 (media, since publish moves staged media).

## Relevant files
- spec/04-server.md §5-7 (publish pipeline steps, restore semantics, upstream watcher)
- spec/05-editor.md §5 (publish drawer / history UX)
- spec/08-testing-acceptance.md §1 (publish pipeline test list incl. every failure leg),
  §2 E2E 5, 6

## How to continue + acceptance
Every publish step's failure leaves live serving + draft intact (tested on temp git
repos with simulated bare-repo origin). Kill-during-publish drill passes. Restore diff
granularity is binding-map-driven (whole-array for lists, per-leaf for scalars). E2E 5
(two publishes -> restore #1) and 6 (AI-lane faked commit -> preview banner -> publish
drawer lists it) passing.

## Links
PR: (fill in when opened)
