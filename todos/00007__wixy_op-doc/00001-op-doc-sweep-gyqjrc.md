# 00001 [gyqjrc] — `op doc` first-run documentation sweep

**Genesis:** workspace 00007 (`00007__wixy_op-doc`), 2026-07-19.
**Trigger:** operator ran `op doc` → `op call aim-doc.doc` enabled AIM doc-maintenance
(`.aim/settings.json`, maintenance block in CLAUDE.md) and handed back a first-run sweep
directive.

## Mission
Build the canonical AIM documentation tree for wixy from actual repo content (no
placeholders), then run the audit loop. The engine build is COMPLETE (M1–M13 + Uxer
integration, 50 decisions logged); an "independence phase" spec exists but is not yet
implemented. Docs must describe reality and LINK to the authoritative `spec/` rather than
duplicate it.

## Deliverables (aim-doc canonical tree)
- [ ] `README.md` — human first-touch, ≤150 lines (already decent; refine + link index)
- [ ] `CLAUDE.md` — AI operator manual; fix stale "once milestone N lands" conditionals
      (all milestones done); add routes/modules/env tables or link them; KEEP the
      `<!-- aim:doc-maintenance:start/end -->` markers untouched
- [ ] `docs/ai/architecture.md` — mental model, data flow, module map
- [ ] `docs/ai/contracts.md` — route table + response envelopes, error conventions,
      fixtures, entrypoints (the #1 audit gap class)
- [ ] `docs/ai/testing.md` — test matrix, fixtures, how-to-run
- [ ] `docs/ai/invariants.md` — numbered invariants + known exceptions
- [ ] `docs/ai/glossary.md` — domain terms + status machines (publish/checkout/chat)
- [ ] `docs/ai/runbook.md` — deploy/rollback/creds (it IS deployed: Wixy service, :9380,
      Slots blue/green, ca.cinnamons.uk)
- [ ] `docs/ai/<subsystem>.md` — deep dives: builder, serving-and-overlay, publish-pipeline,
      editor-protocol, admin-ui, ai-chat, media, deploy
- [ ] Record sweep: `op call aim-doc.doc_record_sweep`
- [ ] Audit loop: `op call aim-doc.doc_audit` until clean

## Method
6 parallel mapping agents digested builder / server-routes / server-services / frontend /
ai-chat / spec+decisions+deploy. Synthesize their digests into the tree. Link, don't
duplicate. Exact identifiers (`file.py:func()`), literal response envelopes, numbered
invariants with exceptions.

## Ship
Branch here → PR → merge to main (Slots deploys engine, but docs are inert). Auto-merge
per fleet rules.

## OUTCOME (DONE 2026-07-19)
Built all 12 `docs/ai/*` files + refreshed README/CLAUDE.md. Sweep recorded. Audit loop ran
**4 adversarial rounds** (docs-only agents planning representative changes), terminated by the
tool at **diminishing-returns**. ~27 real doc defects found and fixed; severity collapsed
missing-critical → cosmetic; mean confidence 5.2 → 7.33 → 7.67 → 7.0. Notable: a mapping agent's
"bug" claim about `bootstrap.py:52` (`except CheckoutError, BuildError:`) was refuted with
`py_compile` (exit 0) — it's valid PEP 758 syntax on Python ≥3.14, captured as Invariant 14.
Remaining audit "gaps" are by-design (unbuilt independence phase → `spec/independence/`;
hypothetical features; the v1 single-project-serving non-goal) — not documented, correctly.
`.aim/settings.json` + `.aim/audit-history.jsonl` committed. Committed on `cmd/workspace-00007`,
pushed, **PR #71 open + mergeable** (docs-only, CI-safe).

## ⚠ MERGE BLOCKED — repo-wide CI outage (operator action needed)
On trying to merge, found GitHub Actions **failing repo-wide**: every CI run since
2026-07-19 ~15:04 fails in ~3s with **zero steps executed** — on `main` pushes AND every branch
(the active `indep/m1..m5`, `fix/*`, `cmd/workspace-00003`, and this PR). Last green run was
2026-07-11. Evidence: wixy is a **private** repo, Actions is **enabled** (`enabled:true`), jobs
are created but can't start (0 steps), the account Actions-billing API is 403 to the bot PAT.
Diagnosis: **GitHub Actions spending-limit / included-minutes exhausted** for the private repo.
This is an **operator-only fix** and blocks ALL wixy PRs, not just this one. Did NOT force-merge
or `--admin-bypass` (fleet rule). Next step for whoever continues: once Josh restores Actions
(raise spending limit / add payment, or make the repo public), re-run CI and `gh pr merge 71
--merge --delete-branch`. Operator decision raised via op-ask-question.
