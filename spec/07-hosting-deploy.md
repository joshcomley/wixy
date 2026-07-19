# 07 — Hosting & deploy (hub VM)

The engine deploys as fleet service **`Wixy`** at `D:\Servers\Wixy\` (derive from
`%AIM_ROOT%\Servers`; never hardcode a drive, never `C:\D`), loopback port **9380**
(verified free across `consumers.json` + Devfleet `services.toml` + live `/status`
2026-07-05; decade convention next to Hall 9370). Public ingress:
`ca.cinnamons.uk → cloudflared tunnel → 127.0.0.1:9380`.

The authoritative fleet runbook is `D:\Servers\Slots\Slots\green\docs\ai\onboarding.md`
(read it before #11; where old docs say `C:\D\Servers\…` substitute `D:\Servers\…`).
Reference anatomy: **Loom** (`D:\Servers\Loom\` — launcher/active.txt/deploy.py/per-slot
venv/`slots.loom.yaml`). What follows is the Wixy-specific application of it.

## 1. Repo artifacts (added to the wixy repo in #11)

- **`launcher.py`** — reads `active.txt`, re-execs `Slots\<slot>\.venv\Scripts\python.exe`
  with cwd = that slot, running `python -m wixy_server` (env: `WIXY_PORT=9380`,
  `WIXY_ENV=prod`, UTF-8 trio). No content paths inside slots — all state under
  `Storage\` (04 §2).
- **`deploy.py`** — `slot_swap_deploy` hooks per onboarding.md (pre_validate: fetch +
  hard-reset inactive slot to origin/main, "nothing to deploy" when unchanged; post_swap:
  mirror `launcher.py`/`deploy.py` to the install root; post_restart: health probe). Keep
  the `devfleet_deploy_shim` import block so `nssm_restart` is rewired to Devfleet.
- **`slots.wixy.yaml`** — consumer spec modeled on `slots.loom.yaml`: `name: wixy`,
  `install_root: D:\Servers\Wixy`, `layout: blue_green`, `poll_interval_secs: 30`,
  services `[{name: Wixy, restart_strategy: nssm_restart, force_kill_host: true,
  port: 9380}]`, build_steps: `pip_install` (per-slot `.venv` from the pythoncore-3.14
  interpreter, pinned `requirements.txt`), smoke probes `GET /healthz` +
  `GET /api/version` with `commit.sha_full` match (the anti-stale gate).
- **`install.py`** — idempotent first-install: create `D:\Servers\Wixy\{Slots\blue,
  Slots\green,Storage}`, clone the wixy repo into both slots, build venvs, write
  `active.txt` = `blue`, seed `Storage\.env` from a template (operator fills secrets),
  print the Devfleet/Slots/Cloudflare follow-ups. Also clones the site repo into
  `Storage\projects\ca\repo` and **bootstraps serving**: if `live.json` is absent, build
  origin/main HEAD into `builds\<sha>\` and write `live.json` as version 0
  (`source: "bootstrap"`, ledger entry appended) — the server also self-bootstraps this
  way on first startup, so ca.cinnamons.uk serves the site at milestone #11, before the
  first human publish (#12). With no live.json the public surface returns 503, never a
  crash (04 §3).
- **Frontend bundles are COMMITTED** (`wixy_server/static/{admin,editor}/*`): esbuild runs
  in dev + CI, never in slot build_steps (keeps deploys pip-only, no node on the deploy
  path). CI enforces no-drift: rebuild then `git diff --exit-code` on the bundle dirs.
  Decision-log this with #1's architecture entry.

Server endpoints backing the probes (04 §10): `/healthz` (alias of `/internal/ready`,
trivial 200 JSON) and `/api/version` → `{"commit": {"sha_full": …}, "slot": …,
"version": N}`.

## 2. Registrations (no elevation needed — user-session control planes)

1. **Devfleet child** — back up then append to `D:\Servers\Devfleet\supervisor\services.toml`:

```toml
[services.Wixy]
description = "Wixy CMS + Cottage Aesthetics site (ca.cinnamons.uk) — blue/green via Slots"
cwd  = "D:\\Servers\\Wixy"
argv = ["C:\\Users\\josh\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe", "D:\\Servers\\Wixy\\launcher.py"]
port    = 9380
health  = "http://127.0.0.1:9380/healthz"
restart = "always"
env = { PYTHONUTF8 = "1", PYTHONUNBUFFERED = "1", PYTHONIOENCODING = "utf-8", WIXY_PORT = "9380" }
```

   then `POST http://127.0.0.1:9999/reload` and confirm `Wixy` healthy in `/status`.
   (Never touch SCM/NSSM for it; Devfleet is the supervisor of record.)

2. **Slots consumer** — back up then add to
   `D:\Servers\Slots\Storage\config\consumers.json`:

```json
{
  "name": "wixy",
  "install_root": "D:\\Servers\\Wixy",
  "base_url": "http://127.0.0.1:9380",
  "kind": "fastapi",
  "hmac_secret_id": null,
  "service_name": "Wixy",
  "repo_url": "https://x-access-token@github.com/joshcomley/wixy.git",
  "slots_yaml_path": "slots.wixy.yaml",
  "slots_branch": "main"
}
```

   Consumers load at startup only → `POST http://127.0.0.1:9999/restart/Slots`. From then
   on **merging wixy `main` = deploying the engine** (30 s poll → build → smoke → swap).
   `POST http://127.0.0.1:9270/api/actions/poke/wixy` forces an immediate cycle (403
   "no HMAC secret" is normal with `hmac_secret_id: null`; 404 means Slots didn't load
   the consumer). Site publishes do NOT ride this path — they're Wixy's own pipeline
   (04 §5) and survive engine swaps because builds live in `Storage\`.

## 3. Cloudflare (elevated — admin gate)

Constants (documented + verified): zone `cinnamons.uk` = `fceebc59ddff6ca52a3a644f7e5027c8`,
account = `39cb5b1442202fad5831e19db6d63c65`, tunnel = `d5e53534-66c0-4076-a695-3841826aa76f`.
**Credentials**: the five `CF_*` keys (`CF_API_TOKEN`, `CF_ACCESS_TOKEN`, `CF_ZONE_ID`,
`CF_ACCOUNT_ID`, `CF_TUNNEL_ID`) live in **`D:\Servers\Loom\.env`** (the Biosphere
`.env`/`cf_api_token.json` paths in older docs are STALE — gone). Copy them into
`D:\Servers\Wixy\Storage\.env` during install (Wixy needs none at runtime except the
Access team domain + AUD; the provisioning script needs them all).

Template: `D:\Servers\Tenna\Storage\provision_cf.py` (idempotent; replicates biosphere
`engine/infra.py:provision_subdomain`). Write our own
`tooling/provision_ca_cloudflare.py` in the wixy repo, adapted:

1. **DNS**: `POST /zones/{zone}/dns_records` — proxied CNAME `ca` →
   `d5e53534-66c0-4076-a695-3841826aa76f.cfargotunnel.com`, ttl 1 (skip-if-exists).
2. **Tunnel ingress**: edit `C:\Windows\System32\config\systemprofile\.cloudflared\config.yml`
   (LocalSystem-only → this is WHY it's gated): backup, insert
   `hostname: ca.cinnamons.uk / service: http://localhost:9380` **above** the
   `http_status:404` catch-all, structural sanity-check before write.
3. **Restart `Cloudflared`** (independent Windows service, NOT Devfleet). Precedent shows
   the stop can report "starting or stopping — try again"; submit the provision and a
   robust stop-wait-start restart as **two separate gate scripts** and expect to run the
   second once or twice.
4. **Access app** — a **SEPARATE, DEDICATED app, isolated from every existing fleet
   Access app** (operator directive 2026-07-09: the clinic owner, Purdi, will be granted
   access to THIS tool and nothing else devfleet-hosted; conversely the template's
   whole-hostname gating must not be copied either). Create ONE self-hosted app named
   `Wixy Admin (Cottage Aesthetics)` with
   `self_hosted_domains: ["ca.cinnamons.uk/admin", "ca.cinnamons.uk/api/admin"]`,
   `session_duration: 720h` (30-day sessions — right UX for a non-technical owner), and
   two policies:
   (a) allow email OTP for: the operator's existing Access email(s) (copy from a live
   fleet app policy — the source of truth for which address he actually uses) **plus
   `cottageaestheticshartlebury@gmail.com` (Purdi)** — her grant lives in THIS app's
   policy only; never add her, and never add `ca.cinnamons.uk` paths, to any existing
   fleet app;
   (b) `non_identity` Service Auth accepting the existing fleet service token (automated
   probes only — a machine credential; it grants no human anything).
   **No app covers `/` — the public site must load with zero auth.** Capture the created
   app's **AUD** and the account's Access **team domain**
   (`GET /accounts/{id}/access/organizations`) into `Storage\.env`
   (`WIXY_CF_ACCESS_AUD`, `WIXY_CF_TEAM_DOMAIN`) — the JWT middleware (04 §9) consumes
   these, and because it pins THIS app's AUD, even a Cloudflare-side misconfiguration
   granting some other app's session cannot open the admin.

Gate mechanics (global CLAUDE.md): check `D:\Servers\Cmd-Admin\admin-gate\HEARTBEAT`
freshness (≤~6 s) → write `inbox\req-<id>.cmd.ps1.tmp` → rename to `.cmd.ps1` → poll
`results\req-<id>.result.json`. Gate closed → `op call
request-admin-action.request_admin_action`. Never hand-run elevated steps.

## 4. Verification checklist (part of #11/#13; evidence in the PR)

1. `127.0.0.1:9999/status` → `Wixy` healthy; `curl 127.0.0.1:9380/healthz` OK;
   `/api/version` SHA == wixy main HEAD.
2. Slot cycle proof: merge a trivial wixy change → within ~60 s inactive slot advances,
   `active.txt` flips, `/api/version` SHA changes, **published site unaffected**.
3. `https://ca.cinnamons.uk/` serves the site publicly (no Access wall) — verify from an
   external vantage (headed browser per fleet browsing rules, plus `curl` from a
   non-fleet network if available); TLS + CF proxied.
4. `https://ca.cinnamons.uk/admin` → CF Access login wall when anonymous; loads with the
   operator identity; `curl` with service-token headers passes; a JWT-stripped direct
   request to 9380 `/admin` (localhost) still 401s (middleware works independently).
   **Isolation checks**: the new app's AUD differs from every existing fleet app's; an
   OTP login as `cottageaestheticshartlebury@gmail.com` opens `ca.cinnamons.uk/admin`
   but the same identity is refused by `cmd.cinnamons.uk` (and the other fleet
   hostnames); the operator's fleet session does not open the Wixy admin without
   passing THIS app (separate AUD → middleware 401).
5. `https://ca.cinnamons.uk/api/admin/state` unauthenticated → 401/302; with service
   token → 200.
5b. `https://ca.cinnamons.uk/healthz` and `…/internal/ready` from outside → **404**
   (edge-header guard, 04 §9) while `curl 127.0.0.1:9380/healthz` on the box → 200;
   `https://ca.cinnamons.uk/api/version` → 200 (public by design).
6. Restart drill: `POST 127.0.0.1:9999/restart/Wixy` → site back within seconds, pointer
   intact, admin session unaffected (stateless JWT).
7. Reboot survival: Devfleet child `restart = "always"` + tunnel watchdog cover it;
   confirm `Wixy` returns after the next natural hub restart window (note in todos if
   not exercised).
8. robots: `ca.cinnamons.uk/robots.txt` = Disallow all + pages carry `noindex` while the
   project registry has `"indexable": false` (stays false until the real-domain cutover
   decision — the Wix site at `www.cottageaesthetics.co.uk` remains the indexed canonical
   for now).

## 5. Ops notes (land these in the repo README + `C:\Admin\Index.md`)

- Add to `C:\Admin\Index.md` ports list: `Wixy :9380 (ca.cinnamons.uk)`.
- Logs: `D:\Servers\Wixy\Storage\logs\`; bounce via Devfleet `POST /restart/Wixy`.
- Engine deploy = merge wixy main. Site publish = the admin's Publish button (or a
  restore). The two never mix.
- Secrets inventory in `Storage\.env`: `WIXY_PORT`, `WIXY_ENV`, `WIXY_CF_ACCESS_AUD`,
  `WIXY_CF_TEAM_DOMAIN` (+ the CF_* provisioning set, used only by tooling).
- Future real-domain cutover (out of scope, documented for later): add
  `www.cottageaesthetics.co.uk` to the tunnel ingress + move/CNAME its DNS into
  Cloudflare, flip `indexable: true`, add 301s from ca.cinnamons.uk. Nothing in v1
  precludes this. The old Wix site's complete indexable surface was enumerated live
  (headed browser, 2026-07-08) — it is a near-empty landing-page template (homepage
  `<title>` "Landing Page | Cottage Aesthetics"), so the 301 map is just:
  `/home → /`, `/about → /about.html`, `/book-online → /treatments.html`,
  `/contact → /contact.html`, `/cart-page → /` (Wix template cruft; no store),
  `/english-privacy-policy → /policies.html`. Also at cutover: resubmit the sitemap in
  Search Console, confirm the Google Business Profile website link resolves, then cancel
  the Wix premium plan and revoke the (already-leaked, per
  `docs/projects/01-cottage-aesthetics.md`) Wix API key — nothing in this stack uses Wix.
