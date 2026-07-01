# Handover Brief — Cottage Aesthetics: Before & After gallery (full-size, high-impact)

## The task (operator's request)
Make the **Before & After gallery a full-size, high-impact, enjoyable experience.**
Right now the 4 images are small thumbnails — on mobile you can't even see the
difference. Requirements:
1. **Pull as many of her Instagram before/after images as possible**, categorised by treatment type.
2. Show them **full size** (not thumbnails).
3. **Split each composite into separate BEFORE and AFTER images** and offer an interactive
   **before/after slider** (draggable divider — the gold-standard pattern). Also consider
   lightbox/zoom, large side-by-side, toggle. Research current best-practice B&A UX.
4. Real **"wow" impact on the AFTER**; each one should be enjoyable to explore. Mobile-first (touch).

## First steps for the receiving session
1. **Pull latest** of the wixy repo before anything (handover-receiver rule): the docs/todos live in
   `joshcomley/wixy` branch `cmd/workspace-00002`. This brief is in `handover/`.
2. The preview site lives in a **session scratchpad that will NOT persist** across sessions. **Clone fresh:**
   `git clone https://github.com/joshcomley/cottage-aesthetics-preview <dir>` (joshcomley has push via the
   fleet GIT_ASKPASS). Work there.

## Preview site — repo & structure
- Repo: **joshcomley/cottage-aesthetics-preview** (public, GitHub Pages).
- Pages: index, about, treatments, **gallery.html** (Before & After), reviews, contact, faq, aftercare, policies.
- Shared: **site.css** (design system + inner-page styles), **site.js** (injects header/footer/booking-modal/
  mobile-menu; wires any `.js-book` element → Faces booking modal; scroll-reveal via `.reveal` class).
- `images/` holds photos incl. current B&A: `ba-lips-1.jpg, ba-lips-2.jpg, ba-chin.jpg, ba-cheeks.jpg` (~640px IG-res — too small; replace/augment).

## Deploy (IMPORTANT — do it this way)
- GitHub Pages **build_type = workflow** (GitHub Actions), NOT legacy Jekyll (legacy kept erroring —
  do not switch back). Workflow: `.github/workflows/deploy.yml` (actions/upload-pages-artifact + deploy-pages).
- Deploy = commit + push to `main` → Actions builds+deploys (~1–2 min). Verify the run via
  `& "C:\Program Files\GitHub CLI\gh.exe" api repos/joshcomley/cottage-aesthetics-preview/actions/runs`
  (run "Deploy static site to Pages", status completed/success). CDN can lag — verify committed file via
  `raw.githubusercontent.com/joshcomley/cottage-aesthetics-preview/main/gallery.html`.
- Live: https://joshcomley.github.io/cottage-aesthetics-preview/  (B&A = /gallery.html)
- **gh CLI must run via PowerShell full path** `& "C:\Program Files\GitHub CLI\gh.exe"` (gh via Bash tool swallows stdout).

## Fast iteration loop (keeps context lean)
- Render pages **locally & instantly** with headless Playwright (Python) + screenshot; downscale to small
  JPGs (width ~700, quality ~70, <49KB) before reading. Force reveals visible for shots:
  `document.querySelectorAll('.reveal').forEach(e=>e.classList.add('in'))`. Only push to Pages at milestones.
- Python: `%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe` (has playwright, pillow, httpx).
  Headed browse uses `p.chromium.launch(headless=False, channel="chrome")`.

## Instagram source — how to pull the images
- Profile is **PUBLIC / not walled**: https://www.instagram.com/cottageaesthetics/
- Method (proven this session, see `scratchpad/ig_pull.py` if it survives, else re-create): headed Chrome,
  webdriver mask (`navigator.webdriver=>undefined`), accept cookie banner ("Allow all cookies"), Escape to
  dismiss login modal, scroll to load rows. Grid posts: `a[href*='/p/'] img` → `{src, alt}`. Download bytes
  via the browser context so IG-CDN signed URLs work: `ctx.request.get(src).body()`.
- Grid src is only ~640px and is the post COVER. For **full-size + true before/after pairs**, OPEN each post
  (`/p/{shortcode}/`) — many are **carousels** (click "Next" for each slide) or **composites** (before+after
  stacked vertically, or side-by-side, or 4-panel). Grab the larger in-post images.
- **Consent: operator CONFIRMED** clients are happy to be published online; this is the preview. OK to use.
- Categories seen: **lips, chin/jaw, cheeks** (all fillers so far). Also microneedling/skin-boosters posts
  exist but as testimonials/graphics — look for genuine before/after photos inside posts.
- Build a **contact-sheet montage** (PIL grid, index-labelled) so you review MANY images by reading ONE small
  JPG (context-efficient) — that's how the genuine before/afters were identified vs marketing graphics.
  (This session found: post covers were mostly marketing graphics; only ~4 clean before/afters. Opening the
  actual posts/carousels should surface more real pairs.)

## Splitting composites into before/after (for the slider)
- Her images are single composites → to power a draggable slider you need SEPARATE before + after images.
- Per-image: detect layout (vertical stack = before top/after bottom; horizontal = before left/after right;
  4-panel) and crop halves with PIL. Layouts differ per image → inspect each (via the montage / individual
  small reads). Some have "BEFORE"/"AFTER" text baked in — crop it out where feasible.

## UX patterns (recommendation)
- **Quick win first:** full-width large tiles + **lightbox/click-to-zoom** of the composite images as-is —
  instantly fixes "too small to see", big impact, no splitting needed. Ship this, then:
- **Premium:** draggable **before/after slider** — before image full; after overlaid and clipped by a
  draggable divider driven by a range input + CSS `clip-path`/inset. **Vanilla JS, no dependency needed.**
  Must work on **touch/mobile**. Needs the split before/after images.
- Keep it in the earthy design language.

## Current gallery.html state
- `<section class="page-hero"><h1>Before & After</h1><p>…consent…</p></section>` (eyebrow just removed).
- `.ba-note` (consent/more-coming text), `.gfilter` buttons (All/Lips/Chin & Jaw/Cheeks) + JS filtering by
  `data-cat`, `.ba-grid` of 4 `figure.ba-tile` (img + figcaption). Replace with the full-size/interactive version.

## Design system (match it)
Earthy palette (site.css vars): --cream `#F1E8D9`, --cream-2 `#EADFCB`, --oat `#E4D6BE`, --mocha `#5E4635`,
--coffee `#3E312A`, --clay `#B26E4A`, --olive `#6E7357`, --brass `#A98A54`. Fonts: Cormorant Garamond
(headings), Jost (body), Pinyon Script (accents). **No logo** (Purdi dislikes the digital logo file; photos
that happen to show the wall wordmark are fine). Buttons: `.btn.btn-primary` (clay), `.btn.btn-olive`.

## Background context (not this task)
- Booking = **Faces** (facesconsent.com/bookings/purdi-hadley) embedded via a modal in site.js (`.js-book`).
  Faces has **no API/webhooks/widget** (confirmed). Alternatives researched in
  `docs/booking-platform-comparison.md` (Pabau #1, then Semble, Cliniko).
- FAQ/Aftercare/Policies are flagged **drafts** for Purdi; contact form is a **demo** (no backend yet);
  socials wired (IG + FB). Production target later = **Wix Headless** build (fast deploys + cache-busting +
  real form backend + custom domain). Full project history/decisions in the wixy repo's `docs/` + `todos/`.

## Definition of done
A Before & After gallery with many categorised, full-size before/afters and a genuinely enjoyable interactive
experience (slider + lightbox), impactful on mobile, deployed live to the preview URL — then report to operator.
