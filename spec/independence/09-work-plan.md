# 09 — Work plan: milestones + review gates

Same train discipline as the CMS build (spec/09): branch → conventional commits → PR →
CI green → merge, todos + decisions kept current, no stopping between milestones except
at the review gates. All in the ENGINE repo unless noted.

| # | Deliverable | Gate |
|---|---|---|
| 1 | Scaffold: `deploy/standalone/` skeleton, `guide/` skeleton, decisions/ entries (01 §5), config generalization audit (01 §2.2: env-override `WIXY_SITE_REPO`/`WIXY_MEDIA_REPO`, `edition` in `/api/version`) | CI |
| 2 | Pre-publication audit + LICENSE + README + move owner materials (photos/brief/client docs) to the private site repo (02) | **FABLE REVIEW** then Josh's one-click publish (guide Track J) |
| 3 | Docker image + compose stack + setup/verify/update/logs scripts + GHCR workflow (03); prove the image serves locally with `edition: standalone` | **FABLE REVIEW** (secrets/ports/non-root checklist) |
| 4 | Fork-sync workflow + admin Engine card + `/api/admin/engine/*` (04) — testable against a scratch fork before her org exists | CI |
| 5 | AI backend interface extraction (`cmd` backend behavior-identical, all existing chat tests green) (05 §1) | CI |
| 6 | `anthropic` backend + worker container + budget enforcement + backend-contract suite (05 §2–4) | **FABLE REVIEW** (key handling/egress/budget checklist) |
| 7 | Backup container + hub-side pre-cutover mirror job + admin System card + stale-backup banner (06) | CI |
| 8 | The HTML guide, complete with captured screenshots + linkcheck CI (07) | CI (drill validates it) |
| 9 | **Implementer drill** on throwaway accounts (08 §1), guide corrections fed back, evidence pack | **FABLE ACCEPTANCE REVIEW** (08 §3, all 8 criteria) |
| 10 | Real-run support pack: the "operator decisions" list, Track J prepared, drill artifacts archived; hand the guide link to Josh | done = phase complete; the REAL cutover happens at human pace via the guide |

Notes:
- Milestones 2/3/6 are the security-gated ones (spec README rule 2): open the PR, then
  request review by peering the spec author's session (KICKOFF-PROMPT.md) with the PR
  number + the relevant checklist section; merge only after an explicit approval reply.
  Everything else auto-merges on green CI.
- Fleet staging must stay green after every merge (08 §3.4) — the standalone work is
  additive; any touch to shared code (config, AI interface) runs the full existing
  suite.
- The Anthropic-backend live smoke needs a real key: use the fleet's drill allowance —
  a throwaway key funded with the minimum ($5) — created by Josh (Track J note), never
  committed, revoked after the drill.
