# 00002 [3l0ia3] Call ends just after Answer on iPhone Safari

## What / Why

The operator reports a real call returns to the caller's Call button just after
the callee answers. The callee uses Safari on iPhone; the caller is Android Chrome.
The earlier same-operator phone test and synthetic Chromium proof do not establish
this affected pair's setup behavior.

## Context + current state

LATEST: diagnostic repair published in PR329, merge
`d2fdc2662fd02686d5e31eea481b143b5f180956`. All six final checks passed at
`0ef1a3e22921ede8dc174b5d998c6d480d4b0070` (reviewed source514b133 plus
audit/task documentation). Origin9380 and publicca `/api/version` both match
the merge, internal `/healthz` ready200, green slot, checked2026-10-18T20:21:56Z.
Senior Opus round4 C0/H0/M0/L0. Decision1874 requests affected Android/iPhone
Safari refresh/unlock/retry, Transcribe check and safe copied call details if
failure. Actual affected-pair success remains unproven: keep this task OPEN.
The three diagnostic-release delivery tasks are done; the remaining step is
affected-device evidence and any repair that evidence requires. Earlier context
below is historical.

CURRENT: three discriminators reproduced red and now green: capture-induced
suspended/interrupted audio, permission-time timer stall before initial connected
pulse, and permanently hidden Transcribe after unavailable. Setup-only resume has
cancel/reject/still-suspended controls; connected300ms stall gates unchanged.
Local and peer failures are visible and offer a bounded32-stage copyable trace
without content/identities/IDs/tokens/URLs/stacks. GET-only Transcribe rechecks
recover the control, abort after5s, retry unavailable after15s, cancel on detach
and ignore late owners; no automatic transcription POST. 2630 frontend tests,
strictTS/LFbuild and four real Chromium scenarios pass, including safe details
and recovery without audio resend. Private synthetic-silence request returned200
after fresh capabilitytrue; actual first failed probe was not captured.
Affected iPhone result remains unproven. User permits diagnostic release before
retest. Freeze and get a fresh senior audit, then final PR/checks/merge, refresh
both affected phones and collect actual result/details. New delivery cycle2 id
ab27b7f8-6bf1-4080-a75a-dbdd3e494f02. Earlier problem description below is historical.

Original feature delivered in PR328, merge22571a22efe72ebb975702b0539c8a5e41bade0c.
This is a new repair. Operator authorizes a diagnostic release (interpreting
"loads of blogging" as logging). No audio, messages, labels, identities or access
tokens may enter diagnostics. Preparation failure currently hides its status in
screen-reader-only text; the other endpoint sees generic Call ended.
Browser identification banked in decision1872. Permission-prompt behavior and the
actual time-to-failure remain unknown. No Job Master exists for wixy.

## Relevant files + commits

Audit follow-up:69c071d received senior round3 C0/H0/M2/L3. All five repaired
directly in the local loop; see voice-answer-repair-audit-packet.md response for
finding-to-fix mapping. New five discriminator cells reproduced RED then GREEN.
Full2635 tests/102files, strictTS and LF rebuild pass. Four browser scenarios pass
38.2s, including phone-width dismissal. Commit the corrected exact head and submit
the same audit relation's next round; source remains frozen while it reviews.
No repair PR or deployment yet; affected physical pair remains unproven.

`admin-ui/src/server/call/{audio,controller,worklet}.ts`, the call tests,
`wixy_server/livechat/{call_protocol,call_broker}.py`, and the voice-call spec.
Existing failed control/terminal reason may provide error propagation without
changing the protocol. Inspect before choosing the repair.

## How to continue + acceptance

Reproduce a discriminating setup failure with the real controller and audio
adapter; inspect actual Safari/WebKit constraints. Implement bounded,
cancellation-safe repair and diagnostics with useful on-screen failure messages.
No weakening of authorization, audio freshness or lock semantics. The user permits
a diagnostic release so the affected pair can retest and expose the real cause. Run focused local
checks, required senior review for lifecycle/audio changes, then final PR/checks/
merge and production SHA verification. Do not report the actual iPhone problem
fixed from synthetic Chromium alone.

## Senior clearance

Opus round4 independently cleared exact514b133 (C0/H0/M0/L0), all five findings fixed. Report: spec/server-chat/voice-answer-repair-audit.md. Independently ran214 focused/1744 wider tests, strictTS and byte-identical in-memory asset rebuild. Diagnostic release only; actual affected pair still requires retest. Bank report with documentation-only commit, then final PR/CI/merge and actual deployed SHA verification.
