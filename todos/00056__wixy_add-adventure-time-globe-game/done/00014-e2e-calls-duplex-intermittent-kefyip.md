# 00014 [kefyip] E2E calls duplex test intermittent

server-calls.spec.ts:89 "duplex sound, muted idle pause, panic stop and fresh idle countdown": failed in
builder bs2's full runs (pw1.log 2026-10-28 ~19:43Z: test timeout 90 s, last seen "Connecting audio…", then
browserContext.close protocol error) and once earlier; passed 16 + 10 + 9 targeted runs (duplex.log,
duplex1.log, duplex-load.log). Call setup is product code (admin-ui/src/server/call/, livechat/call_broker.py,
Inv 55): find whether it is a real race in audio connect or a harness timing artefact before branch
protection makes e2e a required check.

**Done.** Root cause: the 10 s idle lock locked a device nobody had touched while call setup ran past 10 s on a loaded machine (locking correctly ends a call), so the test waited forever at "Connecting audio…". RED with an 11 s pause, GREEN 3x with the test keeping both devices awake through setup (decision 00196); 268/268 full suites x3. PR #356 merged as ebcc4ac. It exposed a product question (should a ringing call keep the chat unlocked?) — operator decision #2136 = yes, built as 00017.
