# Decision: clean URLs (drop `.html`) — mirror GitHub Pages, zero redirects, both shapes forever

## Symptom

The operator, the morning after the GitHub Pages go-live (decisions/00126): "Can we - with
Github Pages - get rid of the .html suffixes everywhere?" Verified live against
`https://joshcomley.github.io/cottage-aesthetics-preview/`: `/about` → **200** (Pages serves
`about.html` for it, no redirect, zero config), `/about.html` → **200**, `/about/` → **404**
(no directory-index fallback). So the clean shape already works on the public host for free —
the engine and `wixy_server` just needed to emit it and resolve it the same way.

## What was decided — `page_url` emits extensionless; on-disk filenames unchanged

`builder/nav.py:page_url` returns `"/"` for `index`, `"/<slug>"` otherwise (was
`"/<slug>.html"` — spec/02 §3's original convention, now superseded; spec/ itself is left
alone as historical record, per the standing "spec is decided, deviations get a decisions/
entry" rule). Every caller — `nav.build_nav`, `templates.apply_head` (canonical + og:url),
`sitemap.py` (`<loc>`) — follows automatically, and `_mark_nav_active` compares against the
same function so active-nav marking stays consistent. `build.py` is untouched: the build
output is still `<slug>.html` files on disk. `page_url` only controls what the engine
*emits*; a separate, strictly wider resolver (below) controls what it *accepts*.

## What was decided — a shared resolver, not two hand-synced copies

`builder/serving.py:resolve_site_path(directory, request_path)` is new: literal path first
(`/about.html` → `about.html`, `/` → `index.html`), and on a miss — only when the request
path doesn't end in `/` and its final path segment has no `.` — a retry with `.html`
appended. Both `wixy_server/routes_public.py:_resolve_within_build_dir` (now a one-line
wrapper) and `builder/cli.py:cmd_serve`'s new `_CleanUrlHandler` (a small
`SimpleHTTPRequestHandler.send_head` override that rewrites `self.path` to the resolved
file's own path before delegating, so content-type/conditional-GET/HEAD keep working
unmodified) call the same function. This sidesteps creating a new instance of the
Inv-20-style "hand-synced pair" failure mode the codebase already has three of — one
algorithm, one set of tests (`builder/tests/test_serving.py`).

`_CleanUrlHandler` fully REPLACES resolution rather than layering the `.html` fallback on
top of `SimpleHTTPRequestHandler`'s inherited directory handling: a real build subdirectory
with no matching page (`images/`) must 404, not redirect to a trailing slash and then serve a
directory listing — `resolve_site_path` never returns a directory, so the base class's
directory branch is never reached. Verified by `TestServeCommand::
test_real_subdirectory_with_no_matching_page_is_404_not_a_listing`, which is red without the
full-replacement design (a fallback-only patch over `translate_path` would 301+list `/images`
instead of 404ing it).

## What was decided — zero redirects, forever, in either direction

`/<slug>.html` keeps resolving alongside `/<slug>` permanently — no redirect from one shape
to the other anywhere in this stack. Two reasons, both hard constraints: (1) GitHub Pages
itself cannot be configured to redirect `/about.html` → `/about` (or the reverse) for a
static site with no server-side logic, so a wixy-side redirect would make `ca.cinnamons.uk`
disagree with the public Pages domain for the exact same URL — the server is deliberately
designed to always agree with what Pages actually does, never to diverge and "fix" it there;
(2) the canonical `<link>` (decisions/00126, shipped the same morning) already tells search
engines which shape is authoritative, so a redirect buys no SEO benefit large enough to
justify the disagreement. A hand-typed or previously-shared `.html` link — anyone's bookmark,
an old backlink, a not-yet-republished piece of content — simply keeps working, forever.

## What was decided — a trailing slash is a deliberate 404, not a directory index

`/about/` 404s on both the dev server and production, matching Pages exactly (verified live —
Pages has no directory-index fallback for a clean-URL page either). `resolve_site_path`'s
`.html`-append retry explicitly excludes any request path ending in `/`; this is now Inv 33
(`docs/ai/invariants.md`) specifically so a future "helpful" fix (redirecting or resolving the
trailing-slash form) gets caught before it ships and desyncs the server from Pages again.

## What was decided — the editor accepts both shapes; the header comment was simply wrong

`editor/src/navigation.ts:resolveInternalPageSlug` matched only `/<slug>.html` before this
change, with a header comment literally asserting that was "the ONLY shape the builder ever
emits" — true when written, false now. It now matches `/<slug>` OR `/<slug>.html` (the legacy
pattern is kept, not replaced, since legacy links must stay interceptable in preview too).
Checked the failure mode for a syntactically-plausible-but-not-real slug (e.g. an anchor to
bare `/images`): today, and unchanged by this PR, `resolveInternalPageSlug` has no way to
distinguish "a real page" from "any single path segment" — it's a pure syntactic match by
design (there's no page registry available client-side to check against). A bogus
`.html`-suffixed link already got this same imperfect treatment before this change (navigate-
attempt to a broken `/admin/preview/<bogus>.html`, not "external"); the new bare-slug pattern
now gets the identical treatment for the same reason. Real content never produces this case in
practice (asset paths appear in `<img src>`, not `<a href>`), and the failure mode is no worse
than the pre-existing one — the acceptance bar this PR was scoped to.

## What was decided — `/admin/preview/*.html` is unchanged, deliberately

That route is an internal admin/editor contract (`routes_preview.py`, `overlay.ts`,
`thumbnailService.ts`, e2e), never public URL surface — nothing about it changes here.

## What was discovered — the parity baseline captures hrefs too, and needed a real recapture

The originating brief asserted the parity harness "captures text + screenshots only (no
hrefs)" — checked against the actual code and found **false**: `builder/tests/parity/
compare.py:compare_page` calls `compare_links`, and `capture.py:capture_page` reads every
`a[href]`'s **resolved** `.href` (by design — see its own comment on why resolved-not-raw is
correct: "same destination", not byte equality). Since nav/CTA/footer hrefs are exactly what
`page_url` changed, the committed baseline (`builder/tests/parity/baseline/*/probe.json`)
would mismatch on `links` for every page the moment this shipped — and the site repo's own CI
(`validate-build-parity`, required, `--strict-screenshots`) runs this comparison against
wixy's committed baseline on every PR, so this was a real, would-have-failed-for-real gap, not
a hypothetical one.

Fixed the correct way — recaptured for real, on the pinned platform, via the workflow already
built for exactly this (`capture-baseline.yml`, `workflow_dispatch`, `ubuntu-latest`; the CLI's
own `--rebaseline` help text warns this must never run anywhere else, screenshot rasterization
differs by OS) — dispatched once, against this PR's wixy branch and the site-repo migration
branch together, so the baseline reflects the true final state (both the engine's nav-link
shape change AND the site repo's own content-href migration) in one recapture rather than two.
Deliberately did **not** make `compare_links` shape-tolerant instead (e.g. stripping `.html`
before comparing): that would permanently blind the comparison to a real future regression —
some page's link reverting to the old shape while the rest stayed clean — which is exactly the
class of bug this check exists to catch. A stale baseline is a one-time, fixable fact; a
weakened comparator is a permanent loss of coverage.

## What to watch for

- **Never add a redirect** between the two URL shapes anywhere in this stack (see "zero
  redirects" above) — it would make the server disagree with what GitHub Pages itself does for
  identical URLs.
- **Never "fix" the trailing-slash 404** into a 200/redirect (Inv 33) — same reasoning.
- If a future page-routing change touches `_resolve_within_build_dir` or `cmd_serve`'s
  handler, change `builder/serving.py:resolve_site_path` once — both callers share it.
- The parity baseline will go stale again the next time real page content changes
  meaningfully (an ordinary, expected lifecycle event, not specific to this change) —
  recapture via `capture-baseline.yml`, never by hand-editing `probe.json`/screenshots.
