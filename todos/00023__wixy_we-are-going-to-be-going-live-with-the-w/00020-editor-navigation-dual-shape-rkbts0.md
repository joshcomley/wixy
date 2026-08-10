# 00020 [rkbts0] wixy: editor/navigation.ts dual-shape acceptance + tests + rebuild bundle

Full context: sidecar 00017.

## What

`editor/src/navigation.ts:resolveInternalPageSlug` currently matches `url.pathname === "/"` →
`index` and `PAGE_PATH = /^\/([A-Za-z0-9_-]+)\.html$/`. Add a second pattern matching
`/^\/([A-Za-z0-9_-]+)$/` → slug, KEEPING the `.html` pattern too (legacy links must stay
interceptable in preview). Update the module's header comment — it currently documents
`.html` as "the ONLY shape the builder ever emits", which becomes false.

## Acceptance (unit tests to extend)

- `/about` → `about`
- `/about/` → null (not a valid page path — trailing slash)
- `/site.css` → null (not a page)
- `/about.html` → `about` (still works)

## How to continue

Check what the caller does with a slug resolved from a bogus path (e.g. `/images` accidentally
matching the new bare-slug pattern when it isn't a real page) — as long as the failure mode is
no worse than today's equivalent for a bogus `/images.html` anchor, that's acceptable; note
findings in the PR description.

After editing: `npm ci` (if needed) in `editor/`, `npm run typecheck`, `npm test`, `npm run
build`, and COMMIT the rebuilt `wixy_server/static/editor/` bundle in the same PR (CI fails on
drift, Inv 2). Do NOT touch `admin-ui/` — nothing there emits public URLs (planner-verified).
