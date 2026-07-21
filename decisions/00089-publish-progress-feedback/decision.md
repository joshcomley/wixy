# Publish progress feedback is shell-owned (status-bar spinner + stage narration + live toast)

**Symptom (operator report, 2026-07-21):** "Is there any kind of indicator when the site is
publishing? The slim banner at the top? The publish button should get a spinner icon at least,
and some notification when it's live." A publish takes 30-60s server-side (pull → merge →
commit+push → build → verify → swap), and the only feedback was the drawer's small inline
"Publishing… (stage)" text. Close the drawer mid-publish (or reload, or publish from another
tab/device) and nothing anywhere said a publish was running, was finishing, or had failed —
the status bar's only gesture was disabling the Publish button, which on a phone reads as
"broken", not "busy".

**Root cause:** run/completion feedback was drawer-owned. The shell knew `publishJob.isRunning`
only enough to disable two buttons on the next state refresh; the completion path
(`onPublished`) lived entirely inside the drawer's lifecycle, so a torn-down drawer silently
dropped it.

**Decided:**
1. **The shell owns publish feedback** (Inv 25), not the drawer. A watch
   (`ensurePublishWatch`/`publishWatchTick` in `shell.ts`) polls `/api/admin/state` every 2s
   while `publishJob.isRunning`, armed by EITHER the drawer's new `onPublishStarted` dep
   (fired synchronously on confirm, before any await) OR any state load that finds a running
   job — covering reload-mid-publish, other tabs/devices, and AI-assistant publishes. Poll
   failure stops the watch silently (revalidation re-arms); a 600-poll (~20 min) cap bounds a
   wedged job.
2. **The confirm→POST race is bridged explicitly.** The watch's first poll can beat the POST
   that registers the job (it would see "no job" and stop; the spinner would never show). So
   `onPublishStarted` sets `publishInFlight` synchronously — the busy affordance renders with
   the CLICK itself (fleet instant-feedback rule) — and the watch keeps polling while the flag
   is up; `onPublishSettled` (the drawer's promise settling in ANY outcome, including the
   409-conflict path where NO job ever starts) clears it. A second guard,
   `publishWatchSawRunning`, means a STALE terminal job from a previous publish (the server
   keeps the last job) is never announced — the watch only toasts a job it actually watched
   run.
3. **The slim status bar IS the progress surface** (answering the operator's question): the
   Publish button swaps to spinner + "Publishing…" at full opacity (`wx-button-busy` +
   `wx-spinner`, shared `spinnerButton.ts` helper, `prefers-reduced-motion` respected) and the
   chip narrates the stage in layman wording (`PUBLISH_STAGE_LABELS`: "Building the site…",
   "Taking it live…", … — decisions/00082's no-git-jargon rule).
4. **Exactly one terminal toast**, version-guarded (`announcedPublishVersion`) so the drawer's
   success path and the watch never double-announce whichever fires second: "Published —
   version N is live." (info, 6s) or "Publish failed — your draft changes are safe." (error,
   8s) — both longer than the default 4s because they carry the outcome the operator is
   waiting for. Success also recaptures all page thumbnails (the draft's pixels became the
   site's). The toast region is now `role="status"` so notifications are announced, not just
   painted.
5. **Drawer stays coherent:** its confirm button spins too, hides on success (a stale
   `expectedRev` makes a second click meaningless), restores on failure; `onPublished` now
   passes the version.

**Why not SSE for the watch:** the drawer's stream needs `EventSource` (untestable in jsdom
and a second connection to manage); the 2s state poll reuses the tested fetch path, drives
`renderTopBar` with zero extra wiring, and the watch's cadence only exists while a job runs.

**Watch for:** any new publish trigger must fire `onPublishStarted` (or be visible via
`publishJob.isRunning`); the drawer's inline SSE stage text stays technical (`(building)`) —
the layman map is the status bar's; e2e: `e2e/tests/publish-feedback.spec.ts`.
