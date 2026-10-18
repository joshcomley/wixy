import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

await esbuild.build({
  entryPoints: ["src/server/call/worklet.ts"], bundle: true, minify: true,
  outfile: "../wixy_server/static/admin/call-worklet.js", format: "iife", target: ["es2022"],
});
const workletHash = createHash("sha256").update(await readFile("../wixy_server/static/admin/call-worklet.js")).digest("hex").slice(0, 10);

await esbuild.build({
  entryPoints: ["src/index.ts"],
  define: { WIXY_CALL_WORKLET_URL: JSON.stringify(`/admin/static/admin/call-worklet.js?v=${workletHash}`) },
  bundle: true,
  minify: true,
  sourcemap: true,
  outfile: "../wixy_server/static/admin/admin.js",
  format: "iife",
  target: ["es2022"],
  logLevel: "info",
});

// A separate CSS-only build (esbuild bundles/minifies plain CSS same as JS) —
// admin_shell.html links this output directly for the shell's full UI styling
// (its own inline <style> stays as the pre-JS instant-render loading screen).
await esbuild.build({
  entryPoints: ["src/style.css"],
  bundle: true,
  minify: true,
  sourcemap: true,
  outfile: "../wixy_server/static/admin/admin.css",
  logLevel: "info",
});

// The Server notification worker is a separate entry point so it can be
// registered with /admin/ scope without loading the full admin application.
await esbuild.build({
  entryPoints: ["src/sw/serverSw.ts"],
  bundle: true,
  minify: true,
  sourcemap: false,
  outfile: "../wixy_server/static/admin/server-sw.js",
  format: "iife",
  target: ["es2022"],
  logLevel: "info",
});
