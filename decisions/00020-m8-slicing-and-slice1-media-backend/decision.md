# Milestone 8 slicing plan, and slice 1: the media upload + reference-scan backend

## Context

Milestone 8 (spec/05-editor.md §3-4, spec/02-content-model.md §4 + §9): the theme
panel and the media panel/dialog/upload pipeline. Its real scope — a Pillow-based
upload pipeline with real image processing, a reference scanner, a full theme-token
editing UI with two different live-preview mechanisms (CSS vars for colors, a
`<link>` swap for fonts), a media grid + a dialog component reused from two different
call sites, and rewiring the editor overlay's `mediaRequest`/`applyOps` handshake — is
exactly the kind of size that made M6 and M7 worth slicing into multiple PRs
(decisions/00010, 00015). This follows the same precedent.

## Decisions

**1. Four slices, in dependency order** (recorded here; each slice's own decision
entry expands on it as it ships): (1) backend — upload + reference scan, this PR; (2)
theme panel; (3) media panel + dialog + the editor's `mediaRequest` wiring; (4) E2E 2
and 3 as real Playwright tests + closing decision. Slice 1 is genuinely
self-contained and unblocks the other three (both the theme panel's "reset to
published" and the media panel need the extended `GET /api/admin/media` shape this
slice builds) — starting here, matching M6/M7's own "backend/contract first" ordering
where one existed (M7 slice 1 was the shared protocol + op queue; M6's slices built
outward from storage/checkout).

**2. Reference scanning matches by FILENAME (basename) only, walking the MERGED
(repo ⊕ overlay) content for any dict value shaped exactly `{"src": <str>, "alt"?:
<str>}`.** Two things this sidesteps rather than needing to solve: (a) a stored `src`
value looks different for a repo file (`images/x.jpg`, no leading slash — confirmed
by reading real migrated CA content, not assumed) versus a staged draft upload
(`/admin/draft-media/x.jpg`) — matching on the basename alone is form-independent by
construction, no canonical-prefix convention needs inventing; (b) using the CONTENT'S
OWN value shape (rather than cross-referencing the bindings-map's `kind: "img"/"bg"`
fields) avoids needing to walk bindings-map SHAPE and live array DATA in parallel to
resolve item-scoped image fields nested arbitrarily deep in lists — the value shape
IS the signal (spec/02 §2: `data-wx-img`/`data-wx-bg`/`meta.ogImage` all share this
exact 1-or-2-key shape, and nothing else in the content model uses it), so a plain
recursive walk finds every real reference without needing the bindings-map at all.

**3. References are reported at the OUTERMOST content-key granularity
(`showcase.items`, never a specific array index or nested item path) —
matching the SAME constraint the overlay's own op-emission already lives under.**
`opTargeting.ts` (decisions/00017 decision 2) established that no dotted path can
address inside a list at any depth — `dotted_get`/`dotted_set` simply don't support
it. A finer-grained "this image is used by item 2 of showcase.items" reference isn't
addressable by ANYTHING else in this system either, so reporting at that
granularity would be more precise than useful and would need inventing a path
convention nothing else recognizes.

**4. Deleting media is scoped to draft-staged (never-yet-published) files only —
deleting an already-published repo image is explicitly OUT of milestone 8, deferred
to milestone 9.** This is decisions/00015 decision 3's page-delete reasoning, applied
to media without modification: spec/02 §9 itself frames media delete as inherently
publish-time-coupled ("deletes repo files AT PUBLISH TIME... the publisher does a
reference scan"), and building the draft-side delete UI/API for a repo image before
milestone 9's publish-time materialization contract exists risks getting the shape
wrong and redoing it — the identical risk decision 3 named for pages. Mechanically,
`delete_draft_media` only ever looks inside `draft/media/`, so a repo image's
filename naturally raises `MediaNotFoundError` rather than needing a separate "is
this a repo file, reject" branch — the scope boundary falls out of the
implementation rather than needing to be bolted on.

**5. The upload's `<hash8>` is a hash of the RE-ENCODED content, not the raw
upload bytes or a random id.** Re-uploading the literal same file (even under a
different original name) naturally reuses the same staged file rather than
accumulating duplicate copies of identical image data — found the failure mode by
testing it: an early version hashed nothing and produced a fresh UUID per upload,
which would silently double storage on every accidental re-select in a file picker.
The human-readable slug portion still comes from the ORIGINAL filename (not the
hash), so uploading the identical image under two different original names
legitimately produces two different full filenames (same hash8, different slug) —
this is correct, not a dedup failure (see slice's own test:
`test_the_hash_is_of_content_not_the_original_filename`).

**6. `ImageOps.exif_transpose()`'s return value loses `Image.format` even when no
rotation is needed — found by a real failing test, not theorized.** An early version
checked `is_png = image.format == "PNG"` AFTER calling `exif_transpose`, which
silently re-encoded every PNG upload as JPEG (`image.format` came back `None`,
falling through to the JPEG branch). Fixed by capturing `is_png` from the freshly-
`Image.open()`'d image BEFORE transposing. `test_keeps_png_as_png` pinned this.

**7. `python-multipart` added as an explicit `server` extra dependency** — FastAPI's
`UploadFile`/`File()` handling requires it at runtime but doesn't declare it as a
hard dependency (by design, so non-upload FastAPI apps don't pay for it unasked);
it happened to already be present transitively on the dev machine, which would have
made a missing-dependency bug invisible until a clean-install environment (CI, a real
deploy) hit it. Declared explicitly rather than relying on an undeclared transitive
dependency continuing to exist.

**8. `POST /api/admin/media` uses FastAPI's `Annotated[UploadFile, File()]` form,
not the classic `file: UploadFile = File(...)` default-argument form.** Both work
identically at runtime; the classic form trips ruff's B008 ("function call in
argument default") — a well-known FastAPI/ruff friction point most projects either
suppress or route around. Since `Annotated` is also FastAPI's own currently-
recommended style, this avoids the warning by being MORE idiomatic rather than by
suppressing a lint rule that (for genuinely mutable-default bugs elsewhere) still
has real value.

## Verification

`wixy_server/media.py` (new) + `wixy_server/tests/test_media.py` (new, 25 tests):
upload accepts/rejects per spec/02 §9's exact rules (size, MIME, SVG-by-extension-
even-with-a-spoofed-content-type), PNG stays PNG / everything else becomes JPEG,
resize respects the per-project configured limit and never upscales, EXIF is
genuinely stripped and orientation genuinely baked in (asserted against real Pillow-
constructed EXIF data, not mocked), reference scan across nested lists / `meta.
ogImage` / global content / multi-page aggregation. `routes_admin_api.py` extended +
`test_routes_admin_api.py` (+21 tests): `GET /media` now reports real dimensions/size/
references, `POST /media` end-to-end through a real `TestClient` multipart upload,
`DELETE /media/{name}` for the referenced/unreferenced/not-found/repo-image-out-of-
scope cases. The path-traversal guard (`delete_draft_media`'s own check) is
untestable through the HTTP layer at all — httpx's `TestClient` (and any real HTTP
client/browser) normalizes a `..` segment out of the URL before the request is even
sent, so `test_media.py` tests the guard directly against the function instead; this
is noted explicitly in both test files so it isn't mistaken for a coverage gap later.

`pytest` (targeted files) 54 passed; `mypy --strict` clean (76 files); `ruff check` +
`format --check` clean. A full-repo `pytest` run hit a 2-minute timeout mid-session —
investigated per this project's own "suspiciously slow → profile before retrying"
rule rather than assumed-and-retried: `Get-CimInstance Win32_Process` found two
long-running `python -m pytest` processes NOT belonging to wixy at all (parent
`bash.exe` command lines traced them to concurrent, unrelated sessions in the
`douglas` and `cmd` repos' own worktrees on this same shared hub machine) —
legitimate resource contention from other sessions' work, not an orphaned/leaked
wixy process (decisions/00014's own prior incident) and not a code bug. Re-ran in the
background; see this PR's own CI result for the authoritative full-suite pass (CI
runs on a dedicated, uncontended GitHub Actions runner).

## What to watch for

- Slice 2 (theme panel) has one real open design question flagged in the todos
  sidecar (`todos/00004.../00008-media-theme-758hsg.md`): how "live-applies to the
  edit iframe" (spec/05 §3) works given the shell only ever mounts one main panel —
  resolve and log it as its own decision when that slice starts, don't guess here.
- Slice 3's `mediaRequest` wiring needs `editor/src/overlay.ts`'s `applyOps` handler
  to do real work for the first time (currently a documented no-op) — routing the
  answer through the SAME `commitEdit` path a typed edit uses (not a new, parallel
  item-scope-resolution path) is the load-bearing design call already flagged in the
  todos sidecar; re-read it before starting that slice.
