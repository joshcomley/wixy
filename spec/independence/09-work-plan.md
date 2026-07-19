# 09 — Work plan: milestones + review gates

Same train discipline as the CMS build (spec/09). **FABLE gates** (milestones 2, 3, 4,
6, 7): open the PR, peer the author session with PR number + the milestone's checklist,
arm a ScheduleWakeup, merge only on explicit approval; keep working on non-dependent
milestones meanwhile. Everything else auto-merges on green CI.

| # | Deliverable | Gate |
|---|---|---|
| 1 | Scaffold: `deploy/standalone/` + `guide/` skeletons; decisions (01 §5, all nine); config-generalization audit — env overrides `WIXY_SITE_REPO` (SSH), `WIXY_DOMAIN`, `WIXY_INDEXABLE`, `WIXY_EDITION`; `/api/version` edition + **baked-SHA env with git fallback** (M2 fix); the **redirects facility** in routes_public; `WIXY_CONTAINERIZED` bind gate | CI |
| 2 | Pre-publication audit + LICENSE + README + owner-material move to NEW private `ca-business` (exact list, 02 §2.3) | **FABLE** → Josh's publish click (Track J) |
| 3 | Image + compose + setup/verify/update/logs + GHCR workflow (PUBLIC package) + **CI image-boot proof both editions** (03 §5) | **FABLE** (03 §4 checklist) |
| 4 | Sync workflow (`SYNC_PUSH_TOKEN`, notify-only schedule, workflows-diff conflict rule) + Engine card + `/api/admin/engine/*` + **rollback** (04) + **site-repo CI re-point + site CLAUDE.md neutralization PR** (01 §3/C6) | **FABLE** (04 §2 checklist: PAT scope/logging, deploy-trigger routes gated, rollback path) |
| 5 | AI backend interface extraction (`cmd` behavior-identical; existing chat tests green) (05 §1) | CI |
| 6 | `anthropic` backend + worker (Node in image) + budget ($40/mo USD) + backend-contract suite (05) | **FABLE** (05 §4 checklist) |
| 7 | Backup snapshot-branch container + hub-side pre-cutover mirror + System card + stale banner (06) | **FABLE-light** (key-scope + force-push-target checklist only) |
| 8 | The HTML guide, complete (07): both tracks incl. fork-Actions/schedule enabling, Zero Trust onboarding, drill-kit chapter; screenshots; linkcheck CI | CI (drill validates) |
| 9 | **Implementer drill** on the drill kit (08 §1 — Track J provisions the kit first: drill org, DO token, test domain, $5 key; ~£10–15, spend-gated via the operator) with guide corrections fed back + evidence pack | **FABLE ACCEPTANCE** (08 §3) |
| 10 | Real-run support pack: operator-decision list, Track J prepared, session-id scrub (02 §2.2 exemption ends), drill artifacts archived, guide handed to Josh | phase complete; REAL cutover at human pace |

Notes:
- Fleet stays green after every merge (08 §3.4); shared-code touches run the full
  existing suite.
- Milestone 8's screenshots iterate with 9 (accounts exist then) — expected loop, not
  a blocker.
- Update `projects/ca.json`'s repo URL upstream once the real transfer lands
  (redirects cover the gap).
