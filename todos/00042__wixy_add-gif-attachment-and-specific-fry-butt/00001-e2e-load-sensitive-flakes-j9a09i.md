# Two e2e tests fail intermittently under parallel load on hub (measured 2026-10-13)

1. server-layout.spec.ts "phone layout": adjacentBubbleGap returned -1 (no two adjacent bubbles
   found) once in a default-workers run; 16/16 green on one worker, 4/4 alone.
2. server-reactions.spec.ts:148 "two people react live": chip still "👍2" + aria-busy (remove
   request pending) after the 3s toHaveText timeout, once in a 4-spec x2 parallel run.

Neither touches GIF/Fry code; CI e2e was green for weeks before. Next: reproduce with
--repeat-each under load, capture error-context, find the race (likely: history render staged
after first bubble visible; reaction PUT slower than 3s under load) and fix the test or app.
