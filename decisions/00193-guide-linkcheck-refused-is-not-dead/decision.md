# Guide link check: refused is not dead

## Symptom

Main's CI went red on fc46e18 (2026-10-28 00:35Z) with nothing wrong in the guide:
`guide-linkcheck` reported `[FAIL] https://opensource.org/license/mit/ -- HTTP 403`. The next
main run passed. Measured over the last 60 CI runs: 1 failure, always this job, always a 403.
From the hub the same URL answers 200 with the checker's own User-Agent (`server: cloudflare`).

## Root cause

`guide/linkcheck.py` treated every status >= 400 as a dead link. opensource.org (like the guide's
other hosts) sits behind Cloudflare, whose bot protection sometimes answers a datacenter address,
here GitHub's hosted runner, with a 403 challenge. The one retry, 2 s later, came from the same
address and got the same answer. A 403 like that says the site would not serve this automated
request from this network; it says nothing about whether the page exists.

## Decision

- `check_url` returns a `LinkResult(outcome, detail)` with three outcomes:
  - **live**: any status < 400 (after redirects);
  - **refused**: 403, 429, or any response carrying `cf-mitigated: challenge`;
  - **dead**: everything else: 404/410, 401 (a login wall is broken for the guide's reader),
    5xx that persists, network failures.
- Three attempts per URL with 2 s then 4 s between them; the first live answer wins.
- `run` exits 1 only for a dead link. A refused link prints `[REFUSED] url -- detail` and, on
  GitHub Actions, a `::warning title=Guide link not verifiable::` annotation, so it is visible
  on every run that hits it, never silent.
- `detail` names the `server` and `cf-mitigated` headers, so a CI log says who refused.
- The checks are unit-tested through `httpx.MockTransport` (no real network).

## Why

spec/independence/07 §3 wants the link check to "keep honesty": catch real rot. Rot shows up as
a 404/410, a dead host or a persistent server error, all of which still fail. Failing on a bot
check made an unrelated PR's merge depend on Cloudflare's opinion of a GitHub runner's address.
That matters more now, because the operator chose (decision #2123, 2026-10-28) to make main
require its CI checks before anything merges, and this job is one of them.

## What to watch for

- A link that is refused on EVERY run is never verified. The warning annotation is the signal:
  if one appears run after run, check the link by hand (a real browser) and replace it if needed.
- Do not add 401 or 404 to the refused set to quiet a check: those are the failures this job
  exists to catch.
