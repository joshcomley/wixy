# 03 — Site repo migration (cottage-aesthetics-preview → CMS-managed source)

Goal: restructure `joshcomley/cottage-aesthetics-preview` into the template+content shape of
[02-content-model.md](02-content-model.md) with a **rendered-parity guarantee** — the built
site must look and read identically to the current site before any real editing features
matter. This is its own PR train in the SITE repo, developed against the builder from the
wixy repo.

## 1. Current state (verified 2026-07-05)

- Repo root: `about.html, aftercare.html, contact.html, faq.html, gallery.html, index.html,
  policies.html, reviews.html, treatments.html, site.css (13.8 KB), site.js (4.2 KB),
  images/ (15 jpg), .github/workflows/deploy.yml, .nojekyll` — deployed today via GitHub
  Pages.
- `site.js` **injects header, footer and the booking modal as JS strings** and wires:
  scrolled-header class, mobile menu, facesconsent booking iframe modal
  (`https://facesconsent.com/bookings/purdi-hadley`), Escape/overlay close, `.reveal`
  IntersectionObserver.
- `site.css` opens with a `:root` token block (colors + `--shadow`); fonts come from a
  Google Fonts `<link>` per page; `font-family` names are hardcoded throughout the CSS.
- `gallery.html` builds its before/after sliders + tiles from an inline JS array; the drag
  logic and lightbox are page-local JS.
- Pages carry stray inline `style="…"` attributes (e.g. contact address color, section
  backgrounds `style="background:var(--cream-2)"`).

## 2. Target layout (site repo)

```
cottage-aesthetics-preview/
  pages/
    index.html … policies.html      # templates, annotated with data-wx-*
  partials/
    header.html  footer.html  booking-modal.html
  content/
    _global.json  home.json  about.json  treatments.html→treatments.json  … (one per page)
  theme/
    theme.json
  images/                            # unchanged path (published as /images/*)
  site.css                           # tokens/:root REMOVED → generated theme.css
  site.js                            # behavior only (no header/footer/modal markup)
  CLAUDE.md                          # the AI-lane contract (see §6)
  todos/  decisions/                 # fleet conventions as work accrues
  .github/workflows/ci.yml           # validate + parity (replaces deploy.yml)
```

Published output (built by wixy) keeps **identical URLs**: `/`, `/<page>.html`,
`/images/*`, `/site.css`, `/site.js`, plus new `/theme.css`, `/sitemap.xml`, `/robots.txt`.

## 3. Migration steps (one PR each unless trivially combinable)

1. **Move pages under `pages/`**, add the two partial markers to each
   (`<!-- wx:partial header -->` after `<body …>`, `<!-- wx:partial footer -->` +
   `<!-- wx:partial booking-modal -->` before `</body>`), no other change. The builder at
   this point can produce a byte-faithful passthrough build (partials still empty shims) —
   this PR also lands the parity harness (§5) with its baseline captured from the
   pre-migration site.
2. **Extract partials from `site.js`**: recreate the header/footer/modal DOM as
   `partials/*.html` (server-injected), annotate with `@global` bindings (brand, nav via
   `data-wx-list`, footer columns, phone/email/social, booking URL as
   `<body data-booking-url="…">` bound with `data-wx-href="@bookingUrl"`), and slim
   `site.js` to behavior only (scrolled class, menu toggle, modal open/close reading
   `data-booking-url`, reveal observer). Nav active-state: builder adds `class="active"`
   to the nav item whose href matches the page being built (static, replaces the JS
   `data-page` comparison; `data-page` stays on `<body>` for CSS/JS hooks).
3. **Annotate + extract, page by page** (order: index, about, treatments, gallery, faq,
   reviews, contact, aftercare, policies): add `data-wx-*` attributes, create
   `content/<page>.json` with today's exact copy (including `meta.title`/`description`
   pulled from each page's head), convert the six collections (02 §6), convert the gallery
   JS array into `data-wx-list` markup + JSON with the slider/lightbox JS reading the DOM.
   Replace theme-fighting inline styles with classes while extracting (e.g. an `alt`
   section-background class instead of `style="background:var(--cream-2)"`) — computed
   styles must not change.
4. **Theme extraction**: move the `:root` block into `theme/theme.json` (02 §4); replace
   hardcoded `font-family` literals in `site.css` with the three font vars; pages get the
   `theme.css` link before `site.css`; the Google Fonts link becomes builder-generated.
5. **Retire GitHub Pages**: delete `deploy.yml` + `.nojekyll`, add `ci.yml` (§7). Do this
   LAST, only after ca.cinnamons.uk serves the parity-verified build (07). Note in the PR
   description that the GH Pages URL will go stale intentionally.

Each step keeps `builder validate` green and parity green — the site repo is never in a
state the builder can't build.

## 4. `site.js` after migration

Keep it dependency-free vanilla JS (it ships to the public site; no build step for site
assets in v1 — the file is small and stable). It MUST NOT contain any content strings.
Behavior inventory to preserve: header scrolled state at 60px, mobile menu toggle + close
on link tap, booking modal (lazy iframe src set on first open, body scroll lock, Escape +
backdrop + × close), `.reveal` IntersectionObserver (threshold 0.12, unobserve after), the
gallery drag-slider + filter + lightbox (page-local, moved to reading DOM), FAQ pages'
native `<details>` behavior.

## 5. Rendered-parity harness (the migration's safety net)

Lives in the wixy repo (`builder/tests/parity/`), runnable against any site-repo checkout:

1. **Baseline capture** (one-time, step-1 PR): headless Playwright loads each of the 9
   pages from the pre-migration static files (`file://` is not enough — serve via
   `http://127.0.0.1` static server so JS injection runs), waits for network idle + fonts,
   then records per page: (a) normalized visible text content of `<body>` (whitespace-
   collapsed, after JS injection), (b) the set of `(text, href)` link pairs, (c) every
   `<img>`'s resolved `src` + natural dimensions, (d) `getComputedStyle` snapshot
   (color, background-color, font-family, font-size, font-weight) for a fixed selector
   sample list (~15 selectors/page covering hero/heading/body/buttons/footer), (e) a
   full-page screenshot at 1280×; and at 390× (mobile) for index + treatments.
2. **Parity check** (every CI run thereafter): build the site with the current builder,
   serve the build, capture the same probes, and assert: text equal, link set equal, image
   set equal, computed-style sample equal (exact), screenshots within a 1% pixel-diff
   budget (antialiasing tolerance). Console errors = failure. The baseline is committed
   (JSON + PNGs) to the wixy repo under `builder/tests/parity/baseline/`.
3. When a HUMAN-approved intentional visual change lands later (post-migration life), the
   baseline is re-captured via `python -m builder.parity --rebaseline` in the same PR — the
   diff shows exactly what changed.

Playwright runs headless against localhost here (the global headed-browser rule governs
*web lookups*, not local test harnesses).

## 6. Site repo `CLAUDE.md` (written in step 1, kept current)

This is the contract every AI-lane chat inherits. It MUST cover, concisely:

- What the repo is; that it is **served by Wixy at ca.cinnamons.uk**, built by the wixy
  builder — with a pointer to the wixy repo spec (`spec/02-content-model.md`) as the
  binding contract.
- The `data-wx-*` binding rules and the strict no-unbound-user-visible-text rule.
- Copy lives in `content/*.json`; structure in `pages/` + `partials/`; theme in
  `theme/theme.json`. Which to edit for which kind of request.
- **Never publish, never deploy**: agents ship to `main` only (branch → PR → auto-merge
  per the fleet's global rules); the site owner presses Publish in Wixy. Publishing pins a
  SHA — merging to main is invisible to the live site until then.
- Run `python -m builder validate` and the parity/CI suite before shipping; never commit a
  broken build. How to preview locally (`python -m builder serve` from a worktree).
- Brand/voice guardrails (from `brief.md` / `docs/DESIGN-AND-CONTENT.md` in the wixy repo,
  distilled): calm, understated, never salesy; British English; the prescription-only
  pricing must stay ≥2 clicks from the homepage; **never publish client photos or reviews
  that lack recorded consent/permission** (gallery images all carry consent notes; Google
  reviews page exists with the owner's knowledge — new such content needs explicit owner
  sign-off in the chat).
- Where images live + the upload conventions (02 §9), and that oversized images must be
  downscaled before commit (tooling exists in the wixy repo `tooling/downscale_photos.py`).

## 7. Site repo CI (`ci.yml`)

On every PR + push to main: checkout site repo + checkout wixy repo @ main (public repos —
plain `actions/checkout` with `repository:`), `pip install` wixy's builder package, run
`python -m builder validate` and `python -m builder build`, then the parity check headless.
Required check for merging. This is what makes the AI lane safe: an agent physically cannot
merge a change that breaks the build contract (and per fleet rules it must not bypass
checks).

## 8. Repo rename (deferred, non-blocking)

`cottage-aesthetics-preview` is no longer a "preview". Renaming to `cottage-aesthetics` is
deliberately deferred until after the build ships (GitHub redirects make it cheap later; a
mid-build rename risks confusing in-flight clones/registrations for zero functional gain).
Tracked in the wixy repo todos, not part of this build.
