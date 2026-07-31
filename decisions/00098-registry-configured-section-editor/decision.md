# Registry-configured admin section editor (Before & After)

## The ask

She considers the Before & After page the most important part of the site and had NO
safe way to add a photo pair — that's what triggered the original incident (decisions/
00095). Build a dedicated management screen: photo pairs picked from the media library,
drag-to-reorder, category/title/sub editing, simple enough for a non-technical phone
user, and safe by construction (a new item can never be born half-filled).

## What was decided

**A generic, registry-configured "section editor," not a hardcoded gallery page**
(Inv 1 — no site literals in engine code). `builder/config.py` gains `AdminSection {id,
nav_label, title, description, page, collections}` → `AdminCollection {path, label,
item_noun, schema, fields}` → `AdminField {key, kind: "image"|"text"|"choice", label,
options}` → `AdminFieldOption {value, label}` — all frozen dataclasses, all threaded onto
`ProjectConfig.admin_sections: tuple[AdminSection, ...]`. `ca.json` declares exactly ONE
section ("before-after", page `gallery`, collections `gallery.sliders`/`gallery.tiles`) —
the engine has no idea what a "photo pair" is; it only knows how to render whatever
sections a project's registry lists. A second project with zero `adminSections` gets
zero extra nav entries and the exact pre-existing pages/theme/media/chat/history
experience, unchanged.

**`admin_sections` is a SEPARATE registry from `builder.collections.COLLECTION_RULES`,
despite pointing at the same schema files** — easy to conflate, so worth stating
plainly: `COLLECTION_RULES` is the write gate's "this content path must satisfy this
schema" table (decisions/00095, applies to every write regardless of which UI made it);
`admin_sections` is "this content path ALSO gets a dedicated admin nav entry + management
screen." `gallery.sliders`/`gallery.tiles` have both; `_global.hours`,
`index.treatments.cards`, `treatments.rx.items`, `reviews.reviews.items` have only the
write-gate entry (still inline-overlay-only, no dedicated screen). Registering a
collection in `admin_sections` does NOT bypass or duplicate `COLLECTION_RULES` — it's
purely an admin-UI affordance layered on top.

**Lenient parsing, mirroring `load_project_config`'s existing defensive style.** A
missing/malformed section, collection, field, or option is skipped individually
(`logger.warning`) rather than failing the whole project config load — one bad registry
entry can never take the site's admin down. `AdminFieldKind = Literal["image", "text",
"choice"]`, narrowed from the raw JSON string via an explicitly-typed
`tuple[AdminFieldKind, ...]` membership check (`_ADMIN_FIELD_KINDS`) rather than `cast` —
mypy narrows a `Literal`-typed container's membership check for free once the container
itself carries that type, so no unsafe cast was needed.

**`/api/admin/state` gains `adminSections`** — a plain camelCase mirror
(`routes_admin_api.py:_admin_sections_snapshot`), same "dict literals off the config
dataclass" shape `pages` already uses. `admin-ui`'s `router.ts` gains `{kind:"section",
id}` (path `/admin/section/<id>`); `shell.ts` renders one nav button per
`state.adminSections[]` entry DYNAMICALLY — inserted right after Edit via
`editNavItem.after(...buttons)`, re-synced on every state reload (diffed against the
previously-rendered id list so an unchanged section list is a no-op) — unlike the
static `NAV_ROUTES` array every other panel uses. An unknown section id (a stale deep
link, or a section removed from the registry) falls back to the pages panel, mirroring
`parsePath`'s own unrecognized-route convention.

**The panel owns its own fetch, unlike `pagesPanel.ts`'s `renderXPanel(data,
callbacks)` shape.** A collection's array VALUES live in page content
(`api.getContent(section.page)`), not `StateResponse` (only the CONFIG does) — so
`sectionPanel.ts` mirrors `mediaPanel.ts`'s `mountXPanel(api, ...): {element, teardown}`
precedent instead. Every mutation (add/edit/reorder/delete) writes the collection's
WHOLE array as one `opQueue.enqueue({file, path, value})` op — this codebase's
established collection-editing rule — never a partial patch; the shell's own
`opQueue.onAccepted` callback (already wired once for every panel) refreshes the draft
chip/status bar exactly like any other edit, so the panel needs no bespoke
`onDraftChanged` callback of its own.

**`opQueue` is typed as `editView.ts`'s existing `OpQueueLike` interface
(`{rev, enqueue}`), not the concrete `OpQueue` class** — matching `pageSettingsDrawer.ts`'s
own precedent, purely so tests can pass a two-line fake instead of constructing a real
queue with callbacks.

**Reordering has BOTH a pointer-based drag (a drop-indicator line, commit-on-release)
AND ↑/↓ buttons emitting the identical whole-array op** — a deliberate divergence from
decisions/00017's earlier call to simplify the INLINE overlay's own item toolbar to
buttons-only (no pointer-drag tracking was ever built there). This screen is
different: it's her most important page ("her pride" — polish it), a phone-first
guided workflow where real drag reads as considerably more natural, and the ↑/↓ buttons
stay as the accessibility/no-pointer fallback exactly as decisions/00017 already
established — not a contradiction of that decision, an addition on top of it for this
one screen.

**The guided add flow is a linear wizard: one step per `image`-kind field (in field
order), then a final form step for the rest** — generalizing the brief's literal "step
1 Before, step 2 After, step 3 form" (written with `gallery.sliders`'s two image fields
in mind) to however many image fields a collection actually declares: one step for
`gallery.tiles` (a single `img` field), two for `gallery.sliders`. Save stays disabled
until `sectionPanelModel.isNewItemComplete` — every `image` field has a picked,
non-blank src, and the field literally named `title` (if the collection has one) is
non-blank text. A new item is therefore always born schema-valid, including non-blank
image srcs, matching the publish-time `pattern` guard (decisions/00095) it will
eventually be checked against — it just never gets the chance to be blank in the first
place. Other text/choice fields (`sub`, `cat`) never block Save — `cat` always starts
pre-filled from the first option (`blankItem`), so it's never genuinely blank in
practice.

**Text values are stored PLAIN, decoded for display, never re-encoded on save** —
matching `contentModel.ts`'s own established convention (its `.textContent`-based reads
already return decoded plain text; the builder's BeautifulSoup render pass re-escapes
values at HTML-serialization time, so the JSON content layer only ever needs to carry
the plain form). `sectionPanelModel.decodeCommonEntities` covers the five standard
XML/HTML entities plus `&nbsp;` — a value written through some OTHER path (hand-edited
JSON, a future import) that carries literal entity text still displays correctly, and
saving it back never adds a second layer of escaping.

**`sectionPanelModel.ts` is the pure, DOM-free half** (dotted-path content reads, array
reorder/delete/update, the add-flow completeness gate, entity decoding) — unit-tested
directly and exhaustively; `sectionPanel.test.ts` covers the thin DOM binding on top,
deliberately DOM-light (spec 3c) since the pointer-drag interaction itself is real-browser
E2E territory, not jsdom's (mirrors `opQueue.ts`'s own "framework-free core" precedent).

## Two real bugs this PR's own E2E coverage caught (real bugs, real lessons)

**A DOM class-identity collision.** The guided add-flow's own modal backdrop/dialog
first reused `.wx-media-dialog-backdrop`/`.wx-media-dialog` (the real media picker's
classes) purely to inherit their visual recipe for free. This modal opens the REAL
media dialog on top of itself, mid-flow — sharing a class made the two indistinguishable
to any selector. Every vitest test passed regardless (`mediaDialog`-mocked interactions
never actually collide in a unit test), but the real-browser E2E flow hit an immediate
Playwright strict-mode violation the moment it tried to find "the media dialog" while
the add-flow's own backdrop was also on screen. Fixed with fully independent class
names (`wx-section-add-backdrop`/`wx-section-add-dialog`) and their own (small, copied)
CSS rules — never share a class between two components that can be visible
simultaneously, even if their visual recipes happen to be identical.

**A `.count()` vs `expect().toHaveCount()` race.** An early E2E draft captured "how many
media thumbnails exist before this upload" via a plain `.count()` read, immediately
after asserting the dialog backdrop was visible — but the dialog's own thumbnail grid
populates from an ASYNC `getMedia()` fetch that hadn't necessarily resolved yet.
`.count()` is a one-shot synchronous snapshot with no auto-waiting, unlike
`expect(locator).toHaveCount(n)` (which polls); it happily returned `0` mid-fetch, and
every subsequent "+1" expectation built on that wrong baseline could never be satisfied
once the grid finished loading to its real (non-zero) count. Fixed by asserting the
KNOWN, deterministic starting count directly via `toHaveCount` (auto-waiting) rather
than reading a snapshot to compute an expectation from — the general rule: never seed an
assertion's expected value from a bare `.count()`/`.textContent()`-style synchronous read
of state that loads asynchronously; assert the expected value directly and let
Playwright's own polling absorb the load-timing race.

## What to watch for

- **The E2E fixture (`e2e/fixture_server.py:_write_gallery_page`) adds a REAL `gallery`
  page + `content/gallery.json` to its OWN seed clone** — deliberately NOT the shared
  `builder/tests/fixtures/mini-site` the Python unit suite also trusts (adding a page
  there would ripple into every test asserting an exact page count/slug set, e.g.
  `TestGetState::test_shape_with_no_draft_and_auto_bootstrapped_live`'s `{"index",
  "about"}`). If a future PR needs yet another admin-section-shaped E2E fixture page,
  extend `fixture_server.py` the same way, not the shared builder fixture.
- **`_list_media` (routes_admin_api.py) appends "repo" items first, then "draft"
  (uploaded) items strictly after, regardless of name** — this is why a freshly
  uploaded image is always the picker grid's LAST thumb, a fact the guided add-flow's
  own E2E coverage leans on (see the bug above). If that ordering ever changes,
  `sectionPanel.ts`'s "pick the just-uploaded item" step doesn't need to (it re-derives
  from the callback value, not position) — but this decision's own E2E test does.
- **The draft-write gate (`draft_validate.py`) deliberately skips `pattern`** — a blank
  image `src` is a VALID in-progress draft state, only rejected at publish-preflight
  time (decisions/00095). A test (or a future feature) that wants to prove "the gate
  rejects a broken write" at DRAFT time must use a genuinely STRUCTURAL violation (a
  missing required key, wrong type) — not a blank string.
