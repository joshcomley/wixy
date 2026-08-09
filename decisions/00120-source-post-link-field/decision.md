# Decision: a `url` admin field kind, and backfilling it for the imported before/afters

## Symptom

The operator: "we need to have links back to the original Facebook and/or Instagram posts in
the imported before/afters." The site has 67 gallery.sliders items imported from real IG/FB
posts (decisions/00008 in the site repo, `manifest.json`), plus 7 items that pre-date or fall
outside that import — none of them carry any link back to their source today; the schema has
never had a field for one.

## What was decided — a new `url` field kind, not a hardcoded key

`builder.config.AdminFieldKind` gains `"url"` alongside `image`/`text`/`choice`/`toggle`
(`_ADMIN_FIELD_KINDS`, both Python and the mirrored TS union in `api.ts`). The registry
(`projects/ca.json`) declares ONE new field on `gallery.sliders`: `{"key": "sourceUrl",
"kind": "url", "label": "Original post link (optional)"}` — registry-driven per Inv 1, not a
hardcoded key anywhere in `sectionPanel.ts`'s rendering code. `builder/schemas/
gallery-slider.schema.json` gains the matching optional `"sourceUrl": {"type": "string"}`.

The main card view gets a NEW `renderUrlField` (`sectionPanel.ts`) — the same plain input as
`renderTextField`, plus a small "Open ↗" anchor next to it that only ever appears (and only
ever gets a real `href`) when the current value matches `/^https?:\/\//i`. This is a real,
deliberate defensive check, not decoration: the value round-trips through a plain text input
she can type or paste ANYTHING into, and a `javascript:` URL must never become a clickable
anchor. The guided add-flow's wizard reuses the plain `renderTextInputRow` for `url` fields
unchanged (identical UI need during creation; the Open-link affordance is for reviewing an
already-saved value, not typing a fresh one).

**A repeat of decisions/00117's exact trap, caught before shipping this time**: the wizard's
form-step dispatch was `if (text) … else if (choice) … else (toggle)` — a NEW kind falls
through the trailing `else` into whatever that catch-all happens to be, silently, unless every
dispatch site is checked by hand when adding a kind. Fixed by explicitly folding `url` into
the `text` branch (`field.kind === "text" || field.kind === "url"`) rather than leaving it to
fall through. **Any future new `AdminFieldKind` must audit BOTH dispatch sites in
`sectionPanel.ts`** (`renderCard`'s fields loop, and the wizard's `renderFormStep`) — grep for
`field.kind ===` before assuming a new kind is handled.

## What was decided — `data-wx-if` needs the key to EXIST, not just be falsy (a real, sharp edge)

The public template (`gallery.html`) shows the link conditionally: `data-wx-if=".sourceUrl"
data-wx-href=".sourceUrl"` on the anchor. Tracing `builder/bindings.py` before shipping this
surfaced a load-bearing distinction: `data-wx-if`'s "JS-falsy" rule (`is_wx_falsy`: exactly
`false`/`null`/`""`/`[]`) only applies once the key **resolves at all** — `_evaluate_if` calls
`resolve_key`, and if `found` is `False` (the key is genuinely ABSENT from the item, not just
holding a falsy value), it calls `_fail(sink, …)`, which is a **hard `BuildError` in strict
(publish) mode**. An empty string is fine (falsy, element removed cleanly); a missing key is
not (build breaks). `visible`'s own absence-tolerance is NOT evidence this is safe by default
— it's a special case handled directly in `_expand_list` (`item_value.get("visible") is
False`), completely separate from the generic `data-wx-if` template mechanism `sourceUrl`
uses.

Consequence: **every** `gallery.sliders` item must carry a `sourceUrl` key — even an empty
one — forever, or a future Publish can hard-fail. Two places had to change to guarantee this:
1. `sectionPanelModel.blankItem()` — a brand-new item from the wizard used to leave `url`-kind
   fields with no key at all (same as `image`, which is correct there: "unset" is a real,
   checked state for a picker). `url` needed the SAME explicit `""` default `text` already
   gets, not `image`'s. Fixed by folding `url` into that branch too.
2. The backfill (below) sets `sourceUrl: ""` on literally every existing slider, including the
   7 that were never part of any tracked import — not just the 67 real matches.

## What was decided — the backfill, and a REJECTED matching strategy

`decisions/00008-social-before-after-import/manifest.json` (site repo) has a real, committed
`url` for every one of its 67 `imported_as` entries. The join key is the `before`/`after`
filenames, normalized for an inconsistent `images/` prefix across import rounds (round-b
entries store it bare, round-c entries store it already prefixed) — 66 of 74 sliders matched
this way outright.

**First attempt, REJECTED after catching it produce real false positives**: for the remaining
handful (items that had gone through the admin's aligner tool since import, which bakes and
re-uploads a NEW content-hashed filename), a `(title, sub, cat)` tuple looked like an obvious
fallback key. It is UNSAFE — confirmed by testing, not assumed: many gallery items share the
EXACT same generic, auto-assigned caption ("Lip Enhancement" / "Dermal Filler" / "lips"), so
5 clearly-different gallery items all resolved to the SAME single manifest post purely because
it happened to be the only manifest entry with that generic combo. A WRONG "View original
post" link — one that opens a different client's photo — is a worse outcome than no link at
all, so this strategy was discarded entirely, not tuned.

**What actually shipped instead**: a second, NARROWER fallback keyed on a real unique
identifier, not a caption. The aligner leaves the original upload in the media library and
often only re-aligns ONE side of a pair — so if either the before or after filename still
carries its original `ba-ig-<shortcode>-`/`ba-fb-<id>-` prefix, extract that id and match
`manifest.json`'s own `id` field directly (globally unique, unlike a title). This recovered
exactly 1 more item (a "Jawline Enhancement" pair whose before-image survived alignment)
cleanly and correctly — verified against the manifest entry by hand, not just trusted.

**The remaining 7 unmatched items are a real, permanent data gap, not a bug**: `git log -S`
archaeology on `content/gallery.json` (site repo) confirms 2 of them are the ORIGINAL
hand-curated items that predate the whole import project (`ba-lips-1`/`ba-cheeks`), and the
other 5 were added later, one at a time, as pure `+` additions (never a modification of an
existing item) via the admin's own wizard using already-uploaded raw files with generic
`img-NNNN`/UUID filenames — never part of the manifest-tracked bulk import at all. There is no
source URL to recover for these; `sourceUrl: ""` is the honest, correct value.

Final tally: 67/74 real URLs, 7/74 empty — exactly matching the manifest's own count of 67
tracked imports, which is the strongest evidence the join is complete and correct, not partial.

## What to watch for

- Never add a matching/join heuristic keyed on free-text captions for this kind of backfill —
  auto-assigned import titles are NOT unique identifiers, confirmed the hard way here. Prefer
  a real id (shortcode, database key, content hash) every time one exists anywhere in the
  data, even if it takes more digging (git history, in this case) to find it.
- If a FUTURE bulk import or backfill touches `gallery.sliders`, it must also set
  `sourceUrl: ""` on any item it can't confidently attribute — never leave the key merely
  absent, for the `data-wx-if` reason above.
- `renderUrlField`'s `http(s)`-only `href` guard is the pattern to copy for any FUTURE
  field that renders user-editable free text as a clickable anchor — never trust a stored
  string as a safe `href` without a scheme allowlist check first.
