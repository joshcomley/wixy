# Decision: fix a live bug where the registry drifted from decisions/00120's own design

## Symptom

The planner, independently live-verifying wixy PR #164 after it merged and deployed, found
the live admin's field-kind list didn't include `url` at all — contradicting the "deployed,
verified live" claim made for that PR. It kept investigating rather than taking the deploy
version match at face value.

## Root cause

`projects/ca.json` line 41 declared `gallery.sliders.sourceUrl` as `{"kind": "text"}`. It
should have been `{"kind": "url"}` per decisions/00120. Every OTHER piece of that PR was
correctly built for `url`: `builder/config.py`'s `AdminFieldKind` enum, `gallery-slider.
schema.json`, admin-ui's `renderUrlField`, the wizard's dispatch fix, and every unit test —
but the one line of DATA that actually wires the field to that kind still said `"text"`,
most likely because the registry edit was made against an early draft of the field
(reusing `text` as the starting point, per decisions/00120's own "reuse the existing text
AdminFieldKind" framing in the original task description) and never updated to `url` once
the dedicated kind was actually introduced.

**Why nothing caught it**: `admin-ui/tests/sectionPanel.test.ts`'s "the url field kind"
tests (decisions/00120) all construct their OWN local `SLIDER_SECTION` fixture with `kind:
"url"` hardcoded directly — they exercise the RENDERING LOGIC given a field descriptor, not
whether `ca.json`'s actual registry produces that descriptor. `python -m builder validate`
doesn't catch it either — `"text"` is a legitimately valid `AdminFieldKind`, just the wrong
one for this specific field; validate only checks kind membership in the allowed set, not
"is this the INTENDED kind." Net effect: the admin rendered `sourceUrl` as a plain text box
with no "Open" link — the one visible piece of UX the whole feature was for — and every
test and CI check was green regardless.

## What was decided

One-line fix (`"text"` → `"url"`), plus a new `builder/tests/test_ca_registry.py` that
loads the REAL `projects/ca.json` (not a synthetic fixture) and asserts the field's actual
kind — the first test in this repo to assert against the committed registry content itself
rather than a parser-behavior fixture. Verified red/green: reverted the JSON, confirmed the
new test fails against `"text"`; restored it, confirmed it passes.

## What to watch for

- Every existing `test_config.py` test uses its own synthetic JSON — none of them would
  ever catch a real `ca.json` drifting from what a decisions entry describes. If a FUTURE
  admin field's *specific* kind matters (not just "is it a valid kind"), add a
  `test_ca_registry.py`-style assertion against the real file, the same way this one now
  does for `sourceUrl`.
- A "deployed, verified live" claim that only checked the deploy commit SHA and that the
  new value round-tripped through the API is not the same as checking that the intended
  ADMIN CONTROL actually renders — the gap here was exactly that distinction. Live
  verification of a UI feature means looking at the UI, not just the data/deploy layer
  beneath it.
- See also decisions/00123 (found by the same live-verification pass, same session): even
  with this fix, the `url` field's own guard never sanitized the STORED value, only
  gated the admin's own convenience link — a separate, more serious gap.
