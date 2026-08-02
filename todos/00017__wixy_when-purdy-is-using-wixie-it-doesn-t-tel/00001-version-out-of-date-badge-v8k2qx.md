# 00001 — Version-out-of-date badge (v8k2qx)

Mission (operator, 2026-08-02): when Purdy uses the admin, tell her the version she's
looking at is out of date — a very small subtle `v N` at the top LEFT of the status
strip; green glowing (fleet `ver` look) when a newer version exists; tap → THEMED
"load the latest version?" confirmation → reload. No git history (client-facing). The
confirmation matters because she may be mid-edit.

## Done in this workspace

- Server: `/api/version` `commit.count` = first-parent count of HEAD
  (`wixy_server/routes_version.py:resolve_engine_version_count` — baked
  `WIXY_ENGINE_VERSION` env → git fallback → null, never 500). Dockerfile +
  publish-image.yml bake it (fetch-depth: 0).
- Admin UI: `admin-ui/src/versionBadge.ts` — pin-on-load, glow on sha change
  (`v old → v new`), rollback un-glows, themed dialog, `beforeReload` gates the reload
  on the OpQueue flush (blocked with a calm note if the save didn't land).
- Shell: badge wired far-left of `.wx-statusbar`; the old auto-reload + "Wixy was
  updated" toast are DELETED (revalidation now drives `badge.check()`); `opSaveFailed`
  flag set by OpQueue `onError`, cleared `onAccepted`.
- CSS: `.wx-version-badge` + `.wx-version-update-available` glow (AA-checked
  `--wx-success-text`/`--wx-success-tint` tokens, all three theme blocks) + the dialog
  classes. Bundles rebuilt (committed).
- Tests: `versionBadge.test.ts` (9), shell.test.ts badge tests, 4 new Python tests,
  `e2e/tests/version-badge.spec.ts`. Full gates green: vitest 594, pytest 1005,
  typecheck, ruff, mypy, e2e.
- Docs: contracts.md `/api/version` row, editor-and-admin-ui.md, spec/05 §1,
  spec/independence 01+03 (`WIXY_ENGINE_VERSION`), decisions/00108, ANSWERS.md Q-002.

## State

Shipped via PR (see git log) — merged to main; Slots deploys. After deploy, Purdy's
next admin load shows the quiet badge; the NEXT deploy after that is the first one she
sees glow.
