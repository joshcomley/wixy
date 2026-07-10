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
Elevation needed for Cloudflare tunnel config + Access app (admin gate); Devfleet/Slots
registration file edits are NOT elevated (user-session control planes, spec/07 §2).

Sliced into repo-code first, then live execution — mirrors this whole chain's own
"verify for real, don't assume" discipline, but ALSO splits cleanly on blast radius:

- Slice 1 [DONE]: every repo-side artifact spec/07 §1 lists — `launcher.py` (reads
  `active.txt`, re-execs `Slots\<slot>\.venv\Scripts\python.exe -m wixy_server`; a
  simpler, self-contained mechanism than Loom's own launcher, which instead relies on
  `post_swap` repointing Devfleet's argv — spec/07 §2's own fixed `services.toml`
  snippet confirms Wixy's design is deliberate, not an oversight, decisions/00036
  decision 1), `deploy.py` (modeled on cor/Smartbell's cleaner template rather than
  Loom's evolved complexity, decision 2), `slots.wixy.yaml`, `install.py` (idempotent,
  dry-run-verified twice against a fully local fixture, decision 5), a REAL pinned
  `requirements.txt` (generated from an actual venv install + freeze, not guessed,
  decision 3), `tooling/provision_ca_cloudflare.py` (written, NOT executed — mirrors
  an existing app's policies dynamically rather than hardcoding an email/token id,
  decision 7). Plus the product code those artifacts assume: `wixy_server/__main__.py`
  (`python -m wixy_server` didn't mean anything before this), `wixy_server/bootstrap.py`
  (the server's own "publish zero" self-bootstrap on every startup, per spec/07's
  explicit requirement — a real, load-bearing behavior change that needed 3 existing
  tests fixed, decision 4, verified via an exhaustive agent sweep that actually RAN the
  full suite rather than just reasoning about it), `/api/version`'s `slot` field
  (previously hardcoded `None`, now reads `WIXY_SLOT` — set by `launcher.py`).
  542 Python tests passing, mypy strict clean, ruff clean. Full reasoning:
  decisions/00036.
- Slice 2 [next]: live execution — merge slice 1 to `main` first (Slots clones from
  `origin/main`, not any local worktree), THEN run `install.py` for real against
  `D:\Servers\Wixy\`, THEN Devfleet registration (`services.toml` + `/reload`) +
  Slots registration (`consumers.json` + `/restart/Slots`) — both no-elevation,
  reversible, "just do it" per this session's own read of the blast-radius split
  (decisions/00036's "Scope boundary" section) — THEN verify spec/07 §4 items 1-2
  (health, slot-cycle proof). Cloudflare provisioning (§3) is flagged for explicit
  operator confirmation before execution — elevated, shared tunnel config affecting
  EVERY fleet subdomain, a new public-facing Access policy — genuinely different risk
  category from the rest of this milestone.

## Relevant files
- spec/07-hosting-deploy.md (full — repo artifacts §1, registrations §2, Cloudflare §3,
  verification checklist §4, ops notes §5)
- D:\Servers\Slots\Slots\green\docs\ai\onboarding.md (the authoritative fleet runbook —
  read in full before slice 1)
- Reference implementations actually read in full: D:\Servers\Loom\{launcher,deploy}.py,
  D:\Servers\Smartbell\{launcher,deploy}.py + Slots\blue\slots.cor.yaml,
  D:\Servers\Tenna\Storage\provision_cf.py

## How to continue + acceptance
Port 9380. Never touch SCM/NSSM directly — Devfleet supervises. CF Access app scopes
ONLY /admin* + /api/admin* (never the whole hostname — public site must load with zero
auth). Admin gate for elevated steps (tunnel config edit, CF API calls) per fleet rules.
Verification checklist 07 §4 items 1-2 (status healthy, slot cycle proof) achievable
before cutover; items 3-8 fully verifiable only after M12/M13.

## Links
PR (slice 1): https://github.com/joshcomley/wixy/pull/45 (merged b838f21)
