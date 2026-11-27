# Adventure Time on an open URL (workspace 00065, Inv 61)

The public, no-login, single-player Adventure Time at `https://adventure.cinnamons.uk/`. Decided brief:
`spec/adventure-public/README.md` (read it first; this file is the code reality). Decision record:
`decisions/00216-adventure-time-public`. Invariant: Inv 61. The private two-player game it grows out
of is `livechat.md` §23 (Inv 56) and is **not changed** by anything here.

- Server half: `wixy_server/adventure_public/` + `wixy_server/routes_adventure_public.py` (this
  file). Client half: `admin-ui/src/public/` (a separate builder; `livechat.md` §23.1's pane reused).
- Bank, rounds, "never again" and the Holiday bank live **only in the visitor's browser**
  (`localStorage`); the server keeps one thing for the public game — a shared, per-destination cache of
  researched holiday packs and their pictures.

## 1. One server, host-gated (`adventure_public/gate.py`)

`WIXY_ADVENTURE_PUBLIC_HOST` (`adventure.cinnamons.uk` in production; empty = feature **off**, the
default). Parsed by `settings.parse_adventure_public_host`: lower-cased, a bare host name only (no
scheme, port, path, trailing dot); the **standalone edition refuses a non-empty value at start**.

When set, `create_app` builds the public application (`routes_adventure_public.build_adventure_public_app`)
and installs `AdventurePublicHostGate` as the **outermost** middleware (registered after every other
`app.middleware` / `add_middleware`). It is a pure ASGI middleware that reads the `Host` header
(lower-case, `:port` stripped, one trailing dot removed; a request naming the public host in ANY of
several `Host` headers is public):

| Host | What happens |
|---|---|
| the public host | the request goes to the **public application only**: its own routes (§3), everything else a plain `404 Not found` (never the site's 404, never the admin). The main application — admin, `/api/admin/*`, `/internal/*`, the site catch-all, `/api/version*`, `/uxer-*`, `/docs` — is structurally out of reach. WebSockets are refused (`websocket.close` before accept). Every response gets `X-Robots-Tag: noindex`, the strict CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. |
| any other host | untouched: the main application (the public routes do not exist there, so they 404 like any unknown path; `/` is the site, `/robots.txt` the site's) |
| feature off | the gate is **not installed**, the public application is never built |

CSP: `default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; script-src 'self'; style-src
'self' 'unsafe-inline'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action
'none'`. The public application has no `/docs`, `/openapi.json`, slash redirects or error shape of the
main app (`PlainTextResponse` 404/405).

Tests: `test_adventure_public_gate.py` (both directions, every traversal / host spelling / method, the
sockets, the setting). Traversal cases go through the raw ASGI interface (`asgi_request` in
`adventure_public_testkit.py`) because an HTTP client collapses `..` and `//` before sending.

## 2. The pack cache (`adventure_public/store.py`, `public.db`)

`Storage/<project>/adventure-public/public.db`: SQLite, WAL, a short-lived connection per operation,
`BEGIN IMMEDIATE` for every mutation, the clock sampled after the lock (decisions/00186). **Never**
`server.db` (Inv 61). A `schema_version` table (v1 only). The folder is created lazily and is absent
from the backup allowlist (a rebuildable cache).

- `packs` (one row per destination — the cache every visitor shares): `destination_id` PK, `state`
  (`pending|ready|failed`; no row = `none`), `run_id`, `pack_json`, `error`, `started_at` (the start of
  the 24-hour tries window), `tries`, `next_try_at`, `images` (`none|pending|done|failed`),
  `images_started_at`, `images_tries`, `updated_at`, `rev`.
- `pictures`: `id` (random 16 bytes as 32 hex), `destination_id` (cascade), `slot` (`hero:<i>` /
  `<section>:<i>`, the private plan's keys), `ordinal`, `width`, `height`, `credit`, `page`, `caption`,
  `created_at`. Files: `adventure-public/pictures/<id>/full.jpg` (as found, ≤ 1600 px) and `thumb.jpg`
  (≤ 480 px long edge, `processing.reencode_still_as_jpeg`).
- **Failure and retry.** `failed` carries a short generic error. `next_try_at` = failure time + 10 min,
  doubling per try (10, 20, 40); the 3rd failure of a 24-hour window holds the pack until the window
  (24 h from its first try) ends; the first request after that starts a fresh window. A pack asked for
  before `next_try_at` answers the stored failed view (`canRetry: false`, `retryAfterS`). cmd being
  **unreachable** is not a try (`transient`: `tries` is given back, `next_try_at` = +60 s).
- **Cost bound.** One research run per destination (1,412 in the shipped bank) plus bounded retries,
  and `limits.StartLimiter`: **30 starts per rolling hour overall, 6 per client per hour**; the client
  is `CF-Connecting-IP` when it is a valid address, else the socket peer, and is a NETWORK: an IPv4
  address counts as its /24 and an IPv6 address as its /48 (`limits.client_key`). The counters are in memory
  only, bounded at 50,000 clients, never logged. Over a limit: `429` `{"error":"rate_limited","retryAfterS":N}`
  + `Retry-After`. **The budgets pay for real research runs only**: `acquire` returns a `StartTicket` (client +
  its own timestamp) and `release(ticket)` removes exactly that start; the route gives it back when another
  request began the pack first, when the runner could not take the job (`start()` returned False: the pack is
  settled `failed`, transient, retryable in a minute, never left `pending` with nobody to run it) and when the
  researcher raises `ResearchUnavailableError` (cmd unreachable: the job calls the route's `refund`). So a cmd
  outage cannot lock research out for an hour.

## 3. Routes (`routes_adventure_public.py`; public host only)

See `contracts.md` ("Public Adventure Time host") for every shape. `GET /`, `GET /d/{code}` (the shell
with Open Graph tags), `GET /assets/{name}`, `GET /api/bank`, `GET|POST /api/pack/{code}`,
`GET /media/{id}/{thumb|full}.jpg`, `GET /robots.txt`, `GET /manifest.webmanifest`.

- **Short codes** (`codes.py`): lower-case base32 (alphabet `abcdefghijkmnpqrstuvwxyz23456789`) of
  `sha256(destination_id)`, first 6 characters — computed server-side only, stable forever. **Pinned**:
  `adventure_public/codes_pinned.json` (destination id -> code) holds the code of every destination in the
  shipped bank, and `build_public_bank` uses the pinned code for a pinned id, always. A destination that is not
  pinned (a newcomer) gets its 6-character code and, if that equals ANY pinned code (even a destination that has
  left the bank) or another newcomer's, only the newcomer(s) lengthen to 8, then 10, 12... (logged); a pinned
  code is never lengthened. After a bank update run `python -m wixy_server.adventure_public.pin_codes` (stdlib +
  repo imports; `--check` only reports) and commit the table: it only ever APPENDS, and
  `test_adventure_public_codes.py::TestPinnedCodes` fails until every shipped destination is pinned to the code
  it has today. The test also pins four literal codes: they are in people's bookmarks.
- **The shell** (`shell.py`): dark, phone-first, painted from an inline style; loads
  `/assets/app.css?v=<hash>` and `/assets/app.js?v=<hash>` (classic `<script defer>`, so the bundle is an
  IIFE like the admin's) computed from the files **at start** (a missing bundle leaves the bare URL; the
  shell still renders); one `<script type="application/json" id="adventure-public-boot">` carrying
  `{"code", "origin", "assets": {world, satellite, atlas}}` (+ `"missing": true` on the unknown-code
  page). Everything dynamic is HTML-escaped; the boot JSON has `<`, `>`, `&` escaped. No inline script,
  no third-party request.
- **Assets** are served by NAME from three places only: the bundle directory
  (`wixy_server/static/adventure-public/`, overridable with `create_app(adventure_public_static_dir=)`),
  the three shared imagery files in `static/admin/` (`adventure-world.json`,
  `adventure-satellite.webp`, `adventure-atlas.webp` — the same bytes as the private game) and the
  home-screen icons in `adventure_public/assets/`. A `?v=` equal to the file's current hash is
  `public, max-age=31536000, immutable`; anything else `no-cache`. The admin bundle is **never** served.
- **Own thread budget** (`service.PublicThreads`, `CapacityLimiter(6)`): every blocking call on the public
  routes (store reads, the asset table, file reads) goes through it, never anyio's shared default pool, so an
  anonymous flood cannot starve the private chat. `/assets` and `/media` are served by
  `adventure_public/files.PooledFileResponse`, a `FileResponse` (same headers: `Content-Length`,
  `Last-Modified`, `ETag`, `Accept-Ranges`, byte ranges; no 304 handling, as before) whose file reads run on that
  budget. (The runner's and the picture job's own store calls stay on the default pool: they are bounded by the
  research budget, not by visitor request count.)
- **Settled-pack cache** (`PublicPackStore.get_with_pictures`): a pack that can no longer change on its own
  (`ready` with its pictures `done`/`failed`; or `failed` until its `next_try_at`) is read from memory, one entry
  per destination, at most the size of the bank, dropped by every write to that row in this process
  (`_write_txn(destination_id)`) and expiring at `next_try_at` for a failed one. `pending` packs and picture
  waits are never cached, so a blue/green neighbour cannot leave this process serving a stale state. The view
  (`pack_view`) is computed from the cached row at read time, so `retryAfterS` still counts down.
- **Not ready**: `service.status.ready` flips true only when `prepare()` succeeded; until then every page and
  API route answers `503` (`contracts.md`), assets/robots/manifest still serve.
- **No source maps**: the public esbuild entries emit none, nothing `*.map` is committed in
  `static/adventure-public/`, and `AssetTable.resolve` refuses any `.map` name.
- **POST /api/pack/{code}** needs `Origin` equal to `https://<host>` (403 otherwise), starts research
  only when the pack is `none` or `failed` past `next_try_at`, takes a limiter slot first and gives it
  back if another request started the pack first; otherwise it answers the current view.
- **No researcher** (fleet edition on a non-cmd AI backend; tests): a pack reads
  `{"state":"failed","error":"Holiday packs aren't available right now","canRetry":false}` and nothing is
  stored.

## 4. Research and pictures

- `runner.PublicPackRunner` mirrors `AdventurePackRunner` (see `livechat.md` §23) over the public
  store: same prompt / parse / sanitise / canonical JSON, `CmdAdventureResearcher(chat_client,
  caller="wixy-adventure-public-pack")`, its own empty cwd `adventure-public/research`, **its own
  `CapacityLimiter(1)`** (the private game keeps its two), spawns ≥ 5 s apart, compare-and-set writes on
  `(state='pending' AND run_id=?)`, resume at startup (poll a known run, else start one), give up after
  25 min (cancel the run), one retry for an early cmd `error`, never re-spawn a run whose answer might be
  lost. With no researcher a `pending` pack found at startup becomes `failed` (transient).
- **Research sweep** (`PublicPackRunner.supervise_research` -> `watch_stale_forever` / `sweep_stale`, supervised
  `adventure-public-research-watch`, Inv 47): every `PackTiming.stale_sweep_interval_s` (300 s) it looks for
  `pending` rows untouched for `give_up_s + stale_margin_s` (25 min + 5 min), skips any this process already has a
  job for, takes one over with the compare-and-set `store.claim_pending` (stamps `updated_at`, so two sweeps or a
  blue/green neighbour claim it once) and runs the same `run_job`: poll the run the row knows, else start one.
  Startup `resume()` is no longer the only recovery. In `app.py` the resume, the research sweep and the picture
  sweep each start in their own guarded block, so one failing never leaves the others unstarted.
- `pictures.PublicPictureJob` mirrors `AdventurePictureJob`: `plan_pictures` → the finder's 240 s hunt →
  stage `full.jpg` + `thumb.jpg` for every picture → ONE transaction inserts the rows and flips `images`
  to `done` (all or nothing; the files of a lost race are removed). Startup redo; a **supervised** sweep
  (`adventure-public-pictures-watch`, Inv 47) re-runs hunts pending longer than `stale_after_s` and gives
  up after 3 tries; the sweep also removes picture directories no row owns older than an hour (a process
  killed between staging and the attach). A hunt that finds nothing ends `images = failed` and is **not**
  retried (as in the private game).
- **Commons only** (licensing): `WebPictureFinder(..., allow_site_images=False)` skips the venue
  `og:image` / `twitter:image` source entirely (no venue page is fetched; `site_picture` itself also
  returns `None`). Every other source is already Wikipedia's summary image taken as its **Commons**
  thumbnail, or a Commons file search. The private game's finder keeps the default (`True`) — its
  behaviour is unchanged.
- **Defaults and seams** (`create_app`): the production `CmdAdventureResearcher` / Commons-only finder
  exist only on the same default path as the private game (fleet edition, cmd AI backend, **no researcher
  injected into either game**); an injected researcher never reaches the internet unless a finder is also
  injected. Seams: `adventure_public_researcher`, `adventure_public_picture_finder`,
  `adventure_public_pack_timing`, `adventure_public_picture_timing`, `adventure_public_limits`,
  `adventure_public_static_dir`. A failure of the public game's startup (its storage) is logged and
  disables it; it never stops the private chat starting.

## 5. Tests

`test_adventure_public_gate.py`, `_codes.py`, `_limits.py`, `_store.py`, `_runner.py`,
`_pictures_job.py`, `_review.py` (the review fixes: research sweep, own thread budget, settled-pack cache,
start-budget refund, 503 state, independent loops, no source maps), `test_routes_adventure_public.py` and `TestCommonsOnly` in
`test_livechat_adventure_pictures.py`; shared helpers in `adventure_public_testkit.py` (`public_client`
builds the whole app with the host set; `module_public_client` for module-scoped read-only apps, since
starting the app is the expensive part).

**E2E** (`e2e/tests/adventure-public.spec.ts`, desktop 1280x800 and 360 px phone): the fixture server
(`e2e/fixture_server.py`) serves the public game on the host name **`localhost`**
(`WIXY_ADVENTURE_PUBLIC_HOST`, `PUBLIC_HOST`) while every other spec keeps reaching it as `127.0.0.1:<port>`, a
different `Host` for the gate, so no existing spec changes; Chromium resolves `localhost` itself (no resolver rule).
The public researcher is a second `CmdAdventureResearcher` (caller `wixy-adventure-public-pack`) on the same fake cmd
(canned pack after ~2 s), with NO picture finder (a public pack is text only, `images: "none"`; nothing leaves the
box) and the start limits lifted. `POST /test/adventure-public/runs` (fixture only, on the private host) counts the
runs the fake cmd was asked for under the public caller. The page is plain http but a research start needs
`Origin: https://<host>`, and the browser owns `Origin`, so the spec's `publicContext` sends `POST /api/pack/*` on
from the runner (`route.fetch` + `fulfill`) with that header; a wrong Origin stays a 403 (its own test). Covered: home
loads with no login and every request on the public origin; a whole round (both spins, landing, both Stops, the pack),
Yay and the Holiday bank, a reload keeping the bank, Copy link (clipboard) `https://<host>/d/<6 chars>`, that link in a
fresh browser showing the place and pack at once with no second research run; Nay's question and "Never show again"
(kept over a reload, and a seeded second round that ends on the one place left, never the rejected one); `/d/zzzzzz`
and Spin the globe; the host gate (`/admin`, `/api/admin/*`, `/internal/*`, site paths, `/healthz`, `/test/*` all 404
with `X-Robots-Tag`), the public routes' headers, and the public routes being 404 on the private host; no sideways
overflow at either width.
