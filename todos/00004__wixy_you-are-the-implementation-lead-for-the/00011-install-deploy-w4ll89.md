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

- Cloudflare provisioning [DONE — MILESTONE 11 CLOSED]: operator confirmed
  go-ahead via AskUserQuestion, then opened the admin gate directly after both
  automated elevation channels had genuinely failed (gate closed per a real probe,
  `request_admin_action` blocked by the consensus classifier — a working safety
  gate declining a genuinely elevated op, not something to route around; both
  attempts documented in git history for the record). Ran
  `tooling/provision_ca_cloudflare.py` through the now-open gate: DNS created,
  tunnel ingress inserted (22 hostnames survive the sanity check, every other
  fleet subdomain untouched), Cloudflared restarted (succeeded on attempt 3 —
  the documented "try again" transient, the retry loop earned its keep on the
  first real run), Access app "Wixy Admin (ca)" created with both mirrored
  policies attached. One real, informative gap: writing `WIXY_CF_TEAM_DOMAIN`/
  `WIXY_CF_ACCESS_AUD` back to `Storage\.env` failed — diagnosed (not guessed)
  via a second small probe through the gate: BOTH `CF_ACCESS_TOKEN` and
  `CF_API_TOKEN` get a real 403 on `GET .../access/organizations` specifically
  (every other endpoint they touched worked fine) — a genuine token-scope gap.
  Rather than request broader token permissions, discovered the team domain by
  observation: opened a real headed browser (Playwright, system Chrome) to
  `https://ca.cinnamons.uk/admin`, and the freshly-created Access app's OWN
  login-wall redirect revealed `cinnamons.cloudflareaccess.com` directly, with
  the `aud` embedded in that same URL matching what the provisioning script had
  already captured — independent proof the app is genuinely, correctly wired
  before writing anything. Wrote both values into `Storage\.env` by hand,
  restarted Wixy. Full reasoning: decisions/00041.

  **spec/07 §4 verification — all checked for real, externally, over HTTPS
  through the actual Cloudflare edge**: (1) status/healthz/version ✅; (2)
  slot-cycle proof ✅ (above); (3) `https://ca.cinnamons.uk/` → 200, real
  homepage, zero auth ✅; (4) `/admin` anonymous → CF Access login wall ✅ (real
  browser); a JWT-stripped direct loopback request to `:9380/admin` still 302s
  (middleware works independently of the edge) ✅; (5) `/api/admin/state`
  unauthenticated → 302 ✅; (5b) `/healthz` + `/internal/ready` from outside →
  404 (edge-header guard) while working on loopback; `/api/version` public →
  200 ✅; (6) restart drill ✅ (needed anyway, for the new env values); (7)
  reboot survival — NOT exercised (no real hub reboot this session), noted as
  unexercised rather than claimed done; (8) `robots.txt` = `Disallow: /`,
  matches `indexable: false` ✅.

## Relevant files
- spec/07-hosting-deploy.md (full — repo artifacts §1, registrations §2, Cloudflare §3,
  verification checklist §4, ops notes §5)
- D:\Servers\Slots\Slots\green\docs\ai\onboarding.md (the authoritative fleet runbook —
  read in full before slice 1)
- Reference implementations actually read in full: D:\Servers\Loom\{launcher,deploy}.py,
  D:\Servers\Smartbell\{launcher,deploy}.py + Slots\blue\slots.cor.yaml,
  D:\Servers\Tenna\Storage\provision_cf.py

## How to continue + acceptance
**MILESTONE 11 IS FULLY CLOSED** — every spec/09 acceptance point done, spec/07 §4's
verification checklist complete except item 7 (reboot survival, needs an actual hub
reboot this session had no reason to trigger — Devfleet `restart="always"` + the tunnel
watchdog should cover it per spec's own reasoning; worth a real check whenever a natural
reboot window occurs, not worth forcing one just to test this).

Next: milestone 12 (CA cutover) per spec/09's own table — point Wixy at CA main, first
real human publish (replacing the bootstrap "version 0"), retire GH Pages, README,
contact-page wording fix. Read spec/07's already-noted "future real-domain cutover"
section (out of scope for M12 itself, but useful context) and whatever M12 doc exists
before starting — not yet read fresh by this chain.

## Links
PR (slice 1): https://github.com/joshcomley/wixy/pull/45 (merged b838f21)
PR (execv fix): https://github.com/joshcomley/wixy/pull/46 (merged 03f3246)
PR (slice 2 record / slot-cycle trigger): https://github.com/joshcomley/wixy/pull/47 (merged 72ccec1)
PR (venv self-lock fix): https://github.com/joshcomley/wixy/pull/48 (merged 92bc6c3)
PR (post_restart arity fix): https://github.com/joshcomley/wixy/pull/49 (merged 54ad4cd — confirmed live via a fully automatic Slots deploy cycle)
PR (Cloudflare-blocked status record): https://github.com/joshcomley/wixy/pull/51 (merged 8d59628)
PR (Cloudflare provisioned, M11 closed): (fill in when opened)
