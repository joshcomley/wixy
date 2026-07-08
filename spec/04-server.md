# 04 — The Wixy server: API, storage, publish pipeline, versioning

One FastAPI app (Python 3.14, uvicorn, loopback bind; port assigned in [07](07-hosting-deploy.md))
serving three surfaces:

1. **Public site** — static files from the live build dir (the visitor path).
2. **Admin** — static shell + `/api/admin/*` JSON (+SSE), CF-Access-JWT-verified.
3. **Internal** — `/healthz` (alias of `/internal/ready`), `/internal/warmup`,
   `/internal/ready`, `/api/version` (fleet warmup + deploy-awareness conventions; these
   back the Slots smoke probes, 07 §1).

Repo layout (wixy):

```
wixy/
  builder/            # pure library + CLI: build/validate/serve/parity (no server imports)
  wixy_server/        # FastAPI app: routes, draft store, publisher, cmdchat, media
  admin-ui/           # TS strict → esbuild → wixy_server/static/admin/
  editor/             # TS strict overlay → esbuild → wixy_server/static/editor/
  projects/ca.json                   # the project registry (§1)
  spec/  docs/  todos/  decisions/  tooling/
```

`builder` is importable standalone (site-repo CI installs just it); `wixy_server` imports
`builder`. Both `mypy --strict`.

## 1. Project registry

`projects/<slug>.json` (in-repo, code-reviewed):

```json
{
  "slug": "ca",
  "name": "Cottage Aesthetics",
  "repo": "https://github.com/joshcomley/cottage-aesthetics-preview.git",
  "defaultBranch": "main",
  "cmdProject": "cottage-aesthetics-preview",
  "domain": "ca.cinnamons.uk",
  "locale": "en-GB",
  "indexable": false,
  "media": {"maxLongSidePx": 2000, "jpegQuality": 85}
}
```

The engine loads every `projects/*.json` at startup; v1 runs with exactly one but nothing
may assume that (all paths/state are per-slug; route prefixes stay project-scoped
internally even though the admin UI mounts the single project by default).

## 2. Storage layout (runtime state — survives slot swaps)

```
D:\Servers\Wixy\Storage\
  .env                          # WIXY_PORT, CF Access team domain + AUD, flags
  projects\ca\
    repo\                       # git clone of the site repo (fetch/ff-only main; Wixy's
                                #   own working copy — never a cmd workspace)
    draft\overlay.json          # 02 §8
    draft\media\                # staged uploads
    builds\<sha>\               # immutable build outputs (published + recent)
    live.json                   # {"sha": "…", "version": N, "buildDir": "builds/<sha>"}
    publishes.jsonl             # append-only ledger
    chats.json                  # 06 §1
    locks\publish.lock
  logs\
```

The Storage repo checkout is written ONLY by the publisher (commits) and the fetch loop —
it is an internal working copy, not a place agents work (agents get cmd worktrees; the
fleet "never author in D:\Servers" rule doesn't apply to Wixy's own machine-managed
checkout, which is runtime data — note this in the repo CLAUDE.md to preempt confusion).

## 3. Public serving

- `GET /` + `GET /{page}.html` + assets → files from `live.json → buildDir`, resolved per
  request via one in-memory pointer (reloaded atomically after publish/restore; no server
  restart). 404 → styled `404.html` (builder emits one; migration adds a simple template).
  No `live.json` yet (pre-bootstrap) → public routes return a plain 503, never a crash;
  install/first-startup bootstraps version 0 (07 §1) so this state is transient.
- Headers: HTML `Cache-Control: public, max-age=300`; css/js/images
  `public, max-age=86400` (+ ETag from file mtime/size). CF edge does the heavy caching;
  correctness comes from the 5-minute HTML TTL (an urgent fix is still fast) — publish
  does NOT purge CF in v1 (decision-logged; revisit only if the owner complains about
  propagation).
- `/robots.txt`, `/sitemap.xml`, `/favicon.ico` from the build. Unknown paths never touch
  git/builder — pure static lookup. No path may escape the build dir (normalize + verify
  prefix).
- `HEAD` supported; `Range` unnecessary (no video).

## 4. Preview & editor injection

- `GET /admin/preview/{page}.html` — renders the page **on the fly** from
  `Storage repo working tree ⊕ overlay` via the builder's render-one-page API in
  **preview mode** (falsy `data-wx-if` elements retained with `data-wx-hidden="1"`,
  02 §2; publish mode removes them and is the byte-authoritative path). The working tree
  sits at origin/main because the watcher fast-forwards it (§7). Templates resolve as
  repo `pages/` ⊕ `draft/pages/` (page ops, 02 §8). The renderer then injects
  `<script src="/admin/static/editor/editor.js">` + editor CSS + a
  `<script type="application/json" id="wx-bindings">` blob (the page's binding map:
  key → kind, list shapes, global keys) so the overlay never re-derives the contract.
- `GET /admin/draft-media/{name}` serves staged uploads.
- `GET /admin/versions/{n}/{page}.html` serves archived builds read-only (05 §5), editor
  NOT injected.
- Preview is uncached (`no-store`). Render-one-page must stay <150 ms (it's per-keystroke-
  batch reload only on hard refresh; live edits are DOM-applied client-side).

## 5. Publish pipeline (`wixy_server/publisher.py`)

`POST /api/admin/publish {message, expectedRev}` → runs as ONE serialized job (asyncio
lock + `locks/publish.lock` file lock; concurrent request → 409 with the running job id).
Steps, each logged to the job record (SSE `GET /api/admin/publish/stream` while running;
job persisted to `publishes.jsonl` on completion):

1. **Preflight**: overlay `rev == expectedRev` (else 409 — UI refetches); `git fetch` +
   `git merge --ff-only origin/main` on the Storage checkout (a non-ff state is a bug —
   abort with diagnostics, never force).
2. **Materialize**: apply overlay ops onto `content/*.json` + `theme/theme.json`
   (canonical rewrite per 02 §3); apply page ops — `git add` staged templates from
   `draft/pages/` into `pages/` (+ their content files), `git rm` deleted slugs; move
   referenced staged media into `images/`; `builder validate` the tree (fail → abort,
   working tree reset hard to HEAD, overlay + staging untouched).
3. **Commit & push**: single commit `wixy: publish v<N> — <message>` (author
   `Wixy <wixy@cinnamons.uk>`); `git push origin main`. Push rejected (rare race with an
   AI merge) → fetch, `--ff-only` re-merge, re-materialize once, re-push; second failure
   aborts cleanly (hard reset to origin/main; overlay preserved).
4. **Build**: `builder build` at the new SHA into `builds/<sha>/` (temp dir + atomic
   rename). **Verify**: builder's post-build self-check (every page present, assets
   referenced exist, HTML parses) + parity smoke on 2 pages against the previous build
   (text-diff sanity, catches catastrophes without blocking intentional edits).
5. **Swap**: write `live.json` (tmp+rename) → flip the in-memory pointer. Append ledger
   entry `{version, sha, message, when, source: editor|upstream|mixed, changed: {…}}`.
   Clear the overlay + staged media (they're now upstream). Prune `builds/` (keep every
   ledger-referenced build from the last 20 versions + always the live one).
6. Any step's failure → job state `failed` with the full log; live site + ledger + draft
   all unchanged (steps 1–4 never touch the serving pointer).

Restore (`POST /api/admin/restore {version}`): loads that version's ledger entry; if its
build dir was pruned, rebuild from its SHA first; flip pointer; set the overlay to
`diff(current main content, that version's content)` so the draft equals what's now live;
append ledger entry `{action: "restore", of: version}`. Live site changes instantly;
nothing is committed until the owner next publishes (which materializes the restored
state as a normal commit). **Diff granularity** (binding-map-driven, never naive
leaf-diffing): list-bound keys emit ONE whole-array op when unequal (02 §8's collection
rule); scalar/meta/theme keys emit per-dotted-leaf ops; page-set differences between the
versions map to overlay page ops (02 §8); template drift stays upstream and is surfaced
in the publish drawer. Restored image refs that no longer exist on main are listed in the
restore confirmation and will fail publish validate until re-uploaded — the drawer links
them.

## 6. Version history

`GET /api/admin/publishes?limit=…` reads the ledger (newest first) + marks the live one.
The ledger is the product-level history; `git log` remains the forensic layer. Ledger
writes are append-only, fsync'd, and rebuilt from git tags if ever corrupted — each
publish also tags `wixy-publish-v<N>` (annotated, pushed) so history survives Storage loss.

## 7. Upstream watcher

Every 60 s (and immediately before preview loads after >10 s staleness + before publish):
`git fetch origin` on the Storage checkout, **then fast-forward the working tree to
origin/main** (taking the publish lock; skipped while a publish/materialize is in flight)
— this is what makes AI-lane merges appear in the draft preview (02 §8, 06 §2); expose
`{aheadOfPublished: [{sha, subject, author, when}…], fetchedAt}` in `/api/admin/state`
(drives the draft chip + chat "preview updated" chip). Fetch failures degrade gracefully
(stale badge after 5 min of failures; full error in logs).

## 8. Admin API index (all `/api/admin/*`, JWT-gated; bodies/semantics per 02/05/06)

| Route | Purpose |
|---|---|
| `GET  state` | project, pages+meta, draft summary (rev, op count), live version, upstream, publish-job state, chat list snapshot |
| `GET  content/{page}` | merged content + binding map (editor fields) |
| `PATCH draft` | `{expectedRev, ops:[{file,path,value}|{file,path,discard:true}]}` → `{rev}` |
| `DELETE draft` | discard all (+ staged media) |
| `GET  media` / `POST media` / `DELETE media/{name}` | library / upload / delete-if-unreferenced |
| `POST pages/duplicate` / `POST pages/delete` | 05 §2 page ops (delete = staged `git rm` at publish; overlay records it) |
| `POST publish` / `GET publish/stream` / `GET publishes` / `POST restore` | §5–6 |
| `POST chat/conversations` / `GET chat/conversations` / `POST chat/conversations/{id}/messages` / `GET chat/conversations/{id}/stream` / `POST chat/conversations/{id}/rename` | 06 |
| `GET  version` (unauthed, `/api/version`) | `{commit, slot}` — fleet deploy-awareness |

Errors: RFC7807-ish `{error, detail, field?}`; every route has a test; no route blocks the
event loop (git/build/Pillow work in a thread pool via `anyio.to_thread`).

## 9. Security invariants

- Bind `127.0.0.1` only (uvicorn host) — the tunnel is the sole ingress; asserted at
  startup (refuse `0.0.0.0`).
- `/admin*` + `/api/admin*` require a **verified CF Access JWT** (`CF-Access-Jwt-Assertion`:
  signature vs team JWKS (cached, refreshed 6-hourly), `aud` = the Access app AUD from
  `.env`, `iss` = the team domain, expiry). 401 JSON on API paths; 302 to the site root on
  page paths. `WIXY_DEV_NO_AUTH=1` bypass for local dev/tests only (refuses to start if
  set while `WIXY_ENV=prod`).
- Rich-lite sanitizer server-side on every draft write (02 §5); path-traversal guards on
  page/media names (strict slug regexes); upload limits (02 §9); no shell-outs with
  user-controlled strings (git via subprocess arg lists with `credential.helper=` +
  timeouts per fleet git rules).
- `/internal/*` and `/healthz` answer **loopback probes only**: a request carrying
  Cloudflare edge headers (`Cf-Ray`/`Cf-Connecting-Ip`) gets a 404 — the tunnel forwards
  ALL paths of ca.cinnamons.uk and the Access app deliberately scopes only `/admin*`, so
  without this guard Wixy would be the first fleet service exposing its internal surface
  to the raw internet. Slots smoke + Devfleet health probes hit loopback directly and
  carry no such headers. `/api/version` stays public by design (fleet deploy-awareness).
- The embedded chat cannot publish (no publish tool exposed to it; 06 §2).

## 10. Observability

Structured logs (one line/request + job logs) to `Storage/logs/wixy.log` (rotating, UTF-8
per fleet encoding rules). `/internal/ready` = pointer loaded + registry parsed;
`/internal/warmup` = pre-load pointer, JWKS, git fetch, import-warm the builder — wired
for the fleet warmup pattern (07). Startup summary line states port, project(s), live
version, build dir.
