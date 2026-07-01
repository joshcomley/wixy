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
