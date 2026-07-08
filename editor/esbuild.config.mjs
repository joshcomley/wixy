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
