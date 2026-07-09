# rx-item schema was missing the required `price` field

## Context

decisions/00002(d) decided the rx-item shape was `{title: str, body: str}` — "price/detail
living in the free-form rich-lite `body`" — reasoned from the spec's compact "rx accordions"
table entry (02 §6) without checking the real markup closely enough.

Reading `pages/treatments.html`'s three `<details class="rx">` accordions (Milestone 4 step
3 prep, ahead of annotating that page) shows each one has a THIRD, structurally distinct
element between the summary and the body paragraph:

```html
<details class="rx">
  <summary><h3>Botox®</h3><span class="rxhint">View details</span></summary>
  <div class="rxbody">
    <div class="rxprice">Full Face — £330 &nbsp;·&nbsp; Three Areas — £220</div>
    <p>Temporarily relaxes carefully selected facial muscles…</p>
    <p style="margin-top:1rem"><a class="btn btn-olive" href="index.html#contact">Enquire</a></p>
  </div>
</details>
```

`.rxprice` is its own `<div>` with its own CSS rule (`color:var(--clay);margin:.2rem 0
1rem;font-size:1.05rem` — visually a price/subtitle line, styled differently from the body
copy right below it). Folding it into the rich-lite `body` would mean either losing that
distinct styling (rendering it as an ordinary paragraph) or asking the rich-lite sanitizer
to preserve a `.rxprice`-classed div inside free-form content it wasn't designed to carry
(rich-lite's allowed inline tags are `strong`/`br`/`span[class]` — see 02 §5 — not
block-level divs). Neither is acceptable: it's a value the editor should be able to edit
as its own field, exactly like `treatment-card`'s `price` (decisions/00002 already treats
`treatment-card.price` as its own field for the same visual reason).

## Decision

**rx-item shape is `{title: str, price: str, body: str}`** — all three required.
`builder/schemas/rx-item.schema.json` now requires `price` alongside `title`/`body`. No
change needed to `builder/collections.py` (the schema file is the only place the shape is
declared; `COLLECTION_RULES`'s `rx.items → rx-item` mapping already routes through it) or
to `builder/validate.py` (generic `CollectionRule` validation, no special-casing needed).
Added `test_rx_item_schema_violation` to `builder/tests/test_validate.py` (no prior test
exercised this schema at all — 00002(d) shipped without one).

The enquire link (`<a class="btn btn-olive" href="…">Enquire</a>`) inside each `.rxbody`
stays out of the schema, same treatment as index.html's static CTA text precedent (CA
decisions/00001) — it's fixed template structure, not per-item content.

## What to watch for

- `content/treatments.json`'s `rx.items` entries need a `price` value for each of the 3
  accordions (Botox®, Relfydess®, Vitamin B12 Complex Injections) — read directly off the
  `.rxprice` div text for each, verbatim including the `·` separator formatting.
- Same standard applies to every remaining page: read the REAL markup closely before
  trusting a previously-decided schema/pattern, per the handover note this decision
  responds to. decisions/00002 is NOT edited in place (decisions are append-only) — this
  entry is the correction of record.
