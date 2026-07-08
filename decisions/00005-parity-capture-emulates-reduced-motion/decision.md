# Parity capture emulates `prefers-reduced-motion: reduce`

## Symptom / what was found

The first real CI run of CA repo PR #1 against the ubuntu-recaptured baseline (milestone
3's final gate) failed on exactly one check:

```
[FAIL] gallery/screenshot: desktop screenshot differs by 14.88% (budget 1%)
```

Every other probe (text, links, images, computed styles, and every other page's
screenshot) passed. This was anticipated in the prior session's handover as a known
flakiness risk, but had not yet been observed as a hard CI failure until this run.

## Root cause

`gallery.html` has a one-shot "auto-nudge" animation: when the before/after slider
scrolls into view, it runs a 1400ms `requestAnimationFrame` sweep of the slider handle
(from 50% out to ~20% and back) "to signal it's draggable" (03 §4's behavior inventory).
`capture.py`'s `capture_screenshot` only waits a fixed 300ms after `networkidle` before
shooting — far shorter than the 1400ms animation — so the screenshot can land at any
point in the sweep. Two captures of byte-identical content can therefore show a large
pixel diff purely from where the slider handle happened to be when the shutter fired.
This is genuine timing non-determinism, not a content regression, exactly as spec/03 §5
anticipates ("screenshot assertions... antialiasing tolerance" — but this is a much
larger source of noise than antialiasing).

Critically, `gallery.html`'s own script *already* guards against this for accessibility:

```js
var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
...
if (!reduce && 'IntersectionObserver' in window) { /* wires up the nudge */ }
```

The capture harness just wasn't asking for that preference, so the guard never
triggered — Chromium's default `prefers-reduced-motion` is `no-preference`.

## What was decided

`capture_site` (`builder/tests/parity/capture.py`) now opens its Playwright page with
`browser.new_page(viewport=..., reduced_motion="reduce")`. This makes the media query
evaluate `true` inside the captured page, so the gallery's own guard skips wiring up the
nudge animation entirely — deterministic, zero-timing-dependency screenshots — rather
than fighting the race with a longer fixed wait (which narrows the window but can never
close it for a repeating/looping capture cadence, and is the kind of stopgap this
project's posture rejects in favor of a real fix).

Verified this is side-effect-free: grepped the whole CA repo for
`reduced-motion`/`prefers-reduced` — the only reference anywhere is this one guard in
`gallery.html`. No CSS `@media (prefers-reduced-motion)` block exists that could alter
any OTHER page's rendering, computed styles, or layout. The fix is therefore surgical to
the one flaky page.

Because this changes what `capture_site` produces, the *committed* baseline (captured
moments earlier via the milestone-3c/3d/3e workflow runs, before this fix existed) no
longer matches what the fixed harness will now capture for comparison — it must be
recaptured once more via `capture-baseline.yml` after this fix lands on wixy `main`,
same as any other capture-code change.

## What to watch for

- Any FUTURE animation added to the site (gallery or elsewhere) that doesn't already
  respect `prefers-reduced-motion` will reintroduce this same class of flake — the fix
  here relies on the site's own code checking the media query, not on Playwright
  suppressing CSS animations globally. If a future page adds motion with no such guard,
  either add one there (matches the site's own accessibility practice) or extend the
  parity harness with a global animation-disabling stylesheet injection at that point.
- Don't "fix" a future recurrence by widening the pixel-diff budget or lengthening the
  settle wait — both mask real regressions instead of removing the actual source of
  non-determinism.
