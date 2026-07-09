# Milestone 8 slice 4: E2E 2 (image replace) and E2E 3 (theme change) as real Playwright tests, a cross-file test-isolation gap found and fixed, closing milestone 8

## Context

Slices 1-3 (decisions/00020-00022) shipped the media upload backend, the theme
panel, and the media panel/dialog + `mediaRequest` rewiring. This closing slice
builds spec/08-testing-acceptance.md §2's E2E 2 ("Image replace") and E2E 3
("Theme") as real Playwright tests, matching M7 slice 4's precedent
(decisions/00019) of reusing `e2e/fixture_server.py` as-is. Only the EDITING-side
half of each flow is built — the publish-tail half of both ("committed to repo
images/, served, resized, EXIF-free" / "theme.css + fonts link reflect it" on the
PUBLISHED site) needs milestone 9's publisher, matching decisions/00015 decision
4's already-established E2E 1/4 caveat, reiterated for M8 throughout
decisions/00020-00022.

## Decisions

**1. The E2E 2 fixture (`e2e/fixtures/oversized-exif-rotated.jpg`) is a real,
checked-in binary JPEG — generated once with Pillow, not constructed at test-run
time.** `e2e/` has no Python dependency of its own (unlike `builder`/`wixy_server`'s
own tests, which construct EXIF-bearing images programmatically via Pillow at
test time) and no JPEG-encoding library — hand-rolling raw EXIF bytes in TS, or
adding a new runtime Python dependency to the E2E suite just for fixture
generation, would both be more machinery than a single small checked-in binary
fixture, matching the precedent `builder/tests/fixtures/mini-site/images/*.jpg`
already sets. The fixture is genuinely BOTH oversized (3000x2000 landscape as
stored, exceeding the mini-site project's configured 2000px `maxLongSidePx`) AND
EXIF-rotated (orientation=6, rotate 90° CW) — verified by running it through the
REAL `process_upload` function before committing it: final output 1333x2000
(portrait — proving re-orientation — and capped at the 2000px limit — proving
resize), EXIF fully stripped.

**2. `e2e/tests/helpers.ts` (new) extracts `gotoEditAndWaitReady`, `editTextField`,
and `trackConsoleErrors` out of `concurrent-editing.spec.ts` (which now imports
them instead of defining its own copies), plus a new `waitForNextDraftPatchAccepted`.**
Justified NOW (not before) because a THIRD spec file needing the identical "wait
for the overlay's `init`" / "filter browser-level resource-load noise" logic is
what actually materialized — extracting after two consumers already existed
would have been premature; extracting once a third needed the exact same thing
is the opposite of premature.

**3. E2E 3 substitutes `cream` for spec/08 §2's literal "`clay`", and confirms
"Headings" = the `serif` role — both already-established substitutions, not new
judgment calls.** The mini-site fixture's `theme.json` (deliberately minimal,
`builder/tests/fixtures/mini-site/theme/theme.json`) only has `cream`/`coffee` —
`clay` is the REAL Cottage Aesthetics palette (spec/02 §4's example), which this
generic engine-level fixture was never meant to mirror. "Headings" = `serif` was
already confirmed against the real CA `site.css`'s own usage in decisions/00021;
this slice just reuses that mapping, not re-derives it.

**4. E2E 3 explicitly blocks `https://fonts.googleapis.com/**` via
`page.route(...).abort()` rather than letting the request attempt (and possibly
fail/hang) on its own.** spec/08 §1: "never hit the real network" — the test's
job is proving OUR code's DOM updates (the CSS var, the `<link>` `href`), not that
Google's CDN is reachable or that the family visually renders; blocking outright
keeps the test's behavior deterministic regardless of the CI runner's actual
network egress, rather than depending on an unstated assumption about it.

**5. A REAL Playwright-config gap, found the moment E2E 2 and E2E 3 existed
ALONGSIDE E2E 8 for the first time: `fullyParallel: false` alone does NOT force
different `.spec.ts` FILES to run sequentially against the one shared fixture
server + draft overlay — only `workers: 1` does.** `fullyParallel: false` only
serializes tests WITHIN a single file/worker; Playwright still assigns different
files to different worker processes by default, and all of those workers hit the
SAME external `fixture_server.py` (one process, one draft overlay) since
`webServer` in `playwright.config.ts` is a single shared instance, not
per-worker. This was invisible when `concurrent-editing.spec.ts` was the only
spec file (nothing else could race it) — the instant `image-replace.spec.ts` and
`theme-change.spec.ts` existed too, a genuine cross-file race surfaced as a real
409 (one file's discard op losing a rev race against another file's concurrent
PATCH). Fixed by adding `workers: 1` to `playwright.config.ts` — accepted as
correct for now given the whole suite runs in ~10s, nowhere near spec/08 §2's
"< 5 min" budget; if the suite grows enough to need real parallelism later, the
better fix would be per-file isolated fixture servers (separate temp
`storage_root`/port each), not attempted here as a speculative build-ahead.

**6. Two prior test-writing mistakes, found and fixed while building THIS
slice's tests (not product bugs) — worth recording so a future test author
doesn't repeat either:** (a) a scoped-looking-but-actually-generic DOM query
(`document.querySelector(".wx-theme-hex")`) silently matched the ALPHABETICALLY
FIRST rendered color row ("coffee") instead of the row a test had explicitly
filtered to earlier ("cream") — `renderSections()` fully rebuilds the DOM on
every reset/refetch, so a later raw querySelector must be re-scoped exactly the
same way the earlier Locator was, not re-derived generically; (b) checking
server-side persisted state immediately after a UI action, before the OpQueue's
300ms coalesce + network round trip has actually completed, produces a false
read of the PRE-change value — fixed by waiting on the actual `PATCH /api/admin/
draft` response (`waitForNextDraftPatchAccepted`) before asserting server state,
not a fixed sleep or a race-prone DOM-only check.

## Verification

`e2e/tests/image-replace.spec.ts` (new, 1 test): upload the oversized/EXIF-rotated
fixture → DOM background-image updates → the uploaded item is genuinely resized
(portrait, ≤2000px longest side, proving re-orientation AND resize both actually
ran) and genuinely servable (asset fetch 200s — decisions/00022's fix, an assertion
that would have caught that exact regression) and EXIF-free (no APP1 marker
immediately after the JPEG SOI). `e2e/tests/theme-change.spec.ts` (new, 2 tests):
a color + a font-family change live-apply to the embedded preview's CSS vars AND
the fonts `<link>` href, and persist server-side; a per-token "reset to
published" round-trips through the server and reverts both the control's
displayed value and the live CSS var. `e2e/tests/helpers.ts` (new, decision 2).
`e2e/tests/concurrent-editing.spec.ts` refactored to use the shared helpers — the
already-passing test re-verified unaffected by the refactor before building
anything new on top of it. `e2e/playwright.config.ts` gained `workers: 1`
(decision 5). Full suite (4 tests across 3 files) run twice in a row locally:
4 passed both times, ~10s total, well under spec/08 §2's budget.

## What to watch for

- Milestone 8 is now 100% closed (all 4 slices merged: wixy PRs #31, #32, #33,
  and this slice's own PR). Next: milestone 9 (publish + history) per
  `spec/09-work-plan.md`.
- E2E 1 (text edit) and E2E 4 (collection) still don't exist as Playwright tests
  yet — decisions/00015 decision 4 deferred them pending milestone 9's publisher
  (their flows explicitly end in "→ Publish → ..."); build them once that exists,
  matching this same "editing-side now, publish-tail once M9 lands" pattern if a
  partial version is ever wanted sooner.
- `playwright.config.ts`'s `workers: 1` (decision 5) means EVERY future E2E spec
  file shares the same global serial-execution constraint — remember this when
  adding new spec files (they will run correctly, just not concurrently with
  each other); revisit per-file fixture-server isolation only if suite runtime
  ever becomes a real problem.
- The two test-writing mistakes in decision 6 are worth remembering as a pair:
  "did I re-scope this query after a DOM rebuild?" and "did I wait for the real
  network round trip, not just the optimistic client-side update, before reading
  server state?" — both are easy to get subtly wrong in exactly the way this
  slice did the first time.
