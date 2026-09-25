# 00011 [0mct1x] Round 2 item 5: newlines in Server chat messages aren't rendered

## What
`.wx-srv-bubble-text` had the default `white-space: normal`, so every typed line break collapsed to a space. Fixed with `white-space: pre-wrap`
(admin-ui/src/server/chat.css). The text is appended as plain text nodes by linkify.ts and the server keeps interior newlines, so it was CSS only.

## Why
Operator-reported (round 2), item 5 of 6.

## Context+current-state
Branch cmd/workspace-00029-r2-newlines off main 6cd21a3. Red-first: new e2e e2e/tests/server-message-text.spec.ts (6 tests: 2-line, blank line + link, stacked
geometry; desktop and 402px phone) all failed on the unfixed code and pass after; new unit guard in admin-ui/tests/serverChatCss.test.ts goes red when the rule is
removed. Existing server-chat/server-layout e2e specs still pass (21/21 together); vitest 1307/1307; tsc clean.

## Relevant files+commits
admin-ui/src/server/chat.css, admin-ui/tests/serverChatCss.test.ts, e2e/tests/server-message-text.spec.ts, wixy_server/static/admin/admin.css(.map)

## How to continue + acceptance
Acceptance: a two-line message renders on two lines at desktop and phone width; a link on a later line still links.
