"""Provision Cottage Aesthetics bookable treatments into Wix Bookings.

Idempotent: skips services whose name already exists, so it is safe to re-run.
Auth: reads WIX_API_KEY from the environment (Wix account API key for the
account that owns the site). Site + default-staff IDs are constants below.

Run (PowerShell):
  $env:WIX_API_KEY = [Environment]::GetEnvironmentVariable('WIX_API_KEY','Machine')
  python tooling/provision_bookings.py

NOTE: prescription-only treatments (Botox, Relfydess, Vitamin B12) and
"Facial Rebalancing" (price after consultation) are intentionally NOT created
here - they are Enquire-only per the brief and must not be directly bookable.
"""
import os, httpx

KEY = os.environ["WIX_API_KEY"]
SITE = "c721738f-2644-49e8-8865-fc10865db30f"
STAFF = "1c41ada4-0c28-47dc-8d76-bf31e0776abf"  # "Business Owner" default staff resource
H = {"Authorization": KEY, "wix-site-id": SITE, "Content-Type": "application/json"}

QUERY_URL = "https://www.wixapis.com/bookings/v2/services/query"
CREATE_URLS = [
    "https://www.wixapis.com/_api/bookings/v2/services",
    "https://www.wixapis.com/bookings/v2/services",
]

# (name, minutes, price GBP or None for free, description)
SERVICES = [
    ("Consultation", 30, None,
     "Every journey begins with a consultation. A relaxed, no-pressure chat so you feel fully confident in both your chosen treatment and your practitioner before making any decisions."),
    ("Standard Microneedling", 45, "30.00",
     "Stimulates your skin's natural collagen and elastin to improve texture, reduce acne scarring and soften fine lines for healthier, brighter skin. Completed using pure Hyaluronic Acid serum. Includes consultation. Course of 5 available for GBP 120."),
    ("Advanced Microneedling", 45, "80.00",
     "Collagen induction therapy combined with premium medical-grade skincare (Derma 2.0 / Newest) tailored to your concerns. Ideal for ageing, pigmentation, acne scarring and skin rejuvenation. Includes consultation."),
    ("Skin Booster - Jalupro Super Hydro", 45, "150.00",
     "Deeply hydrates while improving elasticity, firmness and overall skin quality. Often called a '5-point facelift' - subtle lifting and rejuvenation from within."),
    ("Skin Booster - Profhilo", 45, "230.00",
     "A premium skin booster that intensely hydrates and remodels the skin, improving firmness, elasticity and radiance with a natural, refreshed result."),
    ("Polynucleotides", 45, "150.00",
     "Encourages the skin's natural repair process - stimulating collagen, improving hydration and skin quality, and supporting tissue regeneration. Suitable for face, neck, hands and decolletage. Course of 3 recommended. Product: Newest."),
    ("Under Eye Polynucleotides", 45, "150.00",
     "Designed specifically for the delicate eye area to improve hydration, strengthen the skin, stimulate collagen and reduce crepey skin. Course of 3 recommended. Product: Plinest."),
    ("Dermal Filler - Lip Enhancement", 60, "140.00",
     "Restores hydration, improves symmetry, defines the lip border and creates beautifully balanced lips while maintaining a soft, natural appearance."),
    ("Dermal Filler - Chin Enhancement", 60, "140.00",
     "Improves lower facial balance and profile by adding projection and creating greater harmony between the chin, lips and nose."),
    ("Dermal Filler - Cheek Enhancement", 60, "200.00",
     "Restores youthful volume, enhances cheekbone definition and provides subtle lifting to the mid-face for a refreshed appearance."),
    ("Dermal Filler - Jawline Contouring", 90, "290.00",
     "Creates improved jawline definition, enhances facial proportions and sculpts the lower face while maintaining natural results."),
]


def build(name, minutes, price, desc):
    if price is None:
        payment = {"rateType": "NO_FEE",
                   "options": {"online": False, "inPerson": True, "deposit": False, "pricingPlan": False}}
    else:
        payment = {"rateType": "FIXED",
                   "fixed": {"price": {"value": price, "currency": "GBP"}},
                   "options": {"online": True, "inPerson": True, "deposit": False, "pricingPlan": False}}
    return {"service": {
        "type": "APPOINTMENT",
        "name": name,
        "description": desc,
        "defaultCapacity": 1,
        "onlineBooking": {"enabled": True, "requireManualApproval": False, "allowMultipleRequests": False},
        "payment": payment,
        "schedule": {"availabilityConstraints": {"sessionDurations": [minutes]}},
        "staffMemberIds": [STAFF],
    }}


def existing_names():
    r = httpx.post(QUERY_URL, headers=H, json={"query": {"paging": {"limit": 100}}}, timeout=30)
    r.raise_for_status()
    return {s.get("name"): s.get("id") for s in r.json().get("services", [])}


def create(body):
    last = None
    for url in CREATE_URLS:
        resp = httpx.post(url, headers=H, json=body, timeout=30)
        last = resp
        if resp.status_code < 300:
            return resp, url
        if resp.status_code != 404:
            return resp, url
    return last, CREATE_URLS[-1]


def main():
    have = existing_names()
    print(f"Existing services: {len(have)}")
    created = 0
    for (name, minutes, price, desc) in SERVICES:
        if name in have:
            print(f"  SKIP (exists): {name}")
            continue
        resp, _ = create(build(name, minutes, price, desc))
        if resp.status_code < 300:
            sid = resp.json().get("service", {}).get("id", "?")
            created += 1
            print(f"  CREATED: {name}  ({minutes}m, {'FREE' if price is None else 'GBP '+price})  id={sid}")
        else:
            print(f"  FAIL: {name}  [{resp.status_code}] {resp.text[:250]}")
    print(f"\nDone. Created {created} new service(s).")
    final = existing_names()
    print(f"Total services now: {len(final)}")
    for n in final:
        print("   -", n)


if __name__ == "__main__":
    main()
