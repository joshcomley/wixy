// Builds the Adventure Time preview. Not part of the production build; nothing here is written under
// wixy_server/static.
//
//   node dev/build.mjs                build ONE self-contained file, dev/out/adventure-preview.html: the bundle,
//                                     the CSS, the world map, the destination bank, the sample pack with its
//                                     photos and both map pictures, all inlined (for a link that must work
//                                     with nothing else beside it; ~9 MB)
//   node dev/build.mjs --site         build a SITE folder, dev/out/site/: a small adventure-preview.html plus its
//                                     assets as separate files next to it, referenced by RELATIVE URLs and loaded
//                                     lazily (the two pictures under their committed names, the world map, the
//                                     bank, the sample pack and its photos). Future site releases are then a
//                                     small HTML change, and git stores the pictures once.
//   node dev/build.mjs [--site] --serve   build, rebuild on every change, serve on http://localhost:5178
//
// Inputs:
//   data/adventure-world.json                     the real map (committed)
//   data/adventure-satellite.webp, adventure-atlas.webp   8192x4096 map pictures (committed; public domain:
//                                                 NASA Visible Earth Blue Marble Next Generation, July, with
//                                                 topography and bathymetry; Natural Earth II shaded relief)
//   ../wixy_server/livechat/adventure_destinations.json   the committed destination bank       env ADV_BANK
//   dev/inputs/sample_pack.json (+ dev/inputs/images/)   a sample holiday pack with photos      env ADV_PACK
//                                                 (not committed; a built-in example is used when absent)

import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(here, "out");
const siteDir = path.join(outDir, "site");
const inlineOut = process.env.ADV_OUT ?? path.join(outDir, "adventure-preview.html");

const IMAGE_MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".avif": "image/avif" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 10);

async function readOptional(file, encoding = "utf8") {
  try {
    return await readFile(file, encoding);
  } catch {
    return null;
  }
}

/** The local image file a pack string names (relative to the pack's folder or its images/ folder), or null. */
async function localImage(value, baseDir) {
  if (typeof value !== "string" || /^(https?:|data:)/i.test(value)) return null;
  if (IMAGE_MIME[path.extname(value).toLowerCase()] === undefined) return null;
  const base = path.basename(value);
  for (const candidate of [path.join(baseDir, value), path.join(baseDir, "images", value), path.join(baseDir, base), path.join(baseDir, "images", base)]) {
    const bytes = await readOptional(candidate, null);
    if (bytes !== null) return { file: candidate, bytes, mime: IMAGE_MIME[path.extname(value).toLowerCase()], base };
  }
  console.warn(`image not found for the pack: ${value}`);
  return null;
}

/**
 * Walks the pack and replaces every local image name using `replace(image)`, which returns the new string.
 */
async function rewriteImages(node, baseDir, replace) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) node[i] = await rewriteImages(node[i], baseDir, replace);
    return node;
  }
  if (node !== null && typeof node === "object") {
    for (const key of Object.keys(node)) node[key] = await rewriteImages(node[key], baseDir, replace);
    return node;
  }
  const image = await localImage(node, baseDir);
  return image === null ? node : replace(image);
}

/** JSON for a <script type="application/json"> block: no "<" can open a tag or a comment. */
function jsonBlock(text) {
  return JSON.stringify(JSON.parse(text)).replaceAll("<", "\\u003c");
}

/** JS for an inline <script>: neither "</script" nor "<!--" may appear. */
function scriptBlock(code) {
  return code.replaceAll("</script", "<\\/script").replaceAll("<!--", "<\\!--");
}

async function bundle(define) {
  const result = await esbuild.build({
    entryPoints: [path.join(here, "adventureHarness.ts")],
    bundle: true,
    minify: true,
    write: false,
    format: "iife",
    target: ["es2020"],
    legalComments: "none",
    logLevel: "warning",
    tsconfig: path.join(root, "tsconfig.json"),
    define,
  });
  return result.outputFiles[0].text;
}

async function readCss() {
  return (await readFile(path.join(here, "adventure-harness.css"), "utf8")) + "\n" + (await readFile(path.join(here, "adventure-pack.css"), "utf8"));
}

async function readInputs() {
  const world = await readOptional(path.join(root, "data", "adventure-world.json"));
  if (world === null) throw new Error("data/adventure-world.json is missing (merge origin/adv/world-data).");
  const bankPath = process.env.ADV_BANK ?? path.join(root, "..", "wixy_server", "livechat", "adventure_destinations.json");
  const bank = await readOptional(bankPath);
  if (bank === null) throw new Error("No destination bank: expected wixy_server/livechat/adventure_destinations.json (or set ADV_BANK).");
  const packPath = process.env.ADV_PACK ?? path.join(here, "inputs", "sample_pack.json");
  const packRaw = await readOptional(packPath);
  return { world, bank, bankPath, packPath, packRaw };
}

/** The single self-contained file. */
export async function buildInline(css) {
  const started = performance.now();
  const { world, bank, packPath, packRaw } = await readInputs();
  let pack = null;
  let photoBytes = 0;
  if (packRaw !== null) {
    const parsed = JSON.parse(packRaw);
    await rewriteImages(parsed, path.dirname(packPath), (image) => {
      photoBytes += image.bytes.length;
      return `data:${image.mime};base64,${image.bytes.toString("base64")}`;
    });
    pack = JSON.stringify(parsed);
  }
  // Both pictures, base64, from the committed files. A missing one just leaves that style out.
  const textures = { satellite: "", atlas: "" };
  for (const name of Object.keys(textures)) {
    const bytes = await readOptional(path.join(root, "data", `adventure-${name}.webp`), null);
    if (bytes === null) console.warn(`no picture for the ${name} style (data/adventure-${name}.webp)`);
    else textures[name] = bytes.toString("base64");
  }
  const js = await bundle({ ADV_SITE_MODE: "false" });
  const template = await readFile(path.join(here, "adventure-harness.html"), "utf8");
  const html = template
    .replace("/*@@CSS@@*/", () => css)
    .replace("/*@@WORLD@@*/", () => jsonBlock(world))
    .replace("/*@@BANK@@*/", () => jsonBlock(bank))
    .replace("/*@@PACK@@*/", () => (pack === null ? "null" : jsonBlock(pack)))
    .replace("/*@@TEX_SATELLITE@@*/", () => textures.satellite)
    .replace("/*@@TEX_ATLAS@@*/", () => textures.atlas)
    .replace("/*@@JS@@*/", () => scriptBlock(js));
  await mkdir(path.dirname(inlineOut), { recursive: true });
  await writeFile(inlineOut, html, "utf8");
  console.log(`built ${inlineOut} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${(performance.now() - started).toFixed(0)} ms; sample pack ${pack === null ? "built-in" : `from file, ${(photoBytes / 1024).toFixed(0)} KB of photos inlined`})`);
  return inlineOut;
}

/** The site folder: a small HTML page and its assets as separate files, relative URLs, loaded lazily. */
export async function buildSite(css) {
  const started = performance.now();
  const { world, bank, packPath, packRaw } = await readInputs();
  await rm(siteDir, { recursive: true, force: true });
  await mkdir(path.join(siteDir, "images"), { recursive: true });

  // Assets keep their committed names and bytes, so git stores one copy of each picture in the site repo.
  const versions = {};
  const copyAsset = async (from, name) => {
    const bytes = await readFile(from);
    await writeFile(path.join(siteDir, name), bytes);
    versions[name] = hash(bytes);
    return bytes.length;
  };
  const sizes = {};
  sizes.world = await copyAsset(path.join(root, "data", "adventure-world.json"), "adventure-world.json");
  sizes.bank = await copyAsset(process.env.ADV_BANK ?? path.join(root, "..", "wixy_server", "livechat", "adventure_destinations.json"), "adventure-destinations.json");
  for (const name of ["satellite", "atlas"]) {
    const file = path.join(root, "data", `adventure-${name}.webp`);
    if ((await readOptional(file, null)) === null) console.warn(`no picture for the ${name} style (data/adventure-${name}.webp)`);
    else sizes[name] = await copyAsset(file, `adventure-${name}.webp`);
  }
  if (packRaw !== null) {
    let photos = 0;
    const seen = new Set();
    const copies = [];
    const pass = await rewriteImages(JSON.parse(packRaw), path.dirname(packPath), (image) => {
      if (!seen.has(image.base)) {
        seen.add(image.base);
        copies.push(writeFile(path.join(siteDir, "images", image.base), image.bytes));
        photos += image.bytes.length;
      }
      return `images/${image.base}`;
    });
    await Promise.all(copies);
    await writeFile(path.join(siteDir, "adventure-sample-pack.json"), JSON.stringify(pass));
    versions["adventure-sample-pack.json"] = hash(JSON.stringify(pass));
    sizes.photos = photos;
  }

  const define = {
    ADV_SITE_MODE: "true",
    ADV_ASSET_VERSIONS: JSON.stringify(versions),
    WIXY_ADVENTURE_SATELLITE_URL: JSON.stringify(`adventure-satellite.webp${versions["adventure-satellite.webp"] ? `?v=${versions["adventure-satellite.webp"]}` : ""}`),
    WIXY_ADVENTURE_ATLAS_URL: JSON.stringify(`adventure-atlas.webp${versions["adventure-atlas.webp"] ? `?v=${versions["adventure-atlas.webp"]}` : ""}`),
  };
  const js = await bundle(define);
  const template = await readFile(path.join(here, "adventure-harness.html"), "utf8");
  const html = template
    .replace("/*@@CSS@@*/", () => css)
    .replace(/<script type="application\/json" id="adv-(world|bank|pack)">[\s\S]*?<\/script>\n/g, "")
    .replace(/<script type="text\/plain" id="adv-tex-(satellite|atlas)"[^>]*>[\s\S]*?<\/script>\n/g, "")
    .replace("/*@@JS@@*/", () => scriptBlock(js));
  await writeFile(path.join(siteDir, "adventure-preview.html"), html, "utf8");
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(
    `built ${path.join(siteDir, "adventure-preview.html")} (${kb(Buffer.byteLength(html))}) + assets: ` +
      Object.entries(sizes).map(([k, v]) => `${k} ${kb(v)}`).join(", ") +
      ` (${(performance.now() - started).toFixed(0)} ms)`,
  );
  return siteDir;
}

export async function build(site = false) {
  const css = await readCss();
  return site ? buildSite(css) : buildInline(css);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const site = process.argv.includes("--site");
  await build(site);
  if (process.argv.includes("--serve")) {
    let timer = null;
    const rebuild = () => {
      clearTimeout(timer);
      timer = setTimeout(() => build(site).catch((e) => console.error(String(e))), 150);
    };
    for (const dir of [here, path.join(root, "src", "server", "adventure"), path.join(root, "data")]) {
      watch(dir, { recursive: true }, (_event, name) => {
        if (name && !String(name).startsWith("out")) rebuild();
      });
    }
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://x");
        let name = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        if (name === "") name = "adventure-preview.html";
        const file = site ? path.join(siteDir, name) : inlineOut;
        if (!file.startsWith(site ? siteDir : outDir)) throw new Error("outside the output folder");
        const body = await readFile(file);
        const type = name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".json") ? "application/json" : (IMAGE_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream");
        res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        res.end(body);
      } catch (e) {
        res.writeHead(404);
        res.end(String(e));
      }
    });
    server.listen(5178, "0.0.0.0", () => console.log(`serving http://localhost:5178/ (${site ? "site folder" : "single file"}, rebuilds on change)`));
  }
}
