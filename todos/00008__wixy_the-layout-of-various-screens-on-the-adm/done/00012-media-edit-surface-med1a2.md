# 00012 — Media edit surface (detail sheet, staged replace/delete) + one-line header

**Status: SHIPPED — PR #105 + renumber PR #108. decisions/00080.**

Operator (2026-07-21, phone, dark mode): "I can't edit any media files" +
"the media subheader is far too tall, doesn't need to be over two lines".

## Shipped

- One-line media header (title left, Upload right via grid `headerRow` dep).
- Detail sheet on tap: preview, meta, references list, Replace image…,
  Delete (unreferenced-only), Undo staged replace/delete.
- Replace = staged bytes under the EXACT name (`draft/media-replace/`);
  publish overwrites `images/<name>` in place (references keep working);
  grid previews staged bytes + "replace staged" badge; unstage route.
- Repo delete = staged (`draft/media-deleted.json`) when unreferenced;
  publish RE-SCANS references and keeps anything that gained a use;
  "delete staged" badge (dimmed); unstage route.
- Staging clears after validate; DELETE /draft clears all staged media;
  staged media counts as publishable in preview opCount + the
  nothing-to-publish preflight; drawer media-changes section.
- decisions/00080 (was 00079 — collision with workspace-10's
  composer-autogrow 00079, renumbered via PR #108).

## Gates

admin-ui 441/441, tsc strict, pytest 854, mypy strict, e2e 13/13
(media-edit spec: replace→publish→in-place), ad-hoc verify at 390px.
