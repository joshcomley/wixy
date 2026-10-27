// Builds the Adventure Time preview: ONE self-contained HTML file, `dev/out/adventure-preview.html`, with
// the bundle, the CSS, the real world map, the destination bank and the sample holiday pack all inlined
// (the page is opened from a link, so it must not fetch anything). Not part of the production build and
// never written under wixy_server/static.
//
//   node dev/build.mjs            build once
//   node dev/build.mjs --serve    build, rebuild on every change, serve dev/out on http://localhost:5178
//
// Inputs (all read at build time, none committed):
//   data/adventure-world.json              the real map (committed by the world-data builder)
//   ../wixy_server/livechat/adventure_destinations.json  the committed destination bank (spec 2.2)  env ADV_BANK
//   dev/inputs/sample_pack.json            a sample holiday pack (spec 4.3 shape)     env ADV_PACK
//                                          (optional: a built-in example is used when absent)

import * as esbuild from "esbuild";
import { watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(here, "out");
const outFile = path.join(outDir, "adventure-preview.html");

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** JSON for a <script type="application/json"> block: no "<" can open a tag or a comment. */
function jsonBlock(text) {
  return JSON.stringify(JSON.parse(text)).replaceAll("<", "\\u003c");
}

/** JS for an inline <script>: neither "</script" nor "<!--" may appear. */
function scriptBlock(code) {
  return code.replaceAll("</script", "<\\/script").replaceAll("<!--", "<\\!--");
}

export async function build() {
  const started = performance.now();
  const world = await readOptional(path.join(root, "data", "adventure-world.json"));
  if (world === null) throw new Error("data/adventure-world.json is missing (merge origin/adv/world-data).");
  const bank = await readOptional(process.env.ADV_BANK ?? path.join(root, "..", "wixy_server", "livechat", "adventure_destinations.json"));
  if (bank === null) throw new Error("No destination bank: expected wixy_server/livechat/adventure_destinations.json (or set ADV_BANK).");
  const pack = await readOptional(process.env.ADV_PACK ?? path.join(here, "inputs", "sample_pack.json"));

  const bundle = await esbuild.build({
    entryPoints: [path.join(here, "adventureHarness.ts")],
    bundle: true,
    minify: true,
    write: false,
    format: "iife",
    target: ["es2020"],
    legalComments: "none",
    logLevel: "warning",
    tsconfig: path.join(root, "tsconfig.json"),
  });
  const js = bundle.outputFiles[0].text;
  const css = await readFile(path.join(here, "adventure-harness.css"), "utf8");
  const template = await readFile(path.join(here, "adventure-harness.html"), "utf8");

  const html = template
    .replace("/*@@CSS@@*/", () => css)
    .replace("/*@@WORLD@@*/", () => jsonBlock(world))
    .replace("/*@@BANK@@*/", () => jsonBlock(bank))
    .replace("/*@@PACK@@*/", () => (pack === null ? "null" : jsonBlock(pack)))
    .replace("/*@@JS@@*/", () => scriptBlock(js));

  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, html, "utf8");
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`built ${outFile} (${kb} KB, ${(performance.now() - started).toFixed(0)} ms; sample pack ${pack === null ? "built-in" : "from file"})`);
  return outFile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build();
  if (process.argv.includes("--serve")) {
    let timer = null;
    const rebuild = () => {
      clearTimeout(timer);
      timer = setTimeout(() => build().catch((e) => console.error(String(e))), 150);
    };
    for (const dir of [here, path.join(root, "src", "server", "adventure"), path.join(root, "data")]) {
      watch(dir, { recursive: true }, (_event, name) => {
        if (name && !String(name).startsWith("out")) rebuild();
      });
    }
    const server = http.createServer(async (req, res) => {
      try {
        const body = await readFile(outFile);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(body);
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
      void req;
    });
    server.listen(5178, "0.0.0.0", () => console.log("serving http://localhost:5178/ (rebuilds on change)"));
  }
}
