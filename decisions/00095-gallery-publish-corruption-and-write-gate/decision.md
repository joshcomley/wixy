# The 2026-07-28 gallery publish-corruption incident

## Symptom

2026-07-28: the site owner tried to add a new before/after photo pair on the
gallery page via the editor overlay's list-item toolbar. Publish broke
immediately after and stayed broken for two days — every attempt showed her a
wall of raw validator output (`pages/gallery.html: attribute binding '.cat'
(for 'data-cat') does not resolve to a string`, `content/gallery.json:
gallery.sliders[0]: missing required property 'cat'`, ...). The live draft
overlay (rev 127) had a whole-array `gallery:gallery.sliders` op with all
three items missing `cat` — item[0] fully gutted (`title`/`sub` = the literal
6-character string `"&nbsp;"`, `before`/`after` = `{"src":"","alt":""}`) —
plus a `gallery:meta.ogImage` op pointing at `/images/ba-lips-1-after.jpg`
(leading slash). Three benign upstream commits (a FAQ nav addition) sat stuck
behind it. Resolved operationally the same session (this PR's Workstream 0:
discard the sliders op, fix the ogImage src, publish as v20) before the root
cause was fixed.

## Root causes (three independent bugs, all in the editor's DOM read-back and
## media-pick paths)

**A — attr-kind item fields were silently dropped on every whole-array
reconstruction.** `builder/bindings.py:_apply_attrs` sets the target HTML
attribute (`data-cat`) on the SAME element that carries `data-wx-attr`
(`<figure data-wx-list-item data-wx-attr="data-cat:.cat">` — confirmed against
the real `pages/gallery.html`). `editor/src/contentModel.ts:readItemValue`'s
selector-building ternary had no `"attr"` branch, so it fell through to a
`[data-wx="..."]` selector that could never match a `data-wx-attr` element —
the field was silently OMITTED from the reconstructed item (not set to `""`,
just absent), which is exactly "missing required property 'cat'". This fires
on EVERY structural list edit (add/reorder/delete) and EVERY item-scoped
field edit (whole-array re-read), regardless of which item was actually
touched — explaining why all three items lost `cat`, not just the one edited.

**B — the "blank new item" DOM placeholder became real stored text on a
later read.** `editor/src/overlay.ts:blankTextLikeFields` (the list-toolbar
✚ handler) writes `innerHTML = "&nbsp;"` into a cloned item's text fields —
deliberate: a truly empty text element has zero height in a real browser and
becomes permanently unclickable, so a freshly-added item's title/body could
never be filled in through the visual editor otherwise. The DOM read
(`demoteHtmlToMarkdown`, walking `childNodes`/`nodeValue`) recovers the RAW
decoded character (a single U+00A0), not the entity text — verified
empirically (jsdom: `el.innerHTML = "&nbsp;"` then `el.childNodes[0].
nodeValue` is `"\xa0"`, one character). The literal 6-character string that
actually reached storage came from a THIRD hop: the server's kind-aware
sanitize pass (`wixy_server/draft_sanitize.py`, decisions/00074) runs every
text-kind leaf through `nh3.clean` (Rust/ammonia), which re-serializes a bare
U+00A0 as the literal entity `&nbsp;` in its OUTPUT — verified empirically
(`nh3.clean("\xa0", ...)` returns `"&nbsp;"`). So: DOM placeholder (real
NBSP) → client reads it as content on a later structural op → server sanitize
re-encodes it as literal entity text → stored. The placeholder itself is
correct and necessary; nothing downstream expected it to survive into a
draft op.

**C — the media picker returned the display URL, not the content form.**
`admin-ui/src/mediaDialog.ts`'s pick confirm handed back `item.url` (e.g.
`/images/hero.jpg`, a root-relative path — correct for an `<img src>` on an
admin-ui page, and for the live-preview iframe thanks to `preview.py`'s
injected `<base href="/">`) as the value to STORE in content JSON. Every
hand-authored content value uses the relative form (`images/hero.jpg`, no
leading slash — the ONLY form `builder/validate.py`'s `(project_root /
src).exists()` check resolves correctly; pathlib's `/` operator discards the
left operand entirely when the right looks absolute, so `project_root /
"/images/x.jpg"` silently becomes `Path("/images/x.jpg")` and the check
reports "missing" even though the file is right there). This is what broke
the ogImage half — the owner picked an existing, real image.

## What was decided: a layered write-time gate, not a single patch

Root-causing A/B/C in the editor (`contentModel.ts`'s `readAttrValue` +
`normalizeEmptyText`, `mediaDialog.ts`'s `contentSrc`) closes the paths that
produced THIS incident, but doesn't prevent a DIFFERENT future bug (or a
hand-crafted API call, or an AI-lane mistake) from writing something equally
broken. So the fix is layered, each layer independently sufficient for its
own failure mode:

1. **Editor read-back fixes** — close the two specific bugs at the source.
2. **`wixy_server/draft_validate.py` (the write gate)** — EVERY `PATCH
   /api/admin/draft` op is normalized (silent corrections: leading-slash
   repo-image rewrite when the file exists, nbsp-placeholder collapse —
   mirrors the editor's own `normalizeEmptyText`) and structurally checked
   (type/required/properties/additionalProperties against the real
   `builder/schemas/*.json`, deliberately WITHOUT `pattern` —
   `jsonschema_lite`'s new `skip_pattern` — so a freshly-added, not-yet-
   filled-in item stays a valid draft state) BEFORE it's written. A
   violation is a 422, never persisted; the overlay can no longer hold a
   structurally-broken collection item, full stop, regardless of what wrote
   it.
3. **Publish preflight** (`start_publish`'s `_preflight`) runs the SAME
   full-schema validate (`validate_merged_for_publish`, shared with the
   review drawer's own preview) BEFORE a job is even created — a blocked
   draft gets a calm 422, never reaches `_materialize_locked`'s own
   `validate_site` call and surfaces as a raw `PublishError`/502 (the
   incident's actual symptom).
4. **`draft_repair.py` self-heal + `reports.py`** — deterministic recovery
   for a draft that's ALREADY corrupted (historical data predating the
   gate, or any future gap in it) — see decisions/00096.
5. **`builder/schemas/gallery-slider.schema.json` /
   `gallery-tile.schema.json`** gain a non-blank `pattern` on every image
   src, publish-time only (`skip_pattern=True` at the draft-write gate) — an
   abandoned blank photo entry is now a friendly-screen problem, not a
   silently-broken live page.

## A brief-literal correction, verified before shipping

The implementation brief specified `"pattern": "\\S"` for the blank-src
guard. `builder/jsonschema_lite.py`'s pattern check uses `re.fullmatch`, not
a substring search — an UNQUANTIFIED `\S` under `fullmatch` only matches a
string that is EXACTLY one non-whitespace character, so `"images/hero.jpg"`
(12 characters) would have failed to match and every real, non-blank src
would have been rejected. Verified empirically
(`re.fullmatch(r"\S", "images/x.jpg")` → `None`) before writing the schema
files; corrected to `".*\\S.*"` (verified: matches any string containing at
least one non-whitespace character, rejects `""` and whitespace-only).

## What to watch for

- **`readAttrValue`/`normalizeEmptyText` are TS-side, `rewrite_leading_
  slash_src`/nbsp-collapse are the Python-side mirrors** (`wixy_server.
  draft_validate`) — if either side's logic changes, check whether the
  other needs the same change. Not byte-locked by a shared fixture (Inv
  20's other hand-synced pairs have one; this pair's grammar is small
  enough a plain unit-test-parity discipline was judged sufficient) — a
  future refactor should still keep them in sync by hand.
- **`draft_validate.check_structural` only covers the flat `COLLECTION_
  RULES` table plus the two special shapes (`treatments.sections`' `cards`,
  `_global.footer.*`) it shares with `builder.validate`** — any FUTURE
  collection shape added outside that dispatch needs its own case wired in,
  or a structurally-invalid item for that new shape sails straight through
  the gate.
- **The draft-write gate normalizes but does NOT re-validate an op that
  fails structurally and is REJECTED** — a rejected batch is dropped
  client-side (`opQueue.ts`'s `onRejected`, never re-queued) and the
  PREVIOUS overlay state is untouched; the owner's live DOM can end up
  visually showing the rejected edit until the shell's forced `editView.
  reload()` reconverges it.
