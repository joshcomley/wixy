## What

`admin-ui/src/historyPanel.ts` (new): the `#/history` panel (spec/05 §5) — the
publish ledger newest-first via the already-built `GET /api/admin/publishes`
(slice 2), with View/Restore actions per row. Closes out milestone 9's backend
(decisions/00024 slice 1, 00026 slice 2, restore.py this slice) with its UI
surface.

## Decision 1 — typed confirmation is a real inline text match, not a browser
`confirm()` dialog

Spec says "typed confirmation" for restore. Implemented as an inline row
(inserted as a second `<tr>` right after the target row, `colspan`-ing all
columns) with a text input that must exactly equal the literal string
`"RESTORE"` before the Confirm button enables — not a native `window.confirm`
(which can't demand a TYPED phrase, only OK/Cancel) and not a generic "click
twice" pattern (weaker — a stray double-click could trigger it). A real typed
match is unambiguous, matches spec's own word choice, and needs no new
dependency (no modal library).

**Real HTML-structure bug caught and fixed while building this**: the first
draft rendered the confirm row as a bare `<div>` inserted via `row.after(...)`
— but `row` is a `<tr>` inside a `<tbody>`, and a `<div>` can never be a valid
direct child/sibling of table rows there (HTML table-parsing rules silently
correct or relocate it). Fixed by making the confirm row an actual `<tr>` with
one `<td colspan="7">` wrapping the same inner content — caught by reasoning
about table semantics before it shipped, not by a failing test (jsdom doesn't
enforce this the way a browser's table-parsing algorithm does, so this class
of bug can pass every existing test while still rendering wrong/dropped in a
real browser — worth remembering for any FUTURE inline-row-insertion UI).

## Decision 2 — `getPublishes()`/`restore()` added to `api.ts` only now, not in
slice 2

Slice 2 deliberately did NOT add these to the TypeScript `AdminApi` client even
though the BACKEND route (`GET /api/admin/publishes`) already existed —
logged at the time as "avoid building unused API surface ahead of need" since
nothing consumed it yet. This slice is that consumer; added now, matching the
already-recorded intent exactly.

## Decision 3 — `PublishesEntry` models both ledger-entry shapes as one type
with optional fields, mirroring `LedgerEntry.to_dict()`'s own branching

A publish entry carries `message`/`source`/`changed`; a restore entry carries
`action`/`of` instead (never both, enforced server-side by `LedgerEntry.
to_dict()`'s `if self.action is not None: ... else: ...` branch). Modeled as
ONE TypeScript interface with all of `message?`/`source?`/`changed?`/
`action?`/`of?` optional, rather than a discriminated union — simpler for the
panel's own rendering helpers (`authorLabel`/`messageLabel`), which already
branch on `entry.action === "restore"` directly; a union would add type
narrowing ceremony for no real safety benefit here, since the server's OWN
contract already guarantees the two shapes are mutually exclusive.

## Decision 4 — View defaults to the version's `index.html`, not a
page-picker

Spec's "View (opens that build read-only at `/admin/versions/<n>/…`)" doesn't
name which page. `index.html` matches the existing convention elsewhere in
this codebase for "the natural landing page of a whole site" (the top bar's
own "Site ▸" link goes to the domain root, not a chosen page). A per-page view
picker would be a reasonable enhancement but isn't demanded by spec and adds
UI surface for a rare, already-served-by-the-generic-route need (the archived
build's OTHER pages remain reachable by navigating from the served index page
itself, since `routes_versions.py`'s catch-all serves the WHOLE build
directory, not just `index.html` — a viewer can click through from there).

## Decision 5 — restore's frontend never distinguishes 409 (publish running)
from 422 (unknown version / resurrection unsupported) beyond the label

Matches `publishDrawer.ts`'s own established `PublishOutcome` pattern
(`{kind:"conflict"}` / `{kind:"failed"}`, real server detail message shown
verbatim) rather than inventing richer client-side branching — the server's
own `detail` text already carries the specific reason, and both cases resolve
to the same UI treatment (re-enable the confirm row, show the message inline,
let the operator decide whether to retry/cancel).

## What to watch for

- `historyPanel.ts`'s `changedSummary` renders `{file: (count)}` pairs from the
  ledger's `changed` field — this is the SAME shape `_changed_summary`
  (publisher.py) has produced since slice 1; if that shape ever changes, this
  rendering breaks silently (wrong count, not a crash) rather than loudly —
  worth a shared type/round-trip test if this becomes a recurring drift risk.
- Milestone 9 is now feature-complete for its CORE mechanics (publish
  pipeline, HTTP surface, review drawer, restore, history panel) — what
  remains is explicitly slice 4 (page duplicate/delete routes — scope
  decision still open, see decisions/00024's original note) and slice 5
  (E2E 1/4/5/6, a kill-during-publish drill, and the closing decision).
