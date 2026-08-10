# 00025 [nfxk55] wixy: quality gates + push + PR

Full context: sidecar 00017.

## What

`ruff check .`, `ruff format .`, `mypy`, bare `pytest` (never `-n auto`), editor
`npm run typecheck`/`npm test`/`npm run build` + committed bundle. Push `feat/clean-urls`,
open PR with conventional-commit messages, each carrying a `Release-note:` trailer (e.g.
"Your site's web addresses are now clean — no \".html\" at the end of links."). Wait for
required checks green. Do NOT merge — hold for planner clearance (see brief §7).
