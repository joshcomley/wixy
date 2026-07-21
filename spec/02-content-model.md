# 02 — Content model: templates, bindings, JSON, theme

This file is **normative**. The builder, the editor overlay, the admin API and the AI agents
all program against this contract. Change it only with a decision-log entry.

## 1. The three layers

| Layer | Lives in | Edited by | Examples |
|---|---|---|---|
| **Templates** | site repo `pages/*.html`, `partials/*.html` | AI chat lane (structural changes), humans via PRs | section layout, new page scaffold, classes |
| **Content** | site repo `content/*.json` | Visual editor (draft → publish) and AI | headline text, prices, image refs, nav labels, hours |
| **Theme** | site repo `theme/theme.json` | Visual editor theme panel and AI | colors, fonts, shadow/radius tokens |

Published output = deterministic function `build(templates, content, theme) → static site`.
No runtime database for the public site: the JSON **is** the database, git **is** the history.

## 2. Binding attributes (the `data-wx-*` contract)

Annotations live on template elements. They are **kept in published HTML** (they are inert,
cost a few bytes, and let the editor overlay target the live DOM without a parallel map).

| Attribute | Meaning | Bound value |
|---|---|---|
| `data-wx="<key>"` | element **innerHTML** is bound | string (rich-lite HTML, see §5) |
| `data-wx-img="<key>"` | `<img>` `src` + `alt` bound | `{"src": "images/x.jpg", "alt": "…"}` |
| `data-wx-href="<key>"` | element `href` bound | string (URL or path) |
| `data-wx-bg="<key>"` | element CSS `background-image` bound (hero) — builder writes an inline `style="background-image:url(…)"` on the element | same image object as `data-wx-img` |
| `data-wx-attr="<attr>:<key>[,<attr2>:<key2>]"` | the listed attributes are bound (e.g. `data-booking-url`) | string per attr |
| `data-wx-list="<key>"` | container is a **collection**; bound to an array | array of objects |
| `data-wx-list-item` | marks the item template **inside** a list container | — |
| `data-wx-if="<key>"` | element removed from **published** output when the value is falsy; **preview mode retains it** with `data-wx-hidden="1"` (04 §4, so the editor can reach it). Truthiness = JS-falsy rules (`false`/`null`/`""`/`[]` are falsy). A leading `!` negates (`data-wx-if="!.book"`) | any |

Key resolution:

- A plain key (`hero.title`) resolves in the **page's own** content file (`content/<page>.json`),
  via dotted path.
- An `@`-prefixed key (`@phone`, `@nav`) resolves in **`content/_global.json`**. Partials use
  `@` keys exclusively.
- Inside a `data-wx-list` item template, a **`.`-prefixed** key (`.title`, `.img`) resolves
  relative to the current array item. Nested lists are allowed (relative keys nest).

Rules:

- Every text node a human might ever want to change MUST be covered by a binding. The
  migration (03) enforces this page by page.
- A binding key MUST exist in the JSON; the builder **fails the build** on a missing key
  (strict — no silent fallback to template text; template text is dev-time placeholder only).
- Unbound literal text is allowed only for pure structure/decoration (e.g. the `❦` sprig,
  `★★★★★` glyphs) — and even those SHOULD be bound if trivially possible.
- IDs/classes are never bound (structure belongs to templates).

## 3. Content files

One JSON file per page (`content/index.json`, `content/about.json`, …, matching
`pages/<slug>.html`) plus `content/_global.json`. UTF-8, 2-space indent, keys sorted at
write time (stable diffs — the publisher rewrites files canonically). **The home page's
slug is `index`** everywhere the model threads (template `pages/index.html`, content
`content/index.json`, overlay prefix `index:`, editor route `#/edit/index`); the value
`home` survives only in `<body data-page="home">` as a CSS/JS hook.

Every **page** file has a reserved `meta` object consumed by the builder head-injection
(no annotation needed):

```json
{
  "meta": {
    "title": "Cottage Aesthetics — Nurse-led aesthetics in Hartlebury",
    "description": "A calm countryside retreat for natural, nurse-led medical aesthetics…",
    "ogImage": {"src": "images/lounge.jpg", "alt": "The Cottage lounge"},
    "navLabel": "Home",
    "inNav": true,
    "navOrder": 10
  },
  "hero": {
    "eyebrow": "Nurse-led medical aesthetics · Hartlebury",
    "title": "Cottage Aesthetics",
    "tag": "Natural, considered aesthetics — in a calm countryside retreat…",
    "bg": {"src": "images/lounge.jpg", "alt": ""}
  },
  "treatments": {
    "cards": [
      {
        "meta": "Skin health",
        "title": "Microneedling",
        "price": "From £30",
        "body": "Stimulates natural collagen…",
        "course": "",
        "book": true
      }
    ]
  }
}
```

Card CTA pattern (used on the home teasers and the treatments page): the item template
carries **two sibling anchors** — the Book anchor gated `data-wx-if=".book"`, the Enquire
anchor gated `data-wx-if="!.book"` — so one boolean drives which renders; optional lines
(e.g. `.course`) pair `data-wx-if=".course"` with `data-wx=".course"` (empty string =
hidden).

`_global.json` reserved shapes (exact keys fixed by migration, but MUST include):

```json
{
  "brand": {"line1": "Cottage", "line2": "Aesthetics"},
  "navExtra": [],
  "bookingUrl": "https://facesconsent.com/bookings/purdi-hadley",
  "phone": "07401 562 462",
  "phoneHref": "tel:07401562462",
  "email": "cottageaestheticshartlebury@gmail.com",
  "address": ["8 Walton Cottage, Walton Road,", "Hartlebury, Kidderminster, DY10 4JA"],
  "social": {"instagram": "https://www.instagram.com/cottageaesthetics", "facebook": "…"},
  "hours": [{"day": "Monday", "value": "10:00 – 19:00", "closed": false}],
  "footer": {"…": "columns/links as lists"}
}
```

The **nav is builder-generated, never stored**: `@nav` does not exist in `_global.json`.
The builder derives it at resolve time — pages with `meta.inNav: true` ordered by
`meta.navOrder`, followed by any explicit `_global.json.navExtra` items — and **injects it
into the resolved content BEFORE validation**, so the header partial's and mobile menu's
`data-wx-list="@nav"` bindings resolve like any other key. Nav editing therefore happens
through the page-settings panel (`meta.*`) and the `navExtra` list, never as a direct
list binding (the editor must not offer `@nav` item editing). Page discovery for the
build is `pages/*.html`.

## 4. Theme

`theme/theme.json`:

```json
{
  "colors": {
    "cream": "#F1E8D9", "cream-2": "#EADFCB", "oat": "#E4D6BE",
    "mocha": "#5E4635", "coffee": "#3E312A", "coffee-soft": "#6B584C",
    "clay": "#B26E4A", "clay-deep": "#9A5C3B",
    "olive": "#6E7357", "olive-deep": "#565b43",
    "brass": "#A98A54", "line": "#d9c9ad"
  },
  "shadow": "0 18px 44px rgba(62,49,42,.14)",
  "fonts": {
    "serif":  {"family": "Cormorant Garamond", "weights": ["400","500","600"], "italics": true},
    "sans":   {"family": "Jost", "weights": ["300","400","500"], "italics": false},
    "script": {"family": "Pinyon Script", "weights": ["400"], "italics": false}
  }
}
```

Color keys ARE the CSS variable names minus the `--` prefix (kebab-case, digits included:
`cream-2` → `--cream-2`, exactly what `site.css` consumes) — no name mapping exists.
Builder emits **`theme.css`**:

```css
:root{
  --cream:#F1E8D9; /* … every color key as --<key> … */
  --shadow:0 18px 44px rgba(62,49,42,.14);
  --font-serif:'Cormorant Garamond',serif;
  --font-sans:'Jost',system-ui,sans-serif;
  --font-script:'Pinyon Script',cursive;
}
```

and the Google Fonts `<link>` (single combined `css2?family=…` URL derived from `fonts`).
The generated URL need not byte-match today's hand-written one (e.g. per-weight italic
subsets may differ slightly) — the parity harness gates *rendering*, and tests must not
assert the URL string.
Migration (03) moves the `:root` block out of `site.css` into generated `theme.css`, and
replaces every hardcoded `font-family:'Cormorant Garamond'…` in `site.css` with
`var(--font-serif)` etc. Pages link `theme.css` **before** `site.css`.

The editor theme panel edits exactly this file's values: color pickers per token, font
pickers from a curated Google Fonts list (ship ~24 vetted families across serif/sans/script
in the admin UI; arbitrary family names accepted via the "custom" input). Live preview =
setting CSS custom properties + swapping a fonts `<link>` in the iframe — no rebuild.

## 5. Rich-lite text

`data-wx` values are a restricted HTML fragment. Allowlist (enforced server-side on every
draft write with a proper sanitizer, not regex): `a[href,target,rel,class]`, `em`,
`strong`, `br`, `span[class]`. Allowed `class` values on `a`/`span` come from a fixed
allowlist — v1: `js-book` only (the FAQ answer's booking-modal trigger link is
load-bearing). Everything else is stripped; `href` must be http(s)/mailto/tel/relative.
Plain strings are valid values. The editor decides input mode per element: block-level
bindings (`p`, list bodies) get the rich-lite mini-toolbar; heading/label/price bindings get
a plain input (newlines and markup stripped).

**Amendment (2026-07-21, decisions/00075):** values are now **inline-markdown source**
that RENDERS to the rich-lite fragment above: `**bold**` → `strong`, `*italic*` → `em`,
`[label](url)` → `a` (safe schemes only), newline → `br`. Legacy allowlist tags in
source pass through verbatim; the subset is byte-parity between builder and editor
(`builder/markdown_inline.py` ≡ `editor/src/markdownText.ts`, shared fixture). The
sanitize allowlist and its enforcement points are unchanged (sanitize runs FIRST at
build/write; markdown renders after). The per-element rich-lite/plain input split is
replaced by ONE composer for all text (spec/05 §2).

## 6. Collections

A `data-wx-list` container's array is edited as a unit (the draft overlay stores the whole
array under the list key). The editor supports: add (clones the item template's default
value shape — derived from the FIRST existing item with text fields blanked), remove,
reorder (drag or ↑/↓), and per-field editing inside each item via the same binding kinds.
The seven load-bearing collections after migration:

| Key | Where | Items |
|---|---|---|
| `treatments.cards` | index | 6 treatment teaser cards (per-card `book` flag + optional `course`, see §3) |
| `sections[].cards` | treatments page (nested list: 5 category sections → 12 tcards: 11 Book + 1 Enquire via the `book` flag) | tcards |
| `rx.items` | treatments page (its OWN list — the 3 prescription `<details class="rx">` accordions are structurally different from tcards and must NOT share the `sections[]` item template) | rx accordions |
| `faq.items` | faq | 8 `<details>` Q&As |
| `gallery.sliders` + `gallery.tiles` | gallery | sliders `{cat, title, sub, before, after}`; tiles `{cat, title, img, alt}` |
| `reviews.items` | reviews | 9 review cards `{name, text}` (star row + "Google review" attribution are fixed template structure) |
| `@hours` | index + contact | 7 day rows |

Plus `footer.*` link columns in the footer partial (`@nav` is builder-generated — 02 §3 —
and is not an editable list). The gallery AND reviews pages currently build their content
from inline JS arrays — migration converts both to `data-wx-list` markup + content JSON
(gallery JS keeps only drag/filter/lightbox behavior reading the builder-emitted DOM;
the reviews page script is deleted outright — it has no behavior beyond injection).
The treatments page's alternating section backgrounds move from inline `style` attributes
to a class + CSS `nth-of-type` rule so all `sections[]` items share one template.

## 7. Pages

- `pages/<slug>.html` = one published `/<slug>.html` (plus `/` → `index.html`). Slugs are
  `[a-z0-9-]+`. Output URL structure MUST stay identical to the current live site
  (`about.html`, `treatments.html`, … — no breaking of indexed URLs).
- Partials: `partials/header.html`, `partials/footer.html`, `partials/booking-modal.html`
  are injected by the builder at the `<!-- wx:partial header -->` markers each page carries
  (immediately after `<body …>` and before `</body>`). `site.js` no longer builds
  header/footer strings (03 §4).
- The `<head>` is templated per page but `title`/`meta description`/OG tags/fonts link/
  `theme.css` link are builder-managed (from `meta` + theme) — pages keep everything else
  (per-page `<style>` blocks are fine and stay).
- New page = new template + content file (AI lane or admin "duplicate page"), automatic
  sitemap.xml entry, optional nav entry via `meta.inNav`.
- Indexability is a build input (project registry `indexable`, 04 §1): while `false` the
  builder emits a Disallow-all `robots.txt`, adds `<meta name="robots" content="noindex">`
  to every page, and omits `sitemap.xml` (ca.cinnamons.uk must not compete with the
  still-canonical Wix domain until cutover); `true` flips all three.

## 8. Draft overlay (server-side edit state)

The visual editor never writes content files directly. It maintains a **sparse overlay**:

```json
{
  "rev": 41,
  "baseSha": "31fa784…",
  "ops": {
    "index:hero.title":       {"value": "Cottage Aesthetics", "ts": "…", "by": "editor"},
    "index:treatments.cards": {"value": [ …whole array… ], "ts": "…", "by": "editor"},
    "_global:phone":          {"value": "07401 562 462", "ts": "…", "by": "editor"},
    "theme:colors.clay":      {"value": "#B26E4A", "ts": "…", "by": "editor"}
  },
  "pages": {
    "added":   [{"slug": "aftercare-tips", "fromSlug": "aftercare"}],
    "deleted": []
  }
}
```

- Key = `<file>:<dotted.path>` where `<file>` ∈ page slug | `_global` | `theme`.
- Scalar bindings overlay per-key; collections overlay as the whole array (§6).
- **Merge rule:** draft render and publish both compute `content = repo files @ origin/main
  ⊕ overlay` (overlay wins per key). AI-shipped upstream edits to keys you haven't touched
  flow into the draft automatically on the next preview; keys you HAVE touched keep your
  draft value until published or discarded. Single-operator tool: last-writer-wins per key
  is the intended semantic, no CRDT.
- **Page ops** (duplicate/delete, 05 §2) live in the overlay's `pages` block. A duplicated
  page's TEMPLATE is staged at `Storage/…/draft/pages/<slug>.html` (its content file is an
  overlay op `<slug>:*` seeded from the source page); preview resolves templates as
  repo `pages/` ⊕ `draft/pages/`; publish `git add`s staged templates into `pages/` and
  applies `deleted` as `git rm`; discard-draft removes the staging and tombstones; validate
  treats staged pages as real pages (partial markers, meta, bindings all enforced).
- Publishing materializes the overlay into the JSON files, commits, and empties the overlay
  (04 §5). Discard-draft empties it without committing. Individual keys can be discarded.
- The overlay file is `Storage/projects/<slug>/draft/overlay.json`, written atomically
  (tmp + rename) on every accepted PATCH, with `rev` incremented (optimistic concurrency:
  a PATCH carries the `rev` it was based on; stale → 409 and the editor refetches).

## 9. Media

- Canonical images live in the site repo `images/` (published URL `/images/<name>`).
- An upload goes to `Storage/projects/<slug>/draft/media/<hash8>-<slugged-name>.<ext>` and
  is served at `/admin/draft-media/…` for preview; on publish, staged files referenced by
  the overlay are moved into the repo `images/` and committed with the content.
- Server-side processing on upload (Pillow): auto-orient from EXIF, **strip EXIF** (client
  photos = privacy), re-encode JPEG q85 / keep PNG, and resize so the longest side ≤ 2000px
  (configurable per project). Reject files > 15 MB or non-image MIME. SVG uploads are
  rejected in v1 (XSS surface) — SVGs enter via the AI/PR lane only.
- Deleting media from the library only deletes repo files at publish time and only when
  unreferenced by any binding (the publisher does a reference scan).

## 10. Validation

`builder` ships a `validate` mode used by the admin API, the publisher, CI in **both**
repos, and the AI agent (documented in the site repo CLAUDE.md):

- every binding key in every template resolves;
- every content key that looks like an image object points at an existing file (repo
  `images/` or draft staging);
- rich-lite values sanitize to themselves (i.e. are already clean);
- `theme.json` matches its schema (hex colors, known font weight strings);
- every `pages/*.html` has the two partial markers + a `meta` block in content;
- collection arrays match their item schemas (fixed JSON Schemas in
  `builder/schemas/*.json` — covering hours, gallery sliders incl. `sub`, gallery tiles,
  reviews items, treatment cards incl. `book`/`course`, rx items, navExtra, footer links).

Exit non-zero with a machine-readable error list (`--json`) — the admin UI surfaces these
verbatim next to the Publish button; the AI agent runs it before shipping.
