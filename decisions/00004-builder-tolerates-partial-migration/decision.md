# Builder tolerates the partially-migrated state

## Symptom / what was found

Implementing migration step 1 (spec/03-site-migration.md §3.1 — move pages under
`pages/`, add the two partial markers, "no other change"; `deploy.yml` switches to
`python -m builder build` for the Pages artifact) revealed that the builder as it stood
after milestone 2 could not build these pages at all:

- `load_site_source` called `load_json_object` on every page's `content/<slug>.json`
  unconditionally — a raw, uncaught `FileNotFoundError` (not even a clean `BuildError`),
  because step 1 pages have no content JSON yet (that's step 3 / milestone 4's job:
  "create content/<page>.json with today's exact copy").
- `render_page` required `page_content["meta"]` to be a dict, raising `BuildError`
  otherwise.
- `render_page`/`apply_head` unconditionally called `generate_fonts_url(source.theme)`
  and overwrote the page's existing Google Fonts `<link>` with the result —  but
  `theme/theme.json` doesn't exist until migration step 4 / milestone 5. Loading it
  would itself throw, and even papering over that, a theme built from nothing has no
  font entries, so the generated fonts URL is empty — silently swapping the page's real
  webfont link for a dead one. That changes the RENDERED page (fallback fonts kick in),
  which is exactly what the parity harness (03 §5, landed in milestone 3a) exists to
  catch — the very first real build after step 1 would have failed its own parity gate.

## Root cause

Milestone 2 built the builder against the *fully-migrated* content model (spec/02) as
its only assumption. But the migration itself is staged precisely so "the site repo is
never in a state the builder can't build" (09-work-plan.md's own framing) — which means
the builder has to work correctly at *every intermediate* migration state, not just the
end state. This was a gap in milestone 2's design, only surfaced by actually attempting
step 1.

## What was decided

- `SiteSource.theme` is now `Theme | None`. `load_site_source` accepts `theme: Theme |
  None`; the CLI's `_load_source` loads `theme/theme.json` only if the file exists,
  passing `None` otherwise.
- Missing `content/<slug>.json` or `content/_global.json` now loads as `{}` instead of
  raising (`_load_content_or_empty` in `render.py`).
- `render_page` no longer requires `meta` to be a dict — a missing/malformed `meta`
  degrades to `{}`, and `apply_head`'s existing per-key conditionals (already written to
  skip title/description/OG when absent) handle that gracefully with no further change.
- `apply_head`'s `fonts_url` parameter is now `str | None`. When `None` (no theme yet),
  the fonts-link block is skipped ENTIRELY — the page's existing fonts link (however it
  got there) is left completely untouched, which is what keeps rendering — and parity —
  intact until step 4 actually introduces a real theme.
- `build_site` only writes `theme.css` when a theme is present; `validate_site` only
  runs theme-schema checks when a theme is present (its absence pre-step-4 is not, by
  itself, a validation error).
- New test file `test_partial_migration_state.py` locks in the whole passthrough
  behavior (load/render/build/validate all succeed against a step-1-shaped fixture; the
  original fonts link and title survive untouched).

## What to watch for

- This same tolerance is what step 1's own PR needs to actually build+deploy via the
  rewritten `deploy.yml` — don't reintroduce a hard requirement for content/theme
  presence without re-checking this milestone's fixture still passes.
- Once migration step 3 (milestone 4) adds real `content/*.json` with `meta`, and step 4
  (milestone 5) adds `theme/theme.json`, `apply_head` will start actually managing
  title/description/OG/fonts-link/robots for real — this is the intended, automatic
  transition; no further code change should be needed for that switchover, only content.
