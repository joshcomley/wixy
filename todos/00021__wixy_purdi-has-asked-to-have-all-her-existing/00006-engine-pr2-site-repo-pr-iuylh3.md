# 00006 [iuylh3] Workstream 3: Engine PR2 (categories) + site-repo PR

## What
(a) Tiny engine PR2: add new category options (e.g. `eyes`/`skin`) to `projects/ca.json`'s
`cat` choice fields for both collections — only categories actually used by imports. May
fold into PR1 if classification (00005) finishes before PR1's final handoff; else separate.
(b) Site-repo PR in `cottage-aesthetics-preview`: processed images, `content/gallery.json`
entries (all imported, `visible:false`), `pages/gallery.html` filter-button + empty-filter-
hiding JS, a `CLAUDE.md` note on `visible` semantics, `decisions/00008-social-before-after-
import/` with the manifest.

## Why
Delivers the actual imported content Purdi asked for, generic-category-aware, without
presenting empty filter buttons to visitors.

## Context / current state
Not started. Depends on 00005 [oh5zsa] (classification/images/manifest final) and 00004
[vlgqe7] (engine PR1 MERGED — site PR's CI runs validate+build+parity against engine MAIN,
so it can only pass post-merge). Site repo: `D:\Servers\Cmd\Storage\clones\
cottage-aesthetics-preview` (normal clone, not a deployment target — branch there). Planner-
verified facts:
- `content/gallery.json` entries: sliders `{before:{src:"images/<name>",alt},
  after:{...},title,sub,cat,visible:false}` — `images/<name>` NO leading slash (known
  incident class, `draft_validate.py:98-112`). Existing 8 entities UNTOUCHED. Order:
  imported entries after existing, newest post first. Alt text: descriptive/treatment-based,
  no client names.
- `pages/gallery.html`: add filter buttons per new category to `#gfilter`, AND extend the
  inline script so any filter button whose `data-cat` matches zero rendered
  `.ba-slider`/`.ba-tile` elements is hidden on load (imports start hidden → empty filters
  must not show).
- CI/parity risk: `builder/tests/parity/baseline/gallery/probe.json` (engine repo) is STALE
  (lists 7 images, live has 16) — Wixy publishes bypass PR CI. Rebaseline via engine repo's
  `.github/workflows/capture-baseline.yml` (`workflow_dispatch`, `ca_ref` input) — read that
  workflow + `spec/03-build-serve.md` §5 before using it. If it genuinely can't produce a
  green required check pre-merge, that's a BLOCKER (message planner), not a bypass.
- Site repo `decisions/` next free number: 00008 (verify at commit time). Manifest.json from
  00005 ships here, not in any built/published directory.

## Relevant files
Site repo: `images/`, `content/gallery.json`, `pages/gallery.html`, `CLAUDE.md`,
`decisions/00008-social-before-after-import/`. Engine repo: `projects/ca.json` (PR2, if
separate from PR1).

## How to continue + acceptance
Branch in the site repo clone, PR, CI green (validate+build+parity against engine main —
only possible after 00004 merges+deploys), included in round-(b) FINAL HANDOFF (00007
[rusa0k]) — do not merge before planner clearance for this exact SHA either.

## Links
Depends on 00004 [vlgqe7] (engine PR1 merged+deployed) and 00005 [oh5zsa] (scrape done).
Feeds 00007 [rusa0k] (release + verification).
