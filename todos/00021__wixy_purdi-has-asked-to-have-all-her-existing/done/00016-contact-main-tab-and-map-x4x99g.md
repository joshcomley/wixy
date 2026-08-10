# Contact main tab, address wording, and a real map — DONE

The operator, via the planner, right after decisions/00127 shipped: "Move this to a main
tab, not buried in settings" — plus fixing the address hint's misleading wording, and "it
should update the map" (address-derived by default, or a placed pin — his own
clarification: "Without coordinates, the map should use the address to show where to go").

## What shipped

Contact promoted from a Settings tab to its own main nav tab (`/admin/contact`) — new
`contactPanel.ts`, moved wholesale out of `settingsPanel.ts`. Address label/hint reworded
(no longer reads as "multiple addresses expected"). A real map: `_global.json` gains
`mapCoords`/`mapSrc` (the latter derived — address by default, a placed pin overrides),
mirroring the phoneHref/emailHref derived-pair pattern from decisions/00127. New hand-rolled,
dependency-free map picker (`mapPicker.ts` + `mapPickerModel.ts` — OSM tiles, drag-to-pan,
zoom, armed click-to-pin). Generalized the href scheme-injection guard (decisions/00121/
00123) from `data-wx-href` alone to any `data-wx-attr` pair targeting a URL-bearing
attribute — found while binding the map iframe's `src` from content, the same injection
class, previously completely unguarded there.

- wixy engine PR #186 (merge `f39a0ba7faf78c9836e5c1c3b733f188631c15a5`)
- site repo PR #36 (merge `c00efccdbae6ef04f3c4c80dc3318ffa8ef3e89d`)
- Published v50; live-verified.

## Cleared first time — no FINAL HANDOFF block this round

Unlike decisions/00127's round (which the planner blocked once on a real HIGH), this
feature's FINAL HANDOFF cleared 0 critical/0 high on the first submission — the planner
independently re-derived the key design decisions (derived-pair precedence rules, the
reproduction-invariant test's deliberate non-byte-exactness) at the code level before
clearing, not just trusting the PR description.

## A real mid-flight collision, handled cleanly

Both repos' `origin/main` moved forward with an unrelated, concurrently-merged "clean URLs"
feature (workspace 00023) while this was in flight — caused a decision-number collision
(wixy wanted 00128, already taken; renumbered to 00129 throughout). Rebased both branches
cleanly (no real code conflicts — clean-urls touched different files/regions), re-ran the
full verification matrix after rebasing rather than assuming the rebase was safe.

## Live verification (real production, both surfaces)

- `ca.cinnamons.uk/contact.html` + the GitHub Pages mirror: map iframe `src` confirmed
  byte-identical to the pre-change hard-coded URL (string-compared, not eyeballed) —
  nothing visibly changed, exactly as intended for a first publish.
- Two full production round-trips via direct API calls, each asserted exactly in code (not
  visual spot-checks): (1) staged a pin — confirmed `mapCoords`+`mapSrc` land together,
  discarded — confirmed both revert byte-for-byte; (2) staged an address edit while
  unpinned — confirmed `mapSrc` re-derives correctly, discarded the whole family — confirmed
  all three keys (`address`/`mapCoords`/`mapSrc`) revert exactly. Final `draft.opCount==0`
  both times — no real change left published.

## What to watch for

- `e2e/tests/section-panel.spec.ts`'s "align a photo pair" flake recurred a 4th time
  (measured 84.4% CPU contention this time) — 4th data point now on decisions/00127's
  already-open record; still not re-investigated further, matching the planner's own
  standing guidance not to loop on it.
- The phone/email/address <-> href/mapSrc derived-pair pattern is now used twice
  (decisions/00127, 00129) — any future field with a real link-target companion should
  follow the same shape.
