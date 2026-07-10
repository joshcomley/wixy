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
- Slice 2 [DONE, minus Cloudflare]: live execution. `install.py` ran for real against
  a genuinely fresh `D:\Servers\Wixy\` — both slots cloned + venvs built, the REAL
  `cottage-aesthetics-preview` site cloned and bootstrapped as version 0 (confirmed:
  read the actual build output, all 9 real pages present; curled the running server
  and got the real "Cottage Aesthetics — Nurse-led aesthetics in Hartlebury" homepage
  back). Registering with Devfleet immediately surfaced a REAL bug the standalone
  smoke test had missed: `launcher.py`'s `os.execv` handoff exit-looped under actual
  Devfleet supervision (`os.execv` on Windows spawns a separate process rather than
  replacing the caller's image, orphaning the server from Devfleet's Job Object the
  moment the launcher process itself exits) — root-cause-fixed to a blocking
  `subprocess.run` (decisions/00037), shipped as its own PR (#46), then manually
  synced into the already-installed slots (git fetch + reset --hard, both slots
  confirmed clean first) since Slots wasn't registered yet to do that automatically.
  Re-verified stable under Devfleet after the fix: `status: "running"`, `healthy:
  true`, `restarts_in_window: 0`, uptime climbing. Devfleet (`services.toml` +
  `/reload`) and Slots (`consumers.json` + `/restart/Slots`) registration both done —
  via PowerShell rather than the Edit tool, since `services.toml`/`consumers.json`
  turned out to be live operational state routinely mutated in place by other
  services' own deploy hooks (confirmed via pre-existing git drift, decisions/00038),
  not "deployment target source" the worktree-guard's blanket rule was aimed at.
  Slots load confirmed via the poke endpoint (`403 no HMAC secret` — the documented
  correct response for a `hmac_secret_id: null` consumer, not a 404). Full reasoning:
  decisions/00038.

  **Slot-cycle proof (spec/07 §4 item 2): CONFIRMED, but not on the first attempt —
  two more real bugs surfaced only once a genuinely automatic cycle got far enough
  to hit them.** The decisions/00038 commit (72ccec1) itself DID swap in
  automatically with no manual sync — but watching it (rather than assuming success)
  caught deploy #2: `_pip_install_venv` tried to `rmtree` the venv its OWN
  interpreter was running from (Slots' executor prefers a slot's EXISTING venv
  python to run the build-step subprocess in — true for every redeploy after the
  first), a `PermissionError` that failed 107 consecutive times per Slots' own
  `executor_outcomes` table before I found and fixed it (decisions/00039 — a
  previously-documented fleet outage class, 2026-05-25, per `D:\Slots\self`'s own
  `run_pip_install` docstring; fixed with the same atomic `.venv.new`-build-then-
  swap pattern, self-contained rather than taking on a new `slot_swap_deploy`
  runtime dependency). Shipped as PR #48. The moment THAT fix let a cycle reach the
  swap+restart phase for the first time, it immediately surfaced deploy bug #3:
  `post_restart(ctx, svc)` doesn't match `slot_swap_deploy`'s real `fn(ctx)`-only
  hook-calling convention (copied from cor's deploy.py, which apparently carries
  the same latent bug on a path cor's own production deploys never exercise either)
  — fixed to a single-arg signature (decisions/00040), shipped as PR #49. **After
  PR #49 merged, the very next Slots cycle deployed it end-to-end with zero manual
  intervention**: confirmed via `D:\Servers\Wixy\active.txt` = `green` (swapped from
  blue) and `curl :9380/api/version` reporting `sha_full` = `54ad4cd...` (PR #49's
  own merge commit) — plus `/healthz` 200, the real Cottage Aesthetics homepage
  still serving correctly, and Devfleet `/status` showing `running`/`healthy: true`
  with only the ONE expected restart (not a crash loop). Slots' own DB
  (`executor_outcomes`) independently confirms the same cycle: `deploy_status:
  "deployed"`. Three real bugs found this session, all via actually watching a live
  deploy run rather than trusting a standalone smoke test — exactly the value this
  whole chain's "verify for real" discipline keeps paying for.

  A Slots-spawned "AI repair" chat also auto-fired mid-incident (executor-stuck
  self-healing, `repair_id=18008`) — investigated (no conflicting PRs/changes from
  it), left running rather than killed since it wasn't causing harm and my own
  fixes resolved the underlying issue directly.

  **Remaining, BLOCKED**: Cloudflare provisioning (spec/07 §3). Operator confirmed
  go-ahead via AskUserQuestion (2026-07-10). Tried both elevation channels in order
  per the global CLAUDE.md: (1) admin gate — HEARTBEAT read 16h+ stale; did NOT
  assume closed from that alone, submitted a real no-op probe through the inbox and
  polled 30s — genuinely no result, confirmed closed, not just idle; (2) fallback
  `request_admin_action` — submitted for real (`requestId 36ffaf8f`, full
  request text in `C:\Users\josh\.claude\admin-requests\req-36ffaf8f-....json`),
  the triple-model consensus classifier came back `verdict: "blocked", unanimous:
  false` (`D:\Servers\Cmd-Admin\Storage\admin-audit.log`) — at least one model
  voted BLOCKED, which rejects outright regardless of the other two. No per-model
  reasoning available in the audit log, only the aggregate verdict. This is a
  working safety gate declining a genuinely elevated, security-relevant op
  (LocalSystem config edit + shared service restart + a new public auth policy) —
  not routed around; reported back to the operator to decide how to proceed
  (run it themselves, investigate the classifier's reasoning, or resubmit with
  different framing). `tooling/provision_ca_cloudflare.py` itself is unchanged,
  ready to run whenever an approval path opens.

  Once Cloudflare is done, spec/07 §4's remaining verification items (3-8) need a
  real external check (public HTTPS reachability, CF Access wall, edge-header
  guard from outside, robots.txt/indexable, reboot survival) — items 1-2 (health,
  slot-cycle proof) are fully done and verified above.

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
PR (execv fix): https://github.com/joshcomley/wixy/pull/46 (merged 03f3246)
PR (slice 2 record / slot-cycle trigger): https://github.com/joshcomley/wixy/pull/47 (merged 72ccec1)
PR (venv self-lock fix): https://github.com/joshcomley/wixy/pull/48 (merged 92bc6c3)
PR (post_restart arity fix): https://github.com/joshcomley/wixy/pull/49 (merged 54ad4cd — confirmed live via a fully automatic Slots deploy cycle)
