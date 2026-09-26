# 00001 [a1b2c3] Live drawing (the pen tool): server side, PR + audit

## What
Server side of the live-drawing feature (spec/server-chat/07-live-drawing.md): schema v13
(`drawings`/`drawing_strokes`), 5 routes, the new in-memory `DrawingBroker` live relay,
cascade erasure, docs (contracts.md/livechat.md §18/invariants.md Inv 53/CLAUDE.md),
decisions/00175. Client side is a parallel PR from `cmd/workspace-00035-live-drawing-client`.

## Why
Operator asked for a pen tool in the Server chat (live collaborative drawing). Dispatched
as a dedicated server-builder task by the driver (session `6c42566b`), split off from
workspace 00031 (which was also mid-flight on an unrelated disk-space incident and the
Tease preview/speed-slider work) — the driver reassigned sole ownership of
`cmd/workspace-00029-live-drawing` to this workspace over `/peer` mid-task.

## Context + current state (as of this write)
- Store, models, drawings.py (palette/limits), drawing_broker.py, routes, app.py wiring:
  all reviewed against spec 07 section-by-section, fixed 3 ruff unused-imports + 1 format
  issue + a real bug in `create_drawing`'s IntegrityError handling (was misreporting a
  CHECK-constraint failure as "anchor not found").
- Fixed a real bug the client builder's e2e caught: `GET /messages/{seq}/drawings` 500'd on
  every call (missing `response_model=None`).
- Wrote `wixy_server/tests/test_livechat_drawings.py` (store-level: allowlist, drift guard,
  migration v12->v13, create/append/delete idempotency+limits+CHECK constraints, ordering,
  a two-connection concurrency test, cascade-erasure raw-bytes proofs incl. an "older
  process" bare `DELETE FROM messages`) and `test_routes_livechat_drawings.py` (route-level:
  auth, full validation matrix, every error code, live relay rate limit + per-connection
  isolation + bounded-queue drop-oldest, `drawing_live` SSE frame never disturbing the
  cursor). Added a drawing-specific privacy sentinel to `test_reports.py`.
- ruff check / ruff format / mypy all clean.
- Docs + decisions/00175 + spec 07 amendment (v12->v13) written.
- Coordinated over `/peer` with the client builder (session chain to `79cdc885`, was
  `fffc7eb8`) on: the exact TS palette shape (confirmed byte-identical), decision numbers
  (00175 mine / 00176 theirs), and livechat.md section numbers (§18 mine / §19 theirs).

## How to continue + acceptance
1. Full bare `pytest` was running in the background at last check (18%, no failures) —
   confirm it finished green.
2. Commit (Release-note trailer EXACTLY "Release-note: General bug fixes and improvements."
   per R14a), push to `cmd/workspace-00029-live-drawing`, open the PR (title 'feat(server-chat):
   live drawing, server side'), body = the conformance matrix (drafted in this session's
   scratchpad, `pr_body.md`).
3. Do NOT merge — driver review + mandatory Opus 5.5 audit first (schema migration +
   erasure paths + new streaming path).
4. Known/expected: the TS/Python drift-guard test in `test_livechat_drawings.py` is red on
   THIS branch alone (the client's `drawings.ts` lives on their branch) — will self-resolve
   once both PRs share `main`.

## Links
spec/server-chat/07-live-drawing.md, decisions/00175-live-drawing-server-side/,
docs/ai/livechat.md §18, PR #282 (the Architect's spec ruling).
