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

**2026-10-29, PR #360 merged as 9c94d06** (delegate relation 5c904904, report in that worktree's `.scratch/report-360.md`):
- A second, locally reproduced failure in the same spec (desktop test, line 108: Josh's own message "not found"
  after tapping the reply's quote) is root-caused and fixed: Send then the quote (a gesture-boundary control)
  360 ms apart trips the specified double-tap lock. Test-only; red 8/8, green 8/8 (decision 00198).
- CI now keeps `screenshot: "only-on-failure"` + `error-context.md` and uploads `e2e/test-results/` when e2e fails
  (proven to cover tests that open their own `browser.newContext()`). `trace` was rejected: +31 % suite time
  (248 s -> 325 s) and one 27 s `context.close()` hang.
- **Still open:** the CI mobile unlock stall itself did NOT reproduce (60/60 plain, 40/40 at 6x CPU throttle, two
  full runs). Next occurrence: read the uploaded screenshot. The PIN pad's message discriminates: "Server settings
  unavailable" = the PIN verify hit pinclient's 5 s timeout (fake cmd stalled); "Wrong PIN" = a digit tap lost;
  decoy = an immediate re-lock; blank pad = `/unlock` never answered. Sibling 00013 not shown related.
