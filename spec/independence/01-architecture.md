# 01 — Architecture: the two-lane topology

```
JOSH'S SIDE (dev + staging)                 PURDI'S SIDE (production, hers)
───────────────────────────                 ────────────────────────────────
joshcomley/wixy  (MIT, upstream) ──sync──►  <org>/wixy-engine  (her fork)
  │ build train / fixes                        │ merge upstream on demand
  ▼                                            │ + her AI feature lane PRs
fleet Slots deploy                             ▼ GH Action: build image → GHCR(org)
ca.cinnamons.uk = STAGING                   her droplet (DO LON1, £~12/mo)
                                              docker compose:
                                                wixy (image) ─ Storage volume
                                                cloudflared (her tunnel)
                                                watchtower (auto-pull)
<org>/cottage-aesthetics-site  ◄─ publishes ─ her admin (unchanged UX)
<org>/cottage-aesthetics-media                www.cottageaesthetics.co.uk
<org>/ca-state-backup  ◄─ nightly mirror      + HER Cloudflare Access on /admin
```

## 1. Accounts & names (fixed by this spec)

- **GitHub org**: `cottage-aesthetics` (or nearest available — guide step; the chosen
  name is recorded in `projects/ca.json` as `org`). Owner: Purdi's GitHub account
  (created in the guide); Josh = org **outside collaborator** on the three content repos
  + **maintainer** on `wixy-engine` (both revocable by her).
- **Repos in the org**: `wixy-engine` (fork of joshcomley/wixy), `cottage-aesthetics-site`
  (TRANSFERRED, not forked — she must own the history; GitHub transfer preserves it),
  `cottage-aesthetics-media` (transferred), `ca-state-backup` (new, private).
- **Hosting**: DigitalOcean, **Basic Regular 2 GB / 1 vCPU droplet, LON1 (~$12/mo)**,
  Docker preinstalled via DO's Docker marketplace image. Her account, her card.
- **Cloudflare**: her own free-plan account holding the `cottageaesthetics.co.uk` zone
  (nameserver move at her registrar — guide step), one **Cloudflare Tunnel** (token in
  droplet env; zero inbound ports on the droplet), and one **Access app** on
  `/admin` + `/api/admin` (email OTP: her + Josh, both removable by her). Zone-level
  caching mirrors today's behavior.
- **AI**: her own Anthropic account + API key (05).

## 2. What changes in the engine (all backwards-compatible with the fleet deploy)

1. **`deploy/standalone/`** (03): Dockerfile, compose, `.env.example`, provisioning +
   drill scripts. The fleet Slots deploy is untouched.
2. **Config generalization**: everything fleet-specific already lives in env/registry
   (port, AUD, team domain, repo URLs); milestone audits for stragglers (any hardcoded
   `cinnamons.uk`, hub path, or `joshcomley/` in CODE paths — docs may keep them).
   `projects/ca.json` gains `org`/`repo` values switchable per deployment via env
   overrides (`WIXY_SITE_REPO`, `WIXY_MEDIA_REPO`), so the SAME image serves both sides.
3. **Engine-update surface** (04): commits-behind-upstream indicator + "Get engine
   updates" button in admin Settings (standalone mode only).
4. **AI backend interface** (05): `WIXY_AI_BACKEND=cmd|anthropic`.
5. **Backup job** (06): in-container nightly state push (standalone), hub-side
   equivalent until cutover.
6. **Version/provenance**: `/api/version` gains `edition: "fleet"|"standalone"` and the
   fork's sync base, so support conversations always know what's running where.

## 3. Git identity & credentials on her side

The droplet holds: a **deploy key pair per content repo** (site, media, backup —
read/write, minted during the guide via her logged-in GitHub session, pasted into the
setup script), the tunnel token, her Access AUD/team domain, her Anthropic key, and an
org **fine-grained PAT** scoped to `wixy-engine` actions:write (the "Get engine updates"
button triggers the sync workflow with it). All in the droplet's `.env` (root-owned,
0600); nothing in git; `.env.example` documents each with a guide cross-reference.
Publish commits author as `Wixy <wixy@cottageaesthetics.co.uk>`.

## 4. Cutover & rollback

The guide's final section flips production: lower DNS TTL → confirm her stack green on a
test hostname (drill, 08) → move the real hostname to her tunnel → fleet keeps serving
ca.cinnamons.uk as staging (indexable stays FALSE there; her deployment flips
`indexable: true` — the 301 map from spec/07 §5 ships in her deployment's config).
Rollback at any point = point DNS back; nothing on the fleet is dismantled.

## 5. Decisions (log as `decisions/` entries in PR #1 of the train)

| # | Decision | Because |
|---|---|---|
| 1 | Fork-sync dual control (not shared repo, not repo transfer of the engine) | keeps Josh's lane frictionless AND gives her unilateral custody + veto over incoming changes |
| 2 | Cloudflare Tunnel container on her droplet (not open ports + Caddy/nginx) | zero inbound attack surface, free, identical Access UX to today, symmetric with the fleet pattern already proven |
| 3 | Watchtower image-pull deploys (not push webhooks/SSH from CI) | no inbound surface, no secrets in CI that reach her box, dead simple to explain in the guide |
| 4 | Site/media repos TRANSFERRED, engine FORKED | content is inherently hers (history included); the engine is a product with two legitimate development homes |
| 5 | MIT (operator-confirmed 2026-07-19) | dissolves the licensing dependency entirely; audit gate before publication (02) |
| 6 | Same image both editions, switched by env | one build pipeline, no standalone drift, staging actually stages production |
