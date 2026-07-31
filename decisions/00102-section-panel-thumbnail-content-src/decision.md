# Before & After thumbnails were broken images in production

## What happened

Live bug report from the site owner (with a screenshot): every photo thumbnail in the
admin's "Before & After" section editor (`/admin/section/before-after`, decisions/00098,
PR3) rendered as a broken-image icon, for every existing published item (Lip Enhancement,
Lip Definition, etc.) — not just newly-added ones.

Root cause: `sectionPanel.ts`'s `renderImageSlot` (the card-list thumbnail) and
`renderImageStep` (the guided add-flow's own preview) both did `img.src = picked.src`
directly — `picked.src` being whatever is stored verbatim in the item's content JSON, the
CONTENT-JSON form a repo image's src takes (`images/<name>.jpg`, no leading slash;
decisions/00095). This is not a browser-loadable URL on its own: the admin SPA's own
document carries no `<base href="/">` (only `/admin/preview/*.html` gets one,
`preview.py`), so a bare relative path resolves against whatever admin ROUTE happens to be
current — `/admin/section/before-after` + `images/lip-enhancement-after.jpg` resolves to
something like `/admin/section/images/lip-enhancement-after.jpg`, which 404s.

This exact failure mode already has a named fix and a dedicated helper,
`mediaDialog.ts:contentSrcToDisplayUrl(src)` — prepend a `/` if the content-form src
doesn't already have one (a draft-media src, `/admin/draft-media/<name>`, already has one
and passes through unchanged). `pageSettingsDrawer.ts` already uses it correctly for its
own image preview (`img.src = contentSrcToDisplayUrl(current.src)`). `sectionPanel.ts`
(written this same session, PR3) simply never called it — a plain omission, not a subtler
environment-masked bug like the two chat-activity incidents earlier this session.

## Why every test passed anyway

Not one existing test — vitest OR Playwright — asserted anything about a thumbnail
`<img>` element's `src` attribute at all. `sectionPanel.test.ts`'s card-rendering tests
checked card COUNT and op-queue payloads; `section-panel.spec.ts`'s e2e journey checked
text-field values and the published HTML's own content, never the admin panel's own
thumbnail elements. This is a plain coverage gap, not a masked assumption: nobody wrote
the assertion, so nothing could have failed.

(A contributing factor, had a naive test existed: a vitest/JSDOM assertion checking the
JSDOM-*resolved* `img.src` property rather than the raw `getAttribute("src")` would ALSO
have passed on the buggy code, because JSDOM's own default test-document location is
root-relative — the exact non-root-admin-route problem `contentSrcToDisplayUrl`'s own
docstring warns about doesn't reproduce unless the test asserts the literal attribute
value, matching `pageSettingsDrawer.test.ts`'s own established convention. The tests added
here follow that convention specifically to avoid this trap.)

## The fix

`sectionPanel.ts` now imports and calls `contentSrcToDisplayUrl` at both call sites
(`renderImageSlot`'s card thumbnail, `renderImageStep`'s add-flow preview) — the same
one-line pattern `pageSettingsDrawer.ts` already used correctly.

New coverage that would have caught this, RED-confirmed against the reverted bug before
being GREEN-confirmed against the fix:
- `sectionPanel.test.ts`: a new test asserting a card's thumbnail `getAttribute("src")`
  for both a repo-form src (gains a leading slash) and an already-absolute draft-media
  src (passes through unchanged); an assertion added to the existing guided-add-flow test
  checking the picked-image preview's `src` the same way.
- `section-panel.spec.ts`: after Pair #1 is saved via the real guided flow (a real
  upload, not a fake), asserts both thumbnails' `naturalWidth > 0` in a real browser —
  proof the image was actually fetched and decoded, not just that an `<img>` tag with
  some src exists in the DOM.

## What to watch for

- **Any new admin-ui code that displays a picked/stored image outside the live-preview
  iframe must go through `contentSrcToDisplayUrl`, never render `picked.src`/a raw
  content-JSON src directly.** The iframe is the one context that's exempt (it gets a real
  `<base href="/">`, per `contentSrcToDisplayUrl`'s own docstring) — anything else in the
  admin SPA's own DOM needs the conversion.
- **A thumbnail/preview `<img>` element existing in the DOM is not evidence it rendered.**
  Test its `src` attribute value directly (not a JSDOM-resolved property) in unit tests,
  and assert `naturalWidth > 0` (not mere DOM presence) in e2e — this is the same
  "assert the real observable, not a proxy for it" discipline this project's testing
  guidance already states elsewhere, just not yet applied to image thumbnails
  specifically until now.
