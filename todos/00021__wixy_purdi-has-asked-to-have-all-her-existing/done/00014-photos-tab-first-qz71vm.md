# Swap tab order: Photos before Categories — DONE

Resolved the open UX question left from the admin-tabs feature (decisions/00125, sidecar
`done/00013-admin-section-tabs-fk28mz.md`): the operator decided Photos should be the
default (first-shown) tab, not Categories.

## What shipped

Pure registry reorder in `projects/ca.json` — moved `gallery.sliders`/`gallery.tiles` ahead
of `gallery.categories` in the before-after section's `collections` array.
`groupCollectionsByTab` picks tab order from first-seen registry order, so this alone flips
the default tab; zero code/logic change. Verified directly via `load_project_config` before
shipping that the parsed order + tab grouping resolve as `["Photos", "Categories"]`.

wixy engine PR #176 (merge `5cba2f5887ecdc421f6518f8d69d097fc85796a1`). All 6 CI checks
green. Sent the planner an FYI (not a blocking review — they'd already pre-characterized this
exact change as low-risk when they raised the original question) rather than a full
round-trip.

## Live verification

Confirmed live via `GET /api/version` (sha match) and a real headed-browser check against
`ca.cinnamons.uk/admin`: the Before & After section now opens on "Photos" by default.

## Also answered, same session: two operator questions about existing (unrelated) behavior

Not part of this change, but investigated and answered directly in chat rather than guessed:
1. The "Remove" button (category or photo) uses the browser's plain, unstyled native
   `confirm()` dialog — not a themed modal. Confirmed via Playwright's `page.on('dialog')`
   (which only fires for native dialogs) capturing the exact message text.
2. Deleting a category that's in use: doesn't corrupt the photo's stored `cat` value, but
   leaves its admin dropdown blank (`selectedIndex: -1`, confirmed empirically via a staged
   test, fully discarded afterward) until manually repicked, and the public site keeps
   showing that photo under "All" with no dedicated filter button. Matches the LOW finding
   the planner already flagged in the category-management review (decisions/00124) — now
   independently confirmed by direct testing, not just cited secondhand. A "(no longer in
   your list)" placeholder option was offered as a small follow-up fix; not requested yet.
