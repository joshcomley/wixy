# Round 2, parcel 5: docs + picture-first e2e (spec 09b §F.3, §F.5) + one flaky e2e root cause

Read `common.md` first (its rules bind you: never edit `.git/info/exclude`, stage by explicit path,
FINAL HANDOFF envelope, no PR until I clear your exact SHA). Builder: Sonnet 5.5. Coordinator
(me): session `92d99463-3965-4e8c-9ff7-eca88839d7b4` — every hand-in and question goes there.

Authority: `spec/server-chat/09b-cookout-visual.md` (frozen). You own exactly what §G.1 row 5 says:
everything in §F.5, `e2e/tests/server-cookout-visual.spec.ts`, and the e2e fixture
server/fixtures additions. Do not touch production code (`wixy_server/**`, `admin-ui/src/**`); if a test
you write exposes a real product defect, report it to me with a repro — I route it to its owner.

## A. Docs (start now)

The code reality is on `origin/cmd/workspace-00058`: catalogue (`cookout_catalogue.py`, `.json`),
pack (`cookout_pack.py`, `cookout_ingredient_images.json`), serving (`cookout_visuals.py`, the
`/admin/cookout-img/{sha}.webp` route, the standalone baked pack + `deploy/standalone/ci/cookout_image_proof.sh`),
tooling (`tooling/cookout/visual/*`), UI (`admin-ui/src/server/cookout/*` — the picture-first table,
intro, carousel; merging now from `cmd/workspace-00058-bs22`). Document the CODE (read it), not just
the spec. Write every item in §F.5:

- `docs/ai/livechat.md` §24.2 "Cookout pictures, catalogue and the picture-first table";
- `docs/ai/contracts.md` — snapshot fields (`what`, `image`, `facts`), staples `image`, the image route
  with its literal headers/status codes;
- `docs/ai/invariants.md` **Inv 58** (confirm it is still the next free number), the §F.5 wording;
- `docs/ai/runbook.md` — object store path, registry/pins/lock, `cancel`/`status`, pack
  install/fetch/gc + download admission, releases never deleted, the two env vars, regenerate +
  publish a new pack, missing-pack self-heal, the PAUSE file; and the measured fact that the pilot
  ran as a hub scheduled task (Interactive session), not on the Grid, because the hub's Grid workers
  only take CI jobs;
- `docs/ai/testing.md`, `docs/ai/architecture.md` (module map), `tooling/README.md`,
  `deploy/standalone/README.md` (the baked pack);
- `decisions/<next free>-cookout-ingredient-pictures/{title,decision}.md` (spec says 00201 — check max+1
  across `decisions/` incl. any `done/`): storage decision + rejected alternatives (pictures in git),
  photographic style, empty-queue scheduling, calibration rule;
- `CLAUDE.md` — one line under "What's here" for the manifest + catalogue files.

Docs-only changes still need `ruff format --check .`.

## B. e2e `e2e/tests/server-cookout-visual.spec.ts` (start once I tell you parcel 4 has merged)

Implement §F.3 in full: the fixture server sets `WIXY_COOKOUT_IMAGES_DIR` to a temp dir filled by
`cookout_pack.py placeholders --dest <dir>`, plus a fixture manifest/catalogue covering the fixture bank
ids. The whole matrix (5 viewports; each phone viewport also with the 34 px inset and with a non-idle
call; Open and Blind; no twists and every twist; the long-text fixture) and every assertion listed
(fit in every picking state, hit-testability, 44×44 targets with no overlap, pictures ≥96, no clamped
names, the P<411 rules, tap picks, pictures load, carousel advances, reveal grid of ten with an emoji
fallback, Blind DOM absence). Parcel 4 already committed a chef-stage layout test in
`server-cookout.spec.ts` — do not duplicate it; reuse its helpers if useful (import, don't copy).

No fixed sleeps (`waitForTimeout`) — wait on observable state (`expect.poll`, locators). Each
assertion must be red against a deliberately broken layout: prove this once by temporarily breaking
one CSS rule locally (do not commit it) and record what failed in your hand-in.

## C. Root-cause one flaky e2e (owned by you for this round)

`e2e/tests/server-drawing.spec.ts:276` failed once while the full suite ran concurrently with a
second suite on the hub (double load). A flaky test is a failing test here. Reproduce under load
(e.g. `--repeat-each` under a concurrent full run), capture traces, find the real cause, fix it (the
test if the test is racy; if it is a product race, report it to me with the trace before touching
product code). Prove it: a before/after repeat count under the same load.

## Definition of done

- Full local e2e (`npx playwright test` in `e2e/`) green, including the new spec; then the new spec
  plus `server-drawing.spec.ts` ×10 under a concurrent full-suite load, all green.
- `ruff check .`, `ruff format --check .`, bare `pytest` (never `-n auto`) green.
- Every commit carries `Release-note: General bug fixes and improvements.` (Server-chat rule R14a in
  CLAUDE.md — never name the chat or its features in a trailer).
- FINAL HANDOFF to me with branch, base, exact candidate SHA, verification numbers, deviations.
  One combined hand-in or two (A docs, then B+C) — say which up front.
