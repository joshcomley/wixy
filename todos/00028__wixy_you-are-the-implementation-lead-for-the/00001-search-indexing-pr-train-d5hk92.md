# 00001 [d5hk92] Search-indexing PR train (implementation lead)

## What

Execute `docs/search-indexing-implementation-brief.md` as a small, reviewable PR train
across the wixy engine repo and the `cottage-aesthetics-preview` site repo: WP0 baseline,
WP1 staging noindex correction, WP2 legacy-URL static redirects, WP3 structured data +
favicon, WP4 mobile performance, WP5 treatment page drafts (owner-gated), WP6 monitoring.

## Why

Cottage Aesthetics cut over to `cottageaesthetics.co.uk` on GitHub Pages 10-11 August 2026.
The prior planning lane (workspace 00027) audited both the public site and the
`ca.cinnamons.uk` staging host and found concrete, fixable technical-SEO gaps (staging
`noindex` unobservable to crawlers, missing structured data/favicon, dead legacy Wix URLs,
slow mobile hero/gallery). This workspace is the implementation lane the brief hands off to.

## Context

Full authority is `docs/search-indexing-implementation-brief.md` (read in full at the start
of this session) — its "Decisions made" section (15 items) is binding; do not reopen without
contradicting live/on-disk evidence. Key constraints: never author in `D:\Servers\Wixy\`;
never publish/deploy site changes myself (Purdi's Wixy Publish button only); site-repo work
happens in a separate cmd workspace, never this one; independence-phase milestones 2/3/4/6/7
are security-gated (peer the spec-author session before merge) — this brief's work is
milestones-adjacent but NOT itself one of those gated independence milestones (it's ordinary
engine/content work), so normal architecture-consult + audit gates apply per WP, not the
security-gate peer-approval flow.

Baseline at session start: wixy HEAD `4cf4c94` (`docs: plan search indexing improvements
(#196)`), working tree clean, branch `cmd/workspace-00028` tracking `origin/main`, 0 ahead/0
behind. Social-preview commit `d318cd4` already on main (brief says: verify it reaches
production after the next owner Publish, then close that audit item rather than
reimplementing).

A parent session armed lane-monitor `8d59a952-41d8-4821-a234-7b277927431c` (60 min quiet
tolerance) over this workspace via peer from session `7c82288a-88a2-4916-a419-ad641bbfa6ba`;
check in at major-round boundaries, `/done` when packages 1-4 are merged+deployed+verified
(or the definition of done in the brief is otherwise met), `/failed` only on a genuine
blocker.

## Relevant files and commits

- Brief: `docs/search-indexing-implementation-brief.md`
- Human console guide (do not duplicate/replace): `docs/search-indexing-console-guide.html`
- Planning-lane record: `todos/00027__wixy_please-check-the-website-for-google-etc/`
- Engine surfaces: `builder/sitemap.py`, `builder/templates.py`, `builder/build.py`,
  `builder/nav.py`, `builder/serving.py`, `wixy_server/redirects.py`,
  `wixy_server/routes_public.py`, `projects/ca.json`
- Spec: `spec/02-content-model.md` §7, `spec/07-hosting-deploy.md` §4-5,
  `spec/independence/01-architecture.md`
- Docs to keep in sync: `docs/ai/builder.md`, `docs/ai/invariants.md`, `docs/ai/runbook.md`,
  `docs/ai/serving-and-overlay.md`, `docs/ai/testing.md`

## How to continue and acceptance criteria

Follow the brief's `Task list` order (WP0 → WP1 → WP2 → WP3 → WP4 → WP5 → WP6), one
independently-reviewable PR per work package (site-repo PRs split further per the brief).
Definition of done = the brief's own "Definition of done for the implementation lane"
section. Update this sidecar / add new sidecars per work package as they start; keep the
index line's status current.

## Links

- Public site: `https://cottageaesthetics.co.uk/`
- Staging: `https://ca.cinnamons.uk/`
- Engine repo: `joshcomley/wixy`; site repo: `joshcomley/cottage-aesthetics-preview`
