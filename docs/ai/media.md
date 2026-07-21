# Subsystem: media

Upload processing, reference scanning, and the staging→publish lifecycle for images. Server
code is `wixy_server/media.py`; the content-model rules are
[`spec/02-content-model.md`](../../spec/02-content-model.md) §9. Numbered guarantee:
[invariants.md](invariants.md) 16.

## Where images live

- **Published**: the site repo's `images/<name>`, served at `/images/<name>` from the live
  build.
- **Staged (unpublished)**: `Storage/projects/<slug>/draft/media/<name>`, where the basename
  `<name>` = `<hash8>-<upload-slug>.<ext>` (step 7; `<upload-slug>` = the slugified *uploaded
  filename*, **not** a page slug). The API returns this full basename as the `name` field, and
  it is served for preview at `/admin/draft-media/<name>` (the whole basename — a
  CF-Access-gated `StaticFiles` mount).
- Content references an image as `{"src": "images/x.jpg", "alt": "…"}` (the `data-wx-img` /
  `data-wx-bg` value). While staged, `src` is `/admin/draft-media/<name>`; publish rewrites it
  to `images/<name>`.

## Upload processing (`media.py:process_upload`)

`process_upload(data, original_filename, content_type, config: MediaConfig) → ProcessedUpload`
— a Pillow pipeline that never touches disk (the caller writes the returned bytes into
`draft/media/`):
1. Reject `> _MAX_UPLOAD_BYTES = 15 MB`; reject SVG (`image/svg+xml` / `.svg` — XSS surface);
   reject `content_type ∉ {image/jpeg, image/png, image/webp, image/gif}` → all
   `MediaUploadError`.
2. `Image.open` + `.load()` (unreadable → `MediaUploadError`).
3. Capture `is_png = image.format == "PNG"` **before** `ImageOps.exif_transpose` (transpose
   drops `.format`; capturing after silently re-encoded PNGs as JPEG — a fixed reorder bug).
4. `exif_transpose` auto-orients; **EXIF is stripped** by never round-tripping `.info` into
   the re-save (client-photo privacy).
5. Downscale (LANCZOS) if `max(w,h) > config.max_long_side_px` (project registry, 2000 for
   ca).
6. Re-encode: PNG → `save(PNG, optimize=True)`; else `convert("RGB").save(JPEG,
   quality=config.jpeg_quality, optimize=True)` (85 for ca).
7. Filename = `f"{sha256(final_bytes)[:8]}-{slugify(original)}.{ext}"` — **hashed over the
   final re-encoded bytes**, so re-uploading the same image dedupes to the same staged file
   (Inv 16).

## Reference scanning (`media.py:scan_media_references`)

`scan_media_references(source) → {filename: sorted ["<file>:<key>", …]}` via
`_walk_for_image_refs`: matches any dict whose `src` is a non-empty string and whose keys ⊆
`{src, alt}`, keyed by **basename only** (`PurePosixPath(src).name` — form-independent across
`images/x.jpg` and `/admin/draft-media/x.jpg`), reported at the outermost content-key
granularity. This backs the media library's per-image "references" list and the
delete-if-unreferenced guard.

## Delete (`media.py:delete_draft_media` + `stage_media_deletion`)

`DELETE /api/admin/media/{name}` has two shapes (decisions/00080, which supersedes
the earlier repo-deletion deferral):
- **Draft upload** → deleted immediately, with a traversal guard
  (`target.resolve().parent == draft_media.resolve()` and `is_file`, else
  `MediaNotFoundError`) and a reference guard (still referenced →
  `MediaReferencedError` → 409). Response `{"deleted": true}`.
- **Repo image** (`images/`) → STAGED for the next publish in
  `draft/media-deleted.json` (unreferenced-only at staging time, same 409
  otherwise). Response `{"stagedDelete": true}`. At publish, references are
  **re-scanned against the final merged content** — an image that gained a use
  since staging is kept, never removed. `DELETE /api/admin/media-deletion/{name}`
  unstages.

## Replace (`media.py:stage_media_replacement`)

`PUT /api/admin/media/{name}` stages new bytes for an EXISTING image (404 if the
name exists nowhere) in `draft/media-replace/<name>` — processed like an upload
but keeping the exact filename, so every reference keeps working when the next
publish overwrites `images/<name>` in place. The media grid previews the staged
bytes immediately from `/admin/draft-media-replace/<name>` (StaticFiles mount)
and badges "replace staged" / "delete staged" (from `media_staging()`).
`DELETE /api/admin/media-replace/{name}` unstages. Staging clears only after
validate succeeds, and `DELETE /api/admin/draft` clears it all (a discard takes
staged media state with it). Staged media counts as publishable in both the
preview (`mediaChanges` + `opCount`) and the nothing-to-publish preflight —
without that a media-only publish reads as 422.

## Publish lifecycle (cross-ref)

At publish, `publisher._materialize` copies each overlay-referenced staged file into `images/`
+ `git add` **before** `builder validate`, and unlinks the staged original only **after**
validate passes — so an aborted publish (`git reset --hard` + `git clean -fd`) can never lose
an image (Inv 16). See [publish-pipeline.md](publish-pipeline.md).
