# Overlay chrome (eye toggles) can never leak into committed content values

## Symptom

The production ca draft (2026-07-19, rev 59) contained, staged for publish:

```json
{"day": "Monday", "value": "<button type=\"button\" class=\"wx-if-eye-toggle\" …>👁️</button>👁️10:00 – 19:00"}
```

— in every row of `_global:hours` and in `index:treatments.cards` course fields.
Had the operator hit Publish, the live site would have rendered literal 👁️
characters in the opening hours (build-time sanitize strips the `<button>` tag
but keeps its text). Found while investigating an unrelated operator question.

## Root cause

`ensureIfToggle` (overlay.ts) injects the `data-wx-if` eye-toggle button as a
CHILD of the bound content element at boot — including elements that are ALSO
text-bound (the ca hours template's
`<span data-wx-if=".closed" data-wx=".value">` pattern). Three read paths then
captured the chrome as if it were content:

1. `readScalarValue` / `readItemValue` (contentModel.ts) read text values via
   raw `el.innerHTML` — so any item-scoped commit (which re-emits the WHOLE
   list array, spec/02 §6/§8) swept every sibling's toggle markup into the op.
   Clicking an eye toggle itself triggers exactly this path.
2. `isRichLiteContent` (dom.ts) counted the toggle button as an element child,
   reclassifying plain text bindings as rich-lite — so the rich popover opened
   seeded with the button markup itself.
3. Popover seeds used raw `textContent`/`innerHTML`, picking up the toggle's
   👁️ label text.

Two secondary losses of the toggle itself: `applyValueToElement` and
`blankTextLikeFields` overwrite `innerHTML`, silently deleting the toggle until
the next reload.

The prod draft was remediated via the admin API (PATCH with chrome-stripped
values, preserving the operator's genuine edits — Wednesday's "Closed" and
three treatment-card body rewrites) once the clock-skew fix
(decisions/00072) unblocked service-token access.

## Decision

One invariant, enforced at every read boundary: **overlay chrome is stripped
before any DOM value crosses into a committed value or an editor seed.**

- `dom.ts` exports `OVERLAY_CHROME_SELECTOR` (`.wx-if-eye-toggle`), and
  `isRichLiteContent` ignores chrome children.
- `contentModel.ts` reads text values from a chrome-stripped CLONE
  (`chromeFreeInnerHtml` / `chromeFreeTextContent`), never the live element.
- All popover seeds (text, rich-lite, link label) use those readers.
- `applyValueToElement` and `blankTextLikeFields` re-attach the eye toggle
  after overwriting an if-bound element's `innerHTML`.

Rejected alternatives: stripping chrome at the SERVER on draft write (draft
values are kind-heterogeneous — sanitize would corrupt URLs/meta strings; the
kind-aware version is follow-up work, not a substitute for not-leaking);
temporarily detaching toggles around reads (mutation-window fragility for no
gain over cloning).

## What to watch for

- Any FUTURE chrome injected into content elements (today only the eye toggle)
  must join `OVERLAY_CHROME_SELECTOR` or it leaks.
- The strip selector is deliberately chrome-specific, not `button` — bound
  content may legitimately contain allowlist markup.
- The `data-wx=".value"` dual-span pattern in the ca hours template (same key
  bound on both the closed and open variant) means `readItemValue`'s first
  match always reads the closed variant's copy; harmless only because the
  builder renders both spans with the identical value.
