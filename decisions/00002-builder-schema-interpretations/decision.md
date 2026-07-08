# Builder v1: schema validator + collection-shape interpretations

## Context

spec/02-content-model.md §10 requires "collection arrays match their item schemas (fixed
JSON Schemas in `builder/schemas/*.json` — covering hours, gallery sliders incl. `sub`,
gallery tiles, reviews items, treatment cards incl. `book`/`course`, rx items, navExtra,
footer links)". Implementing this raised one tooling question and a few content-shape
ambiguities the spec states only informally. Recorded here per "where reality contradicts
a spec-cited fact... record a decisions/ entry" — none of these are contradictions, just
underspecified details resolved with the most spec-consistent reading, not escalated to
the spec author per KICKOFF-PROMPT's "everything smaller: decide per spec + fleet rules".

## Decisions

1. **No `jsonschema` PyPI dependency.** Milestone 1's pyproject.toml dependency list
   (spec/09-work-plan.md row 1) doesn't include a JSON Schema library, and the full
   `jsonschema` package's error format doesn't map cleanly onto our `file:key` reporting
   convention (04 §8's RFC7807-ish errors, 02 §10's "precise file:key error"). Wrote
   `builder/jsonschema_lite.py`: a ~70-line validator supporting exactly the vocabulary
   `builder/schemas/*.json` actually uses (`type`, `required`, `properties`,
   `additionalProperties`, `items`, `enum`, `pattern`). The schema files themselves are
   genuine, valid JSON Schema documents — only the validator implements a subset.

2. **`COLLECTION_RULES` (the collection-key → schema mapping) is hardcoded in
   `builder/collections.py`, not made per-project-configurable.** This looked at first
   like it might conflict with decision #9 in decisions/00001 (engine generic over
   projects, no `cottage`-specific string literals in engine code paths). Resolution:
   keys like `treatments.cards`/`rx.items`/`gallery.sliders` are part of 02's own
   **normative content-model contract** ("the builder, the editor overlay, the admin API
   and the AI agents all program against this contract") — fixed v1 vocabulary, not
   Cottage-Aesthetics business data (prices, treatment names, copy). Decision #9's
   genericity is about the engine *machinery* (registry, per-slug state) supporting
   multiple projects structurally; a second project in some future version would need
   its own collection vocabulary, which is out of v1's scope.

3. **Gallery tile shape is `{cat: str, title: str, img: {src: str, alt: str}}`**, not
   four flat top-level fields. 02 §6's compact table literally writes `tiles {cat, title,
   img, alt}` alongside sliders' `{cat, title, sub, before, after}` (where `before`/
   `after` are unambiguously nested image objects). Since `data-wx-img` always resolves
   to a `{src, alt}` object (02 §2, normative), a flat top-level `alt` sibling to `img`
   would be redundant with the alt already inside `img` — read the table's "img, alt" as
   shorthand for "an image field (which carries its own alt)", not two separate keys.
   `builder/schemas/gallery-tile.schema.json` encodes this reading.

4. **rx-item shape is `{title: str, body: str}`** (an accordion: `<details><summary>`
   title + expandable rich-lite body). Not spec'd explicitly beyond "rx accordions" (02
   §6) — this is the minimal shape that fits "prescription-only pricing revealed only
   after selecting the treatment" (brief.md) with price/detail living in the free-form
   rich-lite `body`, mirroring how `faq.items` presumably works (not itself schema'd —
   absent from 02 §10's enumerated list, so builder v1 doesn't schema-validate it either).

5. **Nav items and footer-column links share one shape: `{label: str, href: str}`.**
   `navExtra` (`_global.json`) and the builder-computed `@nav` array use this shape (02
   §3); `footer.*` columns are validated the same way since 02 §3's own example writes
   `"footer": {"…": "columns/links as lists"}` — deliberately not naming real column keys
   yet (that's a migration-time, not builder-time, decision). `_validate_collections`
   therefore treats `footer` as a wildcard: every list found nested under it, regardless
   of column name, is checked against `builder/schemas/footer-link.schema.json`.

## What to watch for

- If migration (03/M3-M5) or a future schema change needs a *different* gallery-tile or
  rx-item shape than what's decided here, update `builder/schemas/*.json` **and** this
  entry — don't let the fixture mini-site's shape silently become the de facto spec.
- `_validate_collections`' `sections[].cards` and `footer.*` special cases
  (`builder/validate.py`) are the only two collection checks that don't fit the flat
  `CollectionRule` table — if a future collection needs similar nested-wildcard handling,
  follow that pattern rather than trying to force-fit `CollectionRule`.
