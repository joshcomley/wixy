## Symptom

Once `builder/tests/parity/capture.py` was fixed (decisions/00141 + its follow-up
`img.decode()` fix) to correctly measure/screenshot `loading="lazy"` images, the
`cottage-aesthetics-preview` WP4 dispatch (site PR #45) re-ran CI and found a
**new, different** single-image parity failure on the gallery page:
`builder/tests/parity/baseline/gallery/probe.json`'s committed entry for
`/images/ba-chin.jpg` was `[0, 0]`, while a fresh capture (through the now-fixed
harness) correctly measured `[640, 640]` — a real, valid, on-disk 640×640 JPEG
present in the site repo since 2026-07-01, nothing to do with WP4's own
`loading="lazy"` addition.

## Root cause

The committed baseline itself was already silently wrong for this one image,
inherited from whatever capture produced it (most recently decisions/00138's
v65 rebaseline, itself just recapturing whatever the previous baseline already
had for this entry) — masked because every prior parity comparison ran the
*same* buggy `capture.py` on both sides (the fresh build AND, indirectly, every
earlier baseline recapture), so a `(0, 0)` vs `(0, 0)` comparison always matched
even though both values were wrong. Fixing the harness (decisions/00141) made
the *fresh* side correct while the *stale, committed* side stayed wrong,
finally exposing the drift as a mismatch instead of a silent double-error.

## What was decided

- Recaptured the baseline again via the established mechanism (decisions/00043,
  00121, 00138): `.github/workflows/capture-baseline.yml` (`workflow_dispatch`,
  pinned `ubuntu-latest`), dispatched against a dedicated branch
  (`chore/rebaseline-parity-decode-fix`) rather than `main` directly — same
  reviewed-merge discipline decisions/00138 established (the workflow's own
  commit step has no PR/review gate of its own; the dispatch ref is the only
  review boundary it gets).
- `ca_ref` = `5b7e20d928ba4547ee028d3381a7132276653b1` — `cottage-aesthetics-preview`
  `main`'s tip at capture time (WP4/PR #45 not yet merged there, so this
  recapture is against the SAME site content the existing baseline already
  targets — proving the `ba-chin.jpg` fix is independent of WP4's own changes,
  not something that only surfaces once lazy-loading lands site-side).
- Verified the resulting diff touches exactly `gallery/probe.json` (the one
  `[0, 0]` → `[640, 640]` line pair) and `gallery/desktop.png` (the screenshot
  now correctly shows the image instead of a blank tile) — nothing else, no
  scope creep into any other page.

## Why

Confirms decisions/00141's own reasoning was correct and complete: the parity
harness's own capture logic, not any site content or WP4-4C's `loading="lazy"`
addition, was the root cause all along. This recapture is the closing half of
that fix — the code fix alone couldn't repair an already-wrong committed
artifact; only a fresh recapture through the fixed code can.

## What to watch for

- Any other previously-authored baseline entry could theoretically carry the
  same class of silent zero-dimension error if it happened to race the old
  capture flow's fixed 300ms settle window for a reason unrelated to
  `loading="lazy"` (a slow-loading before/after slider image, a large file, a
  contended CI runner). This recapture only touched `gallery` because that's
  the only page where a mismatch actually surfaced — a stale-but-still-matching
  `(0, 0)` elsewhere would stay invisible until something else changes the
  fresh-side value. Not chased further here; flagging as a class of risk to
  keep in mind if a future unrelated PR trips an unexplained single-image
  parity diff.
