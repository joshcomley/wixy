# 00011 [w4ll89] M11 WX — Install & deploy

## What
`install.py` (D:\Servers\Wixy layout), `launcher.py`, per-slot venv+asset build, Slots
consumer entry, Devfleet child registration, cloudflared ingress `ca.cinnamons.uk`, DNS
record, CF Access app (+ JWT middleware config), `.env` provisioning; deployed +
`/status` healthy.

## Why
Everything built so far needs to actually run on the hub VM at ca.cinnamons.uk before
milestone 12 (cutover) and 13 (live verification) mean anything.

## Context / current state
Depends on all prior WX milestones (6-10) for there to be something worth deploying.
Elevation needed for Cloudflare tunnel config + Access app (admin gate) and possibly
Devfleet/Slots registration file edits.

## Relevant files
- spec/07-hosting-deploy.md (full — repo artifacts §1, registrations §2, Cloudflare §3,
  verification checklist §4, ops notes §5)

## How to continue + acceptance
Port 9380. Never touch SCM/NSSM directly — Devfleet supervises. CF Access app scopes
ONLY /admin* + /api/admin* (never the whole hostname — public site must load with zero
auth). Admin gate for elevated steps (tunnel config edit, CF API calls) per fleet rules.
Verification checklist 07 §4 items 1-2 (status healthy, slot cycle proof) achievable
before cutover; items 3-8 fully verifiable only after M12/M13.

## Links
PR: (fill in when opened)
