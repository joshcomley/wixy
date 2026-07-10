## Decision 1 — the scope question: page duplicate/delete IS milestone 9 territory

Slices 1/2/3 (decisions/00024, 00026) each inherited an explicitly-undecided
question from decisions/00015 decision 3 (milestone 7): does milestone 9 build
`pages/duplicate`/`pages/delete` at all? Resolved by re-reading the actual
sources rather than assuming:

- `spec/09-work-plan.md`'s own M9 one-liner (line 22) does NOT mention page
  ops — this is what made the question look open.
- But `spec/09-work-plan.md`'s **M7** one-liner (line 20) explicitly says:
  *"admin shell (routing, top bar, pages panel **incl. duplicate/delete** +
  meta drawer)..."* — spec's own work plan DOES name duplicate/delete as part
  of the feature set, just attached to M7's line.
- `decisions/00015` decision 3 (built during M7) deferred it anyway, for
  reasons spec's own table doesn't capture: the MATERIALIZE-time semantics
  (spec/04 §5 step 2's page-ops handling) are M9 publisher territory, so
  building the routes before that contract existed risked getting the shape
  wrong. Its own words: *"Duplicate/Delete become real once the publisher's
  page-ops handling is being designed anyway (milestone 9, or a dedicated
  follow-up slice once M9 clarifies the contract)."*
- No OTHER milestone (1-13) mentions page duplicate/delete anywhere.

Conclusion: this is a real spec-vs-reality gap (spec assigned the feature to
M7's line, M7's own build correctly recognized a real dependency problem and
deferred it, M9 is where that dependency actually got resolved — slice 1
already built `_materialize`'s generic `pages_added`/`pages_deleted`
handling), not a deliberate scope exclusion. Declining to build it anywhere in
the 13-milestone plan would be an unauthorized scope reduction of a
spec-named feature, not a neutral "not my milestone" call. Built here,
closing the loop exactly where decisions/00015 anticipated it would land.

## Decision 2 — `merge_overlay` needed a real extension, not just two routes

Building `POST /pages/duplicate`/`POST /pages/delete` alone would have shipped
a technically-callable but practically invisible feature: `merge_overlay`
never consulted `overlay.pages_added` before this slice, so a newly-duplicated
page's OWN overlay op (`{slug}:meta.navLabel`) would have been silently
dropped by the existing "op targets an unknown page slug — skip" fallback
(the slug genuinely wasn't a key in `page_contents` yet) — the new page would
never appear in the pages panel at all until published, with zero user
feedback that anything happened.

Fixed by seeding `page_contents[new_slug]` from `page_contents[from_slug]` at
merge time (a content COPY, not a template copy — template copying stays
exactly where slice 1 built it, at publish-time materialize;
`decisions/00024` decision 4's "no new storage convention" call is unchanged,
this is a draft-VIEW concern layered on top, not a new persistence mechanism).
`pages_deleted` was deliberately left UNfiltered — spec's own words ("takes
effect at publish as a git rm") mean a staged-for-deletion page must keep
rendering normally in the draft right up until a real publish.

**A second, real gap this surfaced**: even with content seeded, the new
page's TEMPLATE genuinely doesn't exist on disk until publish (unchanged from
slice 1's design) — so `GET /admin/preview/<new-slug>.html` would still fail.
Rather than build the originally-spec'd draft-side template staging
(`draft/pages/<slug>.html`, decisions/00010 decision 4's ORIGINAL anticipation,
already superseded once by slice 1's simpler materialize-time-copy design) —
a genuinely bigger, riskier rearchitecture of already-shipped, tested
publish-pipeline code — `_build_state`'s per-page response gained an
`editable: (source.pages_dir / f"{slug}.html").exists()` flag instead. The
pages panel disables Edit for a non-editable page with a tooltip explaining
why, rather than linking to a preview that would 404. This matches
decisions/00024 decision 4's own framing of exactly this as *"a separate,
smaller UI question,"* not a full draft-editable-new-page flow — consistent
with spec/05 §2's closing line that structural work (which creating an
entirely new page's content from scratch clearly is) is explicitly the AI
chat lane's job (milestone 10), not something the visual editor needs to
support pre-publish.

A `pendingDelete` flag was added alongside `editable` for the same reason
(symmetry: the pages panel needs to show BOTH "this is new and not yet
publishable" and "this is going away at the next publish" as real, visible
states, not silent ones).

## Decision 3 — the diff algorithm reused nothing from restore; `add_page`/
`delete_page` are new, minimal `Overlay` mutators

`wixy_server/overlay.py` gained `add_page`/`delete_page`, mirroring
`apply_patch`'s exact shape (rev-checked, returns a new `Overlay`, raises
`RevConflictError` on a stale rev) rather than inventing a different
mutation-function contract. `delete_page` always bumps `rev` even when the
slug was already staged (idempotent in EFFECT, not in rev) — consistent with
`apply_patch`'s own unconditional bump on a same-value SET, so client rev-
tracking never needs to special-case "did this call actually change
anything." Existence/format validation (is `from` a real page, does `slug`
already exist, is `slug`'s format valid) is deliberately the ROUTE's job, not
these low-level functions' — they have no visibility into the merged site
state to check against.

## Decision 4 — a spurious-but-harmless pydantic warning, accepted rather
than chased further

`PagesDuplicateIn`'s `from` field (a Python keyword, spec/05 §2's own wire
contract names it `{from, slug, navLabel}`) needs aliasing —
`from_: str = Field(alias="from")`. This triggers pydantic 2.12.5's
`UnsupportedFieldAttributeWarning` (*"'alias' ... has no effect in the
context it was used"*) — but ONLY when FastAPI actually processes a real
HTTP request through `TestClient`; a bare `model_validate()` call, and even
full `create_app()`/route-registration, produce no warning at all (verified
directly, three ways). `model_dump(by_alias=True)` round-trips correctly, and
every route test asserting the parsed `from` value passes. Tried the
warning's own suggested fix (`Annotated[str, Field(alias=...)]`) — it does
NOT avoid the warning either, when the same real-request code path is
exercised (only avoids it for the bare `model_validate` case, which was never
the actual trigger). Given the wire contract is spec-mandated (can't rename
`from` to dodge the collision) and the feature is verified functionally
correct through this exact path, accepted this as a known, cosmetic
pydantic/FastAPI interaction quirk rather than degrading the code (e.g.
hand-parsing the body as a raw dict, losing pydantic's validation) just to
silence it — consistent with this project's existing convention of not
suppressing warnings globally (the asyncio deprecation warnings from
FastAPI's own internals show up unfiltered in every run too).

## What to watch for

- If a future pydantic/FastAPI version bump makes this warning disappear (or
  turns it into something more informative), that's a sign the underlying
  quirk is understood/fixed upstream — no action needed on this side either
  way unless it starts producing genuinely wrong `from_` values (it doesn't
  today, verified directly).
- The `editable`/`pendingDelete` flags are the FIRST time `GET /api/admin/
  state`'s pages array carries anything beyond meta/lastModified — if
  milestone 10's chat lane ever needs to CREATE pages programmatically
  (spec/05 §2's own "structural work is the AI chat lane's job"), it will
  need the SAME awareness of "not yet materialized" pages this slice
  established, likely via the same `pages_added`/`editable` mechanism rather
  than a new one.
- Slice 5 (E2E + closing) is what's left of milestone 9 — see the todos
  sidecar for its exact scope (E2E 1/4/5/6, a kill-during-publish drill, and
  the closing decision).
