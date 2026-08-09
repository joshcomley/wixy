# Category management: dynamic choice-field options architecture — DONE

Operator, mid-conversation, right after two production bug fixes: "AND WORKED THANK YOU NOW
WE HAVE ANOTHER ISSUE SHE NEEDS TO BE ABLE TO MANAGE THE CATEGORY NAMES ON THE BEFORE AND
AFTER EDIT THEM ADD NEW ONES THAT SORT OF THING." Purdi needed to rename/add the Before &
After gallery's category labels (Lips/Cheeks/Chin & Jaw/Eyes & Brows) herself, via the admin
UI — previously a hardcoded registry literal only a developer could change.

## What shipped

A new generic `optionsFrom` capability on `choice`-kind admin fields (a dropdown can resolve
its options live from another admin-managed collection's current items instead of a static
list), plus `gallery.categories` registered as an ordinary two-required-text-field collection.
Two real generic gaps found+fixed along the way: a hardcoded `field.key === "title"` special
case in the add-wizard's Save gate replaced with a proper `required: boolean`; `blankItem()`
no longer silently defaults a new item's `optionsFrom` choice field to blank. A new
`dependentCollectionsOf` helper re-renders every field that sources its options from a
collection being edited, live, in the same staged edit (now Inv 30,
`docs/ai/invariants.md`). Full architecture + rationale: wixy repo decisions/00124, site repo
decisions/00012.

- wixy engine PR #171 (merge `b9b9e35361aad4f06888317bb9421b03dade1223`)
- wixy engine PR #172 (merge `6cb9601e93b8961fa79329601e2d11623c59b745`) — see below
- site repo PR #31 (merge `20910b630e94678faa6d0ad006a7aac82f36b242`)
- Published: version 47, sha `20910b630e94678faa6d0ad006a7aac82f36b242`

Planner ran a two-round FINAL HANDOFF gate on this (0 critical/0 high both rounds) — the
planner's own explicit standing instruction for anything changing the public site's rendered
behavior, even when small.

## Two real bugs self-caught during verification (neither invented, both measured)

1. **A previous session's own handover claimed `builder validate` had passed for the seeded
   category content — it hadn't been re-run after the final edit.** 2 category labels ("Chin
   & Jaw", "Eyes & Brows") were stored with raw, unescaped ampersands; `validate` correctly
   rejected them ("not-clean" — this repo's text-binding convention requires pre-escaped
   source, decisions/00075). Fixed before opening the site PR; never shipped broken. Lesson:
   a handover's "verified" claim is a claim, not a fact — re-run the check yourself.
2. **A real process gap of my own**: found+fixed+tested an entity-decoding bug in the admin
   dropdown (`resolveChoiceOptions` wasn't decoding HTML entities in `optionsFrom` labels the
   way `renderTextField` does elsewhere), but committed PR #171 before finishing the full
   verification pass that would have caught it — so the fix never made it into what shipped.
   Caught immediately during the planner-mandated live verification; shipped as a disclosed,
   planner-cleared follow-up (PR #172) within the same session. Lesson, named explicitly to
   the planner: commit AFTER finishing verification, not before.

## Live verification (headed Playwright, both admin and public)

Admin: "Category names" collection renders the 4 seeds; a photo's dropdown lists them,
correctly decoded; a real rename staged as a draft op immediately updated the dependent
dropdown (Inv 30 proven live), then fully discarded — `draft.opCount` confirmed 0 before and
after. Public: filter row renders all 5 buttons correctly; clicking "Chin & Jaw" filtered to
15/52 visible sliders, all `data-cat="chin"`. CI green on all three PRs including the site
repo's strict-screenshot parity check on the pinned ubuntu-latest platform (a 10.51% diff
seen locally on Windows was confirmed to be a pre-existing font-rendering artifact, not a
regression — reproduced identically against unmodified content, and real CI passed clean).

## What to watch for (planner's 3 LOW findings, recorded not respun)

1. A renamed/deleted category leaves referencing photos unfilterable on the public site
   (shown under "All" only) and their admin dropdown blank until repicked. Follow-up: a
   disabled "(no longer in your list): <value>" option so the select shows reality.
2. Nothing prevents two categories sharing the same `value` (duplicate dropdown options +
   duplicate filter buttons; harmless but sloppy). Follow-up: a panel-level uniqueness check.
3. No Playwright e2e for the categories flow specifically (unit coverage is strong, including
   the Inv-30 red/green test; publish pipeline itself unchanged). Follow-up alongside the
   still-open reveal-regression-guard gap from decisions/00010.
