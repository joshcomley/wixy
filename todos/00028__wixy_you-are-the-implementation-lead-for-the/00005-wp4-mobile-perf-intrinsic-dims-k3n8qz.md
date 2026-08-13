# WP4 (brief table Order 5): mobile performance work packages 4A-4E

Started 2026-08-13. Brief section: `docs/search-indexing-implementation-brief.md`
"Work package 4 — first mobile performance pass".

## 4B: intrinsic image dimensions (engine) — DONE, PR pending audit gate

Branch `feat/img-intrinsic-dimensions` (off `origin/main`, independent of PR #204).
PR #205 open, CI green. `builder/bindings.py:_apply_img` sniffs intrinsic
width/height via the existing `builder.imagesize.probe_image_size`, sharing
`is_safe_relative_src` with `templates.py`'s og:image sniff (moved to
`imagesize.py`). decisions/00140, Inv 39. Holding at the audit checkpoint like
#203/#204 until the parent session confirms the audit-infra fault is fixed.

## 4A, 4C, 4E (site-repo) — DONE

Dispatched to cottage-aesthetics-preview workspace #18 (session e46c4302),
merged as PR #45 (e1355765). See todo 00007 (done) for the full writeup,
including the three engine-side parity-harness bugs this dispatch's rigorous
CI-verification surfaced (fixed as wixy PRs #206/#207/#208).

## 4D (reduce image bytes) — NOT STARTED, evidence-gated

Brief requires ranking images by avoidable bytes before optimizing; needs a real
Lighthouse/bytes audit pass first, not blind optimization. Not picked up yet.
