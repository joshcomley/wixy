# 00017 [9znlju] A ringing call pauses the idle lock

Operator decision #2136 (2026-10-28): "Yes, keep it unlocked while ringing". Found by 00014: a caller who
waited more than ~10 s for an answer was locked out mid-ring, which ends the call.

Builder 6c531f07, build space bs5 (branch cmd/workspace-00056-bs5). While a call is calling, ringing or
connecting, the 10 s idle lock pauses on both devices and hands straight on to the connected-call pause;
every way an attempt ends releases it and restarts a fresh countdown. Deliberate locks (double-tap, Escape,
✕, panic) still lock at once and end the call. The server already caps ringing at 30 s and connecting at 20 s.

Opus audit relation 127953d8-ddea-4175-be6d-0215bc4ce44e, clean (C0/H0/M0/L0) after 5 rounds:
- F2 (high): a page frozen mid-ring (iPhone auto-lock with both "lock when I leave" boxes unticked) could
  return unlocked. Pre-existed for connected calls. Fixed with heartbeat-stamped live holds
  (`LockHooks.suspendLive`, `LIVE_HOLD_STALE_MS` = 3000): a stale hold stops counting and a frozen page
  past the idle period locks the moment it returns.
- F1 (low): an unlocked peer re-inviting back to back could hold the callee's chat open; capped after two
  unanswered rings with no local activity.
- F3 (low): doc comment placement.
Decision 00197 records the design and residuals. PR #357 (audited head 7c95519d).
