# Decision: rebaseline the gallery parity fixture; merge live production edits into an in-flight site PR

## Symptom

While finishing the source-post-link feature (decisions/00120), cottage-aesthetics-preview
PR #164's companion site-repo PR #27 was expected to go green once wixy PR #164 merged (the
`sourceUrl` schema landing on wixy `main`). It didn't — `validate` and `build` passed, but the
`rendered-parity check` step failed with `gallery/text`, `gallery/images`, and
`gallery/screenshot` mismatches unrelated to `sourceUrl`. Separately, cottage-aesthetics-preview's
own `main` branch had been RED on every push since roughly 14:37 that day (`wixy: publish v38`
through `v43`, all "Content update via Wixy editor" commits) — a production CI signal nobody was
watching because nothing in this repo pair notifies on a red `main`.

## Root cause #1 — the parity baseline was never re-captured after bulk imports + ongoing visibility edits

`builder/tests/parity/baseline/gallery/` (committed in the wixy repo, spec/03-site-migration.md
§5) is a per-page golden fixture: rendered text, link set, image set, and a screenshot, captured
against ONE specific real-world state of the gallery. Two cottage-aesthetics-preview PRs merged
earlier the same day (#25 "import Instagram/Facebook before-after posts (hidden)", #26 "import 58
more... (hidden)") added 66 new `gallery.sliders` items — but landed them `visible: false`
(intentionally, pending Purdi's review via the "Show on site" switch shipped this session,
decisions/00119) so neither PR's own CI ever saw a rendering change, and neither included the
same-PR rebaseline spec/03 §5 point 3 requires for an intentional visual change.

That alone would have stayed invisible (hidden items don't render), except Purdi was ACTIVELY
using that exact switch throughout this session — the live site's `gallery.sliders` visible count
went from 8 to 52 across `main` pushes v37 through v43, each one a real, correct, human-approved
content change with no corresponding rebaseline. `main`'s CI has effectively been red,
unnoticed, since the first of those edits landed.

## Root cause #2 — an in-flight PR branch silently fell behind concurrent production edits

PR #27's branch (`feat/source-post-links`) was forked before most of that visibility-toggling
happened. By the time this session returned to finish it, `origin/main` had 4 more real commits
(v40–v43) with a 232-line `content/gallery.json` diff from the branch's own merge-base — not
just visibility flags but re-aligned image filenames (the aligner tool) and retitled/recategorized
items. A naive rebase or a `--theirs`/`--ours` conflict resolution would have either dropped
Purdi's live curation work or silently reverted 44 items back to hidden once #27 merged — a real
regression to production content, not a cosmetic issue.

## What was decided

1. **`git merge origin/main --no-edit` into the PR branch, not a rebase.** The branch was already
   pushed; a merge is the safe way to reconcile a long-lived feature branch against a fast-moving
   `main` without rewriting shared history. Produced 5 conflicts in `content/gallery.json`, all the
   same shape: HEAD (this PR) had a stale `sub`/`title`/`visible` plus the new `sourceUrl` key;
   `origin/main` had Purdi's newer `sub`/`title`/`visible` but no `sourceUrl` (the field didn't
   exist yet on main). Resolved every one the same way — keep `origin/main`'s field values (strictly
   newer, real curation decisions), keep HEAD's `sourceUrl` line (the only thing unique to this PR).
   Verified post-merge: still 74 items, still 74 `sourceUrl` keys (67 real + 7 empty), visible count
   now 52 matching `origin/main` exactly — confirmed structurally (Python JSON load + counts), not
   just "no conflict markers left".
2. **Rebaseline against the PR branch's tip, not `main`.** `.github/workflows/capture-baseline.yml`
   (`workflow_dispatch`, `ubuntu-latest` — the pinned platform; a local Windows rebaseline is a
   known, documented incident, 2026-07-21, that broke all nine pages' screenshots) was dispatched
   twice: once (mistakenly, before realizing the branch was behind `main`) against the PR's
   pre-merge tip, producing a baseline with only 8 visible items; once for real, against the PR's
   post-merge tip (`1be72b2`, containing both Purdi's 52-visible-item state and this PR's
   `sourceUrl` links), producing the correct 52-item baseline with 45 "View original post" links.
   Rebaselining against the PR's own branch (not `main`) means the baseline already matches the
   post-merge world, so PR #27's own CI goes green directly instead of needing a second
   rebaseline-after-merge round trip — matching decisions/00043's own established precedent
   ("`ca_ref` = the in-flight PR's own branch").
3. **The baseline-fix landed as its own wixy PR** (branch `chore/rebaseline-gallery-parity`, off
   post-#164 `main`), not folded into #164 or #27 — it's a genuinely separate concern (a stale test
   fixture, unrelated to the `sourceUrl` feature) that happened to block visibility into #27's real
   CI status.

## What to watch for

- **A hidden-until-shown import is not risk-free for CI.** Landing bulk content as `visible: false`
  correctly avoids an immediate rendering diff, but it defers the parity break to whenever someone
  later flips visibility — with no CI run at that moment to catch it (a Wixy publish doesn't run
  this repo's `validate-build-parity` job; only a push to `main`, after the fact, does, and nothing
  alerts on that going red). Any future bulk-hidden import should be followed by a proactive
  rebaseline once the owner finishes reviewing/publishing, not left for the next unrelated PR to
  trip over.
- **An in-flight PR branch that touches high-churn content (the live gallery) can go stale FAST**
  while the site owner keeps working through the CMS in parallel — check `git merge-base
  <branch> origin/main` and diff before assuming a long-open content PR is still current, not just
  before merging it.
- Same rule as decisions/00120: never resolve a content-file conflict by preferring the OLDER side's
  descriptive fields (title/sub/cat/visible) over a newer, real edit — the newer edit is always the
  human's actual current intent.
- If this ever needs doing again: `ca_ref` should be the in-flight PR's CURRENT tip (post-merge with
  `main`, if it was behind), never a stale ref — verify `git merge-base` is a fast-forward or a
  clean, already-merged ancestor first.
