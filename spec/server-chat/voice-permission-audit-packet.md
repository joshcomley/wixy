# Focused fresh senior audit — cached permission policy completion

Review exact head supplied in dispatch against b2c01b60eb7bb4b11e9b1dde335f245c452cf625.
This is proportionate review of one newly composed lifecycle repair, not another
whole transport review. Prior round3 audit covered the unchanged backend/audio
implementation, but missed the subsequent real-controller permission-order test.
Do not inherit its clearance for this delta or reuse proposers as reviewers.

Intent: default background-lock/shield policy must be independent of panel/call
controller pagehide listener order, even with microphone permission pending.
Controller still stops audio immediately. A temporary permission/picker exemption
is not a completed hidden-policy decision. Existing exemptions that remain held
and ordinary non-cache chooser returns keep their existing behavior. No new
consent/audio resumes when cached presence returns.

Runtime delta is confined to server/panel.ts plus rebuilt assets. Inspect actual
hooks, reducer, controller teardown, shield/renewal integration and tests around
that change. No backend/media/protocol/worker code changed in this repair.

Selected mechanism: explicit none/exempt/handled outcome; existing
restorePresencePending owns cached-policy lifetime. A private helper rechecks
only a disappeared cached exemption, using the ORIGINAL hide timestamp. Invoke
it after suspension release, before handling persisted pagehide, and before
visible restoration. Real lock/detach/dispose invalidates the marker. No extra
timer, independent controller policy or new view/authority interface.

Check for actual defects, especially:

- Actual real-panel/real-controller permission teardown in both listener orders,
  with/without hidden event; lock completes before visible return, no transient
  new presence before policy, one audio stop/socket close and bounded reentrancy.
- Visibility-hidden -> permission release -> persisted pagehide; held exemptions
  at cache return; ordinary non-cache chooser exemption after release.
- Ignore mode, shield creation/re-hide/causal evidence using original hide time,
  grant renewal and nonpersisted unload, actual lock/disposal and late callbacks.
- Helper initialization/owner lifetime, repeated/late events and timer behavior;
  a green final UI alone does not prove ordering or resource ownership.
- Generated LF assets match source; docs and tests describe actual semantics.

Parent-local evidence: baseline real-controller four-cell case2fail/2pass;
extra immediate-lock/earlier-release/shield-cause cells fail at old source.
Combined284 affected panel/grant/call tests pass, including four genuine-exemption
controls; strict TS and LF build pass. Full1724 frontend chat regressions passed
before the final one-line invocation of the SAME guarded helper before onVisible;
284 affected cases and strict types passed again after that invocation. Parent
real Chromium cache recovery preserves draft, restores exactly one presence and
no audio, and cannot restore after panic. This browser scenario passed before
the final defensive invocation; it is not physical BFCache/mobile acceptance.
Unchanged backend62-test and two-browser/third-observer audio proof from b2c01b6
remain applicable only to unchanged modules, not new mobile acceptance.

Perform one bounded focused pass; run necessary discriminators, no blanket suite
or full CI, no proposal history before independent assessment. Write ONLY
spec/server-chat/voice-permission-implementation-audit.md with exact SHA,
C/H/M/L counts, concrete reproduction/file lines/repair and code verdict. A clean
result is valid. No source edits, branches, commits, push, PR, merge or agents.
Parent keeps the audited tree unchanged. Peer parent and finish the assigned lane.

Launch gates remain separate/open: physical Android/iPad/actual iPhone browser,
production Access/tunnel across networks,15-minute speakerphone/duplex quality,
measured latency/jitter/loss and actual Slots blocked-worker shutdown. Do not
certify these from mocks, synthetic audio or declared settings. No PR/delivery
exists; parent owns remaining acceptance and actual confirmed merge SHA.
