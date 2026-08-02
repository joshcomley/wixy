# 00002 — Update popup "What's new" release lines (r4t9wc)

Mission (operator, 2026-08-02): the update popup (decisions/00109's badge) must show a
brief, user-friendly list of what's new — NOT git history. Doctrine: every Wixy commit
message carries a `Release-note:` trailer (plain English for Purdy; "General bug fixes
and improvements." when nothing is user-visible); those sentences are what the popup
shows.

## Done in this workspace

- Server: `GET /api/version/notes?since=<sha>` (`routes_version.py`) — harvests
  `Release-note:` trailers from the range, dedupes, chronological, cap 8, generic-line
  fallback (no trailers / unknown since / gitless), hex-validated `since`, never 500.
- Admin UI: the badge prefetches notes at glow time (range = her pinned sha); the
  update dialog renders "What's new in this version:" bullets (loading line fills in
  place); fetch failure → the generic line, never blank, never git detail.
- Doctrine + gate: repo CLAUDE.md binding rule; CI `release-note` job fails PRs with a
  non-merge commit missing the trailer.
- Tests: 5 server (harvest/dedupe/order/fallbacks/injection/gitless), 3 badge unit +
  shell assertion, e2e extended (bullets + no-40-hex proof).
- Docs: contracts.md row, editor-and-admin-ui.md, spec/05 §1, decisions/00112,
  ANSWERS.md Q-006.

## State

Shipped via PR (see git log) — merged to main; Slots deploys. The FIRST live glow
after this deploy is itself self-describing: this PR's commits carry
`Release-note: The update popup tells you what changed in plain English.` — the first
real line she'll ever see in the list.
