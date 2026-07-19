# 00 — Mission & product definition

## What this is

**Wixy becomes a self-hosted website manager** (a lightweight CMS + visual editor + AI
assistant + one-click publisher) for sites that are plain HTML/CSS/JS. The first and
driving customer is **Cottage Aesthetics** — a real nurse-led aesthetics clinic in
Hartlebury (see `brief.md` + `docs/DESIGN-AND-CONTENT.md`, moved to the owner's private
`ca-business` repo pre-publication per spec/independence/02 §2.3; retrievable from this
repo's history at commit `7c4fa3c` before that repo exists). Its site was
AI-generated as static pages (repo `joshcomley/cottage-aesthetics-preview`, currently on
GitHub Pages) and is conceptually "on Wix", but uses no Wix feature — so we take over
hosting and management entirely.

> Naming note: the operator says "ORM" in the brief conversation — the deliverable is a
> **CMS/site-manager** (content editing + publishing), not an object-relational mapper.

## The experience being bought (acceptance-level, in the owner's words)

1. **Browse my site in edit mode** at `ca.cinnamons.uk/admin` — click any text, a little
   editor pops up, I type, the page updates live in front of me.
2. **Tap any image** and replace it (upload from my phone/laptop), see it in place.
3. **Tweak the theme** — colors and fonts — with live preview.
4. **Chat with an AI** in the same admin — "add an aftercare tips page", "move the reviews
   section lower", "try a warmer colour scheme" — and it does it, exactly like chatting in
   cmd, with the result appearing in my draft preview.
5. **Press Publish** — a build runs, the site goes live at `ca.cinnamons.uk`.
6. **Go back** — a version history lists every publish; one click restores a previous
   version.

## Product principles (binding)

- **Git is the database.** Templates, content JSON, theme and images live in the site's
  git repo; every publish is a commit; history/rollback/AI-collaboration all ride git.
  No parallel content database to drift out of sync.
- **The public site stays plain static files.** No client framework, no runtime CMS on the
  visitor path; the builder emits the same kind of HTML/CSS/JS the site has today. Fast,
  cacheable, unbreakable.
- **One human gate.** AI and editor both stage into a draft; only the owner's Publish
  button changes the live site. Restore is always available.
- **Engine ≠ content.** The Wixy engine (this repo) is generic over "projects"; everything
  Cottage-Aesthetics-specific lives in the site repo + a small project registry entry.
  No `cottage` string literals inside engine code paths.
- **Fleet-native.** cmd spawns the chats, Slots deploys the engine, Devfleet supervises
  it, cloudflared exposes it, CF Access guards the admin. No new infrastructure kinds.

## Scope of THIS build (v1)

Everything in specs 01–09: engine + builder + admin/editor + AI chat + hosting at
`ca.cinnamons.uk` + migration of the Cottage Aesthetics site into the content model +
tests + deploy. Single project registered; single operator + owner as users.

## Explicit non-goals for v1

- Multi-tenant SaaS, accounts/roles, per-user auth inside the app (CF Access is the door).
- Editing the Wix site / Wix APIs (the old Wixy framing — dormant; docs remain in
  `docs/wix-cli/` and `docs/projects/01-cottage-aesthetics.md` for reference).
  The **live wixapis-based tooling** (`tooling/provision_bookings.py`, bookings data)
  stays as-is — bookings continue to run on Wix/facesconsent per the current site's
  booking modal; not this build's concern.
- Cutting over `www.cottageaesthetics.co.uk` DNS to our hosting (follow-up once the owner
  approves the ca.cinnamons.uk result; the design must simply not preclude it — it
  doesn't: same tunnel + a CNAME/CF zone move later).
- Blog/e-commerce/forms backends, image CDNs, analytics dashboards.
- Editing wixy-engine code from the embedded chat (operator does that in cmd directly).

## Sensitivities (carry through all work)

- **Client photos & reviews**: before/after images are consented; Google reviews were
  captured with the owner's knowledge. Any NEW such content requires explicit owner
  sign-off (the site CLAUDE.md binds AI agents to this; the editor is owner-driven by
  definition).
- **Prescription-only treatments**: pricing must remain ≥2 clicks from the homepage
  (regulatory posture per the brief). The treatments-page structure preserves this;
  agents are bound via the site CLAUDE.md.
- British English, calm/unsalesy voice (brief).
