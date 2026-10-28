# 00013 [m4yy6r] E2E server-push: decoy absent after goto

Full local e2e run 2026-10-28 ~15:55Z (loaded box, builder suite running too):
server-push.spec.ts:161 failed at unlockServer's `expect(.wx-srv-decoy).toBeVisible()`
(5 s, "element(s) not found") right after goto. The decoy mounts synchronously (decoy.ts);
measured boot 114-171 ms; 18/18 passes standalone (--repeat-each 6). So the Server panel never
mounted in that run. Not reproduced in the next traced full run. Root-cause with a retained
trace (run the full suite with --trace retain-on-failure until it recurs).
