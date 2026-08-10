# 00026 [x01n03] site-repo: migrate internal .html hrefs to clean root-absolute URLs

Full context: sidecar 00017.

## What

Clone `https://github.com/joshcomley/cottage-aesthetics-preview.git` into a SHORT path
(`C:\Users\josh\AppData\Local\Temp\<short>` — deep paths hit "Filename too long"). Branch
`feat/clean-urls`. Migrate (verified list, re-grep `grep -rn '\.html' content/ pages/
partials/ site.js` to be exhaustive):
- `content/_global.json`: 8 footer links (about/treatments/gallery/reviews/contact/faq/
  aftercare/policies `.html`) → `/about` etc.
- `pages/about|aftercare|faq|policies.html`: `href="contact.html"` → `/contact`
- `pages/index.html`: `href="treatments.html"` ×2 → `/treatments`, `href="reviews.html"` →
  `/reviews`
- `pages/treatments.html`: `href="index.html#contact"` ×2 → `/#contact`

Do NOT touch external URLs (Instagram etc.), `data-wx` attributes, or `images/`.
