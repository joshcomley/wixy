## Symptom

The `cottage-aesthetics-preview` site repo's search-indexing brief WP4-4C work
(dispatched to a separate cmd workspace, session `e46c4302`) added
`loading="lazy" decoding="async"` to gallery tile and before/after slider images,
per `docs/search-indexing-implementation-brief.md`'s explicit instruction. Once
built and run against real GitHub Actions CI (not just local Windows testing),
exactly two parity checks failed on the gallery page, both traced precisely by
that dispatch to the same root cause and reported back rather than worked around:

1. `gallery/images` — the captured image set's `naturalWidth`/`naturalHeight`
   differ from baseline: every below-the-fold, correctly-lazy image reports
   `(0, 0)`.
2. `gallery/screenshot` — a full-page screenshot shows blank placeholder boxes
   where later slider rows belong (desktop diff 36.87%, mobile-independent Windows
   local reading 37.99% — later shown to be the same phenomenon, not separate
   noise).

Neither is a markup bug. `builder/tests/parity/capture.py`'s `capture_page`/
`capture_screenshot` never scroll the page — they `goto` + wait for
`networkidle` + a fixed 300ms settle, then read `img.naturalWidth`/`naturalHeight`
and take a full-page screenshot. A correctly `loading="lazy"` image far below the
fold is never given a reason to fetch by that sequence, so it measures/renders as
if it were simply missing — even though it works perfectly for a real visitor who
actually scrolls.

## What was decided

- New `builder/tests/parity/capture.py:_force_eager_images(page)` — sets
  `loading="eager"` on every `<img>` on the page via `page.evaluate`, then waits
  (inside that same evaluate call, via `Promise.all` over each image's `load`/
  `error` event, or immediately if already `.complete`) for every one to actually
  finish loading before returning. Called from both `capture_page` and
  `capture_screenshot`, immediately after the existing `_force_reveal(page)` call.
- This is the direct sibling of `_force_reveal`'s own precedent (a scroll-gated
  `.reveal` section forced to its final visible state so capture sees the same
  fully-settled content a real visitor eventually does) — applied to load-gated
  content instead of scroll-gated content. Same philosophy, same placement, same
  "capture measures the site's TRUE eventual state, deterministically" goal.
- **Waiting for the real `load`/`error` event (not a fixed timeout) was the
  deliberate choice over the two options the dispatching lane itself suggested**
  (poll-for-`.complete` with a generous timeout, or force-eager without an
  explicit wait). A fixed timeout either wastes time when images load fast or
  races when they load slow (real network fetch time through a handful of
  concurrent connections, per the dispatch's own gallery measurement — ~106
  images). An event-driven wait blocks exactly as long as the real fetch takes,
  no more, no less, and needs no tuning constant.
- Verified with a genuine red/green cycle: two new tests in
  `builder/tests/parity/test_parity.py` (`TestCaptureForcesLazyImagesToLoad`) —
  a real `loading="lazy"` image positioned far enough below the fold (`20000px`
  spacer — empirically, Chromium's own lazy-load "near viewport" preload
  distance heuristic is generous enough on an unthrottled local connection that
  a merely-plausible `3000px` distance still loaded the image regardless of this
  fix, giving a false-green red-check; `20000px` reliably defeats it) that the
  probe reports `(0, 0)` and the screenshot is blank at the image's location
  without the fix, and real dimensions / the image's own pixel color with it.
  Both temporarily-disabled-then-restored to confirm the exact failure this fix
  closes, not just that the new code runs.

## Why

Reusing `_force_reveal`'s exact structural pattern (a small, well-named private
helper called right after it, same file, same docstring style explaining WHY
capture needs this and what would go wrong without it) keeps the module coherent
— a future reader who understands one "force the deterministic settled state"
helper immediately understands the other. Event-driven waiting over a fixed
timeout avoids re-introducing exactly the kind of timing-sensitive flakiness this
whole capture module already works hard to eliminate (see `_force_reveal`'s own
docstring on why a fixed viewport-intersection threshold is non-reproducible).

## What to watch for

- A future page with a genuinely broken image (404, wrong path) will now also
  wait for that image's `error` event before the capture proceeds — bounded by
  the browser's own network timeout, not indefinite, but worth knowing if a
  capture ever seems to hang on a page with a bad image reference (that's a real
  bug to fix in content, not a parity-harness problem).
- If a future page has enough images that `Promise.all`-waiting for every single
  one meaningfully slows capture down, the fix should stay correctness-first
  (wait for what the real build actually references) rather than being narrowed
  to "only images already tagged lazy" as a speed optimization — the whole point
  is that a capture reflects the same content a real visitor eventually sees.
