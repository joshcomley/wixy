# 00015 [3aexen] cmd defects behind the missed 20:13 check-in

Operator 2026-10-28 ~21:09: "you had a 20:13 check-in, but it didn't fire. So why didn't it fire? We need to fix that".
Measured: reminder rmd_3f04b5559ffc occurrence 3 fired 20:14:03; Cmd-Chats typed it into a zombie console, its own
submit_confirm asked for kill-and-respawn, method_drivers.py overruled ("claude.exe is ALIVE … NOT killing") and
deferred_resubmit logged verdict=redelivered; it never landed; reminder parked uncertain_hold. Lane b8f07136 went
stalled (both_signals_cold) from 20:58 with alert_count 0. Brief: scratch cmd-wake-defects.md. Fixed in a cmd
sub-workspace (workspace 25847ef5, first chat ea1c9526). Replacement wake: rmd_57ae5f12e32f.

**Done 2026-10-29.** cmd workspace #1198 shipped both fixes as cmd PR #4360 (merge 55bdfc9, 03:18:55Z; decisions 01142 + 01143), deployed to cmd (03:19:58Z) and Cmd-Chats (03:19:08Z). A zombie-console redelivery now retires the stuck driver, respawns, and counts as delivered only when the transcript shows the turn; finished-workspace metadata no longer cancels a parent's lane alert (three long-stalled lanes alerted within 2 min of deploy). Still unknown: why a console goes zombie (one confirmed candidate, a console selection in progress; forensics now captured per event). The lead chat itself went zombie 00:24-01:38Z and was revived via `POST /sessions/<id>/driver/kill` + a peer send. Answers Q-036 (entry 3352) marked answered.
