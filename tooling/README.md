# Cottage Aesthetics — tooling

Operational scripts for building/maintaining the Cottage Aesthetics Wix site, plus
(since milestone 11) the wixy engine's own fleet-infra provisioning script. These are
**project tooling**, not site code (the live Velo code lives in the separate
`joshcomleywix/cottage-aesthetics` repo, synced to the site).

## Auth
All REST scripts authenticate with a Wix **account API key** for the account
that owns the site, read from the `WIX_API_KEY` environment variable, plus the
`wix-site-id` header. In PowerShell, the machine-scoped var must be pushed into
the child process env first:

```powershell
$env:WIX_API_KEY = [Environment]::GetEnvironmentVariable('WIX_API_KEY','Machine')
python tooling/provision_bookings.py
```

Site ID: `c721738f-2644-49e8-8865-fc10865db30f`
Default staff resource ("Business Owner"): `1c41ada4-0c28-47dc-8d76-bf31e0776abf`

## Scripts
- `provision_bookings.py` — idempotently creates the bookable treatments in Wix
  Bookings (Services v2 API). Safe to re-run; skips existing by name.
- `provision_ca_cloudflare.py` — wixy engine infra, not Wix-site tooling
  (spec/07-hosting-deploy.md §3): provisions `ca.cinnamons.uk` on Cloudflare (DNS
  CNAME, tunnel ingress, a path-scoped Access app covering only `/admin` +
  `/api/admin`). Idempotent; run elevated (admin gate) — reads the CF_* credentials
  install.py copies into `D:\Servers\Wixy\Storage\.env`, never Wix credentials.
- `cookout/visual/` — Cookout ingredient-catalogue and picture tooling (spec/server-chat/09b; livechat.md §24.3;
  decisions/00202). **Offline: it reads only the committed bank and catalogue, never chat content (Inv 58).** Python
  3.14; the modules import their siblings by plain name, so run each script by path (the unit tests put this folder on
  `sys.path`).
  - `catalogue.py {author|factcheck|build|audit|validate|report|status}` — Haiku writes `what` / `visual` /
    `presentation` / facts per ingredient and seasoning in cmd chat-spawn runs (`cmdruns.py`: at most 3 in flight per
    provider, 5 s between spawns, every run id journalled before polling so a crash resumes the same run), a second pass
    fact-checks, `audit` has Sol check a seeded sample of 150 facts (bar 146). Resumable from `<work>/catalogue/state.json`;
    the committed `wixy_server/livechat/cookout_catalogue.json` is only ever rewritten whole (temp file + replace, sorted).
    Options: `--work-dir`, `--catalogue`, `--report`, `--limit`, `--ids`, `--seed`, `--allow-partial`.
  - `validate_catalogue.py [--allow-partial] [catalogue.json]` — the whole-file check against the bank (shares the loader's
    per-entry rules via `cookout_catalogue.entry_problems`); `facts_waivers.json` lists ids allowed to have no facts.
  - `images.py {plan|run|status|apply-overrides|publish}` — the picture pipeline: the fixed photographic prompt
    (`prompts.py`), hub ComfyUI one picture at a time behind an **empty-queue gate** (three idle `/queue` polls a second
    apart), the attempt ladder 1-4 then an Opus review (`review.py`, decisions in `image_review.json`) then attempts 5-6 or
    picture-less, renditions `card` 512 / `thumb` 160, a resumable journal, and `publish` (deterministic tar, GitHub Release
    `cookout-images-v<N>` via the full `gh.exe` path, download-back verify, manifest write, `install` under a pending pin,
    history check, and from v2 onward the clean-install check: a fresh-storage install of the oldest pinned manifest).
    `run --phase pilot|rest|all --checker haiku|luna [--limit N] [--render-only]`; `--work-dir` defaults to
    `%AIM_ROOT%\Servers\Wixy\Storage\cookout-images\work`. **`<work>/PAUSE` stops a run between pictures.** `run` needs
    `WIXY_COMFY_OUTPUT_DIR` (and optionally `WIXY_COMFY_URL`, default `http://127.0.0.1:8199`) in `WIXY_ENV_FILE`
    (default `D:\Servers\Wixy\Storage\.env`).
  - `check.py` (verdict schema, neutral-name batches of 10 + 1 decoy, vision proof) and `calibrate.py [--work-dir]
    [--catalogue] [--out-dir]` (the 100-picture spot check: sampler, Sol / Opus judge stages, scoring table, mechanical
    recommendation rule, report under `triad/cookout/r2/`).
  - **Where to run it.** On the hub, as a Task Scheduler task with `LogonType=Interactive`, `RunLevel=Limited` (never session
    0), output to a log. The pilot ran this way: the hub's Grid workers take CI jobs only, so it was not a Grid task (the
    spec still says "Grid task"; that was the plan). Operations (the pack, pins, GC, publishing):
    `docs/ai/runbook.md` "Cookout ingredient pictures". Unit tests: `wixy_server/tests/test_cookout_visual_tooling.py`,
    `test_cookout_catalogue_tooling.py`, `test_cookout_catalogue*.py`.