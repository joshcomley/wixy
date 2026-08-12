## Symptom

`cottage-aesthetics-preview` PR #43 (search-indexing programme, brief Work package 2's
site-side deliverable — the legacy-redirect-map + `.github/workflows/pages.yml` wiring) was
blocked by its `validate-build-parity` CI check failing on 5 checks: `index` text, `index`
images (`hall.jpg`/`room.jpg` vs. a two-newer-images set), `index` desktop screenshot (1.70%
diff), `index` mobile screenshot (2.55% diff), and `about` text. PR #43's own diff (a JSON
redirect map + one build-step flag in `pages.yml`) touches neither page and isn't even
exercised by that CI job (`ci.yml` doesn't pass `--static-redirects-file`) — confirmed
independently twice: once by the search-indexing programme's spec-author session (byte-for-byte
diff against site-repo `main` at `665f0d67`) and once by the dispatched site-repo agent working
PR #43 itself (re-derived the same match independently, plus its own last-5-runs check showing
`main` itself had been red since before PR #43 branched).

## Root cause

Same shape as this repo's own decisions/00121 and (per the dispatched agent's report)
`cottage-aesthetics-preview`'s own decisions/00008 and 00016: the committed parity baseline
(`builder/tests/parity/baseline/`, captured against one specific real-world state of the CA
site) drifts out of sync whenever Purdi publishes real content through the Wixy admin, because
that publish flow commits directly to `cottage-aesthetics-preview`'s `main` as
`wixy: publish vNN` — bypassing the PR-gated CI entirely. Nothing re-triggers a baseline
recapture when that happens, so the drift is invisible until the next unrelated PR opens
against site `main` and trips over it. `cottage-aesthetics-preview` decisions/00016 (per the
dispatched agent, who read it directly) named this exact gap explicitly at v51 as "a
pipeline-design question bigger than [that PR's own change], better decided deliberately than
as a drive-by fix" — and it has now recurred, unaddressed, across six more publishes (v51
through v65).

## What was decided

- Recaptured again via the established mechanism (decisions/00043, decisions/00121):
  `.github/workflows/capture-baseline.yml` (`workflow_dispatch`, pinned `ubuntu-latest` — a
  local Windows rebaseline is a known incident, 2026-07-21, that broke all nine pages'
  screenshots).
- **Dispatched against a dedicated branch (`chore/rebaseline-parity-v65`), not `main`
  directly.** The workflow's own "Commit the recaptured baseline" step pushes straight to
  `github.ref_name` with no PR or review gate of its own — the ref you dispatch against is the
  only review boundary this action gets. Landing it on a branch first, then opening this PR,
  keeps baseline recaptures inside the repo's normal reviewed-merge convention rather than a
  raw direct-to-main push.
- `ca_ref` = `665f0d67a68ae191f54adc6388052cb0bf74f75c` — `cottage-aesthetics-preview` `main`'s
  exact tip at capture time, i.e. the same commit both independent analyses diffed the failure
  against. PR #43's own branch has no parity-relevant diff from that tip (confirmed above), so
  recapturing against `main` fixes both `main` itself and PR #43's own CI run once this merges.
- Verified the resulting diff (`about/{desktop.png,probe.json}`, `index/{desktop.png,
  mobile.png,probe.json}`) touches exactly the two pages named in both independent failure
  reports and nothing else — no accidental scope creep into `gallery`, `treatments`, or any
  other page's fixture.
- **Did not attempt to fix the underlying pipeline gap as part of this PR.** Per
  `cottage-aesthetics-preview` decisions/00016's own framing (still accurate, now truer than
  ever given the recurrence count) that is a deliberate, separate design decision — publish
  bypassing the site repo's CI gate entirely — not a drive-by fix, and out of the
  search-indexing programme's own scope. Flagged as its own tracked follow-up instead (see
  "What to watch for").

## Why

- The established precedent (decisions/00043, decisions/00121) is to recapture via the pinned
  CI platform, never locally — screenshot rendering is platform-sensitive enough that a Windows
  capture has previously broken every page's baseline outright.
- Dispatching against a throwaway branch rather than `main` costs nothing extra (one branch
  create/push) and converts an otherwise-unreviewed direct push into a normal PR, matching how
  this exact class of fix has landed before (decisions/00121: "The baseline-fix landed as its
  own wixy PR... not folded into" the PR it was unblocking).
- Recapturing against site `main`'s current tip (rather than PR #43's own branch) fixes the
  general problem — `main` itself was red, which would have blocked the *next* unrelated PR too
  — not just this one instance.

## What to watch for

- **This will recur.** Nothing about this fix changes the root cause: the next real Wixy
  publish will re-drift the baseline exactly as v52 through v65 each did, with no CI signal
  until an unrelated PR next opens against site `main`. A durable fix needs one of: (a) the
  publish flow itself triggers a recapture (or at least a `capture-baseline.yml` dispatch) when
  it lands, (b) publish is routed through the PR-gated path instead of a direct push to `main`,
  or (c) the parity check becomes tolerant of legitimate content drift some other way (e.g.
  purely advisory, or scoped to structural/template regressions rather than an exact content
  match). None of these has been decided; whoever owns `cottage-aesthetics-preview`'s CI
  architecture should make this decision deliberately rather than have it keep resurfacing as a
  blocked PR every few weeks.
- `ca_ref` must be the SHA actually experiencing the failure — verify the exact match (as this
  decision and decisions/00121 both did) before dispatching; a stale or wrong ref produces a
  baseline that doesn't actually fix the CI run it was meant to unblock.
- Always dispatch `capture-baseline.yml` against a dedicated branch, never `main` — its commit
  step has no review gate of its own.
