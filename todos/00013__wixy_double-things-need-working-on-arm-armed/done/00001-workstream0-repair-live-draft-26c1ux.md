# 00001 [26c1ux] Workstream 0 — repair live draft overlay + publish

## What
Operational (not code) fix on production `ca.cinnamons.uk`: the live draft overlay (rev 127)
has a corrupted `gallery.sliders` whole-array op (all 3 items missing required `cat`, item[0]
gutted to placeholder `&nbsp;`/empty srcs) and a `meta.ogImage` op with a leading-slash src
(`/images/ba-lips-1-after.jpg`) that fails `builder/validate.py`'s path check. This has blocked
the owner's publish since 2026-07-28.

## Why
Site owner tried to add a before/after photo pair via the editor overlay list toolbar and got
a wall of raw validator errors. Three benign upstream commits (FAQ nav) are also stuck behind
this. See the full incident diagnosis in the original brief (session 5b2083a2-...).

## How to continue + acceptance
1. `GET /api/admin/state` on ca.cinnamons.uk (CF Access headers via `verify` skill) → confirm
   draft.rev and the corruption fingerprint still match.
2. `PATCH /api/admin/draft` — discard `gallery:gallery.sliders`, set `gallery:meta.ogImage` to
   `{"src": "images/ba-lips-1-after.jpg", "alt": "Lip enhancement result — after"}`.
3. `GET /api/admin/publish/preview` → assert `validate.ok == true`.
4. `POST /api/admin/publish` → expect version 20.
5. Verify live: gallery page has 3 slider figures with `data-cat`, FAQ nav present.

## Links
Brief section "WORKSTREAM 0". Report step-0 completion in the final completion report.
