# 01 — Architecture: the two-lane topology

```
JOSH'S SIDE (dev + staging)                 PURDI'S SIDE (production, hers)
───────────────────────────                 ────────────────────────────────
joshcomley/wixy  (MIT, upstream) ──sync──►  <org>/wixy-engine  (her PUBLIC fork)
  │ build train / fixes                        │ upstream merged via her button
  ▼                                            │ + her AI feature lane PRs
fleet Slots deploy (source)                    ▼ GH Action: build image → GHCR(org, PUBLIC)
ca.cinnamons.uk = STAGING                   her droplet (DO LON1, ~£9.50/mo)
  + CI boots the IMAGE per merge              docker compose:
                                                wixy (image) ─ Storage volume
<org>/cottage-aesthetics-site ◄─ publishes ─    cloudflared (her tunnel)
<org>/ca-business  (private, owner docs)        watchtower (auto-pull)
<org>/ca-state-backup ◄─ nightly snapshot     www.cottageaesthetics.co.uk (+ apex)
                                              + HER Cloudflare Access on /admin
```

## 1. Accounts & names (fixed by this spec)

- **GitHub org**: `cottage-aesthetics` (nearest available; recorded in
  `projects/ca.json` `org`). Owner: Purdi; Josh = outside collaborator on the content
  repos + maintainer on `wixy-engine` (all revocable by her).
- **Repos in the org** (media lives INSIDE the site repo — `images/`, spec/02 §9;
  there is NO separate media repo in this phase; the Adverts phase introduces its own
  against the post-independence topology):
  - `wixy-engine` — fork of the (by then public, MIT) engine. **Necessarily public**
    (fork of a public repo): her local commits + Actions logs are visible; fine for an
    MIT engine, stated so nobody is surprised.
  - `cottage-aesthetics-site` — **TRANSFERRED** (history preserved; GitHub redirects
    the old URL; secrets do NOT reliably survive — recreate them in the org).
  - `ca-business` — **NEW, private**: the owner's business materials moved out of the
    engine repo pre-publication (02 §2.3).
  - `ca-state-backup` — new, private (06).
- **Hosting**: DigitalOcean **Basic Regular 2 GB / 1 vCPU, LON1 (~$12/mo ≈ £9.50)**,
  DO "Docker on Ubuntu" marketplace image. Her account, her card.
- **Cloudflare**: her own free-plan account holding the `cottageaesthetics.co.uk` zone
  (nameserver move — guide step; includes Zero Trust onboarding: team-name choice and
  possible payment-method prompt on the free plan), one **Tunnel** (token in droplet
  env; zero inbound ports) routing BOTH `www` and the apex, and one **Access app** on
  `/admin` + `/api/admin` (email OTP: her + Josh, both removable by her).
- **AI**: her own Anthropic account + API key (05).

## 2. What changes in the engine (all backwards-compatible with the fleet deploy)

1. **`deploy/standalone/`** (03). The fleet Slots deploy is untouched.
2. **Config generalization** (milestone 1 audit): env overrides
   `WIXY_SITE_REPO` (SSH URL — `run_git` disables credential helpers, so HTTPS+token
   is not an option), `WIXY_DOMAIN`, `WIXY_INDEXABLE`, `WIXY_EDITION`
   (`fleet|standalone`) layered over the committed `projects/ca.json` (today
   `domain`/`indexable` are builder inputs read only from the registry —
   `builder/config.py` — and the storage root env is **`WIXY_STORAGE_ROOT`**, the
   real existing name). Plus a **redirects facility** (none exists today): a
   file/env-driven 301 map served by `routes_public` — her deployment ships the
   spec/07 §5 map; fleet ships none.
3. **Engine-update surface** (04): commits-behind indicator, "Get engine updates",
   "Undo last update" (standalone only).
4. **AI backend interface** (05): `WIXY_AI_BACKEND=cmd|anthropic`.
5. **Backup job** (06); hub-side equivalent until cutover.
6. **Version/provenance**: `/api/version` gains `edition` + the fork's sync base —
   sourced from **baked build args** (`WIXY_ENGINE_SHA`, `WIXY_SYNC_BASE`) with git
   fallback, because the pip-installed image has no `.git` and the current
   git-shelling implementation would 500 (M2 finding — this is a required code
   change, not an option).

## 3. Git identity & credentials on her side

`setup.sh` **generates** deploy key pairs on the droplet (`ssh-keygen` per repo —
GitHub does not mint deploy keys) and prints each PUBLIC key with the exact
GitHub-settings URL for her to paste it into (guide step, "you know it worked when…").
Private keys live as root-owned 0600 **files under `/opt/wixy/keys/`** — NOT in `.env`
(multi-line PEM doesn't fit the KEY=VALUE format the settings loader and compose env
files share). `.env` (root 0600) holds: tunnel token, Access AUD + team domain,
Anthropic key, `WIXY_*` config, and the org **fine-grained PAT** scoped
`actions: write` + `contents: read` on `wixy-engine` only (drives the update button).
Secrets doctrine: every secret exists only under `/opt/wixy/` (0600, root) and in her
password manager. Publish commits author as `Wixy <wixy@cottageaesthetics.co.uk>`.
**Site-repo CI re-point (required, C6)**: the transferred site repo's CI currently pins
`joshcomley/wixy` + a `WIXY_DEPLOY_KEY` secret — a live Josh-dependency. A site-repo PR
re-points it at her fork (tokenless once the engine is public — the deploy key is
dropped entirely) and updates the site `CLAUDE.md`'s "private repo joshcomley/wixy" +
fleet-rule wording to deployment-neutral equivalents.

## 4. Cutover & rollback

Guide-driven: lower TTL → her stack green on a test hostname (drill, 08) → move `www`
+ apex to her tunnel → fleet keeps ca.cinnamons.uk as staging (indexable false there;
her deployment sets `WIXY_INDEXABLE=true` + the 301 map). Rollback = point DNS back;
nothing on the fleet is dismantled. Engine-update rollback for HER side is first-class
(04 §3) — content rollback already is (History/Restore).

## 5. Decisions (log as `decisions/` entries in PR #1 of the train)

| # | Decision | Because |
|---|---|---|
| 1 | Fork-sync dual control | Josh's lane frictionless; her unilateral custody + veto |
| 2 | Cloudflare Tunnel container | zero inbound surface, free, same Access UX, proven pattern |
| 3 | Watchtower image-pull deploys | no inbound surface, no CI credentials reaching her box |
| 4 | Site repo TRANSFERRED; engine FORKED; owner docs to NEW private `ca-business` | content is hers with history; engine has two dev homes; her business material must not ride a public repo |
| 5 | MIT (operator-confirmed) | dissolves licensing dependency; audit gate first (02) |
| 6 | Same image both editions via `WIXY_EDITION` | no standalone drift; upstream CI boots the image per merge (03 §5) |
| 7 | **GHCR package PUBLIC** | the engine is MIT anyway; kills private-registry auth on the droplet and in Watchtower (else both fail — refuted-claim fix) |
| 8 | **Sync pushes use a dedicated `SYNC_PUSH_TOKEN` PAT secret, never `GITHUB_TOKEN`** | GitHub suppresses workflow triggers from `GITHUB_TOKEN` events — image builds and conflict-PR CI would silently never run |
| 9 | **Scheduled sync is notify-only; deploys happen only via her button** | "updates land when SHE chooses" is the promise; auto-deploying upstream weekly is the silent-breakage/supply-chain vector |
