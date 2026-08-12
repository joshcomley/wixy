# Cottage Aesthetics search-indexing implementation brief

**Prepared for:** Claude Sonnet 5 implementation lane<br>
**Prepared:** 12 August 2026<br>
**Public site:** <https://cottageaesthetics.co.uk/><br>
**Wixy staging/admin host:** <https://ca.cinnamons.uk/><br>
**Engine repository:** `joshcomley/wixy`<br>
**Site repository:** `joshcomley/cottage-aesthetics-preview`

This is a handover document. Treat the measured facts below as the baseline, but re-run the
relevant checks immediately before and after each change. The work spans two repositories and
must preserve Wixy's core rule: an agent may merge work to the site repository's `main`, but
only the owner pressing **Publish** in Wixy may move that work to the public website.

## Mission

Improve Cottage Aesthetics' ability to be discovered, understood, and efficiently rendered by
Google, Bing, and other standards-based search engines without weakening the staging/admin
boundary, inventing medical or business claims, bypassing the owner's Publish gate, or making
the generic Wixy engine Cottage-Aesthetics-specific.

Deliver this as a small, reviewable PR train. The first release should fix the high-confidence
technical issues. Later content expansion may be prepared by the agent, but it remains a draft
until Purdi has checked the clinical wording and explicitly publishes it.

The outcome is not “guaranteed rankings”; nobody can promise that. The outcome is:

1. search engines can crawl the public canonical URLs and are given coherent signals;
2. meaningful URLs from the retired Wix site lead users and crawlers to equivalent content;
3. the site exposes accurate brand and local-business identity data plus a favicon;
4. the mobile experience no longer delays primary content or downloads the full gallery up
   front;
5. high-value treatments can gain genuinely useful, non-duplicative landing pages after owner
   review; and
6. every change has deterministic tests, live evidence, documentation, and a safe rollback.

## Current state

### Public site — healthy foundations

The audit on 12 August 2026 found:

- `https://cottageaesthetics.co.uk/` returns `200` over HTTPS.
- `http://`, `www`, and HTTP+www variants permanently redirect to the HTTPS apex.
- `robots.txt` allows crawling and references the public sitemap.
- `sitemap.xml` lists nine canonical URLs: `/`, `/about`, `/aftercare`, `/contact`, `/faq`,
  `/gallery`, `/policies`, `/reviews`, and `/treatments`.
- All nine sitemap URLs return `200` and have a unique title, unique description, one H1, a
  self-referencing canonical, and crawlable static body content.
- Internal links and 123 sampled local assets returned successfully; no mixed content was
  found.
- Browser, Googlebot, and Bingbot user agents received equivalent content.
- A Google DNS verification record already exists:
  `google-site-verification=yLSyZnTI0wT5e2CGeoAuz34B7yVQvuvMkhm_ENvEf_o`.
- Sampled public searches did not yet surface the new domain. The domain cutover happened only
  on 10–11 August, so Search Console and Bing Webmaster Tools are the authoritative sources;
  absence from a few public searches is not proof of an indexing fault.

### Public site — gaps to address

- No JSON-LD structured data was detected.
- No favicon link was detected and `/favicon.ico` returned `404`.
- The retired Wix paths `/home`, `/book-online`, `/cart-page`, and
  `/english-privacy-policy` currently return `404` on the GitHub Pages site.
- The public host is GitHub Pages. Wixy's runtime `WIXY_REDIRECTS_FILE` 301 map is therefore
  irrelevant to that public request path; a server-only redirect change would pass staging
  tests while leaving production broken.
- Both `/<slug>` and `/<slug>.html` intentionally return `200`, with canonical tags pointing
  at `/<slug>`. This is Wixy invariant 33 and must not be “fixed” into a redirect.
- Social-preview metadata was incomplete on the deployed build, but Wixy commit `d318cd4`
  already added `og:site_name`, `twitter:card`, and image alt/dimensions. The next owner
  Publish should pick that up; do not duplicate that work.

### Measured mobile performance baseline

Lighthouse mobile runs from the public origin produced these approximate results. Treat the
exact scores as noisy and the underlying causes/bytes as the useful baseline.

| Page | SEO | Performance | FCP | LCP | Transfer / requests | Main finding |
|---|---:|---:|---:|---:|---:|---|
| Home | 100 | 66 | 3.2 s | 9.6–9.8 s | 1.531 MiB | H1 is hidden by `.reveal` until IntersectionObserver runs; large images and render-blocking fonts/CSS |
| Gallery | 100 | 77 | 3.2 s | 4.6 s | 13.558 MiB / 114 | roughly 106 images are present and the before/after pairs are eagerly loaded |

The homepage audit estimated about 1.13 MiB of avoidable image transfer. Multiple rendered
images lack intrinsic `width` and `height`. The homepage's LCP candidate was text, not the
hero background: `.reveal { opacity: 0; transform: ...; transition: .8s }` delays the H1.

### Staging index controls conflict with crawler behaviour

`https://ca.cinnamons.uk/` currently emits all three of these signals:

- `robots.txt`: `Disallow: /`
- per-page `<meta name="robots" content="noindex">`
- no `sitemap.xml`

Google's current documentation says a crawler must be able to fetch a page to observe its
`noindex` rule. If `robots.txt` blocks the page, the URL can still appear without a snippet
when other pages link to it. The original Wixy spec deliberately combined the crawl block and
`noindex`, so correcting this is a reality-versus-spec decision, not a drive-by one-line edit.

Authoritative reference:
<https://developers.google.com/search/docs/crawling-indexing/block-indexing>

### Relevant code and repository surfaces

Engine:

- `builder/sitemap.py` — current indexable/non-indexable `robots.txt` output.
- `builder/templates.py` — canonical, robots, Open Graph, and social head injection.
- `builder/render.py` and `builder/bindings.py` — binding and post-binding render pipeline.
- `builder/build.py` — full static output, assets, robots, sitemap, 404, and self-check.
- `builder/imagesize.py` — existing stdlib image-dimension probe.
- `builder/nav.py` and `builder/serving.py` — canonical URL emission versus wider URL
  resolution; preserve invariant 33.
- `wixy_server/redirects.py` and `wixy_server/routes_public.py` — server-side redirect map,
  useful for Wixy/standalone hosts but not GitHub Pages.
- `projects/ca.json` — staging domain and `indexable: false`.
- `spec/02-content-model.md` §7, `spec/07-hosting-deploy.md` §4–5, and
  `spec/independence/01-architecture.md` — currently decided indexing and redirect intent.
- `docs/ai/builder.md`, `docs/ai/invariants.md`, `docs/ai/runbook.md`, and
  `docs/ai/serving-and-overlay.md` — code-reality documentation that must move with public
  contract/config changes.

Site repository (open it through its own cmd project/worktree; never edit
`D:\Servers\Wixy\Storage\projects\ca\repo` or any deployment checkout):

- `pages/index.html` — above-fold `.wrap.reveal` currently contains the H1.
- `pages/gallery.html` — slider images at the current lines around 126–127 lack lazy hints;
  gallery tiles already author `loading="lazy"`.
- all `pages/*.html` — appropriate home for site-specific head markup if no generic engine
  feature is justified.
- `site.css` and `site.js` — reveal behaviour.
- `content/_global.json` and per-page `content/*.json` — source-of-truth business and page
  content.
- `images/` — original published media and any favicon/optimised derivatives.
- `.github/workflows/pages.yml` — public GitHub Pages build; currently calls
  `python -m builder build --domain "$WIXY_PUBLIC_DOMAIN" --indexable true` from the
  owner-controlled `wixy-live` ref.
- the site repository's own `CLAUDE.md` and decision log — read before changing anything.

## Decisions made

These decisions are part of the handoff. Do not reopen them unless on-disk or live evidence
contradicts them.

1. **Split authority, not responsibility.** The agent owns code, tests, documentation,
   evidence collection, draft content, and PRs. A human owns authenticated console actions,
   Business Profile changes, review of clinical claims, aesthetic approval of a new favicon,
   and the final Wixy Publish action.
2. **Fix technical correctness before adding content.** Staging controls, legacy URL signals,
   structured identity, favicon, and the first performance pass precede new treatment pages.
3. **Keep public hosting on GitHub Pages for this work.** Do not introduce a reverse proxy or
   DNS/CDN migration merely to obtain HTTP 301s. If an eventual owner-controlled Cloudflare
   deployment supplies real 301s, it can supersede the static fallback later.
4. **Be honest about GitHub Pages redirects.** A zero-delay HTML meta refresh is a redirect
   signal and usable fallback, not an HTTP 301. Name it accurately in code, docs, tests, and
   the final report.
5. **Only map equivalent retired content.** Use `/home` → `/`, `/book-online` →
   `/treatments`, and `/english-privacy-policy` → `/policies`. `/about` and `/contact`
   already resolve at their old paths. Leave the unrelated Wix cart template `/cart-page`
   as a genuine `404` unless Search Console evidence demonstrates a valuable equivalent;
   redirecting unrelated URLs to the homepage risks being treated as a soft 404.
6. **Preserve clean-URL invariant 33.** Do not redirect `.html` URLs and do not make trailing
   slash URLs resolve. Legacy aliases are a separate, explicit map.
7. **Correct staging by making `noindex` observable.** The recommended implementation for a
   publicly reachable staging site is: crawl allowed, no sitemap emitted, every HTML page and
   the generated 404 carry `noindex`. If the team instead chooses authentication, it must
   cover the entire staging public surface and be demonstrably usable by the owner; do not
   claim that `robots.txt` provides privacy.
8. **Record the spec conflict.** Because the base spec explicitly decided Disallow-all plus
   `noindex`, the engine PR must add a decision entry and update the normative spec sections,
   operator docs, invariants as appropriate, and tests in the same PR.
9. **Keep business facts in the site repository.** Generic metadata mechanics may belong in
   Wixy, but address, telephone, hours, social accounts, treatments, and public-domain identity
   are site data. Do not hard-code Cottage Aesthetics strings in a generic builder code path.
10. **Use only visible, accurate structured data.** Do not invent awards, credentials,
    coordinates, price ranges, ratings, service areas, or medical claims. Do not add
    self-serving `Review`/`AggregateRating` markup for the clinic's own testimonials.
11. **Prefer the smallest structured-data mechanism that remains correct on both domains.**
    `WebSite` belongs on the homepage and should use the build's domain. Local-business data
    can be supplied from site-owned data or authored markup, but it must render the public
    canonical URL on the public build and must not require duplicating owner-editable facts
    without a drift test.
12. **Performance must fail open.** Primary copy must remain visible if JavaScript is disabled,
    delayed, or errors. Reveal animation is decoration; it must never gate the H1 or other
    indexable content.
13. **Do not silently recompress irreplaceable originals.** Responsive derivatives may be
    generated, or source images may be intentionally replaced after visual comparison, but
    preserve source/rollback history in git and show the owner material visual changes before
    Publish.
14. **Clinical copy remains an owner gate.** Agent-created treatment pages must be based on
    existing site facts and reputable primary clinical sources where needed, clearly mark
    unresolved factual gaps, and wait in Wixy's draft preview for Purdi's approval.
15. **No direct production edits.** Work in cmd-created worktrees, PR to the appropriate
    repository, merge only on green checks and required review, and allow the Wixy Publish
    mechanism to deploy site changes.

## Files changed

The planning lane changed only documentation and durable task records:

- `docs/search-indexing-implementation-brief.md` — this agent handover.
- `docs/search-indexing-console-guide.html` — the human-only console/review walkthrough.
- `todos/TODO-00027.md` and its task sidecars — traceability for the audit and handoff.

No production engine or site code has been changed by the planning lane.

## Open items

### Work package 0 — establish a reproducible baseline

Do this before editing. Store concise evidence in the first PR description or a checked-in
report if the repository convention supports it.

1. Read the complete current spec entry points and the relevant `docs/ai/` manuals before
   editing. Read the site repository's own instructions in full.
2. Confirm both repositories' clean/dirty state and preserve unrelated user changes.
3. Re-run:
   - public/staging status, canonical, robots, sitemap, and structured-data checks;
   - legacy URL requests;
   - a mobile Lighthouse run for `/` and `/gallery` using the same preset;
   - a count of public gallery `<img>` elements and those with `loading`, `decoding`,
     `width`, and `height`.
4. Capture exact command versions and the current public/site SHA.
5. Verify the already-merged social metadata appears after the next available owner Publish;
   if it does, close that audit item rather than reimplementing it.

Acceptance:

- baseline evidence includes timestamps, URLs, public/site SHA, Lighthouse JSON, and raw
  counts—not screenshots alone;
- no mutations have occurred in a runtime or Slots checkout.

### Work package 1 — make staging `noindex` observable

Recommended implementation shape:

1. Change the non-indexable `robots.txt` policy from a crawl block to an allow policy with no
   sitemap directive. Keep per-page `noindex` and keep `sitemap.xml` absent.
2. Ensure generated `404.html` remains `noindex` for a non-indexable build.
3. Add tests that prove:
   - non-indexable robots does not block `/`;
   - non-indexable HTML contains one effective `noindex` directive;
   - non-indexable builds omit `sitemap.xml`;
   - indexable builds still allow crawling, emit the sitemap directive/file, and do not emit
     `noindex`;
   - deterministic output is unchanged apart from the intended bytes.
4. Add a decision entry explaining why Google cannot apply a blocked page's `noindex` and why
   staging remains public-but-non-indexable rather than private.
5. Update `spec/02-content-model.md`, the stale cutover language in
   `spec/07-hosting-deploy.md`, `docs/ai/builder.md`, `docs/ai/runbook.md`, tests docs, and
   any affected invariant.
6. Before committing a public config/behaviour change, obtain the repository's current
   aim-doc maintenance rules. Escalate the spec contradiction/architecture choice through the
   required consultation lane and run the required audit before merge.

Live acceptance on `ca.cinnamons.uk` after the engine deploy and an appropriate site rebuild:

- `robots.txt` does not disallow the staging pages;
- all staging HTML pages and the staging 404 contain `noindex`;
- staging `sitemap.xml` remains `404`;
- public `cottageaesthetics.co.uk` remains indexable and its nine-URL sitemap remains intact;
- no admin/API authentication surface changed.

### Work package 2 — preserve meaningful retired Wix paths on GitHub Pages

First investigate the narrowest generic mechanism. The recommended direction is an optional
static-redirect input to the builder, used explicitly by the site's GitHub Pages workflow,
rather than pretending the runtime 301 map affects Pages.

Candidate design to validate:

1. Add an explicit optional builder CLI input such as `--static-redirects-file` pointing at a
   flat JSON map owned by the site repository.
2. Validate source paths and output paths against traversal, collisions with real pages/assets,
   loops, malformed values, and ambiguous trailing-slash or `.html` forms. Keep deterministic
   ordering.
3. For each accepted legacy source, generate the `.html` file shape GitHub Pages resolves for
   its extensionless request. It should contain:
   - a zero-delay `meta http-equiv="refresh"` target;
   - a canonical link to the destination;
   - a normal crawlable link and plain-language fallback;
   - minimal valid, accessible HTML;
   - no inclusion in the sitemap or navigation.
4. Reuse a small generic parser/validator with `wixy_server.redirects` only if this genuinely
   reduces duplicate contract logic without coupling `builder` to the server. Do not weaken
   the server's fail-fast configuration behaviour.
5. Add a site-owned redirect map containing exactly:

   ```json
   {
     "/book-online": "/treatments",
     "/english-privacy-policy": "/policies",
     "/home": "/"
   }
   ```

6. Pass it explicitly in `.github/workflows/pages.yml` for the public build. Decide separately
   whether the staging Wixy host should load the same map; public parity is useful, but do not
   make an unconfigured runtime dependency.
7. Update CLI/config contracts, spec, `docs/ai/`, site docs, and both repositories' tests.

Tests/acceptance:

- unit tests cover successful generation, escaping, traversal, collision, loop, bad JSON,
  external-target policy, and deterministic output;
- the normal builder with no option emits no alias files and stays backwards-compatible;
- sitemap still contains only canonical content pages;
- GitHub Pages' deployed `/home`, `/book-online`, and `/english-privacy-policy` load and move a
  real browser to the intended canonical page;
- raw HTTP evidence accurately records that GitHub Pages serves an HTML fallback rather than a
  301;
- `/cart-page` stays a styled 404;
- `/<slug>.html` behaviour and trailing-slash behaviour remain exactly as invariant 33 defines.

Relevant Google guidance on redirects:
<https://developers.google.com/search/docs/crawling-indexing/301-redirects>

### Work package 3 — add site identity structured data and a favicon

Split mechanics from site data.

1. Add one `WebSite` JSON-LD node on the homepage, with `name: "Cottage Aesthetics"` and a URL
   derived from the active build domain. If the engine injects it generically, it must do so
   only for the root/home page and must remain valid for every project.
2. Add one accurate local-business node on a page that visibly contains the business details,
   preferably the homepage graph or contact page. Use the most defensible Schema.org subtype
   after checking the current vocabulary and Google support; do not label the business a
   regulated medical clinic unless the visible/legal facts support that classification.
3. Source values from the site repository. Currently visible facts available for validation
   include:
   - name: Cottage Aesthetics;
   - canonical URL: `https://cottageaesthetics.co.uk/`;
   - telephone: `07401 562 462` / machine form `+447401562462` after verification;
   - email: `cottageaestheticshartlebury@gmail.com`;
   - address: Cottage Aesthetics, 8 Walton Road, Hartlebury, Kidderminster, DY10 4JA, GB;
   - opening hours from `content/_global.json`;
   - Facebook and Instagram URLs from `content/_global.json`;
   - booking URL: `https://facesconsent.com/bookings/purdi-hadley`.
4. Do not add empty coordinates, inferred prices, aggregate ratings, or review markup.
5. Create a stable square favicon that is recognisably on-brand at 16 px and at least 48×48
   at source. Prefer a simple mark over a tiny wordmark. Generate standard browser variants if
   useful, add explicit `<link rel="icon">` markup, and ensure Googlebot-Image can fetch it.
6. Produce a visual artifact showing the favicon at 16, 32, 48, and 128 px for human approval
   before the final site Publish.

Validation/acceptance:

- JSON parses and has no duplicate/conflicting nodes;
- Schema Markup Validator passes the graph;
- Google's Rich Results Test is used for supported LocalBusiness markup (site-name `WebSite`
  itself is checked with Schema Markup Validator, per Google's documentation);
- all facts in markup are visible on the page or directly represented in owner-controlled site
  data;
- the public homepage references a stable favicon URL; that URL returns `200`, correct MIME,
  and a square image;
- the public page's structured URLs use `cottageaesthetics.co.uk`, while staging remains
  `noindex` and does not accidentally declare staging as the public entity URL;
- tests cover escaping and optional/missing fields if Wixy injects the data.

Official references:

- <https://developers.google.com/search/docs/appearance/site-names>
- <https://developers.google.com/search/docs/appearance/structured-data/local-business>
- <https://developers.google.com/search/docs/appearance/favicon-in-search>
- <https://developers.google.com/search/docs/appearance/structured-data/sd-policies>

### Work package 4 — first mobile performance pass

Keep this as a separate site PR unless a small, generic builder enhancement is required.

#### 4A. Make primary text independent of animation

- Remove reveal gating from the homepage hero/H1 immediately.
- Prefer making all reveal content visible by default and enhancing only when the animation
  runtime is known to be active. At minimum, a JavaScript error, disabled JavaScript,
  `prefers-reduced-motion`, or delayed IntersectionObserver must leave every element visible.
- Check keyboard, reduced-motion, and no-JavaScript behaviour.

#### 4B. Add intrinsic image dimensions

- Add `width` and `height` to local content images without distorting CSS layout.
- A generic Wixy solution may post-process bound local `<img>` elements using the existing
  `builder.imagesize.probe_image_size`; preserve explicitly authored dimensions and gracefully
  skip remote/draft/unreadable images.
- Do not expose local paths or couple preview-only staged media into a pure builder path.
- Test JPEG, PNG, GIF, WebP, missing files, authored dimensions, list clones, and preview mode.

#### 4C. Stop eager gallery transfer

- Add `loading="lazy"` and `decoding="async"` to offscreen before/after slider images as well
  as gallery tiles.
- Confirm the before/after control still works when its image enters the viewport, after filter
  changes, and in the lightbox.
- Do not lazy-load the true LCP image on pages where an above-fold image becomes the LCP;
  consider `fetchpriority="high"` only after evidence.

#### 4D. Reduce image bytes

- Inventory rendered dimensions versus source dimensions and rank images by avoidable bytes.
- Optimise the homepage hero and other above-fold assets first.
- Prefer responsive derivatives/`srcset` or intentionally optimised WebP/JPEG assets over a
  blanket quality reduction. Preserve alt text and visual quality.
- If adding generic derivative generation to Wixy, keep output deterministic, do not mutate
  the source checkout during build, document cache behaviour, and add self-check/tests.
- Reconsider the current 2000 px / JPEG quality 85 upload defaults only with visual evidence;
  changing defaults does not optimise existing images and is not a substitute for migration.

#### 4E. Fonts and critical rendering

- Measure before changing. The site currently requests three Google font families with several
  weights and `display=swap`.
- Remove unused weights/families where provable. Consider self-hosting only if licensing,
  subsets, update ownership, and cache policy are handled; do not trade a 2 s render delay for
  an undocumented font-maintenance burden.

Performance acceptance on a clean mobile Lighthouse run, median of at least three comparable
runs:

- homepage H1/LCP content is visible in the initial render and no longer waits for `.reveal`;
- homepage LCP target is under 4.0 s in the lab profile, with a stretch target under 2.5 s;
- homepage initial transfer is under 1.0 MiB, or the PR documents the remaining named assets
  and a follow-up with evidence;
- gallery initial transfer is under 2.5 MiB and does not download every full gallery image
  before scroll;
- CLS remains under 0.1;
- all public pages remain usable without JavaScript and with reduced motion;
- visual comparison covers mobile and desktop home/gallery layouts;
- no broken images, filters, sliders, lightbox, editor bindings, or publish parity regressions.

### Work package 5 — useful treatment pages, prepared as drafts

Start only after packages 1–4 are merged or clearly independent. This package improves query
coverage but carries the greatest content/clinical review burden.

1. Use Search Console query data when available. If not, use restrained keyword research and
   the existing treatment catalogue; do not manufacture location permutations or doorway
   pages.
2. Recommended first set, subject to evidence and owner confirmation:
   - `/microneedling`
   - `/skin-boosters`
   - `/polynucleotides`
   - `/dermal-fillers`
3. Each page must be materially unique and helpful: who the consultation is for, what the
   treatment involves at this clinic, realistic aims, consultation/safety context, relevant
   aftercare, FAQs that answer real questions, and a clear booking/contact route.
4. Use “Hartlebury” and nearby geography naturally in title/copy where useful, not as repeated
   keyword stuffing.
5. Link from the treatment catalogue and relevant FAQ/aftercare content. Let Wixy generate
   canonical/sitemap entries. Decide intentionally whether each page belongs in top navigation;
   a treatment hub with contextual links is likely cleaner than four extra top-level nav items.
6. Reuse existing site claims and owner-approved sources. Any new assertion about candidacy,
   contraindications, longevity, recovery, risks, prescription status, products, qualifications,
   or outcomes must be sourced and highlighted for Purdi.
7. Merge to the site repository only after tests, but leave public release to Purdi's Wixy
   preview/review and Publish action.

Acceptance:

- every page has unique title, description, H1, substantial non-duplicated body, canonical,
  internal links, and a valid sitemap entry after public build;
- no unsupported medical claims or hidden keyword blocks;
- all factual/clinical review points are presented in one concise owner checklist;
- Purdi approves the wording and visual appearance before Publish;
- after Publish, the human lane submits/inspects the new URLs rather than repeatedly requesting
  indexing for unchanged pages.

### Work package 6 — monitoring and optional IndexNow

- Do not block the first release on IndexNow. A correct sitemap and human Bing submission are
  sufficient for a nine-page, low-frequency site.
- After the publish pipeline and URL set stabilise, assess an IndexNow notification at the
  successful end of public publication. It must never make Publish fail, must submit only
  canonical changed/deleted URLs, keep the key owner-controlled, and have bounded retries.
- Search Console/Bing results are external observations. Record them at 48–72 hours, two weeks,
  and four weeks without treating normal crawl delay as an engineering incident.

## Task list

Use this order and keep each repository's PRs independently reviewable.

| Order | Repository | Deliverable | Gate |
|---:|---|---|---|
| 0 | both (read-only) | reproducible baseline and current-SHA evidence | none |
| 1 | wixy | staging crawl/noindex correction + decision/spec/docs/tests | architecture consult + graded audit as required |
| 2 | wixy | optional static redirect-page build mechanism, if investigation confirms this design | public CLI/config contract docs + consult/audit |
| 3 | site | legacy redirect map + Pages workflow wiring | site CI; owner Publish after engine support is deployed |
| 4 | wixy and/or site | WebSite mechanics if generic; site-owned LocalBusiness data; favicon | schema validation + owner visual approval |
| 5 | site, plus a narrow wixy PR only if needed | reveal fix, lazy/async gallery, intrinsic dimensions, optimised assets | visual regression + Lighthouse evidence |
| 6 | site | first useful treatment landing pages | Purdi clinical/content approval in Wixy, then Publish |
| 7 | optional wixy/site | IndexNow publish notification | separate design decision; advisory-only failure semantics |

For every commit, include the repository-required plain-language `Release-note:` trailer. For
every public route/schema/config/invariant change, update the corresponding `docs/ai/` file in
the same PR and obtain the current doc-maintenance rules before committing. Do not bundle
routine SEO copy, architecture changes, and image-pipeline changes into one PR.

## Blockers

No blocker prevents packages 0–4 from starting.

These actions require human authority and are deliberately assigned to
`docs/search-indexing-console-guide.html`:

- access or ownership in Google Search Console;
- sitemap submission and URL inspection/request indexing in Google's UI;
- access/import in Bing Webmaster Tools;
- Google Business Profile website/hours/contact checks;
- visual approval of the favicon;
- confirmation of clinical/treatment claims; and
- pressing Publish in Wixy.

If Search Console shows a materially different legacy URL set or indexing error, capture the
exact report/export and adapt the relevant work package. Do not request account credentials or
work around an authentication boundary.

## Environment

- Planning worktree: the cmd workspace that created this brief; do not assume it will remain
  active.
- Engine developer commands:
  - `ruff check .`
  - `ruff format .`
  - `mypy`
  - `pytest` (repository fixes `-n 4`; never use `-n auto`)
  - `python -m builder --help`
- Site repository is a separate cmd project named `cottage-aesthetics-preview`; use its own
  worktree and instructions.
- Runtime/deployment checkouts under `D:\Servers\Wixy\` and Slots are evidence sources only,
  never authoring locations.
- Public host is GitHub Pages deployed from the site repository's `wixy-live` ref.
- Staging Wixy registry remains `domain: ca.cinnamons.uk`, `indexable: false`; the public Pages
  workflow overrides domain and indexability during its build.
- Current engine social-preview implementation of interest: commit `d318cd4`.
- Current observed site source/runtime SHA at planning time: `665f0d6` (`wixy: publish v65 —
  Content update via Wixy editor`). Reconfirm before work.

## How to continue

1. Read this entire brief, the root repository instructions, and the complete spec entry points
   before editing.
2. Create or reuse a durable todo in each repository so work survives handovers.
3. Execute work package 0 and report any fact that invalidates the plan before implementation.
4. Start package 1 in the Wixy engine. Because it changes a decided indexing contract, write
   the decision and documentation alongside the code, run the required consultation/audit, and
   do not merge on tests alone if the repository's gates require explicit approval.
5. Continue with the small PR train in `Task list`. Open a separate site workspace when needed;
   never edit the Wixy runtime checkout.
6. Keep the operator updated with concise milestone outcomes and links. Ask for decisions using
   the repository's first-class operator-decision mechanism, not a buried prose question.
7. When a site PR is ready, explain exactly what Purdi should inspect in Wixy's draft preview.
   Do not press Publish or invoke an alternate deploy path.
8. After the owner publishes, repeat the baseline probes against production, attach raw evidence,
   and hand the human console guide back for the relevant inspection/submission steps.

Definition of done for the implementation lane:

- packages 1–4 are merged, deployed through their normal mechanisms, and live-verified;
- any package 5 draft that was in scope is owner-reviewed and explicitly published;
- all affected tests/type/lint/build/parity checks are green;
- public and staging index controls match the decisions above;
- the legacy public URL behaviour is verified on GitHub Pages, not inferred from local server
  tests;
- structured data/favicons validate and contain only accurate facts;
- performance evidence compares like-for-like medians and records bytes/requests as well as
  scores;
- docs, decision log, release notes, todos, and rollback notes are current; and
- authenticated console actions remain with the human lane.

## Anything else the next agent must know

- Search-engine indexing is not instantaneous and is never guaranteed. Do not keep resubmitting
  unchanged URLs or call normal early-domain delay a defect.
- Lighthouse's SEO score of 100 does not mean the site is fully optimised; it is a small set of
  checks. Conversely, a performance score can vary between runs, which is why bytes, request
  count, LCP cause, and a median matter.
- Canonical `.html` duplication is understood and intentionally tolerated on GitHub Pages. It
  is not one of the legacy-redirect bugs.
- `robots.txt` is crawl control, not privacy or reliable de-indexing. Staging security remains
  the job of authentication where confidentiality is required; this public staging surface is
  being controlled for indexing, not made secret.
- The public site is health/beauty and carries medical-aesthetics content. Accuracy, visible
  substantiation, and owner review matter more than keyword volume.
- The separate HTML guide is the source of truth for what the operator/Purdi must do. If an
  account console differs, preserve the intended outcome and update the guide rather than
  guessing through a destructive or ownership-changing action.
