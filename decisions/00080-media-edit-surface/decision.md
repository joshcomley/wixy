# Media items are editable: detail sheet with staged in-place replace and staged repo deletion

> **Renumbered 00079 → 00080 (2026-07-21):** two independent sessions shipped
> decision entries numbered 00079 within minutes of each other (the peer's
> composer-autogrow entry merged first, as PR #106). The later one (this one)
> moved to the next free number; content unchanged.


## The complaint (operator, 2026-07-21)

"I can't edit any media files" — the media panel was a read-only gallery for
published images: thumbnail clicks did nothing, and Delete was disabled for
every repo image (the milestone-8 deferral: "can't be deleted from the draft
yet (milestone 9)"). Also: "the media subheader is far too tall, doesn't need
to be over two lines."

## Decisions

**Media edit follows the same publish-time materialization contract as
pages.** Milestone 8 deferred repo-image deletion because no such contract
existed for media; this change builds it (superseding that deferral):

- **Replace** (`PUT /api/admin/media/{name}`): processes bytes like an upload
  but keeps the EXACT filename, staged in `draft/media-replace/`. The next
  publish overwrites `images/<name>` in place — every reference keeps working
  (that is the point of in-place). The grid previews the staged bytes
  immediately from `/admin/draft-media-replace/<name>` and badges "replace
  staged"; `DELETE /api/admin/media-replace/{name}` unstages.
- **Delete** (`DELETE /api/admin/media/{name}`): draft uploads still delete
  immediately; a repo image now STAGES (`draft/media-deleted.json`) when
  unreferenced. At publish, references are RE-SCANNED against the final
  merged content and anything that gained a use is kept — the stale intent
  never wins. `DELETE /api/admin/media-deletion/{name}` unstages.
- Staging clears only after validate succeeds (the same deferral as
  `_copy_referenced_media` — a failed publish loses neither intent nor bytes).
- A media replacement reuses the same URL, so CDN staleness is bounded by the
  site's existing 5-minute TTL — acceptable; content-addressed (hashed)
  naming stays the rule for NEW uploads.

**The panel gets a detail sheet on tap** (the missing edit surface): big
preview, dims/size/source, the references list, and actions — Replace image…,
Delete (with the unreferenced-only rule), Undo staged replace/delete. Grid
thumbnails became buttons; pick-mode (the replace-image dialog) keeps its own
alt-step flow untouched.

**Header to one line**: the panel mounts its Upload button into the header
row (title left, upload right) via the grid's new optional `headerRow` dep —
the separate toolbar line collapses.

## What to watch for

- `DELETE /api/admin/media/{name}` now returns `{"deleted": true}` (draft) OR
  `{"stagedDelete": true}` (repo) — callers must not assert the single shape.
- The publish-time reference re-check is load-bearing: never reintroduce a
  staging-time-only check, or content edited between staging and publish can
  silently delete an in-use image.
- Untracked drift in `images/` (a file git doesn't know) is tolerated by the
  apply (`git rm --ignore-unmatch` + unlink fallback).
