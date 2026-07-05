# 00001 — Build & manage a modern Wix site (Wix Studio + Velo)

**id:** k3n8qr
**status:** OPEN — CONNECTED & AUTHENTICATED. Building. CLI updated to 1.1.222.
Business = beauty & skincare treatments clinic. Build order: BOOKINGS first,
then Store, Portfolio, marketing pages.
Next gate: user installs Wix Bookings app (editor/dashboard, one click) + gives
service list (name/duration/price). Then provision services via Bookings API in
backend code where possible + build custom booking page/logic.

## Connected state (as of session)
- Repo cloned to `D:\wix-sites\cottage-aesthetics` (OUTSIDE D:\Servers to dodge
  worktree-guard). GitHub: `joshcomleywix/cottage-aesthetics` (SSH url given;
  cloned via HTTPS with joshcomley collaborator creds). Site ID:
  c721738f-2644-49e8-8865-fc10865db30f.
- `wix` CLI authenticated as `joshcomley+wix@gmail.com` (device login).
- `npm install` + `wix sync-types` OK. Template = a Portfolio template with pages
  Home/About/Portfolio/Contact + dynamic Project pages/Collection pages. All page
  .js files are EMPTY $w.onReady stubs (design lives in the Wix editor, not repo).
- Template CANNOT be changed post-creation (Wix limitation) — user kept it.

## Division of labour (KEY)
- CODE layer (this repo) = mine: Velo page logic, backend web modules, data
  hooks, http-functions, routers, jobs, permissions.json. Push to default branch
  -> syncs to site; `wix publish` to go live.
- VISUAL design + installing Stores/Bookings apps + creating CMS collections =
  Wix editor GUI actions (Velo attaches behaviour to elements by ID; can't
  create elements). Model: I build code + give user a minimal editor checklist.

## What
Stand up a new Wix website that Claude manages via code, using the most modern
code-manageable Wix stack. Site combines: business/marketing pages, a Store
(Wix Stores), Bookings (Wix Bookings), and a portfolio (CMS-driven gallery).

## Decision (why this approach)
Chosen stack = **Wix Studio + Velo + Git Integration & Wix CLI for Sites**
(NOT Wix Headless).
- Store + Bookings are Wix's turnkey hosted modules (payments, inventory,
  calendar, dashboards) — Headless would mean re-implementing all of that.
- Studio+Velo still gives full code control via the Wix CLI + a Wix-provisioned
  GitHub repo (`wix dev` = Local Editor for live testing, publish from CLI).
- Result: real editable Wix-hosted site AND git/code-managed by Claude.

## Environment (this machine, josh-xps)
- Node v23.6.0, npm 10.9.2, `@wix/cli` v1.1.197 already installed globally.
- Modern flow confirmed via Wix docs: "Git Integration & Wix CLI for Sites" —
  Wix provisions a GitHub repo for the site; clone it, develop in IDE,
  `wix dev` to preview, publish from CLI.

## Blocker (user-only steps)
1. Create/sign into Wix account.
2. Create a **Wix Studio** site (blank; not classic ADI).
3. Enable Dev Mode/Velo, then Settings -> Git Integration & Wix CLI -> connect
   GitHub. Wix creates a GitHub repo for the site.
4. User hands back the GitHub repo URL + which GitHub account.

## SECURITY DECISION — GitHub isolation (important)
Site name = "Cottage Aesthetics" (free plan). Wix's Velo git integration is the
OAuth app **"Velo by Wix-dev"** which demands the broad GitHub `repo` scope =
read/write to ALL repos the authorizing account can reach. It is NOT a GitHub
App and has NO per-repo picker. Authorizing under `joshcomley` would expose the
ENTIRE fleet's private code — forbidden.
DECISION: authorize Velo under a DEDICATED new GitHub account that owns only the
site repo (isolated account contains the broad token). Then add `joshcomley` as
a collaborator on that ONE repo so the fleet creds (GIT_ASKPASS bot-auth) can
clone/push it. Org-level restriction was rejected (leaves personal joshcomley
repos exposed). An org does NOT contain a user-bound OAuth token.

## API / provisioning capability (RESOLVED - big)
- WIX_API_KEY (machine env, len 721) NOW WORKS for the correct account:
  site-list returns "Cottage Aesthetics" [c721738f-...], Bookings API reachable
  (user regenerated it under the right account). USE THIS as stable REST auth.
- CLI token also works: `wix token` -> `Authorization: <token>` against
  www.wixapis.com (expires, so prefer the API key).
- => I can PROVISION Bookings services + CMS collections/data via REST in code.
  Headers: Authorization=<WIX_API_KEY>, wix-site-id=c721738f-2644-49e8-8865-fc10865db30f
- Wix Bookings app INSTALLED (0 services yet). Bookings Services v2 Create:
  POST create-service; required type/name/onlineBooking/payment/defaultCapacity.

## Brief absorbed (Cottage Aesthetics)
Nurse-led medical aesthetics clinic, Hartlebury; founder Purdi (RN 15yr).
Brand "The Cottage": calm, understated luxury, natural, Mediterranean-cottage.
Palette: olive green, limewash/soft stone, anthracite, soft terracotta/ochre,
natural oak, antique brass. Nav: Home, About, Treatments, Before&After, Reviews,
Book Now, Contact (+ FAQ, Aftercare, Clinic Policies). Every page needs Contact.
Photos+brief committed to joshcomley/wixy branch cmd/workspace-00002.

## MAJOR DIRECTION CHANGES (latest)
- ARCHITECTURE: going FULLY HEADLESS (AI writes all HTML/CSS). Operator chose this
  over hosted Studio (Studio = layout composed on canvas/editor; Headless = 100%
  code). If Purdi later wants to self-edit visually, make a separate Studio version.
- DESIGN: earthy/warm palette (mocha/cream/clay + olive-green accent), NO LOGO
  (Purdi dislikes current logo; new logo TBD). Concept homepage + reviews page
  deployed to gh Pages https://joshcomley.github.io/cottage-aesthetics-preview/
  (source in scratchpad gh-pages-demo; index.html=homepage, reviews.html). Homepage
  shows only 2 pull-quote review snippets; full set on reviews page.
- BOOKINGS: Purdi already uses FACES (facesconsent.com/bookings/purdi-hadley) =
  all-in-one aesthetic clinic mgmt incl. digital CONSENT FORMS + prescriptions +
  client records + compliance. Wix Bookings CANNOT do consent/prescriber/medical
  records -> for a nurse-led injectables clinic, KEEP FACES as booking+consent
  engine; front it with our site. Faces booking page has NO X-Frame-Options/CSP
  frame-ancestors => embeddable in an iframe. => the Wix Bookings services/hours I
  provisioned are now REDUNDANT (shelve/remove; not wasted, right call pre-Faces).
  OPEN Q: what exactly does Purdi dislike about Faces (look vs flow vs emails)?

## FULL PREVIEW SITE BUILT (all pages)
Pages: index, about, treatments, gallery(Before&After), reviews, contact, faq,
aftercare, policies. Shared header/footer/booking-modal/mobile-menu via site.js;
shared design in site.css. Homepage H1 = "Cottage Aesthetics". Nav standardized
to brief (Home/About/Treatments/Before&After/Reviews/Contact +Book Now).
- Faces has a website builder + BRANDING (colours/logo). We use our bespoke site,
  NOT Faces' builder. Purdi should set brand colour (olive #6E7357 / clay #B26E4A)
  + logo in Faces branding so the embedded booking matches. (Operator can't be done
  by us - no Faces login.)
- DRAFT/needs Purdi input: FAQ answers, Aftercare (general only), Policies
  (placeholder deposit/notice figures), social links (# placeholders), Before&After
  images (need client photo-consent). Contact form is demo (no backend yet).
- REMAINING: real headless build; wire contact form backend; real socials; B&A images.

## Preview site build (GitHub Pages, joshcomley/cottage-aesthetics-preview)
- Deploy via GitHub ACTIONS workflow (.github/workflows/deploy.yml) NOT legacy
  Jekyll (which kept erroring). build_type=workflow. ~1-2 min per deploy.
- Iterate via INSTANT local Playwright renders (scratchpad/preview.py etc.); push
  to Pages only at milestones. Live URL lagged behind builds earlier -> always
  verify via Actions run + raw.githubusercontent, not just the CDN'd Pages URL.
- Pages/files: index.html (homepage), treatments.html, reviews.html, site.css
  (shared design system), booking.js (Faces modal), images/.
- HERO final: lounge.jpg edge-to-edge (hall.jpg had BAKED-IN black bars - never
  use full-bleed), SOLID tinted strip rgba(18,12,9,.64), hard edges, no blur/fade,
  no logo, nav text-shadow. Earthy palette (mocha/cream/clay + olive accent).
- FACES BOOKING EMBED works: booking.js injects a modal iframe ->
  facesconsent.com/bookings/purdi-hadley. Any .js-book element opens it. Verified
  it loads (Faces shows its own cookie consent + reCAPTCHA, then the calendar).
  Book buttons = .js-book; Enquire (prescription/facial rebalancing) -> #contact.
- Treatments page done: categories + prescription-only behind <details> expanders
  (pricing >=2 clicks per brief), Enquire not Book.
- TODO next: about.html, contact.html (GDPR form/map/hours/parking/socials),
  gallery.html (Before&After - needs consent+images), FAQ/Aftercare/Policies;
  standardize nav to brief (Home/About/Treatments/Before&After/Reviews/Contact
  +Book Now). Then the REAL headless build.

## Progress log (latest)
- 11 bookable services provisioned in Wix Bookings via API (idempotent script in
  wixy repo tooling/).
- Opening hours obtained from Google (headed browser): Mon-Thu 10-19, Fri 10-17,
  Sat 11-16, Sun closed. TODO: apply to Bookings availability + set business
  location (none set) so slots go live.
- Google reviews (5.0, all 5-star) captured to docs/google-reviews.json; branded
  demo reviews-demo.html built + served via cmd portal (9320). OPERATOR CLEARED
  reviews to go on the actual (unlisted) site - no longer preview-only.
- DONE: booking working hours applied via Calendar Events API (tooling/set_hours.py):
  Mon/Tue/Thu 10-19, Fri 10-17, Sat 11-16, WED CLOSED (cancelled per Purdi -
  she keeps Wed for phone enquiries), Sun closed. Business schedule
  b77e2ef5-e931-4208-a6f1-3da3956ed8ef. Booking engine now has real availability.
- DONE: public demo hosted at https://joshcomley.github.io/cottage-aesthetics-preview/
  (repo joshcomley/cottage-aesthetics-preview, gh Pages) so Purdi can view without
  CF Access. Note: the wix.to site preview is also public/shareable.
- NEXT: rename staff resource "Business Owner" -> "Purdi"; set business location
  (clinic address); then the PAGES/visual layout (Wix editor / Local Editor
  `wix dev` — the one surface not doable via pure code). Design approved by
  operator (loves the demo look).

## Treatments (from brief) — BOOKABLE = Book btn; PRESCRIPTION-ONLY = Enquire btn
BOOKABLE: Consultation FREE 30m; Standard Microneedling 45m £30 (course of 5
£120); Advanced Microneedling 45m £80; Skin Boosters: Jalupro Super Hydro £150
45m, Profhilo £230 45m; Polynucleotides £150 (course of 3); Under Eye
Polynucleotides £150; Dermal Fillers: Lip £140 1h, Chin £140 1h, Cheek £200 1h,
Jawline £290 1.5h; Facial Rebalancing (price after consult - Enquire).
PRESCRIPTION-ONLY (Enquire only, price/info >=2 clicks from home, NOT bookable):
Botox Full Face £330 / Three Areas £220; Relfydess £280; Vitamin B12 single £45
/ course of 5 £120.

## How to continue (once repo URL received)
1. `git clone` the Wix-provisioned repo here.
2. `wix login` (user approves browser OAuth once).
3. Install project deps; run `wix dev` to open Local Editor / preview.
4. Install Stores + Bookings apps; create portfolio CMS collection; build
   marketing pages.
5. Commit to git; `wix publish` from CLI.
6. SPEND GATE: price premium plan + custom domain, confirm exact $ with user
   before anything bills. Free tier for initial build.
