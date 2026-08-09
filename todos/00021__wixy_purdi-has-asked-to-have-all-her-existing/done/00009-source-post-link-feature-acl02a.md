# Source-post-link feature — DONE

Follow-on ask from the operator, made in-chat right after the "Before & After editor
legibility" mission (task 00008) closed: "we need to have links back to the original
Facebook and/or Instagram posts in the imported before/afters."

Handed over mid-flight (handover/2608092014-wixy-source-post-links-cross-repo-merge.md) with
two open PRs (wixy #164, cottage-aesthetics-preview #27) and a real cross-repo CI ordering
dependency already diagnosed. Picked up and taken to full completion, live and published.

## What shipped

- New `url` admin field kind (`builder/config.py`, `admin-ui`) — `gallery.sliders.sourceUrl`,
  with an "Open ↗" convenience link, http(s)-only guarded. decisions/00120.
- Public `gallery.html` gains a gated "View original post" link per slider (only when a real
  URL exists). decisions/00009 (site repo).
- Backfilled `sourceUrl` for all 74 gallery items (67 real, joined against decisions/00008's
  import manifest by post id/shortcode; 7 deliberately empty — pre-import or wizard-added,
  no source to recover). A caption-text join was tried and rejected first — confirmed false
  positives.
- wixy PRs: #164 (url kind, merged 764758f), #166 (baseline recapture, merged de48994), #167
  (a real registry-drift bug: sourceUrl shipped as kind "text" not "url", found by the
  planner's own live-verification — merged d38da0f), #168 (a real security hole: the
  builder's `data-wx-href` binding had zero URL-scheme validation, a `javascript:` value
  could become live XSS on the public site — found by the planner mid-review, fixed by
  reusing the existing nh3 sanitizer, merged d783b16). decisions/00121, 00122, 00123.
- cottage-aesthetics-preview PR #27 (merged b3a07c9) — had silently fallen behind main
  (Purdi actively toggling gallery visibility live, 8->52 items, DURING this session); caught
  before merge and reconciled via a real merge+conflict-resolution, not a naive rebase, so
  nothing of hers was reverted.
- Published: site version 44, sha b3a07c9 (== the merge commit).

## Live verification (own checks, not just relayed)

- `/gallery.html` cachebusted: 52 visible items, 45 correct "View original post" anchors,
  7 with no anchor element at all (not just empty href).
- Headed-browser (Playwright, real Chrome) round-trip: the Jawline pair's link resolves to
  the real `instagram.com/p/DbAeisfoYvF/` post from the cottageaesthetics account.
- Admin, via CF-Access service-token session: 67 live "Open ↗" links, matching the 67 real
  URLs exactly.
- cottage main's own CI green on the merge commit.

## Notable mid-flight discoveries (both real, both fixed, not deferred)

1. The registry itself (`projects/ca.json`) drifted from the decided design — declared
   `text` instead of `url` for `sourceUrl`. New `builder/tests/test_ca_registry.py` now
   asserts against the REAL registry file (not a synthetic fixture) to close this class of
   drift going forward.
2. A real, general (not sourceUrl-specific) XSS gap in the builder's href-binding mechanism,
   pre-dating this feature — closed by reusing the project's existing `nh3` sanitizer rather
   than a weaker hand-rolled check (verified directly against real browser-honored bypass
   classes a naive check would miss).

## Follow-up NOT done here (flagged to planner + operator, needs its own design)

The parity-baseline treadmill: Wixy publishes push straight to cottage `main` with no CI gate
and no auto-rebaseline, so any visibility toggle Purdi makes can turn `main` red until someone
manually re-runs `capture-baseline.yml`. Needs a durable fix (e.g. a post-publish hook) as its
own piece of work — deliberately not improvised into this feature per the planner's guidance.

POST-RELEASE DONE REPORT sent to planner (session 75f673ab-803c-44ea-a863-edc04f1783e9)
2026-08-09.
