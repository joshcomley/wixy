# 02 — Regulatory guardrails (UK aesthetics advertising)

> Distilled from primary-source research (2026-07-08/09; every rule below was loaded and
> quote-checked at its source URL by the research pass — full citations inline). This doc
> is the source of truth for the **compliance linter** (§5) that gates every ad, boosted
> post, organic caption and leaflet the Adverts feature ever emits — and it flags two
> **site-copy actions** (§6). ASA enforcement in this vertical is active and automated
> (CAP's AI monitoring swept 928 paid social ads for one filler procedure in 2025;
> 11.5% compliant).

## 1. The hard line: prescription-only medicines (botulinum toxin)

- **Criminal law**: advertising a POM to the public is an offence — Human Medicines
  Regulations 2012 reg 284; up to 2 years' imprisonment (reg 303).
  (legislation.gov.uk/uksi/2012/1916/regulation/284, /303; gov.uk/guidance/advertise-your-medicines)
- **CAP Code 12.12**: POMs/POM treatments "may not be advertised to the public" —
  applies to **all media including websites and organic social media**; 12.18 bans
  health-professional/celebrity endorsement of medicines. (asa.org.uk code section 12)
- **Hashtags count** (#botox etc. = implied POM ad — Beauty Boutique Aesthetics & Faces
  by AKJ rulings, 25 Sep 2019); **coded names count** ("Beautytox"/"Beautox" —
  CAP enforcement update); **indirect signalling counts** (Therapie Clinic ruling,
  Dec 2024, breached 12.12 without using the word).
- **Third-party listings count**: a clinic was ruled against for its **Fresha booking
  listing** ("Botulinium Toxin from £50", bookable without consultation — Dr Bunny
  Aesthetics, Apr 2024). Direct precedent: **our facesconsent.com listing must be
  audited to ad standard** (§6).
- **Price lists**: reg 7(3) + CAP FAQ allow a genuine price list *without product
  claims*, not distributed promotionally, not homepage-prominent — ideally reached
  after consultation-focused pages.
- **Real enforcement targets social**: Facebook-group "models wanted for Botox" posts
  (Menar Jimmy Georgiou, 2023), Instagram Stories with a reality-TV personality (LIFT
  Aesthetics, 2023 — 12.12 + 12.18 + undisclosed-ad rules).

**The compliant pattern (CAP's own words — Botox FAQ + AdviceOnline):** advertise the
**consultation**, never the product; website POM references incidental/balanced/factual
only; **no price promotions on the POM ever** (even on our own site); "anti-wrinkle
injections" only if a non-POM injectable is genuinely offered and nothing implies Botox;
**"wrinkle relaxing" is explicitly NOT acceptable** (FAQ Q8 — "relaxing" is an implied
Botox reference); **no before/after images of POM results, anywhere**. Conveniently, the
NMC's remote-prescribing ban (from 1 Jun 2025) makes a face-to-face consultation the
legally required gateway for the toxin service anyway — the compliant ad framing and the
clinical pathway are the same thing.

## 2. What CAN be advertised (and how)

Dermal fillers, skin boosters (Profhilo/Jalupro), polynucleotides, microneedling — all
nameable and advertisable, subject to:

- **18+ targeting (CAP 12.25, in force May 2022)**: cosmetic-intervention ads must not
  be directed at under-18s by media selection/context; banned from media where
  under-18s exceed **25% of the audience**. Scope explicitly includes fillers,
  injectables, skin rejuvenation, micro-needling.
- **Responsibility (CAP 1.3, 4.9)**: no exploiting appearance insecurity, no
  trivialising ("no intervention is without risk" — so no unqualified
  "safe/painless/no-downtime"), **no time-pressure** on procedures (the 2025 sweep's
  top failure: "limited slots", countdowns, urgency).
- **Claims**: substantiable claims only; "temporarily reduces the appearance of fine
  lines" fine; unqualified "cure"/"rejuvenation" not generally acceptable (12.1, 12.7).
- **Before/after (non-POM only)**: signed + dated genuineness proof, no
  performance-relevant retouching, matched styling/lighting/pose between the shots,
  representative results — evidence file per image pair.
- **Testimonials**: genuine + documented + permissioned (3.44–3.50); a testimonial
  that names the POM breaches 12.12 regardless of genuineness.
- **"Free consultation"**: fine — it's the CAP-encouraged framing; promotion hygiene
  (Section 8: significant conditions, no pressure) applies.

## 3. Platform policies (verified against Meta/Google policy pages)

**Meta** (cosmetic procedures live under Health & Wellness restricted goods):
- 18+ mandatory for cosmetic products/procedures ads (policy names fillers,
  injectables, skin rejuvenation, micro-needling).
- **No side-by-side before/after composites in ads** for wrinkle/anti-ageing
  treatments; close-up single-state results imagery allowed if realistic.
- Personal-attributes rule: never assert/imply things about the viewer ("Ready to look
  younger?" is Meta's own ❌ example; "Our new lotion fights wrinkles" is their ✅).
- No UK certification path for POM ads (LegitScript route is US/CA/NZ only) — UK
  creative stays inside the cosmetic-procedures framing.

**Google Ads**:
- No certification exists for a UK aesthetics clinic; **"botox"/"botulinum" are on the
  restricted prescription-drug-terms list** — they may not appear in ad copy, landing
  pages, or keyword lists for UK campaigns. The lawful mechanism for the real "botox
  kidderminster" demand: bid on lawful terms ("anti-wrinkle consultation kidderminster",
  treatment+geo terms) and let close-variant matching surface the ad.
- Local Services Ads: not available for this vertical in the UK.
- PMax: avoid at small budgets (uncontrolled placements + automated asset assembly is a
  poor fit for a banned-words vertical).

**Consent/tracking (ICO, guidance finalized 29 Apr 2026)**: any Meta Pixel / Google tag
— **including pure conversion measurement** — requires prior opt-in consent (PECR/UK
GDPR); block tags until opt-in; reject as easy as accept. The site ships with zero
tracking today; tags arrive only with a proper consent banner (roadmap ring 3).

## 4. NMC (binds Purdi personally, independent of ASA)

Code 20.10 (responsible social media use) + 21.4 (advertising must be accurate,
responsible, ethical, never exploiting vulnerabilities) + 21.5. Plus the 1 Jun 2025
face-to-face prescribing mandate (§1). Anything her professional accounts post is also
an NMC matter — one more reason the linter runs on organic posts.

## 5. The linter (machine-checkable rules — the build spec implements these verbatim)

Applied to: ad copy, organic captions, hashtags, bios, alt-text, leaflet copy, image
selections, campaign configs, destination URLs. Severity: BLOCK unless noted.

| # | Rule | Source |
|---|---|---|
| 1 | Reject `botox\|botulinum\|vistabel\|azzalure\|bocouture\|dysport` + `\w+tox\b` coinages in any public promotional text | CAP 12.12; HMR reg 284; coded-names enforcement update |
| 2 | Reject hashtags matching rule 1 or `#antiwrinkle*` | 25 Sep 2019 hashtag rulings |
| 3 | Reject `wrinkle[- ]relax\w*` in promotional copy | CAP Botox FAQ Q8 |
| 4 | FLAG (human review) `anti[- ]wrinkle injection\w*` — only passable with genuine non-POM injectable offered + no Botox implication | FAQ Q7 |
| 5 | Reject promo mechanics (`%\|£-off\|deal\|offer\|save\|discount\|voucher`) in the same asset as rule-1/3/4 terms or a POM-linked consultation | FAQ Q6 |
| 6 | Reject urgency tokens (`today only\|ends tonight\|limited slots\|last chance\|hurry\|countdown…`) in any procedure ad | CAP 1.3 guidance; 2025 sweep |
| 7 | Reject second-person appearance assertions (`your wrinkles\|hate your\|fix your\|ready to look younger…`) | Meta personal-attributes; CAP 1.3/4.9 |
| 8 | Reject unqualified `safe\|risk-free\|painless\|pain-free\|no downtime\|easy` in procedure ads | CAP responsibility guidance |
| 9 | Imagery: no side-by-side B/A in any META AD for wrinkle/anti-ageing; no B/A of POM results ANYWHERE; every non-POM B/A requires its evidence file (consent + genuineness + matched-conditions) — the Studio's consent-gated pairs (03 §1) carry this | Meta H&W policy; FAQ Q9; CAP B/A guidance |
| 10 | Campaign config: minimum age 18 on every Meta/Google campaign; no youth-skewed placements (>25% under-18) | CAP 12.25; Meta H&W |
| 11 | Google campaigns: no rule-1 terms in keywords, ad text, or landing-page URLs | Google restricted drug terms |
| 12 | Every paid destination URL carries dictionary-registered lowercase UTMs; every booking CTA fires the tracked outbound click on OUR domain before the facesconsent handoff (verified: UTMs do NOT survive into facesconsent); no marketing tag fires pre-consent | GA UTM guidance; ICO 2026; live facesconsent test |
| 13 | Testimonials in ads require on-file permission + genuineness record and must pass rules 1–3 | CAP 3.44–3.50 × 12.12 |

Rules 1–3 also run (as FLAG, never rewrite — 03 §0) on her organic Studio posts.

## 6. Site & social copy actions (flagged for the owner, post-build — not mid-migration)

1. **Rename "Wrinkle Relaxing"** on the treatments page/home teaser: the current label
   fails CAP FAQ Q8 in promotional context. Compliant replacement pattern: a
   "Prescription treatments — by consultation" section that is factual, un-promoted,
   price-list-shaped, and never distributed/boosted. (The migration copies today's copy
   verbatim for parity; this is a content edit through the CMS editor afterwards, with
   owner sign-off.)
2. **Audit the facesconsent listing** to the same standard (Dr Bunny/Fresha precedent:
   the clinic is liable for its booking-platform listing): no POM names with prices
   bookable without consultation.
3. **Existing social posts** (from the 2026-07-08 audit,
   `research/existing-posts-audit.md`): her personal before/after Reel names Botox
   directly in the caption — on a clinic account that is an implied POM ad under the
   same rulings that caught hashtags; recommend editing the caption (the story works
   without the word) or archiving. Handle sensitively — it is her genuine personal
   story, which is exactly the voice we're building around; only the POM name has to
   go, not the post's honesty.
4. **Credential consistency**: the same clinic-day announcement calls the visiting
   colleague "our prescriber" on Facebook and "our pharmacist" on Instagram — pick the
   accurate title and use it everywhere (NMC 21.4 accuracy; also basic trust hygiene).
5. **Consent microcopy on before/afters**: four audited B/A posts carry no visible
   consent disclosure — going forward the Studio's locked consent badge (03 §2b)
   makes this automatic.

## 7. Honest residual gaps (do not treat as settled)

Public comment-replies confirming POM prices: no ruling either way — treat as
high-risk, route to DM (reasoned, not sourced). NMC "strike-off for Botox ads" warning:
trade-press corroborated, not loaded from nmc.org.uk. Meta radius minima and the
reported health-domain pixel-event stripping: industry-corroborated, not
Meta-documented. All CPM/CPC/CPL figures: national estimates with ~60% inter-source
spread — calibrate with our own first 90 days. facesconsent's logged-in "Business
Insights"/"Marketing tools": unknown without a login; whether a completed booking
redirects anywhere trackable: untestable without a real booking.
