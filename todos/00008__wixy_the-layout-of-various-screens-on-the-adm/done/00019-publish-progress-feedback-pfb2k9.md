# 00019 — Publish progress feedback (operator round 2026-07-21)

**Operator report:** "Is there any kind of indicator when the site is publishing? The slim
banner at the top? The publish button should get a spinner icon at least, and some
notification when it's live."

**Shipped:** decisions/00089 + Inv 25. The shell now owns publish run/completion feedback:
while `publishJob.isRunning`, a shell watch polls `/api/admin/state` every 2s; the slim
status bar shows a spinner + "Publishing…" on the Publish button and layman stage narration
in the chip ("Building the site…", "Taking it live…"); the terminal job fires exactly one
version-guarded toast — "Published — version N is live." (6s) / "Publish failed — your draft
changes are safe." (8s). Drawer confirm spins too and hides on success; works when the drawer
is closed mid-publish, on reload-mid-publish, and for publishes started elsewhere.

**Files:** `admin-ui/src/shell.ts` (watch + renderTopBar + toasts), `publishDrawer.ts`
(onPublishStarted, busy confirm, onPublished(version)), `spinnerButton.ts` (new shared
helper), `style.css` (spinner/busy rules), tests in `admin-ui/tests/{shell,publishDrawer}.
test.ts`, e2e `e2e/tests/publish-feedback.spec.ts`, docs (invariants Inv 25,
editor-and-admin-ui.md).
