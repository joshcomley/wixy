# 00018 [hd55of] E2E reply test: unlock stalled 5 s on CI

PR #360's CI e2e (run 40792341131, 2026-10-29 00:21:15Z): `server-reply.spec.ts:118` (mobile) failed at its
unlock helper's wait right after the PIN submit: neither the name prompt nor the thread within 5 s. The test
took 6.2 s in all, so everything before the submit ran at normal speed, and other workers' full PIN unlocks
in the same seconds finished in ~1.0-1.4 s, so this is not plain runner slowness. CI kept no artifacts, so the
page state at failure is unknown.

Sibling shape: 00013 (decoy absent 5 s after goto in a loaded local run).

Work (Sonnet builder on branch adv/e2e-align-save-wait, PR #360, alongside the align-save wait fix ffda7479):
reproduce with retained traces, root-cause with measurements, fix at the source (product defects go to the
operator first), red/green; make CI upload failed e2e test-results (trace/screenshot) as an artifact.
