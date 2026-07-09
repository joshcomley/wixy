import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  minify: true,
  sourcemap: true,
  outfile: "../wixy_server/static/editor/editor.js",
  format: "iife",
  target: ["es2022"],
  logLevel: "info",
});

// A separate CSS-only build (esbuild bundles/minifies plain CSS same as JS, no
// preprocessor needed for this project's small, hand-written stylesheet) — the
// preview renderer (wixy_server/preview.py's EDITOR_STYLESHEET_PATH) links this
// output directly.
await esbuild.build({
  entryPoints: ["src/style.css"],
  bundle: true,
  minify: true,
  sourcemap: true,
  outfile: "../wixy_server/static/editor/editor.css",
  logLevel: "info",
});
