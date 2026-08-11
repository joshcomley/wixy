# Decision: remove `capture_page`'s console/pageerror listeners after each slug's own capture window

## Symptom

cottage-aesthetics-preview PR #39 (a one-line `.hero` CSS fix, unrelated to any JS or
third-party embed) failed CI's `rendered-parity check` with:

```
[FAIL] index/console: console errors present: ['ReferenceError: google is not defined ...']
[FAIL] about/console: console errors present: ['ReferenceError: google is not defined ...']
[FAIL] aftercare/console: console errors present: ['ReferenceError: google is not defined ...']
[FAIL] contact/console: console errors present: ['ReferenceError: google is not defined ...']
```

Only `contact.html` actually embeds a Google Maps iframe (`content/_global.json`'s
`mapSrc`, spec/02 §9-adjacent) — `index`, `about`, and `aftercare` have no Maps
reference anywhere in their markup or shared partials. A rerun of the same CI job,
no code changes, went green.

## Root cause

`builder/tests/parity/capture.py`'s `capture_site` (called with `--slugs
index,about,aftercare,contact,...`) launches **one** Playwright `page` and reuses it
across every slug in a single `for slug in slugs:` loop. Each slug's `capture_page`
call registered a **fresh** `console`/`pageerror` listener (closed over a fresh
`console_errors` list) via `page.on(...)` — but never removed it. Playwright
listeners persist across `.goto()` navigations and are not implicitly scoped to one
navigation; they accumulate for the life of the `page` object.

By the time `contact` (4th in the slug order) loaded its Maps iframe and the iframe's
async init script threw (`maps.gstatic.com/.../init_embed.js`, a live third-party
script whose load/init timing is inherently non-deterministic under CI network
conditions — hence the clean rerun), there were 4 *simultaneously active* listeners
on the shared `page`: one each from `index`, `about`, `aftercare`, and `contact`'s own
`capture_page` calls. Playwright's `console` event fires all registered listeners,
so the single error got appended to all four still-open `console_errors` lists —
exactly the four pages that failed, in exactly the order they'd been captured so far.
`faq`/`gallery`/`policies`/`reviews`/`treatments` (5th–9th) hadn't registered
listeners yet at the moment the error fired, so they were unaffected — this is the
detail that pins the mechanism precisely (a purely-random flake wouldn't correlate
with slug processing order).

## What was decided

Wrap `capture_page`'s probe-gathering in `try/finally` and call
`page.remove_listener("console", on_console)` /
`page.remove_listener("pageerror", on_page_error)` in the `finally`, scoping each
slug's error capture to its own `goto` + settle window
(`builder/tests/parity/capture.py`). Added a regression test
(`test_parity.py::TestCaptureConsoleErrorScoping`) that serves two bare static pages
— `a.html` (clean) and `b.html` (throws 30ms after load) — through the real
`capture_site` entry point and asserts `a`'s probe stays clean while `b`'s own error
is still captured; confirmed RED on the pre-fix code (`a` picked up `b`'s error twice
— once from `capture_page`, once from the screenshot pass's re-navigation) and GREEN
after.

## Why

This is a harness bug, not a flake to route around: any future page with a
slow/flaky third-party script (analytics, chat widgets, further Maps/social embeds)
would non-deterministically fail *every other page processed before it in the same
run* — a growing source of confusing, hard-to-reproduce CI red that has nothing to
do with whatever the actual PR touched. Removing the listeners restores the
documented contract (spec/03 §5 point 2: "Console errors = failure", implicitly
per-page) instead of "console errors anywhere in this batch, attributed
arbitrarily."

## What to watch for

- `capture_screenshot` does its own separate `page.goto(url, ...)` for the same slug
  (re-navigating, for the screenshot pass) with **no** console listener at all,
  before and after this fix — an error that fires only during that second
  navigation (not during `capture_page`'s own window) is still silently uncaptured.
  Not addressed here (out of scope for this incident; `capture_page`'s `goto` +
  networkidle + 300ms settle already gives async init scripts a realistic window to
  throw within their own slug's listener).
- If a real page's third-party embed is genuinely, persistently flaky in CI (not a
  one-off), the fix here won't mask that — it'll now correctly and *only* fail that
  one page every time, which is the signal to either mock/stub the embed for parity
  purposes or accept it as an advisory-only check.
- Same reused-`page`-across-a-loop shape could recur anywhere else in this file if
  extended (`capture_site` also loops for screenshots on the same `page` per slug) —
  any future `page.on(...)` added to a per-slug helper needs the same
  register/remove-in-`finally` discipline.
