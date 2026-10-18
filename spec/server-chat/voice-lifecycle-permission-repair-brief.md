# Bounded lifecycle repair — pending call permission on persisted pagehide

Source b2c01b60eb7bb4b11e9b1dde335f245c452cf625. Round3 audit PASS is recorded
but did not execute this newly measured counterexample. Do not broaden this task
into another whole implementation review. Parent owns integration and delivery.

Actual regression in parent `admin-ui/tests/server/panel.test.ts` named
`pending call permission cannot waive cache lock`: real panel hooks and real
call controller; only socket/audio resource collaborators injected. Incoming,
Answer, prepare with unresolved audio.prepare holds panel micPermission. Both
pagehide listeners are collected/reordered explicitly. Default hidden-lock
settings. Four cells: panel-first/controller-first, with/without later hidden
notification. At current source panel-first2fail (no panel detach, fresh reattach);
controller-first2pass. Audio stops once in all cases; this is a lock-policy bug,
not continued audio or third-device disclosure.

Source: onHidden sets hiddenTransitionHandled BEFORE isPickerOrMicOpen return.
Panel-first pagehide exempts micPermission; controller detach then releases it.
Later hidden gets deduplicated and onVisible restores presence without applying
default lock. Exemption is temporary, not a completed hidden-policy decision.

Independent PROPOSE from Astra and Gemini, ALL issues = this ONE issue. Exact
smallest panel-level code, honest red/green or explicit unexecuted green, limits
and layer check. Preserve genuine filePicker/micPermission hidden exemptions,
ignore policy, shield and re-hide, grant renewal, nonpersisted unload and actual
controller pagehide teardown. Account for BOTH event orders and absent hidden
notification; no repeated timers or independent controller policy machine.

Parent source edits forbidden; in-memory trials or own isolated checkout only.
Do not read the other's proposal before MERGE. Bounded3-minute proposal, no
blanket suites, no new agents, commits, branches, PR or deployment.
Astra output parent `spec/server-chat/voice-permission-proposal-astra.md`.
Gemini output own workspace50 `spec/server-chat/voice-permission-proposal-gemini.md`.
Parent then sends BOTH to EACH for a narrow MERGE. YOUR OWN PROPOSAL HAS NO
PRIVILEGE IN PHASE 2. Label MEASURED-BLIND/MEASURED-KNOWING/CITED; do not count
the parent's baseline as your measurement. State drop-first/defend-hardest.

No relitigation of the five already converged repairs or live gate scope.
Parent applies selected repair, executes this4-cell discriminator and affected
panel/grant/call controls, updates proof and seeks proportionate fresh review.
Physical/tunnel/quality/Slots and confirmed delivery SHA remain open.
