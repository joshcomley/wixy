# M13: spec/08 §4 live verification results

All drills run for real against the deployed instance (`ca.cinnamons.uk`, through
the live Cloudflare edge, using the CF Access service-token mechanism from
decisions/00042), not against a local/dev stack. Evidence below; each drill left
the live site in a correct end state, verified by re-fetching the public page.

## Restore drill (undo/redo)

`POST /api/admin/restore {version: 0}` then `{version: 1}` against the live v1
(the M12 wording-fix publish). Confirmed: restore does NOT reuse the target's own
version number — it appends a NEW ledger version (`{action: "restore", of: N}`)
each time, so "undo" (v1→v2, content reverted to v0's) and "redo" (v2→v3, content
reverted to v1's) are both forward-moving history entries, not a rewind. Verified
via the public `/contact.html` (cache-busted) at each step: v2 showed the old
"Demo preview" wording, v3 showed the corrected wording again — restore genuinely
flips live content in both directions, ending on the intended (correct) state.

## Kill-during-publish drill (spec/08 §5 item 3, "on the deployed instance")

M9's own kill-during-publish drill (decisions/00030) covered this at the
unit/integration level (temp git repos) before Wixy was ever deployed anywhere;
this is the first time it's been exercised against the real, Devfleet-supervised,
live production process.

First attempt used a fixed 150ms delay before `Stop-Process -Force`; the resulting
502 (Cloudflare "couldn't reach origin") was ambiguous — it doesn't distinguish
"killed mid-pipeline" from "killed before the request was even dispatched."
Second attempt polled for `Storage/projects/ca/locks/publish.lock`'s own
appearance (proof `run_publish` has started) instead of guessing a delay — it
appeared within 1ms of the request landing, confirmed the kill genuinely
interrupted an in-flight publish, and gave a much stronger result:

- Live pointer: unchanged (still the pre-publish version/SHA) — confirms steps
  1-4 never touch the serving pointer, exactly as designed.
- Draft overlay: unchanged (same rev, same pending op) — the crash lost nothing.
- Ledger: unchanged (no corrupt or partial entry) — `run_publish` never reached
  step 5's `append_ledger` call.
- In-memory `publishJob` state: `None` on the fresh process (Devfleet restarted
  Wixy in well under a second, `healthz` was already 200 on the very first
  post-kill probe) — no stale "still running" flag blocking new publish attempts.
- The lock FILE was left orphaned on disk (confirmed via direct Python
  `Path.exists()` — **the Glob tool under-reports files under `D:\Servers\Wixy`,
  it isn't indexed the way the git worktree is; don't trust it for checks against
  live deployment directories, use a direct filesystem read instead**), age 73.8s
  at check time, comfortably inside `watcher.py`'s 600s staleness window.
- Decisive proof of self-healing: a follow-up publish (new draft edit, same
  content field) succeeded normally (`200`, new version) **despite the orphaned
  lock file still being present** — `run_publish` unconditionally overwrites
  `publish.lock` on every call (no staleness check of its own; that check exists
  only in `watcher.py`, gating the background fetch loop, not publish itself) —
  and its own `finally` block cleaned up the lock normally this time. Confirmed
  the orphaned lock is fully gone after that publish.
- Live public page re-checked after the follow-up publish: correct final content,
  no kill-drill test-marker text leaked to production.

## AI-conversation drill (spec/08 §4: "a real AI conversation... agent ships →
preview chip → publish")

Created a real conversation via `POST /api/admin/chat/conversations` (service
token, no browser) asking the site-owner-facing agent to reword the contact
page's `formIntro.body` line ("I'll get back to you personally, usually within a
day") since the form doesn't email anywhere yet, matching the honesty framing of
the M12 `thanksText` fix. The agent: read `CLAUDE.md`, found the exact field,
edited `content/contact.json`, validated, built, shipped (branch → PR #16 on
cottage-aesthetics-preview), hit a real parity-CI failure, diagnosed it
correctly (the change is a real visible-text diff against the committed
baseline — spec/03 §5 point 3's intentional-change case), found and triggered
`capture-baseline.yml` itself, and only there hit a genuine bug in that
workflow (**decisions/00043** — full writeup) that this whole chain had never
exercised post-migration before. The operator (`joshcomley`) independently
opened a parallel fix (PR #54, a verified-safe revert of the corrupted baseline
data) while this session root-caused and fixed the workflow itself (PR #55) —
both merged (complementary, different files, no conflict). Once the fixed
workflow was re-dispatched against PR #16's own commit (so the recaptured
baseline reflects its pending content, not stale main), PR #16 went green and
merged.

This is a genuinely valuable result beyond "the happy path works": the AI lane's
first real exercise against a live, post-migration site surfaced a real,
previously-latent infrastructure bug that would have blocked every future
content edit needing a visible-text rebaseline — exactly the value "verify for
real" keeps paying for, unchanged from every earlier milestone in this chain.

## `@pytest.mark.live_cmd` smoke test (spec/06 §4)

`pytest -o addopts="" -m live_cmd wixy_server/tests/test_cmdchat.py` — real
conversation against production cmd, "reply with the word pong" round-trip.
**PASSED** (7.51s).

## Lighthouse (spec/08 §4, "performance ≥ 90, a11y ≥ 90 — the static site already
achieves this; the CMS must not regress it")

`https://ca.cinnamons.uk/` (default Lighthouse config: mobile form factor,
simulated throttling): **performance 70, accessibility 93**. Accessibility
clears the bar; performance does not.

Before treating this as a regression, ran the identical check against the
still-live archived GitHub Pages snapshot
(`https://joshcomley.github.io/cottage-aesthetics-preview/`, `.nojekyll`
retired in M12 but the last-deployed build is still reachable and unchanged):
**performance 70, accessibility 93 — identical scores**, LCP 7.0s / FCP
~3.1-3.2s on both. This is decisive: **the CMS introduced zero performance
regression** (the spec's "must not regress it" bar is met). The spec's separate
claim that "the static site already achieves [≥90 performance]" does not hold
under this standard (default CLI / PageSpeed-equivalent) methodology — it never
did, pre- or post-migration; whoever verified that fact for spec/08 either used
different conditions (e.g. a desktop preset, or field data from real users
rather than lab data) or the claim was simply inaccurate. Root cause of the
~70 score on both: `server-response-time` is fast (47-59ms) and there's no
render-blocking/layout-shift/long-task issue (TBT 0ms, CLS 0) — the FCP/LCP hit
comes from Lighthouse's default mobile-simulated throttling (150ms RTT +
562.5ms request latency + 4x CPU slowdown) applied to the external Google Fonts
round-trips (`fonts.googleapis.com` + `fonts.gstatic.com`), a page-design choice
that predates this entire project (spec/03 §1: fonts have always loaded via a
per-page Google Fonts `<link>`) and is explicitly preserved verbatim by the
migration's rendered-parity guarantee. Changing the font-loading strategy
(self-hosting fonts, preloading, `font-display` tuning beyond the `swap` already
set) would be a real, legitimate future improvement, but it is a site-design
change outside this build's scope (implement faithfully, don't redesign) —
noting it here rather than silently chasing the number or silently ignoring the
gap.

## Files/evidence

Ad hoc verification scripts used for these drills were scratch, not committed
(one-off httpx/Python probes against the live admin API with the service-token
headers from decisions/00042 — same pattern, not repeated here). Raw Lighthouse
JSON reports and the live_cmd pytest log are session-local, not committed;
the concrete numbers/SHAs/timestamps above are the durable record.
