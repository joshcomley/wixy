# `_mark_nav_active` marks every `@nav` container, not just the first

## Symptom / what was found

Designing the CA site's header partial (milestone 4, spec/03 §3.2) surfaced a real
gap before any code shipped with it: the header needs the nav rendered **twice** —
once in the desktop `.nav-links` bar, once in the collapsible `.mobile-menu` panel —
exactly mirroring the current live site's own `site.js`, which calls its `links()`
helper twice and inserts the identical markup into both containers. Each rendering
must independently show the current page's link as `.active` (`.nav-links
a.lnk.active{color:var(--clay)}` is a real, visible style difference).

`render.py`'s `_mark_nav_active` used `body.find(attrs={"data-wx-list": "@nav"})` —
`.find()`, singular — so only the FIRST `data-wx-list="@nav"` container in document
order ever got its matching link marked. A second container with the same binding
(the mobile menu) would render with no link marked active at all.

## Why this wasn't already caught

The rendered-parity harness (spec/03 §5) wouldn't have caught this: the mobile menu
is always visually collapsed (`max-height:0;overflow:hidden`) unless a real user
clicks the hamburger toggle, which the automated capture never does — so a missing
`.active` class inside it would never show up in a screenshot, and the computed-style
probe only samples a fixed selector list (`nav.nav-links`, not individual `.lnk`
links), so it wouldn't catch this either. This would have shipped silently: a real
visitor opening the mobile menu on any non-home page would see no page highlighted,
with no automated signal ever flagging it.

## What was decided

`_mark_nav_active` now iterates `body.find_all(attrs={"data-wx-list": "@nav"})` and
marks the matching link inside every container, not just the first. Added
`test_every_nav_container_gets_its_own_active_link` (`test_render.py`) against a
fixture extended with two `@nav` containers (`nav.primary` + `nav.mobile`) —
confirmed RED against the pre-fix code (mobile link never marked, `KeyError` on the
missing `class` attribute) and GREEN after.

## What to watch for

- Any future template with `@nav` rendered more than twice (e.g. a footer nav) gets
  this behavior for free — no further change needed.
- Don't "simplify" this back to `.find()` — the whole point is supporting more than
  one simultaneous rendering of the same list.
