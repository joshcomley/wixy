# M13: capture-baseline.yml served the raw (unbuilt) CA checkout post-migration

Found live, during M13's own live-verification AI-conversation drill (spec/08 §4's
"a real AI conversation asking for a trivial copy tweak end-to-end"): the site-owner
chat agent made a real, legitimate content edit (`content/contact.json`'s
`formIntro.body`, cottage-aesthetics-preview PR #16), and its parity CI failed —
correctly, per spec/03 §5 point 3 ("intentional visual change... re-captured via
`--rebaseline`... the diff shows exactly what changed"). The agent investigated,
found `.github/workflows/capture-baseline.yml`, and triggered it. It reported
success and committed a new baseline to wixy `main` (`0553fc2`) — but PR #16's CI
**still failed against the fresh baseline**, with the exact same page's parity check
now diffing real rendered text against a raw directory listing:

```
was: Directory listing for / .git/ .github/ .mcp.json CLAUDE.md content/ decisions/
     images/ pages/ partials/ README.md site.css site.js theme/ todos/
now: Cottage AESTHETICS ABOUT TREATMENTS BEFORE & AFTER REVIEWS CONTACT BOOK NOW ...
```

## Root cause

`capture-baseline.yml` passes `--serve-root ca-site` — the RAW site-repo checkout —
straight to `python -m builder parity --rebaseline`. `builder/cli.py`'s own
`--serve-root` help text says what it actually wants: **"a builder build output, or
the raw pre-migration site for the one-time baseline capture"**. This workflow was
first written for exactly that one-time case (spec/03 §5 point 1 — the ORIGINAL
baseline, captured against the pre-migration site when `index.html` etc. sat flat at
the repo root and no build step existed yet). Migration step 1 (spec/03 §3 step 1)
moved every page under `pages/`; from that point on, serving `ca-site` raw means
serving a directory with no root-level `index.html` at all — Playwright's static
server falls back to a directory listing, and `--rebaseline` happily captures THAT
as the new "baseline" with no error (nothing in the parity module treats a
directory-listing capture as invalid — it's syntactically a normal page load).

`ci.yml` (the workflow that actually runs on every PR, and has been passing this
whole time) never had this bug — it always builds first:
`python -m builder build --root . --project wixy/projects/ca.json --out _build`
then `--serve-root _build`. `capture-baseline.yml` was simply never updated to match
once migration finished and "post-migration life" (spec/03 §5 point 3's ongoing
rebaseline use) actually started — this is the FIRST time anyone has invoked it
against a post-migration ref, and it happened live, during this exact M13 drill.

## Impact

The broken commit (`0553fc2`) landed on wixy `main` for real — every future
cottage-aesthetics-preview PR's parity check would have failed against a
directory-listing baseline until this was fixed, not just PR #16's. This blocked the
one thing the AI-lane content-editing experience most depends on: an owner asking
for a trivial copy change and having it ship cleanly.

## Fix

`capture-baseline.yml` now builds `ca-site` first (`python -m builder build --root
ca-site --project projects/ca.json --out ca-build`, mirroring `ci.yml`'s own
invocation exactly) and points `--serve-root` at `ca-build`, not the raw checkout.
Re-ran the workflow for real (`ca_ref` = the in-flight PR's own branch, following the
spec's "in the same [logical] PR" framing — the baseline must reflect the PR's own
pending content, not main, or the PR's own CI would fail against a baseline that
doesn't yet include its change) — the recaptured baseline's `index` probe now shows
the real homepage text, not a directory listing. cottage-aesthetics-preview PR #16
went green against it and merged.

## What to watch for

- Any FUTURE post-migration rebaseline must go through this (now-fixed) workflow —
  don't hand-roll a different invocation that reintroduces the same `--serve-root`
  mistake.
- The one-time pre-migration baseline capture (spec/03 §5 point 1, already long done)
  is the ONLY legitimate case for pointing `--serve-root` at a raw checkout; every
  rebaseline from here on (all of "post-migration life") must build first.
- This is exactly the kind of gap live verification exists to catch — a unit/CI-level
  test never exercises a manually-triggered, rarely-run workflow like this one; only
  actually invoking it for a real content change surfaced the bug.
