# Runbook

Ops, deploy, rollback, and creds for the deployed **`Wixy`** service. Authored intent:
[`spec/07-hosting-deploy.md`](../../spec/07-hosting-deploy.md). The deploy-script bug history
is decisions/00037, 00039, 00040.

> **Never author code in `D:\Servers\Wixy\`** — it's the deployment target (Inv 19). Branch in
> this repo → PR → merge `main`; Slots deploys. Editing a slot is silently overwritten.

## At a glance

| Thing | Value |
|---|---|
| Fleet service | **`Wixy`** (Devfleet-supervised, **not** SCM) |
| Install root | `D:\Servers\Wixy\` (`%AIM_ROOT%\Servers\Wixy`, never `C:\D`) |
| Loopback port | **9380** |
| Public URL | `https://ca.cinnamons.uk` (`/admin*` behind CF Access; `/` public) |
| Health | `curl http://127.0.0.1:9380/healthz` → `{"ready":true}` |
| Version/slot | `GET /api/version` → `{commit:{sha_full}, slot, version}` |
| Logs | `D:\Servers\Wixy\Storage\logs\` |
| Bounce | `POST http://127.0.0.1:9999/restart/Wixy` (Devfleet; never `Start-Service`/NSSM) |
| Devfleet status | `http://127.0.0.1:9999/status` (the signal of record) |

## Deploy = merge to `main`

Standard Slots blue/green (modeled on Loom). `slots.wixy.yaml` declares the consumer
(`install_root: D:\Servers\Wixy`, `layout: blue_green`, `branch: main`,
`poll_interval_secs: 30`; service `Wixy`, `restart_strategy: nssm_restart`,
`force_kill_host: true`, `port: 9380`; build steps `_pip_install_venv` + `_testclient_validate`;
smoke probes `GET /healthz`==200 and `GET /api/version` with `commit.sha_full` matching the
deployed sha — the **anti-stale gate**). The consumer is registered in
`D:\Servers\Slots\Storage\config\consumers.json`.

Flow: merge wixy `main` → within ~30s Slots fetches + hard-resets the **inactive** slot to
`origin/main`, builds its `.venv`, smoke-probes it, flips `active.txt`, restarts `Wixy` via
Devfleet. No manual step. Force an immediate cycle:
`POST http://127.0.0.1:9270/api/actions/poke/wixy` (a 403 "no HMAC secret" is normal;
404 means Slots didn't load the consumer). **Site publishes do NOT ride this path** — they're
Wixy's own pipeline ([publish-pipeline.md](publish-pipeline.md)) and survive engine swaps
because builds live in `Storage\`.

`deploy.py` hooks (Slots imports them from the inactive slot): `pre_validate` (fetch +
hard-reset; raises `DeployError` = graceful-skip on "nothing to deploy" / already-attempted
sha); `_pip_install_venv` (build `<slot>/.venv.new` fresh, then `_atomic_swap_dir` — **never**
in-place rmtree, Inv 21); `_testclient_validate` (boot the app with `WIXY_DEV_NO_AUTH=1` and
assert `/healthz`==200); `post_swap` (mirror `launcher.py`+`deploy.py` to the install root);
`post_restart` (health probe, `fn(ctx)` arity — Inv 21). `DeployError` (graceful-skip) is
rigorously distinct from `BuildStepError` (a real failure) so a build error is never silently
swallowed.

`launcher.py` (the Devfleet entrypoint, argv never changes) reads `active.txt`, sets env
(`WIXY_PORT=9380`, `WIXY_ENV=prod`, `WIXY_SLOT`, UTF-8 trio), `chdir`s to the active slot, and
runs its venv's `python -m wixy_server` as a **blocking `subprocess.run`** (never `os.execv` —
Inv 21).

## First install (`install.py`, idempotent)

Creates `Slots\{blue,green}` + `Storage\`, clones the engine into both slots, builds both
venvs (pythoncore-3.14 → `requirements.txt` → `pip install --no-deps .`), writes
`active.txt=blue`, mirrors `launcher.py`/`deploy.py` to root, seeds `Storage\.env` (copying
CF_* from `D:\Servers\Loom\.env`), clones the **site repo** to `Storage\projects\ca\repo`, and
**bootstraps serving** (builds `origin/main` HEAD → `builds\<sha>\`, writes `live.json` v0).
It prints — but does not perform — the Devfleet/Slots/Cloudflare registration follow-ups. Flags
`--wixy-repo-url`, `--skip-venv`.

## Rollback

- **Site content**: use **Restore** in the admin History panel (or `POST /api/admin/restore
  {version}`) — flips the live pointer instantly to a past version's build; nothing is
  committed until the owner next publishes. This is the owner-facing, always-available path.
- **Engine**: revert the offending merge on `main` (Slots redeploys the reverted state) — or,
  on the box, `python deploy.py --rollback` swaps `active.txt` back to the previous slot. The
  previous slot's build is still intact until the next successful deploy overwrites it.

## Project registry (`projects/ca.json`)

One in-repo, code-reviewed JSON file per site (`builder/config.py:load_project_config`; loaded
at startup, one project in v1 but nothing assumes it — Inv 1):

| Field | Value (ca) | Meaning |
|---|---|---|
| `slug` | `"ca"` | project id; keys all Storage paths (`Storage/projects/<slug>/`) |
| `name` | `"Cottage Aesthetics"` | display name |
| `repo` | `…/cottage-aesthetics-preview.git` | the **site** repo cloned into `Storage/projects/<slug>/repo` |
| `defaultBranch` | `"main"` | branch the checkout tracks (fetch/ff-only) |
| `cmdProject` | `"cottage-aesthetics-preview"` | the cmd clone dir for the AI chat lane (which cmd project, not host) |
| `domain` | `"ca.cinnamons.uk"` | used in `<head>` OG/canonical + sitemap |
| `locale` | `"en-GB"` | site locale |
| `indexable` | `false` | gates `robots.txt`/`noindex`/`sitemap.xml` (false until the real-domain cutover) |
| `media` | `{maxLongSidePx: 2000, jpegQuality: 85}` | the upload downscale/re-encode limits ([media.md](media.md)) |

## Config & secrets

- **Env vars** (runtime, in `Storage\.env` unless noted): `WIXY_PORT`, `WIXY_ENV`,
  `WIXY_STORAGE_ROOT` (env-only, chicken/egg), `WIXY_SLOT` (set by launcher), `WIXY_DEV_NO_AUTH`
  (dev/test bypass — refuses to start if set while `WIXY_ENV=prod`, Inv 12),
  `WIXY_CF_TEAM_DOMAIN` + `WIXY_CF_ACCESS_AUD` (consumed by the JWT middleware). `.env` values are overridden
  by process env.
- **CF Access**: `/admin*` + `/api/admin*` sit behind a **dedicated, isolated** Access app
  (`Wixy Admin (Cottage Aesthetics)`), scoped to only `ca.cinnamons.uk/admin` +
  `/api/admin` — the public `/` has no Access. Its AUD differs from every other fleet app's, so
  a session for another app cannot open this admin. Provisioned by
  `tooling/provision_ca_cloudflare.py` (elevated, via the admin gate).
- **CF_* provisioning creds** (`CF_API_TOKEN`, `CF_ACCESS_TOKEN`, `CF_ZONE_ID`,
  `CF_ACCOUNT_ID`, `CF_TUNNEL_ID`) live in `D:\Servers\Loom\.env`, copied into `Storage\.env`
  by install; used **only** by the provisioning tool, never read by the running server.
  Cloudflare constants: zone `cinnamons.uk`=`fceebc59…`, account=`39cb5b14…`,
  tunnel=`d5e53534-66c0-4076-a695-3841826aa76f`.
- **Git auth**: the sentinel clone URL `https://x-access-token@github.com/joshcomley/wixy.git`
  (fleet askpass). Every git subprocess passes `-c credential.helper=` + a 60s timeout.

## CI (`.github/workflows/ci.yml`, on push-to-main + all PRs)

- **`python`** (ubuntu, py3.14): `pip install -e ".[server,dev]"` + `playwright install`;
  `ruff check` + `ruff format --check`; `mypy` (strict); `pytest` (the `-n 4` addopts, `-m
  'not live_cmd'`).
- **`frontend`** (ubuntu, node 22): for both `admin-ui/` and `editor/` — `npm ci`, typecheck,
  vitest, `npm run build`; then the **bundle-drift gate** `git diff --exit-code --
  wixy_server/static` (Inv 2).
- **`e2e`** (needs python+frontend): install the server extra, `npm ci` in `e2e/`,
  `playwright install`, `npx playwright test`.

`.github/workflows/capture-baseline.yml` — manual `workflow_dispatch` to regenerate the parity
baseline; it **builds** the site (`python -m builder build`) then rebaselines against the build
output (never the raw checkout — decisions/00043).

## Public site: GitHub Pages custom domain

The public site also deploys as a static build to **GitHub Pages**, serving the operator's
own custom domain (independent of `ca.cinnamons.uk`, which stays the private staging/admin
home — see decisions/00126). This lives entirely in the **site repo**
(`joshcomley/cottage-aesthetics-preview`), not here:

- `wixy_server/checkout.py:push_live_mirror` force-pushes the current live pointer's sha to
  `refs/heads/wixy-live` on the site repo's origin, at the end of every successful publish
  and restore (Inv 32) — **only this server ever writes that ref.**
- The site repo's `.github/workflows/pages.yml` triggers on pushes to `wixy-live` (plus
  `workflow_dispatch`), checks out that exact ref, checks out this engine, and runs
  `python -m builder build --domain "$WIXY_PUBLIC_DOMAIN" --indexable true` before deploying
  via `actions/deploy-pages`. It deliberately never deploys the site repo's `main` HEAD
  directly — that would ship agent-merged content without the owner's Publish/Restore gate.
- **`WIXY_PUBLIC_DOMAIN`** — a repo Actions **variable** (Settings → Secrets and variables →
  Actions → Variables) on the site repo, holding the bare apex domain (no scheme, no `www.`,
  no trailing slash). The workflow no-ops green (a `not-configured` job, not a failure) when
  it's unset — safe by default on a fork. **Changing the operator's domain later = edit this
  variable AND the Pages "Custom domain" box (repo Settings → Pages) to the same value, then
  either wait for the next publish or re-run the workflow manually** — nothing here needs a
  code change.
- **Bootstrap (first time only, or after a from-scratch reinstall):** `wixy-live` doesn't
  exist on the site repo's origin until the first publish/restore after this feature shipped.
  To bring an already-live site under Pages without waiting for the owner's next publish:
  push the CURRENT live sha (`D:\Servers\Wixy\Storage\projects\ca\live.json`'s `sha` field)
  straight to `refs/heads/wixy-live` from a site-repo clone, then manually dispatch the
  workflow (`gh workflow run pages.yml --ref main -R joshcomley/cottage-aesthetics-preview`)
  — the bootstrap push itself won't auto-trigger a run (next bullet explains why).
- **Known gap, not a bug:** GitHub resolves a push-triggered workflow run from the *pushed
  commit's own tree* — so pushing a sha that predates `pages.yml` existing on `main` (true for
  the bootstrap push above, and true for a restore to a version published before this feature
  shipped) moves `wixy-live` correctly but triggers **no** Pages run. The public domain then
  lags until the next publish whose sha postdates the workflow file, or a manual
  `workflow_dispatch`. This is accepted and documented (decisions/00126), not something to
  "fix" by chasing GitHub's trigger resolution.
- The full click-by-click setup (GitHub repo variable + Pages custom-domain box, Name.com DNS
  records, HTTPS enforcement, troubleshooting) is
  [`docs/go-live-github-pages.html`](../go-live-github-pages.html) — written for the site
  owner/operator, not an engineering doc.

## Health & internal surface

`/healthz` (alias of `/internal/ready`), `/internal/warmup`, `/internal/ready`, `/api/version`.
`/internal/*` + `/healthz` return a bare **404** to any request carrying a `Cf-Ray`/
`Cf-Connecting-Ip` header (they answer loopback probes only — Inv 12); `/api/version` is public
by design. With no `live.json` the public surface returns **503**, never a crash. Node index:
`C:\Admin\Index.md` should list `Wixy :9380 (ca.cinnamons.uk)`.
