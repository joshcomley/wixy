# Advertising — master plan (Cottage Aesthetics)

> **Status: strategy + product design.** This is phase A of the advertising feature —
> deciding where/what/how. It is **NOT part of the CMS build running in workspace 00004**
> (the 13-milestone spec/ train); the Adverts module (§6) gets its own build spec once the
> CMS ships. Companion docs: [01-channel-playbook.md](01-channel-playbook.md) (where,
> researched + verification-tagged),
> [02-regulatory-guardrails.md](02-regulatory-guardrails.md) (what we may legally say —
> load-bearing for everything), and [03-creative-studio.md](03-creative-studio.md)
> (the owner-driven posting studio — **build priority #1 of this feature family**).

## 1. Objective & economics (planning assumptions, marked as such)

**Fill the diary via free consultations.** The funnel: local awareness → free 30-min
consultation → treatment plan → repeat visits + referrals.

Assumption-level economics (to be calibrated with real data in the first 90 days):
a treated client is worth roughly £140–£290 per visit across fillers/boosters/
polynucleotides, with 2–4 visits/year and multi-year retention → lifetime value
plausibly £1,000–£3,000. That makes a **cost per booked consultation of £15–£40
comfortably profitable** even at modest conversion. The dial (§5) is tuned against
**cost per consultation**, not clicks or reach. [ASSUMPTION — calibrate]

Secondary objective: compound the owned flywheel — Google reviews velocity, Instagram
following, referral habit — so paid spend can be turned DOWN over time without the
diary emptying. Paid fills the top; the flywheel keeps it full.

## 2. Positioning & angles of attack

From the brief/blueprint (calm countryside retreat, never salesy) — every ad speaks one
of these, in brand voice, British English:

| # | Angle | The line of attack | Typical use |
|---|---|---|---|
| A1 | **Nurse-led trust** | "Registered nurse, 15+ years NHS — medical aesthetics done properly." Differentiates vs non-medical injectors; safety-first messaging. | Meta ads, GBP, registers |
| A2 | **Natural, never overdone** | Converts the biggest objection ("I don't want to look done"). Honest consultations, subtle results. | IG organic + ads |
| A3 | **The Cottage experience** | A private countryside retreat, longer appointments, free parking, never rushed — spa-feel, clinic standards. | Print/village mags, IG reels (interior), partnerships |
| A4 | **Entry ladder** | Free consultation (always the CTA) and low-friction skin treatments (microneedling from £30) as the first visit; boosters/fillers follow from the consult, never from the ad. | Paid search + Meta lead gen |
| A5 | **Social proof** | 5.0★ Google, consented before/afters (compliance-gated), "regulars call it The Cottage". | Everywhere |
| A6 | **Local hero** | Hyperlocal familiarity: Hartlebury/Kidderminster/Stourport/Droitwich naming, community presence, sponsorships. | Groups, print, sponsorship |

**A7 — Her voice, not AI's (doctrine as differentiator).** Purdi's own observation: every
competitor's posts read as AI-written, and audiences feel it. Her personal wording IS the
brand asset — so across this entire feature family, **AI never writes her copy**; it does
layouts, imagery arrangement, production and suggestions only
([03 §0](03-creative-studio.md) binds this product-wide). In a feed of synthetic sameness,
a real nurse's real words are the most defensible creative angle we have.

**Never in any ad or boosted post: prescription-only medicines** (botulinum toxin by any
name). The compliant surface is consultations + non-POM treatments + brand. Full rules in
[02](02-regulatory-guardrails.md); the linter (§7) enforces them mechanically — on her
organic posts too (ASA treats clinic social posts as advertising), flagging but never
rewriting.

Seasonality calendar (campaign hooks, all compliance-checked per guardrails): January
"new-year skin reset" · spring wedding/occasion season (mother-of-the-bride angle) ·
September post-summer skin repair · November–December party season + gift vouchers
(vouchers for consultations/skin treatments only — never POM).

## 3. Channel portfolio

Three rings — the playbook ([01](01-channel-playbook.md)) carries the researched detail
and the ranked start order:

- **Foundation (owned/free — always on, dial-independent):** Google Business Profile
  fully built out + review-velocity habit (ask every happy client same-day); Instagram
  organic 3–4×/week (reels of The Cottage, education, consented results); Facebook page
  + participation in local groups per each group's rules; presence on the aesthetics
  trust registers (Save Face / JCCP etc. — membership fees are proposals, not dial
  spend); the CMS's landing pages (every campaign lands on a fast ca.cinnamons.uk /
  future real-domain page with UTMs — built with the machinery we're already shipping).
- **Paid core (the dial's main throttle):** Meta (Facebook+Instagram) local campaigns —
  radius-targeted, 18+, consultation-led; then Google Search on high-intent local
  keywords ("lip filler kidderminster", "profhilo worcester", "skin clinic near me").
- **Experiments (rotating test slots, one at a time, each individually approved):**
  Nextdoor ads, village/parish magazines (Hartlebury-trust play), Kidderminster Shuttle
  /Newsquest local digital, leaflet drops in affluent postcodes (Hagley/Bewdley/
  Droitwich pockets), partnerships (hair salons, bridal, gyms/pilates), community
  sponsorships.

## 4. Measurement (designed for a static site + Faces booking)

- **UTM discipline everywhere**: every ad/post/leaflet QR carries
  `utm_source/medium/campaign`; the CMS records landing-page hits server-side
  (first-party, cookieless log counting — no consent banner needed for that).
- **Consultation attribution**: booking clicks out to facesconsent are counted at the
  moment of outbound click per UTM session; phone taps (`tel:`) counted the same way.
  (True in-Faces conversion tracking is limited — treat outbound-booking-click +
  consult-shows from the diary as the KPI pair. Playbook confirms what Faces exposes.)
- **Platform-side**: Meta/Google native reporting for in-platform metrics; Meta
  Pixel/CAPI and Google tags are **deferred** until a consent banner ships (the site
  currently has zero tracking — a feature, not a gap; retargeting is a ring-3 upgrade,
  §8 roadmap).
- Weekly digest: spend, per-channel cost-per-consultation-click, review count, IG growth
  — rendered in the Adverts dashboard and postable to the owner.

## 5. The Spend Dial (the product's core mechanic)

One number — **monthly ad budget, £0–£2,000** — mapped to channel allocations by a
policy table, applied via platform APIs. Turning it up adds channels in proven order;
turning it down sheds them in reverse (never mid-flight-cancels a committed one-off buy).

| Dial (per month) | Allocation (policy v1 — refined by playbook + live data) |
|---|---|
| £0 | Foundation only (owned channels never stop) |
| ~£150 | + boosted IG/FB posts, ~£5/day, 15 km radius, 18+ |
| ~£400 | + always-on Meta consultation campaign (Instant Forms / Messages objective — on-platform lead capture, because facesconsent eats UTMs and cosmetic-domain pixel events are unreliable; verified in 02/playbook research) |
| ~£750 | + Google Search exact-match local keywords |
| ~£1,200 | + one rotating experiment slot (Nextdoor / print / leaflets) |
| ~£2,000 | + scaled Meta + retargeting (only once consent banner ships) |

Mechanics & guardrails:

- **Meta and Google budgets are API-writable** (Meta Marketing API, Google Ads API):
  the dial edits daily budgets within minutes; the dial value is a **hard monthly cap**
  enforced by pacing checks, with auto-pause on cap.
- **Every spend change passes a human gate**: moving the dial shows the exact new £/month
  and requires explicit confirmation; offline/one-off buys (a magazine slot, a leaflet
  run, a register membership) are **proposal cards** — each shows the exact price and is
  individually approved before any commitment. Nothing ever spends on inference alone.
- Safety automations: anomaly alerts (pacing over-run, cost-per-result spikes),
  auto-pause of any campaign whose landing page stops returning 200 (the CMS knows its
  own deploy state — unique advantage of ads + CMS in one system).
- Prerequisite (operator-assisted, one-time): Meta Business Manager + ad account +
  `ads_management` app credentials, and later a Google Ads account + developer token.
  Documented as setup steps in the module spec, not runtime magic.

## 6. Where it lives in Wixy

A new **Adverts** tab in the existing admin (post-CMS-build), reusing its shell, auth
(CF Access), and AI-chat lane:

- **Studio** — the photo library + post/reel composer + the WXL drag/swap layout editor
  + queue ([03-creative-studio.md](03-creative-studio.md)) — ships FIRST; Facebook +
  Instagram are the only platforms that matter right now.
- **Dashboard** — spend vs consultations funnel, per-channel cards, review/IG counters.
- **Dial** — §5, with the allocation preview + confirm gate.
- **Campaigns** — list/detail: status, creative, targeting, per-campaign results.
- **Proposals** — the one-off buy cards (print/leaflets/register memberships) awaiting
  approval, each with exact £.
- **Compliance** — linter results per draft (§7); nothing publishable while red.
- **Assets** — creative library (reuses the CMS media library + consent tags on
  before/after imagery).
- **AI lane**: same cmd-chat mechanism as content editing — "design me a February
  campaign for skin boosters" spawns the agent in the site/ads workspace; it drafts
  copy + creative briefs + targeting into a campaign draft that must pass the linter,
  then the owner approves (publish = API push). The agent NEVER holds spend authority;
  approval and the dial remain human-only, same doctrine as site publishing.

## 7. Compliance engine (why this is a feature, not a PDF)

[02-regulatory-guardrails.md](02-regulatory-guardrails.md) distils UK CAP/ASA rules
(POM ban, 18+ cosmetic-procedure targeting, before/after and incentive restrictions),
Meta + Google platform policies, and NMC social-media expectations into
**machine-checkable linter rules** applied to every draft — AI-written or human-written —
before the publish button exists. Aesthetics advertising is an ASA enforcement hotspot;
"the tool won't let you" beats "the owner remembered the rule". The linter ships with the
module's v1; the rules file is maintained like code (versioned, decision-logged).

## 8. Roadmap

- **A (this PR)**: master plan + researched channel playbook + regulatory guardrails +
  the Creative Studio design. Everything actionable manually from day one — the docs
  stand alone even before any module exists.
- **B (module v1 = the CREATIVE STUDIO, own spec + build after the CMS ships)**: photo
  library (private media repo, categories, B/A pairs + consent), the 3-step composer
  (her words verbatim → her photos → generated layouts), carousel + reel generation
  (ffmpeg + curated licensed music), compliance linter (shared with paid later),
  FB+IG publishing via Graph API with the send-to-my-phone fallback from day one.
  Reordered to first because content creation is her actual pain TODAY, and organic
  posts are the raw material everything paid later boosts.
- **C (module v2 = PAID)**: the Spend Dial driving Meta (boosts + always-on
  consultation campaign), UTM landing-page generator (CMS synergy), first-party click
  counting, proposals flow for offline buys, weekly digest.
- **D (module v3)**: Google Ads integration, Nextdoor, consent banner + Pixel/CAPI
  retargeting, automated experiment rotation + kill/scale rules.
- **First 90 days of paid** (the "investment plan", assumption-tagged): start the
  dial at **£400–£600/month** (Meta core + boosts — research puts the floor for an
  always-on campaign that generates optimisable signal at ~£400–£800/mo); decision
  gates at day 30/60/90 on
  cost-per-consultation (kill creative > £60/consult-click after £150 spent; scale
  winners; re-allocate a dead channel's budget to the best performer). Review targets:
  +2–4 Google reviews/month via the ask-habit. [ASSUMPTION — calibrate against playbook
  benchmarks + live results]

## 9. Sensitivities

Same as the site (00-mission §Sensitivities), sharpened for ads: consent recorded for
every before/after used in any creative; POM never in ad surface; no exploiting
appearance insecurity (CAP responsibility rules — and it's off-brand anyway); Purdi's
professional NMC standing considered in everything her accounts post. The linter encodes
all four. Two compliance-driven **site-copy actions** are flagged in
[02 §6](02-regulatory-guardrails.md): the "Wrinkle Relaxing" label itself fails CAP's
Botox FAQ Q8 (rename via the CMS post-build, with owner sign-off), and the facesconsent
listing needs auditing to ad standard (clinics are liable for booking-platform listings
— Dr Bunny/Fresha precedent).
