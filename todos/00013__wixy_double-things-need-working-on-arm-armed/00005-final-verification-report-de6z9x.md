# 00005 [de6z9x] Final live verification + completion report

## What
After PR3 merges and deploys: final live pass (repeat/confirm all per-PR live checks), then
send the mandatory completion report via POST to the planning agent.

## How
POST to `http://127.0.0.1:9321/sessions/5b2083a2-fdf6-4abf-b1b6-bf43ae0975ba/send` with JSON
body `{"text": "<message>"}` (same as the `peer` skill). Message must cover: what shipped per
PR (PR numbers/merge SHAs/live version numbers), live-verification evidence, deviations from
the brief and why, anything deliberately left for follow-up.

## Links
Brief section "Your reporting contract" + "CROSS-CUTTING VERIFICATION & SHIPPING".
