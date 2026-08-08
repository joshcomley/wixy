# 00005 [oh5zsa] Workstream 2: scrape+classify+process IG & FB before/after posts

## What
Complete, auditable inventory of EVERY post on both @cottageaesthetics IG and the Cottage
Aesthetics FB page, each classified, and every before/after post converted to a slider pair
or tile with processed images + a manifest.json audit trail.

## Why
This IS Purdi's request — "all her existing before/after posts" — so completeness (or an
honest accounting of why not) is the actual deliverable, not just "some pairs imported".

## Context / current state
Not started as of sidecar creation. Independent of the engine PR (shares no files) — can run
in parallel. Preserved stash at
`D:\Servers\Cmd\Storage\cottage-social-import\2026-08-01-ig-stash\` (31 posts, embed_manifest.
json has captions, manifest.json has shortcode→URL, split.py has a curated but UNRUN RECIPES
table for 10 posts). Full shortcode list and RECIPES table are in the original brief (see
Links). Key facts:
- IG anonymous: profile grid shows only first ~12 posts then login wall; individual post
  pages (`/cottageaesthetics/p/<code>/`) serve FULL-RES anonymously (measured 1648x2197 vs
  embed's 900px); at least 2 posts newer than the stash exist (`DbnHGgRorRy`, `DbjfZUpiNdr`).
- FB: zero prior scrape. Page `facebook.com/profile.php?id=61572079150383`. Anonymous depth
  ~15 photos via Photos tab then login nag.
- If anonymous enumeration can't prove completeness (total count vs union count mismatch) →
  raise `op-ask-question` (delayed mode, NOT a planner blocker) asking Josh to log into
  IG/FB in Chrome on this box, then continue everything else while pending.
- Classification is MY OWN judgment (read images via ≤1800px previews + captions) — never
  call any LLM API directly for this. Categories: lips/cheeks/chin/eyes/skin (new ones only
  if actually needed).
- Image processing mirrors `wixy_server/media.py:73-121`: EXIF-strip+auto-orient, downscale
  LANCZOS to ≤2000px longest side, RGB, JPEG q=85 optimize=True. Naming `ba-ig-<shortcode>-
  before/after.jpg` / `ba-ig-<shortcode>.jpg` (tiles); FB `ba-fb-<id>-...`.
- Dedupe against: 2 existing IG-derived sliders, 5 owner-uploaded pairs, existing `ba-chin`
  tile, unreferenced `ba-lips-2*` files, IG/FB mirror posts of each other.
- manifest.json row shape: `{platform, id/shortcode, url, date, caption_excerpt,
  classification, category?, disposition}`, disposition ∈ imported-slider/imported-tile/
  duplicate-of-existing:<which>/duplicate-of:<platform:id>/not-before-after:<why>/
  video-not-importable/unreachable:<why>, plus per-platform `enumeration:{total_claimed,
  total_enumerated, complete, notes}`.

## Relevant files
Working area: copy the stash into a scratch dir first (don't mutate the stash in place).
Final output feeds the site-repo PR (00006 [iuylh3]): processed images + manifest.json.

## How to continue + acceptance
Headed Chrome (channel="chrome", headless=False — NEVER headless) via
`/c/Users/josh/AppData/Local/Python/pythoncore-3.14-64/python.exe` (has playwright+Pillow+
httpx). Long scrapes: `run_in_background=true` + 90s liveness check + poll log. Every post on
both platforms accounted for in the manifest with an honest enumeration-completeness verdict.

## Links
Full RECIPES table, complete shortcode list, and platform probe details are in the original
implementation brief (planner session `75f673ab-803c-44ea-a863-edc04f1783e9`, delivered to
the session that created these todos). Independent of engine PR1 sidecars 00001-00004.
Feeds 00006 [iuylh3] (site-repo PR).
