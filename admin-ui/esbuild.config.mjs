import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";

await esbuild.build({
  entryPoints: ["src/server/call/worklet.ts"], bundle: true, minify: true,
  outfile: "../wixy_server/static/admin/call-worklet.js", format: "iife", target: ["es2022"],
});
const workletHash = createHash("sha256").update(await readFile("../wixy_server/static/admin/call-worklet.js")).digest("hex").slice(0, 10);

// Adventure Time's world map (spec/server-chat/08-adventure-time.md §2.1) is a static asset the game
// fetches lazily: copied next to the bundle and addressed by its content hash, exactly like the worklet.
await mkdir("../wixy_server/static/admin", { recursive: true });
await copyFile("data/adventure-world.json", "../wixy_server/static/admin/adventure-world.json");
const worldHash = createHash("sha256").update(await readFile("../wixy_server/static/admin/adventure-world.json")).digest("hex").slice(0, 10);

// The globe's map imagery (satellite and atlas, 8192x4096 WebP, public domain: NASA Blue Marble NG (July) with
// topography and bathymetry; Natural Earth II shaded relief) is fetched lazily by the renderer, after the
// vector globe is up, with the same content-hash scheme.
const imageryDefines = {};
for (const [style, constant] of [["satellite", "WIXY_ADVENTURE_SATELLITE_URL"], ["atlas", "WIXY_ADVENTURE_ATLAS_URL"]]) {
  await copyFile(`data/adventure-${style}.webp`, `../wixy_server/static/admin/adventure-${style}.webp`);
  const hash = createHash("sha256").update(await readFile(`../wixy_server/static/admin/adventure-${style}.webp`)).digest("hex").slice(0, 10);
  imageryDefines[constant] = JSON.stringify(`/admin/static/admin/adventure-${style}.webp?v=${hash}`);
}

await esbuild.build({
  entryPoints: ["src/index.ts"],
  define: {
    WIXY_CALL_WORKLET_URL: JSON.stringify(`/admin/static/admin/call-worklet.js?v=${workletHash}`),
    WIXY_ADVENTURE_WORLD_URL: JSON.stringify(`/admin/static/admin/adventure-world.json?v=${worldHash}`),
    ...imageryDefines,
  },
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
