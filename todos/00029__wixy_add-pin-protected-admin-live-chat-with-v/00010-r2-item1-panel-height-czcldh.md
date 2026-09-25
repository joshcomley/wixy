# 00010 [czcldh] Round 2 item 1: Server chat panel doesn't fill available vertical space

## What
Root-caused and fixed: `.wx-srv-panel` used `min-height: 60vh` (a floor) instead of filling `.wx-main`'s
real available height, leaving a ~240-250px gap below the panel on every ordinary viewport (measured desktop
1280x900 and phone 402x870 both before and after).

## Why
Operator-reported bug (round 2 screenshot), item 1 of 6, explicitly first priority.

## Context+current-state
Fixed on branch cmd/workspace-00029-r2-panel-height off main 1d4e02b. One-line CSS change (admin-ui/src/server/lock.css),
same pattern as the AI chat's .wx-chat-conversation-view (decisions/00110). Verified live with a Playwright geometry
script (getBoundingClientRect on .wx-main/.wx-srv-panel/thread/composer chain) against the fixture server, before and
after the fix, at desktop and phone widths. Recorded as decision 00160.

## Relevant files+commits
- admin-ui/src/server/lock.css, wixy_server/static/admin/admin.css(.map), decisions/00160

## How to continue + acceptance
Acceptance: no gap between .wx-srv-panel's bottom and .wx-main's padding at any viewport; typecheck/vitest/e2e green.
Verified: tsc clean, vitest 1306/1306, e2e/tests/server-layout.spec.ts 3/3 (both existing layout invariants still hold).
