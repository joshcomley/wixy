# Cottage Aesthetics — Design & Content Blueprint

Single source of truth for the site build. Derived from the client brief
(`brief.md`) and the clinic photos (`photos/`). Keep this current as decisions
are made.

## Brand essence
Nurse-led medical aesthetics clinic in Hartlebury, founded by **Purdi** (RN,
15+ yrs NHS/private, plastic surgery & dermatology background; Level 7 Aesthetic
Medicine in progress). Known to regulars as **"The Cottage"** — a peaceful
countryside retreat, not a busy high-street clinic.

Feeling: **calm · elegant · understated luxury · natural · welcoming ·
professional · trustworthy.** More "beautiful countryside cottage" than clinic.
Never sales-driven, flashy, or overly clinical.

## Visual language (from photos)
- Limewash / polished-plaster walls; arched niches; oak floors & barn doors.
- Olive trees, aloe, citrus; dried gypsophila in an ochre antique pot.
- Antique-brass fittings, cane/boucle seating, marble tops, warm lamps.
- Exterior: limewash render, sage stable-door, olive trees in ribbed stone pots.
- Logo: olive-green roundel, antique-brass line-art cottage + olive branches,
  "COTTAGE AESTHETICS · NURSE AESTHETICIAN". Wall wordmark: script *Cottage* +
  spaced serif *AESTHETICS* with a small olive sprig.

## Palette (starting hexes — refine on the live page)
- Olive green (primary): `#6E7357`
- Limewash / soft stone (bg): `#EDE7DA`
- Warm off-white: `#F6F2EA`
- Anthracite (text): `#2F2E2B`
- Soft terracotta / ochre (accent): `#C57B54`
- Natural oak (warm neutral): `#B08A5E`
- Antique brass (fine accents/lines): `#A88A4F`

## Typography direction
- Headings: an elegant serif (understated, not glam) — e.g. Cormorant /
  Fraunces / EB Garamond feel.
- Body: a clean humanist sans (calm, readable) — e.g. Jost / Mulish / Nunito Sans.
- Generous white space; airy line-height; nothing crowded.

## Photography
Light, airy, calming, minimally edited. Hero = clinic exterior/interior.
Professional photo of Purdi on Home + About. Avoid clinical/harsh/flashy.

## Site map & navigation
Main menu: **Home · About · Treatments · Before & After · Reviews · Book Now ·
Contact.** Every page has an easy-to-find **Contact** button. A **Book Now**
button appears throughout **except** on prescription-only treatments.
Also: **FAQ · Aftercare · Clinic Policies** (footer/secondary).

### Home
Hero image of the clinic; warm welcome intro; short "About Me" with Purdi's
photo; intro to The Cottage; "Why choose Cottage Aesthetics"; CTAs: **View
Treatments · Book Now · Contact Me.**

### About
Purdi's full story (see brief), My Philosophy, The Cottage (location, privacy,
parking, longer appointments, calm atmosphere).

### Treatments
Overview grouped by category; each treatment links to its own detail page with:
overview, benefits, duration, price, **Book** button (bookable) or **Enquire**
button (prescription-only), and a Contact button.

### Before & After
Gallery organised by treatment type (filter/dropdown). Genuine before/after
photos. (Populate later — needs client images + consent.)

### Reviews
Genuine testimonials. Integrate **Google Reviews** to auto-update if feasible.

### Contact
Contact form (GDPR-compliant), Google Map, opening hours, easy-parking note,
social links.
- Purdi · 07401 562462 · Cottageaestheticshartlebury@gmail.com
- 8 Walton Cottage, Walton Road, Hartlebury, Kidderminster, DY10 4JA

**Opening hours** (from the clinic's Google Business Profile, verified via headed browser):
| Mon | Tue | Wed | Thu | Fri | Sat | Sun |
|---|---|---|---|---|---|---|
| 10:00–19:00 | 10:00–19:00 | 10:00–19:00 | 10:00–19:00 | 10:00–17:00 | 11:00–16:00 | Closed |

**Reviews:** 5.0★ on Google (genuine 5-star reviews captured to
`docs/google-reviews.json`). Demo section built (`reviews-demo.html`) — NOT to be
published to the live site without Purdi's explicit permission.

## Treatment catalogue (source of truth)

### Bookable (show **Book** button) — provisioned in Wix Bookings
| Treatment | Duration | Price | Notes |
|---|---|---|---|
| Consultation | 30 min | FREE | Every journey begins here |
| Standard Microneedling | 45 min | £30 | Course of 5 £120; incl. consultation; HA serum |
| Advanced Microneedling | 45 min | £80 | Derma 2.0 / Newest; incl. consultation |
| Skin Booster — Jalupro Super Hydro | 45 min | £150 | "5-point facelift" |
| Skin Booster — Profhilo | 45 min | £230 | |
| Polynucleotides | 45 min* | £150 | Course of 3 rec; face/neck/hands/décolletage; Newest |
| Under Eye Polynucleotides | 45 min* | £150 | Course of 3 rec; Plinest |
| Dermal Filler — Lip Enhancement | 60 min | £140 | |
| Dermal Filler — Chin Enhancement | 60 min | £140 | |
| Dermal Filler — Cheek Enhancement | 60 min | £200 | |
| Dermal Filler — Jawline Contouring | 90 min | £290 | |

\* duration assumed (brief did not specify) — confirm with Purdi.

**Facial Rebalancing & Rejuvenation** — *price after consultation* → **Enquire**
(not a fixed bookable service).

### Prescription-only (show **Enquire**, NOT Book) — NOT in Wix Bookings
Pricing/details must be **≥2 clicks from the homepage** (revealed only after
selecting the treatment). Client cannot book directly; Enquire → prescription
consultation to determine suitability.
| Treatment | Price |
|---|---|
| Botox® — Full Face | £330 |
| Botox® — Three Areas | £220 |
| Relfydess® | £280 (intro; prescription consult required) |
| Vitamin B12 Complex — single | £45 |
| Vitamin B12 Complex — course of 5 | £120 |

## Additional requirements
Mobile-friendly; simple online booking; GDPR-compliant forms; FAQ; Aftercare;
Clinic Policies (deposits, cancellations, late arrivals).

## Build status / open items
- [x] Wix Bookings app installed; 11 bookable services provisioned via API.
- [x] Opening hours obtained from Google (see Contact). TODO: apply them to
      Bookings availability + confirm business **location** (none set yet) so
      appointment slots go live.
- [ ] Rename default staff "Business Owner" → "Purdi".
- [ ] Bookings categories (Consultation / Microneedling / Skin Boosters /
      Polynucleotides / Dermal Fillers) — group services.
- [ ] Enquire flow for prescription-only treatments (backend + form).
- [ ] Page layouts (editor / Local Editor) per this blueprint.
- [ ] Google Reviews integration; Before/After gallery content; FAQ/Aftercare/
      Policies copy.
