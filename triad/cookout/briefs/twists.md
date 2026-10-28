# Cookout twists — module briefs (X1–X5)

Read `common.md` first (it binds every parcel). Authority for the twists:
`spec/server-chat/09a-cookout-twists.md` (frozen), layered on the core spec `spec/server-chat/09-cookout.md`
and the core code ALREADY ON the feature branch. The operator accepted all twelve twists; implement all
of them exactly as specified — the core game must behave identically when no twist is used.

Your parcel's exclusive files and dependencies are in 09a **Appendix A**; the frozen interfaces between
parcels are A.1–A.3 — do not change them; if one is wrong, send me a BLOCKER.

**Schema rule (orchestrator ruling):** schema v21 has never been deployed. There is no v22: the twist
schema changes are made IN PLACE in the existing `_SCHEMA_V21_COOKOUT` (and its migration), the
version stays 21, and the genuine-v20 migration fixture test must still pass and assert the final shape.

## X1 — Bank, draw engine and twist catalogue (Sonnet 5.5) — goes first

Implement 09a A.1 + §3 (chaos-shelf exotic draw, replacement draw for veto/swap, role-schedule
`first_role` for fridge raid, bank search for fridge raid, wildcard draw, encore seeding helpers,
`mentions` / `food_free_tokens`) and the §3.3 twist catalogue module `cookout_twists.py` (styles and
challenges as fixed static enums with their frozen wording). Tests per 09a §9 for your files. Small and
quick: X2 and X3 switch from fakes to your real code once you merge.

## X2 — Store, game, routes (Sonnet 5.5)

Implement 09a §1 (every twist's behaviour, states, Open/Blind rules, interactions), §1.10 generation
fencing, §2 schema (in-place v21), §4 wire (every new route/field/error, `require_server_token` first,
`no-store`, moveId idempotency, generation on vote/Bank/retries), and every A.2 store method with the
exact signatures, including the generation-fenced claim/completion methods X3 calls. Tests per 09a §9
(two-connection races, Blind on every response, migration). Use fakes for X1's API until it merges.

## X3 — AI and pictures (Sonnet 5.5)

Implement 09a §5 (style/challenge prompt lines from the catalogue, stars as required heroes, wildcard
coverage, rescue-swap generations with `forbidden_ids`, kitchen-challenge deterministic checks,
updated lexical scan), the changed runner protocol and `expected_generation` on every claim/completion
path (A.2), and §6 pictures (regeneration after swap within the existing `images_generation` fence).
Tests per 09a §9 incl. the two-worker generation-race tests and the five staple swap tests. Do not edit
store/models/app.

## X4 — Admin UI (Opus 5.5)

Implement 09a client section against the A.3 wire (JSON fixtures until X2 merges): start-sheet options
(style + spin, challenge, cloche, stars, fridge raid search), in-game controls (lucky dip, chaos shelf,
veto, swap propose/choose, cloche lift/decline, star toggles that disable once revealed, dinner vote with
hidden-until-both), generation display (archived dishes view-only), the "We cooked it!" sheet (cooked
marker, two heart ratings, linked mini-chat photo), encore/remix entry points, Recipe book additions.
Phone-first at 320/360 px with the same header/overlap layout check you (or the core UI builder) used,
plus desktop, light and dark; real renders of every new state. Blind mode: no hidden partner data in the
DOM. `npm run typecheck`, `npm test`, `npm run build`, committed LF bundles.

## X5 — Docs and e2e (Sonnet 5.5) — last

09a docs list (livechat, contracts, Inv 57 extension, glossary, testing, CLAUDE.md store table,
`decisions/00194-server-chat-cookout-twists/`) and `e2e/tests/server-cookout-twists.spec.ts` covering
each twist end to end with two browsers, after X1–X4 merge.

Every brief: FINAL HANDOFF to me per `common.md`; PRs target `cmd/workspace-00058`.
Design questions → the Architect (`ask-architect` skill); scope questions → me.
