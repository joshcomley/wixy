# 00007 [rusa0k] Workstream 4: round-(b) FINAL HANDOFF, merge, publish, live verification, DONE report

## What
Second FINAL HANDOFF round covering engine PR2 (if separate) + site-repo PR + the publish
plan; after `FINAL HANDOFF CLEARED`, merge, publish via Wixy admin, verify live, then send
the mandatory `POST-RELEASE DONE REPORT` to the planner.

## Why
Closes the loop — Purdi needs to actually SEE the imported entities with working toggles in
her admin, and the public site must stay byte-equivalent for visitors until she switches
things on.

## Context / current state
Not started. Depends on 00004 [vlgqe7] (PR1 merged+deployed) and 00006 [iuylh3] (PR2/site PR
ready). Planner-specified sequence:
1. After all merges+deploys: `GET /api/admin/state` — REQUIRE `draft.opCount==0` before
   publishing (if Purdi has WIP ops, do NOT publish — leave merged-but-unpublished, note in
   DONE report, verify preview surfaces only).
2. `POST /api/admin/publish` `{"message":"Added your Instagram and Facebook before-and-after
   photos to the editor — each one stays hidden until you switch it on.","expectedRev":<rev>}`.
   Expect version 35+.
3. Live checks (cachebust `?v=<epoch>`): public gallery figure count UNCHANGED (7 sliders +
   1 tile visible); new filter buttons absent/hidden; imported image files served at
   `/images/<name>` (expected, same as today's unreferenced files).
4. Admin checks (CF Access token per `verify` skill, headed browser): `/admin/section/
   before-after` shows ALL entities, imports dimmed "Hidden"; toggle one ON → draft preview
   shows it, publish-preview diff shows the change; then DISCARD (restore rev) — do NOT
   leave draft ops or publish the toggle test. Editor overlay: hidden items ghosted with
   badge; trivial edit to a visible item's title; verify hidden items' `visible:false`
   survived the whole-array write; discard.
5. e2e + unit matrices all green, THEN `POST-RELEASE DONE REPORT`: implementation_session_id,
   PR numbers/URLs, merge commits, verification commands/outcomes, observable release
   evidence (live URLs, version numbers, publish ledger entry), deviations, every recorded
   medium/low finding.

## Relevant files
N/A (verification/release step, not code).

## How to continue + acceptance
POST round-(b) `FINAL HANDOFF` to planner session `75f673ab-803c-44ea-a863-edc04f1783e9` via
`http://127.0.0.1:9321/sessions/75f673ab-803c-44ea-a863-edc04f1783e9/send` BEFORE merging
anything in this round. Wait for explicit `FINAL HANDOFF CLEARED` for the exact candidate
SHAs — silence/timeout/old-SHA clearance is never permission. DONE means: Purdi can open
Before & After on her phone, see every imported pair with a working "Show on site" switch.

## Links
Depends on 00004 [vlgqe7] and 00006 [iuylh3]. Terminal task for this workspace.
