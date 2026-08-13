# WP4-site: mobile performance (4A reveal-gating fix, 4C lazy gallery, 4E fonts audit)

Dispatched to cottage-aesthetics-preview workspace #18 (session e46c4302), reused
from the earlier WP2-site/WP3-site dispatches.

Delivered (all evidence-based, "measure before changing" throughout):
- 4A: `.reveal` visible by default now; JS only opts an element INTO the
  hide-then-fade-in treatment once confirmed below the fold at load — no-JS/
  JS-error/reduced-motion/slow-observer can no longer leave real content
  invisible, by construction. 17/17 interaction tests.
- 4C: `loading="lazy" decoding="async"` on gallery slider images (tiles already
  lazy). Verified via Lighthouse's LCP-element audit that neither homepage nor
  gallery's LCP candidate is an image (both text) — no above-fold carve-out
  needed.
- 4E: trimmed two provably-unused font weights (Cormorant Garamond 600, Jost
  500), confirmed two independent ways (computed-style probe + exhaustive
  grep). Honest finding: zero measured byte savings (Google Fonts only serves
  weights actually rendered) — the value is a truthful contract, not a
  transfer reduction.

Measured (devtools-throttled Lighthouse, apples-to-apples): home LCP
3.07s→2.37s, gallery LCP 3.16s→2.01s, gallery transfer 7.9→2.3 MiB (under the
2.5 MiB target). Homepage transfer stays over the 1.0 MiB target — correctly
deferred to 4D (image bytes) with the exact reason named.

Merged as cottage-aesthetics-preview PR #45, commit `e1355765`.

**Found + I (the engine session) fixed 3 real engine-side parity-harness bugs
along the way, rather than the dispatch working around them:**
1. `capture.py` never waited for `loading="lazy"` images to actually load
   before measuring dims/screenshotting → `_force_eager_images` added (wixy
   PR #206, decisions/00141).
2. That fix's `load`/`error`-event wait resolved before `decoding="async"`
   images were truly PAINTABLE (decode lags load) → swapped to `img.decode()`
   (wixy PR #207, root-caused and the fix verified by the dispatch directly
   against the real gallery page).
3. Fixing both of the above unmasked a pre-existing stale `[0, 0]` baseline
   entry for `ba-chin.jpg` (predates this whole investigation, silently wrong
   because prior comparisons ran the same buggy harness on both sides) →
   recaptured via `capture-baseline.yml` (wixy PR #208, decisions/00142).

decisions/00021 (site repo) has the full methodology writeup including the
Lighthouse-throttling-instability root cause (fixed by switching from
"simulate" to "devtools" throttling mode).
