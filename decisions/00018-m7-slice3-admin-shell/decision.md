# Milestone 7 slice 3: the admin shell

## Context

Third slice of the M7 PR train (decisions/00015): `admin-ui/src/` — hash router, top
bar, left nav, pages panel, edit-mode iframe host wired to slice 1's `OpQueue` and
slice 2's overlay protocol, page settings drawer. This is the first point in the whole
milestone where a genuinely complete, servable end-to-end page exists — decisions/00013
and 00017 (decision 8) both explicitly deferred real browser verification until this
slice, "owed once slice 3 exists." It was owed, done here, and it found three real
bugs/gaps left over from earlier slices that no amount of unit testing against jsdom
fixtures could have caught, plus one this slice's own first backend consumption of the
provisional bindings-map surfaced. All four are root-cause fixed in this same PR, not
deferred further, per this repo's own "verify in a browser, fix what's broken" rule and
the fleet's no-stopgap posture.

## Decisions

**1. The admin shell owns the ONE `OpQueue` for the whole session (spec/05 §2: "the
shell owns state") — panels never construct their own, and it is NEVER torn down or
remounted on background state refresh.** Constructed once, seeded with `draft.rev`,
on the first successful `/api/admin/state` load. The critical bug this avoids: naively
remounting the edit panel (and therefore its iframe) every time `/api/admin/state` is
refetched — e.g. after every accepted PATCH batch, to update the draft-status chip —
would tear down and reload the live iframe on every accepted keystroke batch. Fixed by
splitting state loading into `loadState()` (first load + routing bootstrap, runs once)
and `refreshStateInBackground()` (top-bar data only, called after every accepted batch,
never touches routing or the mounted panel).

**2. `editView.ts` is split into a pure-ish message-routing CORE
(`createEditViewCore`) and a thin DOM-mounting wrapper (`mountEditView`), mirroring
`editor/src/overlay.ts`'s own internal-handler/DOM-coordinator split.** Neither jsdom's
`<iframe>` nor its cross-document `postMessage` is reliable enough to unit-test the
real DOM wiring directly; the core takes injected `postToOverlay`/`loadPage`/
`onOverlayNavigated` callbacks and is fully testable without a real iframe at all
(`editView.test.ts`). The core also guards a real async race: a `ready` message's
content fetch can be in flight when a NEWER navigation (`setPage` or an overlay-driven
`navigate`) supersedes it — a `loadToken` counter, bumped on every navigation and
checked when the fetch resolves, discards a since-stale `init` rather than sending it
to whichever page now happens to be loaded in the iframe.

**3. Navigating between two DIFFERENT `#/edit/<page>` routes reuses the SAME mounted
edit view via `setPage`, rather than tearing down and recreating it.** This matters for
one specific case: when the overlay reports it navigated internally (an intercepted
content-link click, decision 5), the shell updates `location.hash` in response — which
re-enters the router — and that re-entry must NOT recreate the iframe (it already
navigated itself) or race its own in-flight load. `shell.ts`'s route handler special-
cases edit-to-edit transitions; `core.setPage`/`EditView.setPage` are additionally
self-guarding (no-op if already on that page) as a second layer, not just relying on
the shell getting the special-case right.

**4. `OpQueueLike` — a narrow structural interface (`{readonly rev, enqueue()}`) —
is what `editView.ts`/`pageSettingsDrawer.ts` actually depend on, not the concrete
`OpQueue` class.** `OpQueue` has private fields, which makes a plain test-fake object
literal structurally incompatible with the class type even though it implements every
PUBLIC member correctly; depending on the narrow interface both documents the real
dependency surface and lets tests construct a queue fake without touching `OpQueue`'s
internals. The real `OpQueue` instance built in `shell.ts` satisfies it without change.

**5. Internal/external link interception — spec/05 §2's "the overlay rewrites
internal link clicks to the preview equivalent and notifies the shell... external
links are inert (toast)" — did not exist anywhere in slices 1-2, despite being core
"Edit mode" behavior, not a peripheral one.** Neither decisions/00015 nor 00017 flagged
it as deliberately deferred (unlike page duplicate/delete, drag-reorder, the page-
picker — all explicitly reasoned about); it had simply fallen through the slice
boundaries (slice 2's own scope list didn't mention it; slice 4 is "full integration
wiring + E2E 8," and E2E 8 doesn't exercise it either). Built here
(`editor/src/navigation.ts` + a `handlePlainAnchorClick` branch in `overlay.ts`,
reached only for anchors `closestBoundElement` didn't already claim as an EDITABLE
`data-wx-href` binding): a same-origin link matching `builder.nav.page_url`'s own URL
convention (`/` or `/<slug>.html`) is rewritten to `/admin/preview/<slug>.html` and the
shell is told via a `navigate` message; anything else shows a toast and is inert. This
was necessary, not optional, to do BEFORE finishing this slice's own browser
verification — without it, clicking any real nav/footer link while exploring the admin
in a real browser (exactly what verification requires) would have escaped edit mode
entirely.

**6. Discovered while wiring #5: the preview document needed a `<base href="/">`, a
real M6 bug no unit test could have caught.** `builder`'s templates emit the site's own
asset/internal-link URLs as relative to the site ROOT (`site.css`, `theme.css`,
`images/x.jpg`, and even some hand-authored page links like `about.html` — verified via
`curl` against a live preview render, not assumed) — correct when the built output is
served AT the root (the published site), silently wrong when the identical HTML is
served at `/admin/preview/{page}.html` (the preview route): every relative reference
resolves one directory too deep and 404s/503s. `wixy_server/preview.py` now injects
`<base href="/">` as the first child of `<head>`, before any other tag, so every
relative URL in the document — asset links AND bare relative page links alike — resolve
against the site root exactly as a real browser would. This is why decision #5's
`resolveInternalPageSlug` resolves relative hrefs against `origin + "/"` rather than
the current window path: it has to agree with what the `<base>` tag makes a real click
actually navigate to, not a nicer-looking approximation. A `<base>` tag also changes
how the browser resolves BARE FRAGMENT links (`href="#contact"`) — without a guard they
would resolve to `/#contact` (a real navigation to a different page) instead of staying
on the current page and scrolling — `resolveInternalPageSlug` special-cases any href
starting with `#` before it does anything else. Verified directly: `curl`'d the raw
preview HTML before AND after, confirmed via the running dev server's own access log
that `theme.css`/`site.css`/`site.js`/`images/*` requests changed from
`/admin/preview/theme.css` (503) to `/theme.css` (200 once a live build existed) — real
evidence, not theorized.

**7. Also discovered while browser-verifying: slice 2's `handleIfToggleClick` had a
listener with nothing to click.** The delegated click handler (`.closest(
".wx-if-eye-toggle")` → `.closest("[data-wx-if]")`) was correct and tested, but nothing
in production code ever INSERTED that button into a real rendered page — only the
tests' own hand-written fixture markup included one. `overlay.ts` now scans
`document.querySelectorAll("[data-wx-if]")` once at `initOverlay()` startup and inserts
an idempotent eye-toggle button as a CHILD of each (not a `document.body`-mounted
floater like the hover chip/item toolbar — it has to be a real descendant for the
existing `.closest("[data-wx-if]")` lookup to keep working), with `editor/src/style.css`
showing it only while the element actually carries `data-wx-hidden`. A new guard line
in `handleClick` (`if (event.target.closest(".wx-if-eye-toggle") !== null) return;`)
stops the bound-element click router from ALSO firing when the toggle sits inside an
element that's simultaneously if-bound and href-bound (the real fixture's CTA pattern) —
found by writing exactly that test case and watching it fail before the guard existed.

**8. `editor/src/style.css` and `admin-ui/src/style.css` didn't exist before this
slice — the preview route already linked `EDITOR_STYLESHEET_PATH` (M6) and
`editor.js`'s hover/popover/toolbar chrome already referenced classes like
`wx-hover-outline`/`wx-popover`/`wx-item-toolbar` (M7 slice 2), but no CSS file backed
any of it.** Both are real, spec-driven (05 §2's literal "2px, brand blue, 4px radius"
etc.) stylesheets now, esbuild-bundled the same way as the JS (a second `esbuild.build`
call per package, CSS-only entry point, minified+sourcemapped, self-hosted — no CDN,
no preprocessor needed for either file's size). `admin_shell.html`'s pre-JS loading
screen CSS was re-scoped from the `#wx-shell` id itself to a `.wx-loading-wrap` child
(with the loading markup wrapped in that div) specifically so it stops fighting
`admin-ui`'s own `.wx-shell` layout rules once `main()` replaces the loading markup —
an ID selector beats a class selector regardless of which stylesheet loads later, so
leaving the original id-scoped rule in place would have silently overridden the real
shell's `flex-direction`/layout once JS took over.

**9. `pageSettingsDrawer.ts`'s ogImage field is a minimal pick-from-existing-repo-
media list (`GET /api/admin/media`, already built in M6), not the real upload-capable
media dialog spec/05 §4 describes.** The real dialog (drag-drop upload, references
scan, staged-draft badge, alt-text-required-unless-decorative-checkbox) is explicitly
milestone 8's job; this ships a genuinely working "choose an existing image + set alt
text" flow now rather than a placeholder, using API surface that already exists — not
a stand-in that needs rebuilding later, just extending.

**10. `/api/admin/state`'s pages list gained a `lastModified` field (`null`, or the
newest draft-overlay-op timestamp touching that page) — spec/05 §2 lists it as a
pages-panel column M6's subset never had to build until this slice became its first
real consumer.** There is no other last-modified signal until milestone 9's publish
ledger exists; this is honest about that (draft-only, `null` with no edits) rather than
inventing a git-mtime fallback the spec doesn't ask for.

**11. The pages panel's `#/pages` route lists every real page; the left nav's "Edit"
slot is a non-interactive indicator (shows "Edit: `<page>`" only while actually in
edit mode), while Theme/Media/Chat/History ARE real clickable nav destinations that
render a "coming in a later milestone" panel.** Spec/05 §1's ASCII shell diagram lists
"Edit" as a nav row alongside Pages/Theme/Media/Chat/History, but there is no bare
`#/edit` route (editing always needs a page slug) and no other source of "which page"
to point it at outside of actually being in edit mode already — treating it as a
live status indicator rather than an always-clickable link is the only reading that
doesn't invent a destination the spec doesn't define elsewhere. Small, own-call,
logged here rather than asked about, per this chain's "decide the small things
yourself" mandate.

## Verification

`editor`: `tsc --noEmit` clean, `vitest run` — 102 tests (up from 85; +17 covering the
eye-toggle auto-injection, the CTA-pattern non-conflict, and internal/external link
navigation, including the fragment-guard). `admin-ui`: `tsc --noEmit` clean, `vitest
run` — 76 tests across 9 files (router, api incl. retry/backoff with fake timers,
pagesPanel, editView core, pageSettingsDrawer incl. `readMeta`, shell integration with
a fake API/window/edit-view). Both bundles rebuilt three times to confirm stability
(decisions/00016's trap); `git status` identical after the 2nd and 3rd rebuild. `wixy`:
`pytest` 335 passed (up from 331; +4 covering `lastModified` and the `<base>` tag),
`mypy --strict` clean (74 files), `ruff check`/`format --check` clean.

**Real browser verification** (the thing owed since decisions/00013): a throwaway local
dev server (`create_app` pointed at a fresh Storage root + this wixy checkout, real
`git clone` of the actual public CA repo — not a synthetic fixture) driven with
Playwright/Chromium. Confirmed end-to-end against REAL Cottage Aesthetics content: pages
panel lists all 9 real pages with correct meta; Edit navigates and mounts a real iframe
loading `/admin/preview/index.html` with the real overlay injected; hovering a bound
element shows the outline+chip; clicking opens a real popover; committing an edit
updates the live DOM AND is confirmed persisted server-side (`GET /api/admin/state`
showed `draft.rev` incrementing, `GET /api/admin/content/index` showed the new value);
the device toolbar resizes the iframe; the page settings drawer loads real `meta.*`
values. A full pass with a real PUBLISHED build in place (built via `python -m builder
build` + a hand-written `live.json`, so the preview page's own site.css/theme.css/
images load instead of 503ing pre-publish) produced ZERO console errors and ZERO page
errors across the whole flow. Screenshots taken at each step; visually confirmed the
hover chrome, popover, and device toolbar render correctly against fully-styled real
content (fonts, photography, brand colors) — not just functionally, visually.

**Not fixed here, deliberately out of scope**: the "Before &amp; After" nav label
displaying its HTML entity literally in the pages panel — the CA repo's own
`content/gallery.json` stores the literal string `"Before &amp; After"` (verified: the
built HTML source contains it too, so a real browser decodes it correctly as "&" when
the ORIGINAL template injects it unescaped; this admin panel column correctly uses
`.textContent`, which does not decode entities in a stored string). This is a CA
content-data quality artifact from the M3/M4 migration, not a wixy bug — noted here so
it isn't silently rediscovered, not actioned (out of scope for the wixy repo, and
cosmetic).

## What to watch for

- The eye-toggle auto-injection (decision 7) was verified against real content that
  happened to have NO currently-falsy `data-wx-if` sections on the pages exercised —
  the unit tests (`overlay.test.ts`) are what actually prove the mechanism works;
  the browser pass confirms zero toggles were WRONGLY injected/visible, not that a
  real one was clicked end-to-end. Worth a specific look once a page with a genuinely
  hidden section is edited for real.
- `pageSettingsDrawer.ts`'s media picker (decision 9) has no "click outside to
  dismiss" — acceptable for a minimal stand-in, revisit if M8's real dialog doesn't
  simply replace this code outright.
- Slice 4 (E2E 8 as a real Playwright test, full CI green, closing decision) is next;
  nothing in this slice's own scope was deferred within M7 itself.
