# 00002 [cnxxqg] PR 1 — publish can never break like this again + calm publish UX

## What
Root-cause fix for the incident in 00001, plus defense in depth so a draft can never persist
schema-invalid content again, plus a calm, self-healing publish UX for the non-technical owner.

Sub-parts (see brief "WORKSTREAM 1" for full detail):
- 1a. `editor/src/contentModel.ts` — attr-binding read-back (root cause A) + nbsp/placeholder
  normalization on read (root cause B).
- 1b. Media picker returns content-form src (`contentSrc`) not served URL (root cause C) —
  `wixy_server/routes_admin_api.py`, `admin-ui/src/api.ts`, `admin-ui/src/mediaDialog.ts`.
- 1c. New `wixy_server/draft_validate.py` — normalize + structurally validate every draft
  PATCH before it's stored; 422 on violation; `admin-ui` opQueue drops+toasts on 422 instead
  of infinite-retry.
- 1d. New `POST /api/admin/draft/repair` (`wixy_server/draft_repair.py`) — deterministic
  self-heal against base content.
- 1e. New `POST /api/admin/report` (`wixy_server/reports.py`) — diagnostic bundle + optional
  email via `WIXY_REPORT_SMTP_*` env (must be added to `D:\Servers\Wixy\Storage\.env` before
  merge, from `%AIM_ROOT%\Biosphere\Storage\gmail_smtp_credentials.json`).
- 1f. `builder/schemas/gallery-slider.schema.json` + `gallery-tile.schema.json` — `pattern`
  guard on image srcs (publish-time only, not draft-write-time).
- 1g. `admin-ui/src/publishDrawer.ts` — replace raw error dump with blocked/running/success/
  failure states, Fix-it-for-me + Send-a-report buttons.
- 1h. Docs (`contracts.md`, `editor-and-admin-ui.md`, `media.md`, `publish-pipeline.md`,
  `invariants.md`, `architecture.md`) + 2 decisions entries.

## Acceptance
mypy --strict, ruff, bare pytest, npm typecheck/test/build (admin-ui + editor, committed
bundles), e2e green. PR merged, Slots deployed (confirm via `/api/version`), live 422/repair
smoke-tested per brief's cross-cutting verification step 6.

## Links
Brief section "WORKSTREAM 1 (PR 1)".
