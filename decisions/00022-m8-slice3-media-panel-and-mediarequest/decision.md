# Milestone 8 slice 3: the media panel + shared dialog, the mediaRequest/applyOps rewiring, and a real draft-media-serving gap found by testing

## Context

Slice 1 (decisions/00020) shipped the media upload/reference-scan backend; slice 2
(decisions/00021) shipped the theme panel. This slice builds the `#/media` route
and the shared media dialog (spec/05 §4), and finally wires the editor's
`mediaRequest` message to do real work — `editView.ts`'s core has treated it as a
documented no-op since milestone 7 slice 2 (decisions/00017), and `overlay.ts`'s
`applyOps` handler has been "nothing to reconcile in v1" since the same slice. Both
of slice 1's todos-sidecar design notes for this slice (reproduced in decisions/00020's
"what to watch for") are resolved here, largely as already planned — see decision 3
below for the one place reality added a wrinkle that plan didn't anticipate.

## Decisions

**1. `mediaDialog.ts`'s `renderMediaGrid` is the ONE "same component" spec/05 §4
describes — used directly (no `onPick`) for the full `#/media` panel, and wrapped in
a modal (`mountMediaDialog`/`openMediaDialog`) for every "replace image" invocation:
the editor's `mediaRequest` (via `editView.ts`) AND `pageSettingsDrawer.ts`'s ogImage
field (replacing decisions/00018 decision 9's flagged minimal stand-in — that field's
old separate inline alt-text input is gone too, since the dialog's own alt-step now
covers picking AND alt text together).** `openMediaDialog(deps, respond)` is the
single entry point both callers use: mounts to `document.body`, tears itself down,
calls `respond` with the picked `{src, alt}` or `null` exactly once.

**2. Picking is ALWAYS a separate, explicit click on a grid thumbnail — upload never
auto-selects its result, even for a single freshly-uploaded file.** One path
regardless of how many files were dropped/selected keeps the mental model simple:
"upload adds to the grid; picking is its own step," rather than special-casing
"exactly one file" vs "several."

**3. The shell relays a `mediaRequest` answer by reusing the EXISTING `applyOps`
message (not a new dedicated message type) — an op whose `path` equals the ORIGINAL
`mediaRequest` key verbatim (even item-scoped, e.g. `.img`), or an EMPTY `ops` array
for "cancelled, nothing picked."** The overlay tracks `pendingMediaTarget` and clears
it ONLY on an actual path match or an explicit empty-batch cancel signal — never
unconditionally on any `applyOps` arrival — because a batch containing some OTHER,
unrelated accepted op (e.g. a text edit already queued before the dialog opened,
whose acceptance echo lands while the modal is still up) must pass through without
being mistaken for the real answer. This is SAFE, not just narrow, specifically for
image-kind bindings: `mediaRequest`/`pendingMediaTarget` only ever exists for
`img`/`bg` keys, and there is no OTHER op-producing path for an image key (an image
can only ever be set via this exact dialog flow) — so a stale `pendingMediaTarget`
left over from an uncleared cancel can never collide with a genuinely-unrelated
op sharing the same path. Verified by test (`overlay.test.ts`'s "an unrelated
non-empty applyOps batch does not clear a pending target; a later matching one still
applies").

**4. `EditViewCoreDeps` gained `onMediaRequest(key)`; `mountEditView`'s DOM wrapper
(not the pure core) owns "open the shared dialog, translate the result into
`applyOps`" — no new dependency was added to `MountEditViewDeps`, and neither
`shell.ts` nor `themePanel.ts` needed a single line changed for this.** The wrapper
already has everything (`deps.api`, `postToOverlay`, the current page) to implement
it directly, exactly mirroring how `applyOps`'s own wrapper-level implementation is
already a thin one-liner nothing else needs to inject. Because of this,
`themePanel.ts`'s embedded preview iframe (decisions/00021 decision 1: full
`mountEditView` reuse, chrome included) gets working "Replace image" for free.

**5. `parseJson`'s (`admin-ui/src/api.ts`) error path now surfaces the server's real
`detail` message (FastAPI's `HTTPException` body shape) instead of a generic
"request failed with status N" for EVERY endpoint, not just media.** Upload's 422
("file exceeds the 15MB limit") and delete's 409 ("still referenced by: …") are the
motivating cases, but the fix is generic since every admin-api error body has the
same shape.

**6. Media delete uses a plain `win.confirm()` (injectable window, not a typed-
confirmation dialog like page-delete).** spec/05 §2 explicitly calls page delete
"typed-confirmation"; §4's media-delete sentence has no such qualifier, and it's
already scoped to draft-only + unreferenced (lower blast radius than deleting a
whole page) — matching the wording difference rather than inventing symmetry spec
doesn't ask for.

**7. A REAL backend gap, found only by driving a real browser through the full
upload/replace flow (`app.py`): nothing served `GET /admin/draft-media/{name}` at
all.** `_save_upload`/`_media_item` (slice 1, `routes_admin_api.py`) construct and
return that URL, and the file genuinely exists on disk — `GET /api/admin/media`
correctly lists it and an `<img src>` correctly targets it — but no route/mount ever
served it, so every staged upload 404'd (or 503'd, pre-first-publish) the instant
anything actually fetched it. Every existing unit test for upload (`test_
uploads_and_stages_a_processed_image` et al.) asserted the constructed URL STRING
and the on-disk file's existence SEPARATELY, never fetching the URL through a
`TestClient` — so this was invisible to 376 passing Python tests and 137/108 passing
TS tests alike, and was only surfaced by an ad hoc Playwright script driven against
`e2e/fixture_server.py`'s real server (not a permanent test — deleted after use;
slice 4 is where a real, permanent Playwright E2E test for this flow gets built).
Fixed with `app.mount("/admin/draft-media", StaticFiles(directory=paths.draft_media),
name="draft-media")` in `app.py`, right alongside the existing `/admin/static` mount
— safe because `ensure_project_dirs` (called earlier in `create_app`) already
guarantees `paths.draft_media` exists by mount time, and per-project (not the fixed
`_STATIC_DIR` `/admin/static` uses) is correct since one app instance serves exactly
one project (spec/04 §1). Confirmed RED (503) against the pre-fix code, GREEN (200,
correct JPEG dimensions decoded back) after, per this project's bug-fix discipline —
`TestUploadMedia::test_the_returned_url_is_actually_servable`.

## Verification

Backend: `wixy_server/app.py`'s new `/admin/draft-media` mount + 1 new test (the
red/green regression above). `python -m pytest` 377 passed (was 376); `mypy --strict`
clean (76 files); `ruff check` + `format --check` clean.

Frontend: `admin-ui/src/mediaDialog.ts` (new: `guessAltFromFilename`,
`renderMediaGrid`, `mountMediaDialog`, `openMediaDialog`) + `mediaDialog.test.ts` (25
tests: filename-guessing, management-mode rendering/delete-gating/upload/drag-drop,
pick-mode alt-step/decorative-checkbox/back, modal open/backdrop-click/close-button/
Escape/pick-resolves). `admin-ui/src/mediaPanel.ts` (new, thin `#/media` wrapper) +
2 tests. `admin-ui/src/api.ts` extended (`MediaItem`'s full shape, `uploadMedia`,
`deleteMedia`, the `parseJson` detail-message fix) + 5 new tests.
`admin-ui/src/editView.ts` (`onMediaRequest` dispatch + the wrapper's dialog-opening
implementation) + 1 new core-level test. `editor/src/overlay.ts`
(`pendingMediaTarget` + the `applyOps` matching logic) + 4 new tests, including the
hard case: an item-scoped image pick emits the WHOLE `showcase.items` array with the
sibling item untouched — passed on the first run, confirming the
`commitEdit`→`emitItemScoped`→`findOutermostList` reuse design (decisions/00020's
"what to watch for") holds. `admin-ui/src/pageSettingsDrawer.ts` simplified (dialog
replaces the old inline picker + alt input) + 1 new test exercising the real
dialog-driven pick end-to-end. `admin-ui/src/shell.ts` wires `#/media` to
`mountMediaPanel`. `npm run typecheck` clean for both packages; `npm test` — admin-ui
137 passed (was 102), editor 108 passed (was 104); both bundles rebuilt, zero drift.

**Real-browser verification** (this chain's standing highest-value habit,
decisions/00018-00020): drove `e2e/fixture_server.py`'s real server with a throwaway
Playwright script (not committed) through the full flow — direct (`hero.bg`) image
replace via pick, item-scoped (`showcase.items[0].img`) replace via a real file
upload, the `#/media` panel, and the page-settings ogImage field — asserting SERVER-
SIDE state via `GET /api/admin/content` and `GET /api/admin/media` after each step,
not just DOM appearance (a first pass looked fine in the DOM but a naive regex in the
verification script itself briefly masked whether persistence was real — re-checked
directly against the server once suspicious, per this project's own "measure, don't
assume" discipline). This is what surfaced decision 7's `/admin/draft-media` gap;
after the fix, a full clean run showed zero console errors and every server-side
value correct, including the sibling list item staying byte-for-byte unchanged.

## What to watch for

- Slice 4 (E2E 2/3 as real Playwright tests) is next — E2E 2 (image replace,
  oversized + EXIF-rotated fixture) should specifically include a case that fetches
  the resulting `<img src>` and asserts a real 200 (not just that the src attribute
  changed), so a regression of decision 7's fix would be caught by CI, not just by
  another ad hoc manual pass.
- The `onMediaRequest`-owned-by-the-wrapper pattern (decision 4) is now precedent:
  when a core-level message needs a real DOM/network effect, add a core-deps
  callback the WRAPPER implements directly (using what it already has in scope)
  rather than plumbing a new dependency through every caller.
- `parseJson`'s detail-message surfacing (decision 5) means any FUTURE admin-api
  endpoint that returns a `HTTPException(detail=...)` automatically gets a
  meaningful client-side error message for free — no per-endpoint frontend work
  needed for that alone.
- Decision 7's root cause (a constructed-and-listed URL nobody actually serves) is a
  class of bug unit tests systematically miss when they assert "the string is right"
  and "the file is on disk" as two separate checks instead of one round-trip check —
  worth remembering when adding any FUTURE endpoint that returns a URL pointing at
  newly-written content (e.g. milestone 9's publish/version-history "View" links).
