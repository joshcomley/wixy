// Admin shell entrypoint (spec/05-editor.md). Loaded via
// wixy_server/static/admin_shell.html's
// `<script src="/admin/static/admin/admin.js">` — there's no other caller, so
// this self-invokes at module load, matching editor/src/index.ts's own pattern.

import { mountShell } from "./shell";

export function main(): void {
  const container = document.getElementById("wx-shell");
  if (container === null) return;
  mountShell(container);
}

main();
