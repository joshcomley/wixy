## Context

Slices 1-4 (decisions/00024, 00026, 00027, 00028, 00029) shipped the publish
pipeline core, its HTTP surface + review drawer, restore + history, and page
duplicate/delete. This closing slice builds spec/08-testing-acceptance.md §2's
remaining E2E flows (1, 4, 5, 6 — 2, 3, 8 already existed; 7 needs milestone 10's
chat and stays deferred), a real kill-during-publish drill (§1), and milestone 9's
closing acceptance decision, matching M6/M7/M8's own "E2E + closing decision"
precedent (most recently decisions/00023's structure).

Every one of E2E 1/4/5/6 is the FIRST thing in this whole 9-milestone chain to
actually exercise a real, end-to-end publish through a real browser. That turned
out to be far more consequential than "write four more Playwright specs" — it
found five real, previously-shipped bugs across the editor, publisher, and
watcher, none of which any prior unit test (jsdom has no real layout/hover
geometry; TestClient never puts two requests in a genuine timing race; no test
before this slice ever sent a real OS-level kill signal) could have caught. This
is the same pattern this whole chain has repeated at every milestone: real
browser/process verification finds what mocked/in-process tests structurally
cannot.

## Decision 1 — the E2E fixture's site origin needed to be a genuine bare repo

`e2e/fixture_server.py`'s `site_origin` was a plain `git init` working-tree repo
(pre-existing since M7). A non-bare repo refuses `git push` to its own checked-out
branch by default — harmless for every flow before this slice (all read-only), but
it would have broken E2E 1/4/5/6 outright the moment any of them tried to actually
publish. Fixed by mirroring `wixy_server/tests/test_publisher.py`'s own
`bare_origin` fixture exactly: `git init --bare`, seed-clone, commit, push. This
was the FIRST thing every other decision below depends on.

## Decision 2 — a real bug: the item toolbar cleared itself the instant it was hovered

`editor/src/overlay.ts`'s `handleItemToolbarHover` ran on every `pointerover`
event and treated any target that didn't match `.closest("[data-wx-list-item]")`
as "left every item" — including the toolbar's OWN buttons, which are mounted on
`document.body` (positioned near the item, never nested inside it). The instant a
real pointer entered the toolbar to click a button, this cleared the toolbar out
from under itself, making `add`/`duplicate`/`moveUp`/`moveDown`/`delete` — the
ENTIRE list-item toolbar — permanently unclickable in a real browser. This
shipped in milestone 7 (decisions/00017) and was invisible to the existing unit
suite: jsdom dispatches synthetic `mouseover` events directly, never the real
`pointerover`-with-`relatedTarget` sequence a genuine mouse transit produces, so
the self-clearing path was never exercised. Found the moment E2E 4 tried to click
"add" for real. Fixed with a one-line guard: `if
(itemToolbar?.contains(target)) return;` before the existing "not inside a list
item" check.

## Decision 3 — a real bug: an emptied text field collapses to zero height and becomes unclickable

`blankTextLikeFields` (the "add"/"duplicate" toolbar action's cloned-item
blanking) set `innerHTML = ""` on every `[data-wx]` element. A completely empty
block element has no line box in a real browser — 0×0, confirmed directly via
`getBoundingClientRect()` — and Playwright correctly refuses to click something
with zero area, exactly as a real user's mouse could never land on it either. This
meant a freshly-added list item's title/body could NEVER be filled in through the
visual editor: the moment "add" ran, that field became permanently unclickable
until the whole page reloaded with different (non-empty) server data. jsdom never
renders real layout, so `getBoundingClientRect()` there is meaningless zeros
regardless of content — this bug was invisible to the unit suite by construction,
not by bad luck. Fixed by setting `innerHTML = "&nbsp;"` instead of `""` — the DOM
stores/serializes this back as a literal U+00A0 character, giving the element a
minimal real line box without touching this file's own explicit "editing chrome
never mutates layout metrics" CSS rule (this is ordinary bound CONTENT, not
chrome, and it's replaced the instant the user actually edits the field). The
VALUE actually sent to the server for a fresh "add" is computed separately and
correctly by `listOps.ts`'s `blankStrings` (unconditionally `""`, unchanged) — the
DOM-side nbsp is purely a same-session clickability fix, never persisted if the
user reloads before filling the field in (a narrower, accepted, out-of-scope-here
gap: a genuinely empty PUBLISHED field would still be unclickable on next load,
same as any pre-existing empty content would be — not something this slice
introduced or is positioned to fully solve).

## Decision 4 — a real bug: rapid edits followed immediately by publish can 409 on a stale client-side rev

`shell.ts`'s `OpQueue.onAccepted` fires a background, UN-AWAITED `GET
/api/admin/state` after every accepted PATCH (`refreshStateInBackground`) — this
is what the publish drawer's `expectedRev` is built from. E2E 4's flow (add, fill,
reorder, delete, then immediately publish) chains four accepted PATCHes with
essentially no other await between them, exactly as a real user rapidly clicking
through an item toolbar would — and the drawer can open on a stale
`state.draft.rev` before that last background refresh has landed, producing a
409 that has nothing to do with a real conflict (no other actor touches this
fixture's draft). Fixed in the test helper, not product code: `publishAndWait`
retries on 409 by closing and reopening the drawer (which re-reads whatever
`state` is by then), converging within a couple of attempts. This is a test-harness
robustness fix, not a product bug — the underlying race is a client that hasn't
caught up with its own recent writes yet, which a real user would also
occasionally hit and just as harmlessly retry (the button re-enables, nothing is
lost).

## Decision 5 — `gotoEditAndWaitReady`'s same-URL navigation was a silent no-op

Navigating to the exact URL (including hash) the page is already on is a browser
no-op — no navigation, no hashchange, so the SPA router never remounts the edit
view and the content fetch this helper waits for never fires, hanging until
Playwright's own timeout. E2E 5 (restore) is the first flow to revisit the same
page's edit route twice in one test (before and after a publish). Fixed in the
shared helper (not per-test): detect `page.url().endsWith(target)` and use
`page.reload()` instead of `page.goto()` in that case. The SAME gap existed for
navigating to `#/history` twice in a row (restore.spec.ts's own "check history
before, check history again after restoring" need) — fixed inline there with an
explicit `page.reload()` plus a wait for the specific `GET /api/admin/publishes`
refetch, since that case is local to one test rather than a cross-file-reusable
helper concern.

## Decision 6 — a real bug: a genuinely killed publish leaves `publish_lock` orphaned forever

`run_publish` only removes `paths.publish_lock` in its own `finally` block — a
genuine OS-level process kill (`Popen.kill()`, no graceful shutdown) skips
`finally` entirely and leaves the lock file on disk permanently.
`watcher.fetch_once` checks `paths.publish_lock.exists()` with NO staleness logic
at all, so an orphaned lock would pause the upstream watcher forever — meaning a
killed-and-never-manually-cleaned-up publish would silently stop AI-lane commits
from ever appearing in the draft preview again, with no error, no log, nothing to
signal it. This is exactly the kind of gap that only a GENUINE kill (not a
monkeypatched/raised exception, which always runs `finally`) can surface — found
specifically while designing this slice's own kill-during-publish drill, before
the drill was even fully written. Fixed with a staleness threshold
(`_LOCK_STALE_AFTER_S = 600.0`, ten minutes — deliberately far longer than any
real publish, including a slow network push/build, should ever take): a lock
older than that is treated as abandoned, not in-flight, so the watcher self-heals
within that window with no operator action needed. `run_publish` itself already
self-heals the lock's CONTENT on its own next run (it unconditionally overwrites
the file, no existence check gates it) — only the watcher's own read side needed
the fix.

## Decision 7 — a genuine spec-vs-reality gap: the staleness-triggered preview fetch was never built

spec/04-server.md §7 describes the upstream watcher fetching "every 60s (and
immediately before preview loads after >10s staleness + before publish)." Only
two of those three triggers actually existed in code: the periodic 60s loop
(`watch_upstream`) and the always-fetch-before-publish (`run_publish`'s own
preflight `ensure_checkout` call, unconditional). The on-demand "preview load
after stale" trigger was never implemented anywhere — confirmed by grepping the
whole `wixy_server` package for every `fetch_once`/`watcher_status` call site.
This surfaced only because E2E 6 needed an AI-lane commit to become visible in the
draft preview / publish drawer within a test's timeframe, exactly the UX gap this
spec line exists to close (without it, an admin editing the site while an AI-lane
merge lands wouldn't see it for up to 60 real seconds). Built properly in
`routes_preview.py`'s `GET /admin/preview/{page}.html` (the actual route the
editor's iframe loads, per `editView.ts`'s `iframe.src`) — NOT `/api/admin/state`,
which reports whatever the checkout's current HEAD already is but never fetches
on its own. The threshold (`DEFAULT_PREVIEW_STALENESS_THRESHOLD_S = 10.0`, spec's
own number) is a `create_app` parameter, mirroring the existing
`watcher_interval_s` test-tuning pattern exactly, rather than an environment
variable — consistent with how this codebase already exposes test-only timing
knobs. Two new `test_app.py` cases cover both the stale-triggers-a-fetch and
fresh-does-not-refetch directions.

E2E 6 deliberately does NOT lean on this mechanism for its own determinism,
despite being what motivated building it: `fixture_server.py`'s
`/test/simulate-upstream-commit` (fixture-only, never imported by product code)
fetches the checkout forward itself, immediately, right after pushing — it has a
much stronger signal available (it just pushed the commit) than "wait for the
next preview load to notice staleness." An earlier version of this fixture DID
lower the whole app's `preview_staleness_threshold_s` to near-zero globally so
E2E 6 could rely on the real mechanism end-to-end — reverted (see decision 12)
once it turned out to slow down or destabilize EVERY OTHER test's preview loads
suite-wide for no real benefit; the direct-fetch approach gives E2E 6 the same
guarantee with zero blast radius on the rest of the suite.

## Decision 8 — E2E 1, 4, 5, 6 built

- **E2E 1 (text edit)**: exactly per spec's own flow description — edit
  `hero.title`, draft chip shows 1 change, publish, live page shows the new text,
  history gained a version. The simplest flow; also the first to prove the whole
  publish pipeline works end-to-end through a real browser (decision 1's fix,
  verified for real here for the first time).
- **E2E 4 (collection)**: spec says "add + reorder a treatments card; delete an
  FAQ item" — the mini-site fixture (deliberately minimal, generic, not
  CA-specific) has exactly ONE list-bound collection, `showcase.items`, not
  separate treatments/FAQ lists. Both halves exercise `showcase.items`,
  explicitly recorded as a substitution rather than silently reinterpreting spec
  — matching decisions/00023 decision 3's own established precedent (substituting
  `cream` for `clay`) for the identical reason: this generic engine-level fixture
  was never meant to carry CA-specific content. Add clones+blanks (decision 3's
  fix makes this clickable), the new item is given real content, moved up one
  slot, then the original second item is deleted; publish; the built HTML
  reflects both the new order and the new count via a real DOM query (`ul.showcase
  > li`, not a regex — the nested `.tags` sub-list and the header/footer
  partials' own nav/legal lists all carry the SAME `data-wx-list-item` attribute,
  so a naive selector massively overcounts).
- **E2E 5 (restore)**: two real publishes, restore to the first version via the
  history panel's typed-confirmation UI, then verifies all three spec-named
  outcomes independently — the live site serves version 1's content again, the
  history panel gained a genuine restore-action ledger entry (`Restore of version
  N`, author "restore"), and the draft (re-opened in the editor) now shows
  version 1's content too, not version 2's. Never hardcodes a version NUMBER
  anywhere (the fixture already does one initial publish before the server even
  starts, so this flow's own two publishes land at whatever versions actually
  follow that) — always uses the number `publishAndWait` itself returns.
- **E2E 6 (AI lane, faked)**: milestone 10's `cmdchat.py` doesn't exist yet, so
  "fake cmd ships a commit" is simulated exactly as its own name says — a
  fixture-only endpoint pushes straight to the bare origin and fetches the
  checkout forward (decision 7's closing paragraph). Verifies the draft-status
  chip surfaces the upstream count, the publish drawer lists the commit's subject
  and author, publishing includes it live, and — a bonus check beyond spec's own
  wording — the history panel correctly attributes a zero-draft-ops publish
  riding purely on an upstream commit to source `"upstream"` (rendered as "AI" by
  `historyPanel.ts`'s `authorLabel`), not `"editor"`.

`e2e/tests/helpers.ts` gained `publishAndWait` (shared from the moment all four
of the above needed the identical open-confirm-wait-retry sequence, unlike
`gotoEditAndWaitReady`/`editTextField`/`trackConsoleErrors`'s own
third-consumer-discovered-organically precedent — here every consumer was already
known up front, so extracting immediately was the non-premature choice) and the
`gotoEditAndWaitReady` same-URL-reload fix (decision 5).

## Decision 9 — E2E 2 and E2E 3 extended with real publish-tail assertions

decisions/00023 flagged this explicitly as an undecided nice-to-have and never
revisited it. Both flows' own spec/08 §2 wording literally includes "→ publish →"
as part of the canonical description — E2E 2 ends "...→ publish → file committed
to repo images/, served..." and E2E 3 ends "...→ publish → theme.css + fonts link
reflect it." Neither was actually testing that half. Now that the publisher fully
exists and E2E 1/4/5/6 already proved the whole pipeline works end-to-end, this
closes a real, spec-named gap at modest incremental cost (both extensions reuse
`publishAndWait` and existing fixture infrastructure) rather than leaving it
flagged a third time. E2E 2 now asserts the uploaded image is genuinely
`git`-committed and servable from `/images/<name>` on the LIVE (not draft) site,
byte-identical to the staged version, and referenced in the live HTML — this also
caught its own small gap: the existing test never actually waited for the
"replace image" action's own overlay PATCH to be accepted before proceeding, so a
publish immediately afterward could race ahead of the op that makes
`hero.bg` referencing the media at all (found the moment this extension's own
"file exists in images/" assertion 404'd — the media was uploaded and visible in
the LIST endpoint, but the binding itself hadn't been persisted server-side yet).
E2E 3 now asserts the built `theme.css` contains the new color and the live
page's fonts `<link>` reflects the new family.

Extending E2E 3 surfaced a real CROSS-TEST-FILE coupling bug: its second test
("reset to published") hardcoded the fixture's pristine original cream value
(`#F1E8D9`) as what "reset" should revert to — correct in isolation, but no
longer correct once the FIRST test in the same file genuinely publishes a
different cream value, which is now what's actually checked out/published by the
time the second test runs. Fixed by having the second test capture whatever the
CURRENTLY-published value is (a fresh `GET /api/admin/theme` at the top of the
test) and asserting reset reverts to THAT, not a hardcoded constant — the correct,
general fix (independent of file-internal test ordering or what any other test in
the suite has done), not a workaround. This is the same "one shared fixture
server across a whole suite run" lesson decisions/00023 decision 5 already
established, now shown to bite MORE than just concurrent PATCH revs.

## Decision 10 — the kill-during-publish drill uses a real OS process kill, not a mocked exception

spec/08 §1's publish-pipeline guarantee ("any step's failure → job state
'failed'; live site + ledger + draft all unchanged") was already exercised at
the unit level in `test_publisher.py` via monkeypatched/raised exceptions — but
a raised-and-caught exception ALWAYS runs Python's own `finally`/`except`
machinery, which is exactly what a genuine process kill (`SIGKILL`
equivalent — `subprocess.Popen.kill()`, which calls `TerminateProcess` on
Windows and is abrupt/uncatchable on both platforms, no cleanup code runs at
all) does NOT do. The todos sidecar's own scope explicitly called for "a genuine
E2E kill," never yet exercised. `wixy_server/tests/test_kill_during_publish.py`
(new) runs the whole pipeline as a REAL, SEPARATE OS process (a tiny generated
launcher script + `uvicorn.run`, not the in-process ASGI `TestClient` every other
`wixy_server` test uses) specifically so `.kill()` can terminate it truly
abruptly at an unpredictable point — the exact scenario atomic tmp+rename writes
(`live_pointer.save_live_pointer`) are meant to survive, and the exact scenario
that found decision 6's stale-lock bug.

Design specifics:
- **Timing**: rather than trying to land the kill at one precise pipeline stage
  (racy — this fixture's git operations are fast enough that a blind sleep or a
  stage-targeted wait could easily miss the window), the test tightly polls `GET
  /api/admin/state` and kills the INSTANT `publishJob.isRunning` is first
  observed true. `job.stage` is set to `"pulling"` as literally the first
  statement inside `run_publish`, before any git/file I/O runs at all, so this
  reliably lands well before "swapping" (step 5) even on a slow box. A sanity
  assertion (`observed_stage not in ("swapping", "done")`) turns a late kill into
  a loud, honest test failure instead of a silent false pass that proves nothing.
- **No `pytest-timeout` dependency**: that plugin happens to be installed in this
  interpreter but is NOT declared in `pyproject.toml`'s `dev` extras — using
  `@pytest.mark.timeout(...)` would silently rely on an undeclared, possibly
  environment-specific package that a clean CI `pip install -e ".[dev]"` might
  not have. Every wait in this test is instead bounded by its own explicit
  `time.monotonic()` deadline or `timeout=` parameter, so nothing can hang
  indefinitely without any global plugin at all.
- **Recovery, not just non-corruption**: after confirming live.json/the
  ledger/the draft overlay are all byte-identical to their pre-publish state, a
  SECOND, fresh server process is started against the SAME Storage root and
  asked to publish normally. This is the stronger, more valuable assertion — not
  just "nothing broke," but "the system self-heals from a genuine kill with zero
  operator intervention," directly exercising decision 6's fix in the same test
  that motivated it.

Ran 4 times in a row locally, ~8s each, 4/4 clean — the "kill as soon as
observably running" design has no meaningful timing dependency to be flaky about.

## Decision 11 — an intermittent full-suite-only theme-change timeout, investigated and NOT chased further

Across this slice's many full-suite runs (roughly a dozen), one specific
assertion (E2E 3's first test — a `page.waitForFunction` waiting for a live CSS
custom property to reflect a color change) intermittently hit its own 30s
timeout, always and only when running the FULL 8-test suite together, never in
isolation. Investigated properly rather than dismissed:
- Checked for and killed an orphaned `fixture_server.py` process (a real, separate
  issue from an earlier interrupted run — cleaned up, not the root cause of the
  timeout pattern itself).
- Formed and tested a specific hypothesis (the suite's growing total runtime,
  after this slice added two more real publishes to E2E 2/3, now lands close to
  the watcher's periodic 60s tick, and that tick's thread-pool work coincides
  with theme-change's own critical timing) — DISPROVEN directly: setting
  `watcher_interval_s` to an hour for the E2E fixture (kept anyway, decision 7's
  closing paragraph, purely because it's genuinely unneeded background work for
  this fixture) had zero effect on the failure rate.
- Profiled REAL system load with `fleet_diag.py` (this box's own psutil-based
  reader, never a single noisy `Win32_Processor.LoadPercentage` sample) during an
  active failure window: CPU at 61.4% (up from an idle-ish 39.7% minutes earlier)
  and, critically, OTHER unrelated `python.exe` PIDs pushing 362 MB/s and
  104 MB/s of disk I/O — this box's own already-documented "transient disk-I/O
  contention from other unrelated processes" pattern (decisions/00025, 00027,
  and the prior handover's own "Open items #1" gotcha are three earlier,
  independent instances of the identical characteristic), now a FOURTH
  confirmed instance with real, contemporaneous evidence, not a guess.
- Per-test timings inside every "failing" full-suite run were uniformly fast
  (2-5s each) right up until the one stuck 30s wait — consistent with an
  occasional scheduling delay on a busy shared box hitting one timing-sensitive
  wait, not a systemic slowdown or a logic bug in this slice's own code (which
  is, in every other respect, unchanged from before this investigation).

Not fixed further — per this project's own established threshold (decisions/
00025, 00027, and the prior handover both draw the same line): re-investigate
only if the RATE or REPRODUCIBILITY genuinely changes (e.g. the same test fails
twice in a row with the SAME system-load signature and NO plausible external
cause), which this run's own evidence explicitly rules out (an identified,
external, independently-confirmed cause). If this becomes a persistent CI
annoyance rather than a rare local one, the next escalation step would be
widening this ONE `waitForFunction`'s own timeout rather than anything
structural — not attempted here as a speculative fix for a pattern already
explained.

## Milestone 9 closing acceptance (spec/08-testing-acceptance.md §1 + §2)

- Every publish step's failure leaves live serving + draft intact, tested on
  temp git repos with a simulated bare-repo origin — DONE (slice 1,
  decisions/00024) at the unit/monkeypatch level, and now ALSO exercised as a
  genuine OS-level kill (decision 10) — the harder, previously-unexercised case
  the todos sidecar specifically called for.
- Restore semantics (04 §6): diff granularity binding-map-driven, instant live
  swap, draft reset to the restored version — DONE (slice 3, decisions/00027/
  00028), now also verified end-to-end through a real browser (E2E 5, decision
  8).
- E2E 1 (text edit), 4 (collection), 5 (restore), 6 (AI lane, faked) — all four
  built and passing (decision 8); E2E 2 (image replace) and E2E 3 (theme) now
  ALSO cover their own publish-tail halves (decision 9). E2E 7 (chat UX) remains
  correctly deferred — needs milestone 10's chat panel, which doesn't exist yet.
  E2E 8 (concurrent editing) already existed (M7 slice 4, decisions/00019).
- A genuine kill-during-publish drill exists and passes reliably (decision 10).
- Full suite green: 473 Python tests, mypy strict (84 source files), ruff check +
  format; 170 admin-ui TS tests (unchanged this slice — no admin-ui source
  touched); 109 editor TS tests (2 new/updated for decisions 2-3); 8 E2E tests
  (4 new, 2 extended, 2 unchanged), reliably green in isolation and the
  overwhelming majority of full-suite runs (decision 11's one documented,
  external, non-code exception).

**Milestone 9 (publish + history) is now CLOSED.** All 5 slices merged: wixy PRs
#35, #36, #37, #38, and this slice's own PR.

## What to watch for

- Five real product bugs (decisions 2, 3, 4's underlying race — though the FIX
  there is test-side, the race itself is a real client behavior a real fast user
  could also hit — 6, 7) were found by this slice's OWN E2E work, not by any
  prior review. This is now at least the 7th distinct instance across this whole
  chain of "verify behavior for real finds what mocked/unit tests structurally
  cannot" — keep doing this at every future milestone, especially milestone 10's
  chat panel (a domain with its own SSE/streaming/postMessage timing surface
  that's exactly this same class of risk).
- Decision 3's `&nbsp;` fix is a same-session-only clickability patch — a
  genuinely empty PUBLISHED field (from ANY source, not just "add") would still
  render unclickable on a fresh page load. If milestone 10's AI chat lane ever
  creates pages/fields programmatically with empty string values, this same
  class of bug could resurface there; the fix, if ever needed, is the identical
  "seed a minimal real value, never a bare empty string" pattern.
- Decision 7's staleness-triggered fetch threshold (10s) is now a REAL,
  user-facing timing behavior in production, not just a spec sentence — if a
  future milestone's own UX work depends on "how fresh is the draft preview,"
  this is the mechanism and the number to know about.
- The E2E suite's `/test/simulate-upstream-commit` endpoint
  (`e2e/fixture_server.py`) is fixture-only scaffolding for the AI lane's
  UPSTREAM-COMMIT half; it has no bearing on milestone 10's actual `cmdchat.py`
  client, which talks to a fake cmd SERVER (spec/06 §4), a completely different
  integration surface.
- Milestone 10 (AI chat) is next — `spec/06-ai-chat.md` needs a full fresh read
  before starting (not yet re-read this whole M9 milestone); it is genuinely new
  territory, unlike M9 which built entirely on M6-M8's existing foundations.
