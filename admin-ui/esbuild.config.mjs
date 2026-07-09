import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/index.ts"],
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
