# 00001 — Publish makes the site repo CI red until someone manually recaptures the parity baseline

**Found:** 2026-07-22, while shipping the Q&A full-screen editor (site PR
cottage-aesthetics-preview#19). Every wixy-editor publish (site repo `main` push,
e.g. v11–v15 on 2026-07-21) changes page text/footer copy, but the rendered-parity
BASELINE the site repo's `validate-build-parity` check compares against lives in the
ENGINE repo (`builder/tests/parity/baseline/`, last rebaselined for v6–v8 content).
Result: site repo main has been red on every publish since v11, and every site PR
fails CI through no fault of its own. Mitigated that day by manually running the
engine repo's "Capture parity baseline (pinned platform)" workflow against site main
(`ca_ref` = publish SHA).

**Root cause:** nothing links the publish pipeline to a baseline recapture — the
recapture is a manual `workflow_dispatch` (it commits new baseline artifacts back to
the engine repo, so it was deliberately not run on every push; see the workflow's
header comment).

**Proper fix (design decision needed, not drive-by):** after a successful publish,
the wixy server (or a site-repo CI step on `push` to main) should trigger the
capture-baseline workflow for the published SHA — OR the site CI should compare the
PR's build against a baseline captured from main at PR time instead of a pinned
committed baseline. Trade-offs: auto-commits to engine main bump Slots deploys;
per-PR capture costs CI minutes. Owner: wixy engine + site repo together.
