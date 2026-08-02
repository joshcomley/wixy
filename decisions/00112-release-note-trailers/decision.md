# Release-note trailers: the update popup's "What's new", doctrine + CI-enforced

## Symptom

The version badge (decisions/00109) tells the owner a new version exists but not what
changed. Operator, 2026-08-02: "we want to add in the update a brief, very user-friendly
release change list of what's new in this version… it's not the full Git comment
history… anything going forward, any changes to Wixie, needs a very user-friendly
description of what it is. And if it's just bug fixes and things, then it just says
that… updating the doctrine for Wixie so that any git commits also have with it in the
description the user-friendly release info sentence. And that is what gets shown when
there's a new version."

## Decision

**The commit message is the database.** Every commit message now carries a
`Release-note:` trailer — one plain-English sentence written for the site owner (no
filenames, no PR numbers, no jargon). Unglamorous work writes exactly
`Release-note: General bug fixes and improvements.` The doctrine lives in the repo
CLAUDE.md's binding rules; CI's new `release-note` job hard-fails any PR containing a
non-merge commit without one (merge commits exempt; a multi-commit PR may repeat one
trailer — the harvest dedupes).

**The server harvests, it does not editorialize.** `GET /api/version/notes?since=<sha>`
(public, next to `/api/version`) runs `git log --format=%B <since>..HEAD` over the
engine checkout, extracts the trailers (case-insensitive), whitespace-collapses,
dedupes preserving order, reverses to chronological, caps at 8. Fallbacks, never a 500:
no trailers in range (pre-doctrine history) → `["General bug fixes and improvements."]`;
unknown `since` → last 10 commits; gitless image → the same generic line. `since` is
hex-validated before it reaches a rev range.

**The popup shows exactly those sentences.** When the badge detects a deploy it
prefetches `/api/version/notes?since=<her pinned sha>`; the update dialog renders a
"What's new in this version:" bullet list between the question and the
saved-changes note (a "Loading what's new…" line fills in place if she opens it
first). No commit subjects, no shas, no dates, no pagination — that is the fleet `ver`
popup's developer surface, and this is deliberately not it.

## Why

- **Trailer in the commit, not a CHANGELOG file**: the note rides the commit it
  describes — no merge conflicts on a shared file, no "forgot to update the changelog"
  step, and the range query (`since..HEAD`) is exactly "what changed since the version
  she's running" with zero bookkeeping.
- **Enforced, not aspirational**: an unenforced convention decays the first time
  someone is in a hurry, and the failure mode is silent (a deploy with nothing to tell
  her). The CI job makes the popup's content guaranteed, and the generic fallback
  sentence makes even a fallback truthful.
- **`sha_full` range, not count**: versions compare by sha (exact); the count stays a
  display-only number (decisions/00109).

## What to watch for

- The first-parent `--first-parent` count (the `v N` number) and the notes range use
  DIFFERENT history walks deliberately: the number counts merges to main; the notes
  read every commit in the range including feature-branch commits (that's where the
  trailers live).
- A commit whose trailer is missing slips nothing into the popup — the CI job is the
  only gate; `git log` has no memory of intent.
- Tests: `test_routes_version.py::TestVersionNotes` (harvest/dedupe/order/fallbacks/
  injection/gitless), `versionBadge.test.ts` (list render, generic-on-failure,
  loading-then-fill), `shell.test.ts` (list present in the shell's dialog),
  `e2e/tests/version-badge.spec.ts` (full flow incl. a no-40-hex assertion).
