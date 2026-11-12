# 00003 [vq78vr] Live voice notes

Spec: spec/server-chat/07-live-voice-notes.md; decisions/00211; Answers 3770.
Depends on 00002 (spec 06 live upload) being integrated first: same recorder/thread/upload files.
Modules: (1) server decoder task + live attachment status + WS route; (2) rolling transcription; (3) client mode switch, LIVE sender UI, listener live player via call AudioWorklet; (4) synthetic two-browser proof, then physical-device gate on both real phones.

## 2026-11-12 ~17:00 — shipped
Merged d43f44c6 (PR 415), live on blue slot, Wixy healthy, DB schema 23. Two-browser e2e green x3 locally + CI. Remaining: physical-device gate (operator, both phones). Answers #3770 partial.
