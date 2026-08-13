# WP4 (brief table Order 5): mobile performance work packages 4A-4E

Started 2026-08-13. Brief section: `docs/search-indexing-implementation-brief.md`
"Work package 4 — first mobile performance pass".

## 4B: intrinsic image dimensions (engine) — DONE, PR pending open

Branch `feat/img-intrinsic-dimensions` (off `origin/main`, independent of PR #204).

- `builder/bindings.py:_apply_img` now sniffs intrinsic width/height for a bound
  `<img>` via the existing `builder.imagesize.probe_image_size` — reusing the exact
  mechanism `templates.py`'s `og:image:width`/`height` already uses (decisions/00134).
- Moved the shared safety gate (`_is_safe_relative_src` → public
  `is_safe_relative_src`) into `builder/imagesize.py` so `bindings.py` and
  `templates.py` share one implementation, not a driftable copy.
- Never overwrites an explicitly authored `width`/`height` on the template tag.
  Gracefully skips remote/draft-media/traversal src (same gate, no special-casing
  needed — a draft src is always `/`-prefixed per docs/ai/media.md) and missing/
  unreadable files.
- decisions/00140 + Inv 39 written. Tests added (`TestImgBindingIntrinsicDimensions`
  in test_bindings.py, `TestIsSafeRelativeSrc` in test_imagesize.py) covering
  JPEG/PNG/GIF/WebP, missing files, authored-dimension preservation, unsafe-src
  skip, preview mode, per-list-clone independence.
- mypy strict, ruff, full pytest suite all green.
- NOT YET committed/pushed/PR'd as of this note — holding, same as PR #203/#204,
  to submit for graded audit only once the parent session (7c82288a) confirms the
  audit-infra fault (poisoned senior-sonnet relations credential) is fixed. See
  handover 2608130221 Blockers section for full root-cause writeup.

## 4A, 4C, 4E (site-repo: reveal-gating fix, lazy/async gallery, fonts) — NOT STARTED

To be dispatched to the reused cottage-aesthetics-preview session (workspace #18,
session e46c4302) once it's free (it just finished WP3, merged PR #44) and this
engine PR is at a stable point to verify against.

## 4D (reduce image bytes) — NOT STARTED, evidence-gated

Brief requires ranking images by avoidable bytes before optimizing; needs a real
Lighthouse/bytes audit pass first, not blind optimization.
