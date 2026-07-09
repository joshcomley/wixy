# Parity harness tooling choices (milestone 3)

## Context

Building the rendered-parity harness (spec/03-site-migration.md §5) for the CA migration
surfaced three implementation-detail gaps between the spec's prose and what's needed to
actually ship it. None are architectural conflicts — decided per spec + fleet rules and
logged here rather than escalated, per KICKOFF-PROMPT's guidance.

## Decisions

1. **Split `pyproject.toml` dependencies into core vs a `server` extra.** Milestone 1's
   flat dependency list mixed `builder`'s needs (bs4/html5lib/nh3) with `wixy_server`'s
   (fastapi/uvicorn/PyJWT/cryptography/httpx/anyio) — but 04-server.md's component table
   says `builder` is "importable standalone (site-repo CI installs just it)", which only
   works if the site repo's `pip install` doesn't drag in a FastAPI app it'll never run.
   Core = `beautifulsoup4`, `html5lib`, `nh3`, `playwright`, `pillow` (everything
   `builder` + its parity harness need — screenshots need a real browser, pixel-diffing
   needs image decoding). `server` extra = fastapi/uvicorn/httpx/PyJWT/cryptography/anyio,
   pulled in only by wixy's own CI (`pip install -e ".[server,dev]"`) for `wixy_server`
   work from milestone 6 onward.

2. **`python -m builder parity`, not `python -m builder.parity`.** 03 §5 point 3 mentions
   rebaselining via `python -m builder.parity --rebaseline`, which would require the
   harness to live at `builder/parity/` as its own top-level runnable module — but two
   OTHER mentions in the same section place it at `builder/tests/parity/` (both the
   opening line and where the baseline is committed). Resolved by adding `parity` as a
   fourth subcommand of the CLI milestone 2 already built (`python -m builder
   build|validate|serve|parity`), keeping the harness code + baseline at
   `builder/tests/parity/` consistently with both of the other two mentions, and treating
   the exact "`builder.parity`" invocation spelling as an informal shorthand rather than a
   literal path requirement.

3. **The parity CLI takes `--serve-root` + `--slugs`, not `--root` + `--project`.** It
   doesn't build the site itself — it serves and probes whatever static directory it's
   given. This lets the SAME code path handle both the one-time baseline capture (serving
   the raw pre-migration site directly, before any builder/content-model structure
   exists) and every later CI check (serving a fresh `builder build` output) — decoupling
   "capture+compare" from "how the directory got built."

4. **`projects/ca.json` created now, not deferred to milestone 6.** The site repo's CI
   (03 §7) needs a project registry file to invoke `python -m builder
   validate/build/parity` at all; `04-server.md` frames "project registry" as milestone
   6 work (the *loader* that reads every `projects/*.json` at server startup), but the
   *data file* itself has no runtime-code dependency and is needed as soon as anything
   invokes the builder CLI against this project. Used the exact values 04 §1 already
   gives as its worked example — those are this project's real values, not illustrative
   placeholders.

## What to watch for

- The common `COMMON_SELECTORS` list in `builder/tests/parity/capture.py` was chosen by
  reading the real pre-migration site's markup (`h1`/`h2`/`h3`/`p`/`a.btn-*`/`.eyebrow`/
  `.tag`/`.price`/`header#hd`/`footer.site-footer`/`nav.nav-links`/`body`) — a selector
  that matches nothing on a given page is silently skipped rather than erroring. If
  migration (04/05) changes these class names, the *parity check itself* won't notice
  (it'll just stop sampling that selector) — only a human comparing the sampled selector
  set before/after would catch a silent coverage drop. Worth a periodic sanity check.
- Screenshot pixel-diffs are captured on this Windows dev machine's baseline; per spec
  the *enforced* (`--strict-screenshots`) comparison must run on the pinned CI platform
  (ubuntu-latest) — local/cross-platform runs are advisory only. The CI workflow (added
  alongside the CA repo's own `ci.yml` in the next PR) must pass `--strict-screenshots`
  only from that pinned job.
- `_strip_origin` (capture.py) assumes the SAME `base_url` was used for both the baseline
  capture and every later check invocation's OWN local server — it strips whatever
  `base_url` is passed to `capture_site` for *that* run, so this is inherently
  self-consistent regardless of which ephemeral port either run happened to bind, not a
  fixed baked-in value.
