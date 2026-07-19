# 00 — Mission: total independence, dual control

## The problem (in the owner's words)

Purdi currently leans on Josh for: changes to the editor, hosting the editor, and fixing
anything in the publish flow. Her worry: "if we fall out, what happens?" The answer must
become: **nothing happens** — she keeps the site, the editor, the history, the AI help,
and the ability to evolve all of it, on accounts in her own name, at a cost a small
clinic absorbs (~£9.50/mo hosting + her own capped AI spend + ~£10/yr domain).

## Current dependency inventory (what this phase eliminates)

| Dependency | Today | After |
|---|---|---|
| Hosting | Josh's hub VM (fleet Slots/Devfleet) | Her DigitalOcean droplet (Docker compose), fleet becomes Josh's staging |
| Domain + ingress + admin login | Josh's cinnamons.uk + Cloudflare account | Her `cottageaesthetics.co.uk` + HER free Cloudflare account (tunnel + Access) |
| Site repo (media lives inside it) + her business docs | `joshcomley/*` (his account) | Her GitHub org (site transferred; owner docs to a new private `ca-business`); Josh a revocable outside collaborator |
| Engine code | `joshcomley/wixy`, private | MIT open source; her org runs a synced fork; his repo stays the dev upstream |
| Engine updates & fixes | Josh's build lane only | BOTH: his lane ships upstream; her fork syncs on demand; her own AI lane ships to her fork |
| AI (content chat, future features) | cmd on Josh's Claude subscription | Pluggable backend: her own Anthropic key in standalone; cmd remains the fleet-deploy backend |
| Publish flow operations | Josh + fleet agents | Self-serve: History/Restore already hers; monitoring alerts to her; runbook + drill prove any competent dev can operate it |
| Backups | Fleet Storage on the hub | Nightly mirror into a private repo in her org |

Already independent (no work needed): bookings + consent (facesconsent, her account),
the real domain (registered to the business), her content itself (git is the database).

## The dual-control principle (operator directive, 2026-07-19)

Independence must NOT cut Josh off. Two lanes, both first-class, neither blocking:

- **Josh's lane (unchanged):** he develops in `joshcomley/wixy` exactly as today —
  the milestone train, PRs, auto-merge. His fleet deployment (ca.cinnamons.uk) becomes
  the staging environment where engine changes soak first.
- **Her lane:** her org's fork deploys to production. A sync workflow (scheduled +
  a "Get engine updates" button in her admin showing a plain-English changelog) pulls
  his upstream when SHE chooses. Her own AI feature lane PRs into HER fork on HER
  billing. The asymmetry that answers her worry: she can stop syncing him, revoke his
  collaborator access, and lose nothing; he cannot take anything from her.

## Definition of done

The **independence drill** (08) passes: starting from nothing but her accounts and her
org's repos, a fresh droplet serves the site on a test hostname; she can edit, publish,
restore, pull an engine update, and hold an AI conversation on her own key — all
following the HTML guide (07), with no fleet access and no Josh involvement. Plus the
acceptance list in 08 §3.

## Non-goals

Migrating the Adverts/Studio phase (not yet built — it will be built against the
post-independence topology); multi-tenant SaaS; moving Josh's dev workflow; deleting the
fleet deployment (it stays as staging); any change to the visitor-facing site.
