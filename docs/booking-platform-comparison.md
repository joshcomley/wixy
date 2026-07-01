# Booking + Consent Platform Comparison — Cottage Aesthetics

**Goal:** replace/augment Faces Consent so booking integrates **natively** (developer
API / webhooks / embeddable widget) into the bespoke coded website, while keeping
medical-aesthetics consent forms + client records/prescribing.

Every API/widget/integration claim below was verified against a real page (fetched);
"unconfirmed" = could not be confirmed from a real page.

## Comparison

| Platform | Aesthetics consent | Booking+pay | Public API / webhooks | Embed widget/iframe | UK / prescribing | Rough price | Native-integration fit |
|---|---|---|---|---|---|---|---|
| **Faces** (current) | Yes (core) | Booking yes; no native card pay | **No API, no webhooks** | **No** — hosted link/redirect only | UK; prescribing yes | Custom; booking free | **Impossible** — link-out only |
| **Pabau** | Yes (face-mapping, med-spa) | Yes (Stripe) | **Yes REST + webhooks** | **Yes** (JS embed) | UK; **e-prescribing yes** | ~£125–225/user/mo | **Strong (moderate effort)** |
| **Semble** (ex-HeyDoc) | Via questionnaire engine | Yes (Semble Pay) | **Yes GraphQL + webhooks** | **Yes** (true iframe) | UK; prescription objects | Quote | **Deepest API** |
| **Cliniko** | Partial (generic forms) | Yes (Stripe) | API yes; **webhooks NO** | **Yes** (embed snippet) | UK; no e-prescribing | ~US$45/mo/practitioner+ | **Simplest/cheapest** |
| **Meddbase** | Partial (generic) | Yes | **Yes REST + webhooks** | Unconfirmed | UK; prescribing yes | ~$50–150/user/mo | Low-mod but heavyweight |
| **ClinicMinds** | Likely (aesthetics EMR) | Yes (Stripe) | Booking API + webhooks | Unconfirmed | UK; e-prescribing | Quote (API paid add-on) | Moderate (docs gated) |
| **Phorest** | Yes (med-spa) | Yes | REST yes; **webhooks NO** | **Yes** (iframe/widget) | UK; prescribing not evidenced | Quote | Moderate (API gated) |
| **e-clinic** | Partial/unconfirmed | Unconfirmed | REST+webhooks (gated, no public docs) | Unconfirmed | **UK; prescribing yes** | Quote | Unknown until sales call |
| **Fresha** | Partial (medspa) | Yes | **No public API (410 Gone)** | Yes (Book button) | UK; no prescribing | £14.95/mo solo+fees | Widget only, no sync |
| **Timely** | Partial (templates) | Yes | **No public API** (Zapier only) | Yes (script) | UK; no prescribing | Tiered | Widget only |
| **Kitomba** | Partial | Yes | No public API found | No (hosted link) | UK; no prescribing | Quote | Link-out only |
| **Jane App** | Yes (strong charting) | Yes | Partner-gated only; no self-serve/webhooks | Unconfirmed | UK usable; no e-prescribing | ~£8/practitioner/mo | Partner program required |
| **Consentz** | Yes (consent-centric) | Yes | **No API** | Booking link only | UK; prescribing unconfirmed | ~$49/mo | Link-out only |

## Shortlist (best for native booking + medical consent)
1. **Pabau** — aesthetics-native + UK e-prescribing + REST API + webhooks + embeddable widget. Directly replaces every Faces function AND integrates natively. Watch: per-user/add-on pricing — get an all-in quote.
2. **Semble** — deepest/most flexible API (GraphQL + webhooks + iframe + Semble Pay), UK private-healthcare origin. Trade-off: general EMR, so aesthetics consent/prescribing templates are built via its questionnaire engine.
3. **Cliniko** — lowest-friction dev experience (public REST API + one-line embed + Stripe), transparent low price. Trade-off: generic consent (no injection-site mapping), no webhooks (poll), no e-prescribing.

## Is staying with Faces viable?
**No, not for native integration.** Confirmed: Faces has **no developer API, no webhooks, no embeddable/iframe widget** — only a hosted redirect "Booking link" (which is what the current site embeds via iframe). Faces is excellent for UK aesthetics consent + prescriptions, but is a dead-end for deep integration. Switching is justified *specifically* by the integration requirement.

## Consent-but-no-usable-API (no better than Faces for integration)
Consentz, Kitomba, Fresha (API gone), Timely (Zapier only), Jane (partner-gated).

## Verify before committing
- Exact all-in UK pricing (Pabau/Semble are quote-based).
- That Pabau's API exposes appointment-**write** endpoints for a fully custom booking UI.
- That aesthetics-specific consent/prescribing templates meet compliance on Semble/Cliniko.

_Note: "Noteable" was investigated but resolves to unrelated products (a wine-tasting app / a US behavioural-health EHR) — no UK aesthetics product; confirm the exact name if the client meant something specific._
