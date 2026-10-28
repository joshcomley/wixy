# 00014 [kefyip] E2E calls duplex test intermittent

server-calls.spec.ts:89 "duplex sound, muted idle pause, panic stop and fresh idle countdown": failed in
builder bs2's full runs (pw1.log 2026-10-28 ~19:43Z: test timeout 90 s, last seen "Connecting audio…", then
browserContext.close protocol error) and once earlier; passed 16 + 10 + 9 targeted runs (duplex.log,
duplex1.log, duplex-load.log). Call setup is product code (admin-ui/src/server/call/, livechat/call_broker.py,
Inv 55): find whether it is a real race in audio connect or a harness timing artefact before branch
protection makes e2e a required check.
