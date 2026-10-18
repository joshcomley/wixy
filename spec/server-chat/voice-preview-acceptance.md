# Private voice-call preview and remaining acceptance

## Current deployment (supersedes the Grid plan below)

The operator requested direct deployment and testing. Grid was an unnecessary
dependency for hosting this preview; two hours was an arbitrary shutdown limit,
not an acceptance duration. Decision1869 is withdrawn; hub's worker stays stopped.

The candidate is now deployed at
**https://wixy-call-test.cinnamons.uk/admin/server**, under Devfleet service
`WixyCallPreview`, with no two-hour cutoff. It serves an immutable archive of
`177e0a91a154b33ec0e5cd6647bf4053638f7d5a` (same audited product runtime as
`a2030d5`). Archive SHA256:
`8d621b05449eab6ed4cabe77880f2bf88ecd30d3a4f84818260d1f693bffc12a`.
The snapshot and isolated data are separate descendants of the registered runtime
directory. The source launcher is `tooling/voice_preview_service.py --runtime
<workspace>/.scratch/voice-preview-runtime`.

The operator subsequently reported "It works!" from Android Chrome and requested
phone/hang-up icons beside the ⋯ menu, then explicitly requested publication.
This establishes reported real-device login and call success; it does not supply
latency samples, a documented 15-minute speaker test or blocked-worker shutdown
measurements. Those limits remain disclosed rather than inferred from the report.

The runtime was relocated out of `e2e/test-results` after discovering Playwright
clears that directory. The preview's retained SQLite database was moved intact;
deleted preview settings and local fixture are reconstructed. Production storage
was never involved. The launcher now rejects runtime paths under `test-results`.

Observed: origin health200, unauthenticated admin API401, public Access redirect,
and Access login HTML200. DNS route and ingress were added with a validated
candidate config and backup; elevated gate request
`req-4a01ec86-2f97-4646-910c-9ab2574c6256` completed exit0, Cloudflared Running.
No production chat storage or production Wixy service was changed.

Interactive login and a working phone call are now operator-reported. The full
15-minute duplex/speaker test has not been documented; it is an acceptance exercise,
not a hosting timeout. The service can be stopped via Devfleet's existing stop
action for `WixyCallPreview`; stop it before retiring its registered source/data.

The sections below preserve the original preparation evidence and superseded
Grid dependency. They are historical where they conflict with this section.

Checked 2026-10-18, continuation session `18da6fbb-bcd2-44d3-9c7a-4caab2a13051`.
Runtime candidate `a2030d5410042b60ebfb0b4c0543c1ef9e1edd7f`; subsequent
`3564bb0` only banks its focused audit and task records. No PR or delivery merge.

## Prepared environment

- Intended URL: `https://wixy-call-test.cinnamons.uk/admin/server`.
  **Not live yet. Do not present this as a working test URL.**
- Origin: hub loopback port **9488**. Confirmed absent from Slots and Devfleet
  configuration and available to bind during preflight.
- Cloudflare Access application `f4ef91fb-0b6a-435f-9e5c-0b8036eaba20`,
  full-host protection, operator email allow policy only, 24-hour session.
  No service-token bypass policy was added.
- Fresh storage and disposable local fixture site under the workspace's ignored
  `e2e/test-results/voice-preview-runtime/`. No production chat/media/secret-key
  files or site repository were copied. Git writes target the local fixture only.
- Production-mode authentication, strict HTTPS origin, real default PIN verifier
  for the existing `wixy-livechat` project key. No PIN value is held by the runner.
  PIN verification uses the existing service's lockout state; never guess a PIN.
- The workspace is adopted in Fir's central folder ledger as hub folder
  `212f18aa-804b-4a54-acde-6da5cee9b701`, with original creator unknown and
  review-required retention. Descendant preview artifacts inherit that record.
- Runner exits after two hours; Grid timeout is 7,260 seconds. No recording or
  transcription instrumentation is enabled. The runner disables HTTP access logs.

Preparation and run helpers are local ignored evidence:
`voice-preview-{prepare,run,submit,local-check}.py` in `e2e/test-results/`.
Settings JSON contains configuration identifiers, no PIN or Cloudflare API token.
Helpers read the existing Cloudflare credential in memory without copying it.

## Measured preflight

`python e2e/test-results/voice-preview-local-check.py` passed:

- Actual candidate app starts and serves `/healthz` with 200.
- Server data path is contained in the isolated preview directory.
- Allowed call origin is exactly the intended preview HTTPS origin.
- Authentication bypass is disabled.
- Unauthenticated admin page redirects to `/`; admin API returns 401.
- Unauthenticated real call-WebSocket upgrade returns 403.
- Fixture-only test route returns 404.
- Origin finishes its normal application shutdown and leaves no server running.

The first preflight assertions incorrectly expected an authentication redirect to
Cloudflare. Inspection confirmed the engine's documented behavior is a local
redirect to `/`; the checker was corrected. Product code was unchanged.

These checks establish origin preparation, not authenticated identity-path,
phone audio, performance or Slots shutdown acceptance.

## Current dependency

Grid preview task `t-1d5830f7a029` was submitted, remained pending, then was
cancelled without starting. Hub's worker is absent from capacity; Devfleet
reports `CmdGridWorker` stopped with `user_requested_stop=true`.

[Decision 1869](https://cmd.cinnamons.uk/decisions#d-1869) asks whether to restart
that explicitly stopped worker. Do not infer authorization from elapsed time.
Restart could admit other queued work as well as this preview.

DNS and tunnel ingress have **not** been changed. Elevated read-only preflight
confirmed Cloudflared is running with its normal systemprofile config and origin
certificate. No preview ingress rule exists. The gate is open; its standing
authorization does not answer the separate explicitly-stopped-worker decision.

## Continue after the worker decision

1. Recheck decision delivery, worker state, port availability and source candidate.
   If restarting is authorized, use the existing Devfleet supervision; never
   start the obsolete Douglas worker or a duplicate scheduled worker.
2. Resubmit the bounded preview through the supported `ci-scoped` Grid class.
   Record the new task ID and wait for actual origin startup evidence.
3. Commission DNS and ingress with the `commission-subdomain` skill, preserving
   all existing ingress, backing up and validating config, with restart rollback.
   Full-host Access already exists; verify its policy before exposure.
4. Check gated HTTPS and complete a real interactive Access login. An Access
   redirect or a service-token probe alone does not prove identity-path success.
5. Give the operator the now-working URL and request the physical run below via
   the decision mechanism. Additional participant identity access needs explicit
   input; operator devices can use the same authorized identity.

## Physical acceptance record to fill with observed results

- Devices: Android Chrome, iPad Safari and the actual iPhone browser (confirm it).
  Headphones first; one cellular device and one external broadband device.
- Open Server on each, unlock with the known PIN, choose the exact target device,
  Call and deliberately Answer. A third unlocked browser must receive no incoming
  prompt, microphone request or call audio.
- At least 15 minutes duplex: silence, mute/unmute, simultaneous talking and normal
  chat use; repeat on speakers for echo and double-talk. Live listening only.
- Remain muted beyond idle timeout, then End and verify a fresh full idle period.
  Exercise configured hide/screen policies, shield/restore, manual lock, remote end,
  network loss and server/tunnel interruption. Restoration must never resume audio.
- Check mic indicator and playback stop on both devices. Background termination
  is an ended call; telephone-style background continuity is not promised.
- Measure synthetic one-way p95 mouth-to-ear against the 300 ms target, reporting
  sample counts and method; no retained human audio. Measure phone underruns and
  resource stability. Under +100 ms RTT, 30 ms jitter and 1% loss, require intelligible
  audio without multi-second accumulation or prompt explicit failure.
- Separately exercise actual Slots drain/hard-stop with blocked native workers;
  normal origin shutdown above does not close this gate.

Record each as passed, failed or unexecuted with its method. All these physical,
network, sustained-quality/performance and actual Slots gates remain unexecuted
here. Final PR/checks and confirmed merge SHA remain the delivery owner's work.
