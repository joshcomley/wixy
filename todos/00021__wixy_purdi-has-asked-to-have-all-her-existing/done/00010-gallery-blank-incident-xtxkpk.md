# Production incident: gallery permanently blank — DONE

Not part of any planned task — the operator reported live, mid-session (screenshot from his
own phone, right after the source-post-link publish), that `ca.cinnamons.uk/gallery.html`
rendered completely blank below the intro text.

## Root cause (measured, not assumed)

`pages/gallery.html` (site repo) applied `site.js`'s scroll-reveal `reveal` class
(`opacity:0` until an `IntersectionObserver` at `threshold:0.12` adds `.in`) to `#basliders`,
the CONTAINER holding every gallery item — not to each item individually. Measured on the
live build: the container is 17,724px tall (52 currently-visible items, grown from 8 today
via the owner's own publishes). 12% of that is 2,127px of required viewport overlap — more
than double an 844px mobile viewport. No scroll position can satisfy it; the whole gallery
stayed invisible forever. `#bagrid` (the "more results" tiles) has the identical latent
defect, not yet symptomatic only because that list is currently near-empty.

Not caused by the source-post-link feature — the item-count growth that broke this was the
owner's own visibility-toggle publishes (v37-v43) from earlier the same day, using the "Show
on site" switch shipped in the PRIOR mission (00008). A pre-existing design trap (container-
level reveal doesn't scale past whatever container height keeps 12% reachable at a real
device's viewport height) that finally broke once the gallery grew large enough, and was
first noticed today.

## Fix

Moved `reveal` from the containers (`#basliders`, `#bagrid`) to each individual item
(`.ba-slider`, `.ba-tile`) — the same per-item `IntersectionObserver` pattern already proven
at this exact scale by the pre-existing "drag hint" nudge animation a few lines below in the
same file. cottage-aesthetics-preview PR #28 (merge commit `f97fc49`). Full rationale +
verification: decisions/00010 in that repo (with a follow-up correction, PR #29, after
confirming the parity screenshot harness never covered — and never would have caught — this
class of bug, because it deliberately force-reveals before every screenshot for its own,
unrelated determinism reasons).

Verified: 0/52 sliders ever reached `.in` before the fix (headed-browser, real mobile
viewport, realistic scroll-through); 52/52 after, both in a local build and on the live site
post-publish (version 45, sha matches the merge commit). Operator confirmed fixed on his own
phone.

## What to watch for

No automated test currently guards against a regression to container-level `reveal` — see
decisions/00010's "what to watch for" in the site repo for the specific gap and a proposed
follow-up test shape. Not started this round (time-pressured hotfix, fixed and verified by
hand, not by oversight).
