# 00014 [ewzoao] Round 2 follow-up: double-tap-to-lock now needs same place, same thing (R3 v1.7)

## What
Operator report: rapid scrolling, or tapping two different menu items quickly, locked the chat as a false-positive panic gesture.
createMultiTapDetector only ever checked timing (two primary-button pointerdowns within 400ms), no position/target check. Consulted
the Architect (schema-adjacent security-relevant gesture item 4 depends on the same trigger); ruling = R3 v1.7 (spec PR #256): a
double-tap needs a genuine TAP (down+up, <=10px, <=300ms, never pointercancel'd - shared with R2's decoy-reveal too), in the SAME
PLACE (<=32px of the run's first tap) and on the SAME THING (same nearest interactive/bubble zone). Boundary-tap chains (open here,
close there) are exempt from place/thing, unchanged from before.

## Why
Direct operator report, round 2. Architect-ruled since it's the security-relevant panic-lock mechanism item 4 (permanent unlock)
also pauses its grant on.

## Context+current-state
Branch cmd/workspace-00029-r2-doubletap off main 72d5fea, built in my own worktree. gestures.ts rewritten around a shared tap
recognizer; two real implementation bugs found and fixed via the existing unit-test suite going red (a boundary-closing-an-unrelated-
run test, and a 3-boundary-tap-chain test whose running count was being reset by a shared helper). Red-first at every layer: unit
(admin-ui/tests/server/gestures.test.ts, ~50 tests incl. the 4 new radius/zone regressions - confirmed red with the gate forced open,
green restored), e2e (e2e/tests/server-tap-precision.spec.ts, mobile 390x844 hasTouch: a synthetic scroll-shaped touch sequence never
locks, a genuine same-spot double-tap on a bubble still does - confirmed red on the pre-fix bundle via a stash-and-rerun, green after).
Full regression: vitest 1326/1326, tsc clean, zero bundle drift, 82/82 across every server-*.spec.ts e2e file. Recorded as decision
00163; docs/ai/livechat.md and testing.md updated.

## Relevant files+commits
admin-ui/src/server/{gestures,constants,panel}.ts, admin-ui/tests/server/{gestures,panel}.test.ts, e2e/tests/server-tap-precision.spec.ts,
wixy_server/static/admin/admin.js(.map), decisions/00163, docs/ai/{livechat,testing}.md

## How to continue + acceptance
Acceptance: a rapid scroll or two different controls tapped quickly never locks; a genuine same-spot double-tap still does; every
existing R3/R2 gesture behaviour (boundary chains, exclusions) unchanged.
