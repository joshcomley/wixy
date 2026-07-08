# Parity capture forces every `.reveal` section visible

## Symptom / what was found

After decisions/00005's `reduced_motion="reduce"` fix merged and the baseline was
recaptured a third time, CA repo PR #1's CI failed again on the **exact same** check:

```
[FAIL] gallery/screenshot: desktop screenshot differs by 14.88% (budget 1%)
```

The suspicious part: **14.88%, to two decimal places, identical to the pre-fix
failure.** Random timing noise (which is what 00005 assumed the nudge animation was
causing) does not reproduce the same percentage twice — a stable, repeated number
means a deterministic, structural cause, not a race. That was the signal to stop
theorizing and measure directly (per this project's profiling discipline) rather than
trust the first plausible-looking explanation.

## Root cause (confirmed by direct DOM inspection, not inference)

Built a local copy of the CA site, served it, and queried the gallery page's DOM state
right before the screenshot would fire:

```
basliders: {children: 3, opacity: '1', top: 867}   ← revealed
bagrid:    {children: 1, opacity: '0', top: 1844}  ← NOT revealed
morelabel: {children: 3, opacity: '0', top: 1704}  ← NOT revealed
```

`site.js`'s `.reveal` mechanism only flips an element to `opacity:1` (the `.in` class)
once an `IntersectionObserver` reports it has actually intersected the viewport.
`capture_screenshot` never scrolls — it navigates once and shoots a `full_page=True`
screenshot from a static, unscrolled layout. Elements within roughly one viewport
height of the top (`basliders`, at 867px in a 900px-tall viewport) happen to intersect
and reveal; elements further down (`bagrid`/`morelabel`, at 1700–1844px) never do,
and sit at `opacity:0` — invisible, but still laid out (unlike `display:none`).

This explains the exact failure pattern already observed in CI: text/link/image/
computed-style probes all passed, only the screenshot failed. `innerText` and
`getComputedStyle` are both unaffected by `opacity` (only `display:none`/
`visibility:hidden` remove text from `innerText`), so the non-visual probes saw
identical content on both sides — only the *pixels* differed, because one side
render blank rectangles where photos belong.

Ran the exact same probe against the true pre-migration raw site (the one the
baseline was captured from) and got the **same pattern** (`basliders` revealed,
`bagrid`/`morelabel` not) — confirming this isn't a migration-introduced regression,
it's an existing fragility in the capture harness's page-settling strategy that
migration merely exposed (gallery is the one page where the un-revealed region is
large, photographic, and therefore highly sensitive to being blank vs. filled — a
small colored text section shifted the same way barely moves the pixel-diff needle;
a blank rectangle where 3-4 large photos should be moves it enormously).

Also directly verified with `compare_screenshot` (the real comparison function, not a
guess): before this fix, raw-vs-built gallery screenshots differ well past budget;
after adding the fix described below, they match cleanly.

## Relationship to decisions/00005

00005's `reduced_motion="reduce"` fix is **not wrong** — it correctly makes the
gallery slider's auto-nudge animation deterministic, which matters for a genuine
user-facing concern (an actual visitor scrolling the page could still hit that
animation-timing window). It is kept. But it was **not the cause of the CI failures**
observed — both failures were entirely explained by the reveal-visibility issue
below, independent of the nudge animation. 00005 was a plausible-looking but
incomplete diagnosis, corrected here with direct measurement once the same exact
failure recurred after that fix was live.

## What was decided

`capture.py` now has a `_force_reveal(page)` helper, called in both `capture_page`
and `capture_screenshot` right after the existing settle wait:

```js
document.querySelectorAll('.reveal').forEach(el => {
  el.style.transition = 'none';
  el.classList.add('in');
});
```

Setting `transition:none` inline (higher specificity than the class-based transition
rule) before adding `.in` makes the visibility change instant rather than animating
over the CSS-defined 0.8s fade — so no additional wait is needed and no mid-fade
frame can be captured. This makes every capture show the fully-settled state a real
visitor eventually sees, deterministically, regardless of viewport height, page
length, or where a given section happens to sit relative to one viewport's worth of
scroll.

## What to watch for

- Any FUTURE reveal-style, scroll-triggered visibility mechanism (not just the
  current `.reveal`/`IntersectionObserver` pair) will reintroduce this same class of
  problem if the capture harness isn't updated to force it visible too — the fix here
  is keyed to the specific `.reveal` class name, not a generic "wait for all
  animations" mechanism.
- Don't diagnose a repeated exact-percentage screenshot failure as "flaky/timing" —
  an identical number across runs is evidence FOR a deterministic cause, not against
  one. Always get a second data point (rerun, or reproduce locally) before
  committing to a fix; a plausible first theory (00005) survived exactly one round
  of "looks right" before being falsified by a second identical failure.
