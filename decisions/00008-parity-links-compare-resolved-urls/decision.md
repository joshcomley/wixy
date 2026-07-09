# Parity link probe compares resolved URLs, not raw `href` strings

## Symptom / what was found

Building milestone 4's partials (header/footer nav, `@nav`'s builder-generated
items), a local raw-site-vs-built-site comparison showed every page's link-set
check failing with the SAME 5 nav labels reported as "extra" (present in the
current build, absent from the original) — even though the destinations were
obviously the same pages.

## Root cause

`builder/nav.py`'s `page_url()` generates root-relative hrefs (`/about.html`) for
`@nav` items — a deliberate, more robust convention for a general-purpose builder
(works regardless of what directory depth the current page is served from). The
original hand-authored site (and this migration's own `_global.json` footer
links, copied verbatim from the original markup) use plain-relative hrefs
(`about.html`, no leading slash). For a site with every page at the root (true
here, and the common case), these are the exact same destination — but
`capture.py`'s link probe read `getAttribute('href')`, the raw unresolved
attribute string, so `/about.html` and `about.html` compared as different
strings entirely.

This is precisely the "byte equality" trap spec/03 §3.1 already warns against for
markup (bs4/html5lib normalization) — the same principle applies to hrefs: what
parity should care about is *where the link goes*, not the exact spelling of the
attribute that gets it there.

## What was decided

`capture_page`'s link probe now reads `e.href` (the browser-resolved absolute
URL) instead of `e.getAttribute('href')`, then strips the capture server's own
origin via the same `_strip_origin` helper already used for image `src`s — so a
resolved `http://127.0.0.1:PORT/about.html` becomes `/about.html` on both sides
of any comparison, regardless of whether the source markup wrote it as
`about.html`, `/about.html`, or (hypothetically) a fully-qualified same-origin
URL. External links (different host — social media, the booking iframe URL)
resolve to themselves unchanged and are compared as before, since a *real*
destination mismatch there is exactly the kind of finding parity should catch.

This mirrors decisions/00005 and 00006's precedent: fix the capture harness to
measure what genuinely matters (rendered destination, revealed content) rather
than an incidental representation detail (raw href spelling, animation timing).

## What to watch for

- Like every other `capture.py` change, this changes what the probe *records* —
  the committed baseline must be recaptured via `capture-baseline.yml` (never
  locally on Windows) before any CI comparison using it will pass again.
- If a future page's builder output legitimately needs to distinguish two
  same-path-different-origin URLs that currently collapse under this
  normalization, that would be a new, deliberate case to handle — not yet hit.
