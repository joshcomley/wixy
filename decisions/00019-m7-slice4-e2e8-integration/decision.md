# Milestone 7 slice 4: E2E 8 as a real Playwright test, closing the milestone

## Context

Fourth and final slice of the M7 PR train (decisions/00015). Replaces
`e2e/tests/smoke.spec.ts`'s CI-wiring placeholder with a real, full-stack Playwright
test for E2E 8 (spec/08-testing-acceptance.md §2: "Concurrent editing sanity: two
admin tabs, edits in both, no lost ops (rev/replay)") — the one of the three E2E flows
M7 is scoped against that doesn't depend on milestone 9's publisher (decisions/00015
decision 4; E2E 1 and 4 need a real publish step to fully pass).

## Decisions

**1. `e2e/fixture_server.py` — a standalone Python script, not a pytest fixture or a
TypeScript `globalSetup` — builds the full stack Playwright's `webServer` config
launches.** It lives inside `e2e/` (an npm package) despite being Python, because its
only job is importing `builder`/`wixy_server` directly (`ensure_checkout`,
`build_site_source`, `build_site`, `create_app`) — reimplementing checkout/build/app-
construction logic in TypeScript instead would duplicate real product code for no
benefit. It builds a genuine, throwaway git repo from `builder/tests/fixtures/mini-
site` (copied into a temp dir, `git init`+commit) — the SAME real-shaped fixture the
Python unit suite already trusts (decisions/00017 decision 1's "real-shaped fixtures"
lesson applies here too) — rather than a hand-authored HTML snippet that might miss a
real binding-shape edge case. `hero.title`/`hero.tag` (spec/08 §2's targets) are two
independent, direct (non-item-scoped) text bindings already on that fixture's home
page — no new fixture content needed.

**2. The fixture server publishes ONE real build (via `builder.build.build_site` +
a hand-written `live.json`) before ever starting uvicorn.** Without this, every E2E
flow's preview page would 503 loading its own `site.css`/`theme.css`/`images/*`
(`routes_public.py`'s correct, spec-mandated "no live.json yet" response for a
genuinely fresh install, spec/04 §3) — correct behavior, but noise unrelated to
whatever a given E2E flow is actually testing, and spec/08 §2 makes "console errors
anywhere in E2E" an unconditional failure. Mirrors exactly what milestone 12's real
cutover does as its first action, just invoked directly here rather than through
milestone 9's (not yet built) publish pipeline.

**3. The console-error check filters out `"Failed to load resource"` messages
specifically, while still catching every real `console.error()`/`pageerror`.** That
message is a BROWSER-level network diagnostic Chromium emits for any non-2xx HTTP
response Chromium's own resource loader observes — it fires regardless of whether
application code handles the response correctly, and cannot be suppressed from JS.
E2E 8 deliberately, correctly provokes a 409 (decision 4) as the entire point of
testing rev/replay; treating that diagnostic as a failure would make spec/08 §2's own
rule unsatisfiable by the flow it explicitly describes. Every OTHER console-error
category (uncaught exceptions, application `console.error()` calls) still fails the
test — this is a narrow, justified exception, not a blanket weakening.

**4. The rev-conflict/replay path is forced DETERMINISTICALLY via Playwright request
interception, not left to real-world timing.** Tab A's `PATCH /api/admin/draft` is
delayed 700ms via `page.route()` before tab B's (undelayed) edit on the same page
commits — guaranteeing tab A's request reaches the server with a now-stale
`expectedRev`, forcing a real 409 and the OpQueue's own refetch-and-replay logic
(`admin-ui/src/opQueue.ts`, already unit-tested in slice 1) to run for real, end-to-
end, against a live server. A test that only hopes two ~300ms-coalesced requests
happen to race on a given CI run would be flaky-by-construction — this design turns
a probabilistic race into a deterministic one and asserts the 409 was actually
observed (`patchResponses.some(r => r.tab === "A" && r.status === 409)`), so a future
regression that broke the replay path would fail loudly rather than passing by luck
on a fast runner.

**5. `.github/workflows/ci.yml`'s `e2e` job gained Python setup (`actions/setup-
python` + `pip install -e ".[server,dev]"`) — it had none before this slice.** The
job previously only ran `smoke.spec.ts`'s placeholder (no real backend needed); a real
E2E flow against a real `wixy_server` needs Python available in that job's own runner
regardless of the `python`/`frontend` jobs having already passed (`needs:` is an
ordering dependency between GitHub Actions jobs, not a shared filesystem/environment —
each job runs in its own fresh container). `playwright.config.ts`'s `webServer.command`
resolves the interpreter via `WIXY_E2E_PYTHON ?? "python3"` — `python3` is correct and
present after `actions/setup-python` on the `ubuntu-latest` runner; the env-var override
exists because this repo's own Windows dev convention is a specific, non-PATH
interpreter location (this project's CLAUDE.md) where a bare `python`/`python3` resolves
to the Microsoft Store's useless stub, confirmed by direct testing (`python3 --version`
prints the Store-redirect message, not a version) rather than assumed.

## Verification

Ran the real E2E test locally 3× in a row (`WIXY_E2E_PYTHON=<pythoncore-3.14> npx
playwright test`), all green, consistent ~4.2s runtime — a genuine concurrency test can
be flaky even after "it passed once," so multiple consecutive clean runs is the actual
bar, not a single pass. Confirms: both tabs' edits (`hero.title`, `hero.tag`) persist
correctly (`draft.opCount === 2`, `GET /api/admin/content/index` shows both new
values); tab A's forced conflict genuinely produced a 409 followed by a 200 (the
replay succeeding); tab B's edit succeeded on the first attempt; zero real console/page
errors on either tab. `wixy` full suite still green after this slice (`pytest` 335,
`mypy --strict` clean on `builder`/`wixy_server` — `e2e/fixture_server.py` is outside
mypy's configured `files` scope by design, since it's E2E-test-only infrastructure, not
product code; `ruff check`/`format --check` DO cover it, both clean).

`admin-ui`/`editor` source untouched this slice — no rebuild needed, no drift.

## What to watch for

- E2E 1 and 4 (text-edit-to-publish, collection-edit-to-publish) still can't fully
  pass until milestone 9's publisher exists (decisions/00015 decision 4) — not
  attempted here, as planned.
- `fixture_server.py`'s port (8799) is hardcoded — fine for CI (one job, one runner)
  and local runs; would need to become dynamic if E2E tests ever needed to run
  multiple fixture servers concurrently (not a need today).
- This closes Milestone 7 (Editor v1) — all 4 slices merged (wixy PRs #27, #28, #29,
  and this one). Milestone 8 (media + theme panel) is next per spec/09-work-plan.md.
