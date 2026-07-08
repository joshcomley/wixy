# 09 — Work plan (PR train)

Run end-to-end without stopping between PRs (fleet rule: each PR is a checkpoint, not a
checkout). Every PR: branch → conventional commits → push → PR → required checks green →
merge (auto-merge doctrine; gh via PowerShell full path). Keep `todos/TODO-<workspaceID>.md`
+ sidecars current as you go; add `decisions/` entries when you make a non-obvious call.
WX = wixy repo, CA = site repo (`cottage-aesthetics-preview`).

Milestones are sequenced so something real is demonstrable at every step, and so the site
repo is never in a state the builder can't build.

| # | Repo | Deliverable | Key spec refs |
|---|---|---|---|
| 1 | WX | **Scaffold**: `pyproject.toml` (py3.14, fastapi/uvicorn/httpx/pillow/bs4+html5lib/nh3/PyJWT+cryptography/pytest+xdist/mypy/ruff), `builder/` + `wixy_server/` package skeletons, `admin-ui/` + `editor/` TS workspaces (strict tsconfig, esbuild scripts, vitest), CI (`ci.yml`: ruff+mypy+pytest with a FIXED `-n` cap (never `auto`)+tsc+esbuild(+bundle-drift `git diff --exit-code`)+vitest+playwright), repo `CLAUDE.md` (dev commands, layout, spec pointer), `decisions/00001` (architecture, from 01 §3) | 01 |
| 2 | WX | **Builder v1**: config/registry loader, template parse + all `data-wx-*` bindings, partials, head/meta/theme/fonts injection, `theme.css`, sitemap/robots, `validate` (+`--json`), `serve` (dev static server), `build` CLI; fixture mini-site + full unit suite; deterministic-output test | 02 |
| 3 | CA | **Migration step 1**: move pages under `pages/`, add partial markers, empty-shim partials; capture parity baseline via the pinned-platform CI job (03 §5); site CI (`ci.yml` calling WX builder@main — wixy is PRIVATE: provision the read-only deploy key + `WIXY_DEPLOY_KEY` secret per 03 §7 — validate+build+parity); rewrite `deploy.yml` to publish the BUILT output (03 §3.5 — the root-relative Pages deploy would otherwise 404 all through migration) | 03 §3.1, §3.5, §5, §7 |
| 4 | CA | **Migration steps 2–3**: partials extracted from `site.js` (slimmed to behavior), `_global.json`, then page-by-page annotation + content extraction incl. the six collections + gallery JS-array→DOM conversion; parity green after every page | 03 §3.2–3.3 |
| 5 | CA+WX | **Migration step 4**: theme extraction (`theme.json`, `site.css` de-tokenized, fonts vars); parity green; site `CLAUDE.md` written (03 §6) | 03 §3.4, §6 |
| 6 | WX | **Server core**: project registry, Storage layout + site checkout manager (clone/fetch/ff-only), draft overlay store (rev/409/atomic), merged-content service, preview renderer (draft render + editor asset injection), public serving of a built tree behind the atomic pointer, `/api/admin/state|content|draft|media(list)`, CF Access JWT middleware (dev bypass flag), instant-render shell | 04 |
| 7 | WX | **Editor v1 (text + links + lists)**: admin shell (routing, top bar, pages panel incl. duplicate/delete + meta drawer), edit iframe + overlay (selection chrome, text popovers plain/rich-lite, list toolbar), postMessage protocol, op queue/coalesce/replay; E2E flows 1, 4, 8 | 05 §1–2 |
| 8 | WX | **Media + theme**: upload pipeline (Pillow: orient/strip/resize/re-encode), media panel+dialog+drop-on-element, reference scan; theme panel with live vars + fonts swap; E2E 2, 3 | 05 §3–4, 02 §9 |
| 9 | WX | **Publish + history**: publish pipeline (lock → pull → materialize overlay+media → commit/push → build → verify → swap → ledger), publish drawer (diff review + upstream commits + validate surface), history panel, restore (04 §6), prune; upstream watcher + draft-status chip; E2E 5, 6; kill-during-publish test | 04 §5–7 |
| 10 | WX | **AI chat**: `cmdchat.py` client + fake-cmd test double, conversations store, create/pending/ready flow, send w/ idempotency, poll→SSE fan-out, chat panel UI (markdown, tool rows, status dot, preview-updated chip, offline banner), handover-follow; E2E 7; preamble template | 06 |
| 11 | WX | **Install & deploy**: `install.py` (D:\Servers\Wixy layout per 07), `launcher.py`, per-slot venv+asset build, Slots consumer entry, Devfleet child registration, cloudflared ingress `ca.cinnamons.uk`, DNS record, CF Access app (+ JWT middleware config), `.env` provisioning; deployed + `/status` healthy | 07 |
| 12 | CA | **Cutover**: point Wixy's project checkout at CA main, first real publish from the admin, retire GH Pages (`deploy.yml`, `.nojekyll` removed), README updated with new home; reword the contact page's "Demo preview: live email delivery…" line to match reality (owner-visible honesty — forms backends are a non-goal) | 03 §3.5, 07 |
| 13 | WX+CA | **Live verification + polish**: full 08 §4 checklist (live chat smoke, external CF Access checks, edit→publish→restore drill, Lighthouse), fix everything found, `verify` skill evidence in PR, final docs/todos/decisions sweep, acceptance list 08 §5 ticked one by one in the PR description | 08 |

Notes:
- #3–#5 (CA migration) develop against WX builder from its worktree (editable install /
  `pip install -e ../wixy`-style path or `PYTHONPATH`); CA CI pins WX@main, so merge WX
  builder changes before the CA PR that needs them.
- Infra actions in #11 that need elevation or CF credentials follow 07's runbook exactly
  (admin gate for service-level ops; the `CF_*` credentials live in `D:\Servers\Loom\.env`
  per 07 §3 — the Biosphere paths in older docs are gone).
- If a step's spec turns out to conflict with discovered reality (an API changed, a port
  taken), prefer reality, note it in the PR + a decision entry, and continue — peer the
  spec author (see KICKOFF) only if the conflict is architectural.
