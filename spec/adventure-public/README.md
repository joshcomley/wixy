# Adventure Time on an open URL (workspace 00065)

Decided brief. Authority: same as `spec/` ("decided, implement faithfully"). Layered on top of
`spec/server-chat/08-adventure-time.md` (the private two-player game) — where this brief is silent, the
private game's behaviour is the behaviour. Decision record: `decisions/00216-adventure-time-public`.
Invariant: Inv 61 (`docs/ai/invariants.md`).

## 0. The operator's words (verbatim)

> I'd like the Adventure Time to be published to an open URL, please.
>
> For this version, you won't be able to bank. Well, I suppose you can. You can still have the banking
> facility, but it's only going to be in your browser cache, and you should be able to copy a short URL
> for any of the destinations that you land on, so you can just sort of bookmark that for yourself or
> send a link to yourself.

## 1. What ships

A public, no-login, single-player Adventure Time at **`https://adventure.cinnamons.uk/`**.

- Anyone opening the URL plays the whole game alone: spin sideways, spin up/down, landing, country
  roulette, place roulette, Stop, zoom to the place, the **holiday pack** (researched by AI, with pictures).
- **Bank** ("Yay") and **Never again** ("Nay") work exactly as in the private game but live ONLY in that
  browser's `localStorage`. The **Holiday bank** screen lists the browser's banked trips. Options holds
  "Include places the UK says not to travel to" (per browser) and the map style (per device, as today),
  plus **"Forget everything on this device"** (clears bank + never-again list, after a confirm).
- Every place you land on has a **short link**: `https://adventure.cinnamons.uk/d/<code>` (`code` = 6
  lowercase characters). A **Copy link** button (and **Share** where `navigator.share` exists) sits beside
  Yay/Nay once a place is chosen, and on every Holiday bank row. Opening a short link shows that place at
  once (globe on the place, its holiday pack below) with Yay/Nay/Copy link and **Spin the globe** to start
  a fresh game. The link is the same for everyone and works forever while the place stays in the bank.
- Nothing about the private Server chat is reachable on the public host; nothing the public host stores
  touches the private chat database.

## 2. Architecture

### 2.1 One server, host-gated (fleet edition only)

The public game is served by the SAME wixy process (it already owns the bank, the researcher and the
picture finder), on its own hostname. New setting `WIXY_ADVENTURE_PUBLIC_HOST` (empty = feature off,
which is the default and the standalone edition's only value — the standalone edition refuses a
non-empty value at start, like other fleet-only settings).

A **host gate** middleware, registered so it runs BEFORE every other middleware (outermost):

- Request `Host` (lower-cased, port stripped) equals the public host → only the public routes in §2.3
  are served; EVERY other path answers a plain 404 (no admin, no `/api/admin`, no site, no internal, no
  version routes). The response carries `X-Robots-Tag: noindex` and a strict CSP (§2.6).
- Any other host → the public routes answer 404 (they exist only on the public host).
- Feature off → the gate is a no-op and the public routes are never mounted.

Tests pin both directions, including `/admin`, `/api/admin/server/...`, `/internal/...`, `/` (site),
path-traversal attempts and a `Host` with a port / upper case.

### 2.2 Public pack cache (`wixy_server/adventure_public/`)

A new package, separate from `livechat/` (Inv 61: public data never enters `server.db`):

- **Store**: SQLite `Storage/<project>/adventure-public/public.db` (WAL, same connection discipline as
  other stores, `BEGIN IMMEDIATE` for mutations, clock sampled after the write lock — decisions/00186).
  Table `packs`: `destination_id TEXT PRIMARY KEY`, `state` (`pending|ready|failed`), `run_id`,
  `pack_json`, `error`, `started_at`, `tries`, `next_try_at`, `images` (`none|pending|done|failed`),
  `images_started_at`, `images_tries`, `updated_at`, `rev`. Table `pictures`: `id TEXT PRIMARY KEY`
  (random 16-byte hex), `destination_id`, `slot` (the same slot keys the private plan uses: `hero:<i>`,
  `<section>:<i>`), `ordinal`, `width`, `height`, `credit`, `page`, `caption`, `created_at`; files at
  `adventure-public/pictures/<id>/full.jpg` and `thumb.jpg`. A schema-version table like the other
  stores; v1 only.
- **Research** reuses, unchanged: `adventure_pack.build_prompt`, `parse_pack`, `sanitise_pack`,
  `canonical_pack_json`, `CmdAdventureResearcher` (the same cmd chat-spawn run settings, `caller:
  wixy-adventure-public-pack`, its own empty cwd `adventure-public/research`). A public runner
  (`PublicPackRunner`) mirrors `AdventurePackRunner`'s discipline: compare-and-set writes on
  `(state='pending' AND run_id=?)`, resume at startup (poll a known run, else start one), give up after
  25 min (cancel the run), one retry for an early cmd `error`, spawns ≥ 5 s apart, never re-spawn when
  an answer might have been lost. **Its own** `CapacityLimiter(1)` (the private game keeps its 2; the
  public game must never starve the private one).
- **Pictures** reuse `plan_pictures`, `WebPictureFinder`, `prepare_picture` and the 240 s hunt budget,
  in **Commons-only** mode: a new finder flag `allow_site_images: bool` (default `True`, the private
  game unchanged) that, when `False`, skips the venue `og:image` / `twitter:image` source entirely —
  only freely-licensed Wikimedia Commons files (with their credit and licence) are ever published.
  Each found picture is written as `full.jpg` (≤ 1600 px, as found) and `thumb.jpg` (≤ 480 px long
  edge, `reencode_still_as_jpeg`), all-or-nothing per pack (stage, then one transaction inserts the rows
  and flips `images` to `done`; staged files of a lost race are removed). Startup resume + a supervised
  stale sweep exactly like `livechat-adventure-pictures-watch` (contained group, Inv 47).
- **Failure**: `failed` with a short generic error. A failed pack may be re-requested once
  `next_try_at` has passed (10 min after the failure, doubling per try, max 3 tries per 24 h); until
  then `POST` answers the stored failed view with `canRetry: false`.
- **Cost bound**: the cache is keyed by destination, so the most research the public game can ever
  cause is one run per bank destination (1,412 today) plus bounded retries. Additionally a global
  limit of **30 new research runs per rolling hour**, and **6 research starts per client IP per hour**
  (client IP = `CF-Connecting-IP` when present, else the socket peer). Over a limit → `429` with
  `Retry-After`; the client shows "Lots of people are exploring right now — try this place again in a
  few minutes" and keeps polling `GET` (someone else's request may already be researching it).

### 2.3 Public routes (`wixy_server/routes_adventure_public.py`, public host only)

| Route | Answer |
|---|---|
| `GET /` | The page shell (HTML, §3). `Cache-Control: no-cache`. |
| `GET /d/{code}` | The same shell with per-place `<title>` and Open Graph tags (`og:title` = place name, `og:description` = "<Country> · <blurb>", `og:image` = the pack's first hero thumb when ready, else none, `og:url` = the canonical short URL). Unknown code → 404 page (the shell with a "That place isn't on the map any more" message and **Spin the globe**). |
| `GET /assets/{name}` | The fingerprinted bundle, CSS, world map, satellite/atlas imagery, icons (from `wixy_server/static/adventure-public/` and the shared adventure assets). Immutable caching for `?v=` / hashed names. |
| `GET /api/bank` | The public bank: `{version, countries: {<unit>: {name, advice, destinations: [{id, code, name, region, lat, lng, kind, blurb}]}}}` built once at start from `AdventureBank`, ETag + gzip. |
| `GET /api/pack/{code}` | `{code, destinationId, state: "none"|"pending"|"ready"|"failed", data, error, canRetry, images, pictures: {hero:[...], items:{...}}, retryAfterS}`; pictures as `{thumbUrl, fullUrl, credit, page, caption}` with same-origin `/media/{id}/{thumb|full}.jpg` URLs. `Cache-Control: no-store` while pending, short max-age when ready. |
| `POST /api/pack/{code}` | Starts research if `state` is `none`, or `failed` past `next_try_at`; otherwise idempotent (answers the current view). Rate limits per §2.2. Body empty; `Origin` must equal the public origin (403 otherwise). |
| `GET /media/{id}/{thumb\|full}.jpg` | A cached picture. `id` validated as 32 hex chars; immutable caching. |
| `GET /robots.txt` | `User-agent: *` / `Disallow: /` |
| `GET /manifest.webmanifest`, icons | So it can be added to a phone's home screen. |

The **short code** is computed server-side only: lowercase base32 (alphabet `abcdefghijkmnpqrstuvwxyz23456789`)
of `sha256(destination_id)`, first 6 characters; uniqueness is asserted when the public bank is built
(a collision lengthens BOTH colliding codes to 8, logged; tests pin no collision in the shipped bank and
the lengthening rule). Codes are stable for a destination id forever.

### 2.4 The client (`admin-ui/src/public/`)

A second esbuild entry (`src/public/main.ts` → `wixy_server/static/adventure-public/app.js` + `app.css`),
committed like the admin bundle (CI drift check covers it). It reuses the production game, not the dev
preview:

- **The pane** (`adventureGame.ts`) is reused as-is in behaviour. Changes allowed only to make its
  server-chat dependencies OPTIONAL: `float` (no chat FAB on the public page), `hooks` (no idle lock),
  live trail (no partner; `postLive` absent → no sender/receiver), `partner()` null. The title row gains
  a **Copy link** action when the deps supply `shareLink(view)` (public only). The private chat's
  behaviour must be byte-for-byte unchanged (existing tests stay green untouched).
- **`LocalAdventureBackend`** (`src/public/localBackend.ts`) implements `AdventureGameApi` plus the
  model feed: it holds the one current round in memory, runs the SAME state machine as the server
  (§23 of `docs/ai/livechat.md`: `spin_lng → spin_lat → country → destination → chosen → banked|rejected`,
  exactly-one-place-left skips to `chosen`, `exhausted` when none left, eligibility = playable units
  minus whole-country-advised units unless the setting is on), produces `AdventureView` objects with
  `serverNow` = local clock, seeds as random uint32, `country.rouletteAt = now + durationMs/1000 + 5`,
  `destination.rouletteAt = now + 3.5`. The top-five rule is a TS port of
  `AdventureBank.top_destinations` (rank order, 40 km great-circle spacing, then fill shortfall in rank
  order), with a golden test generated from the Python implementation over the real bank so the two
  can never drift. "Remaining" = bank − this browser's never-again − this browser's banked.
- **Pack**: on `chosen` the backend `GET`s `/api/pack/{code}`; `none`/retryable `failed` → `POST`; then
  polls `GET` every 5 s while `pending` (and while `images` is `pending`), maps the answer onto the
  view's `PackView`. `retryPack` → `POST`. A 429 shows the friendly wait message and keeps polling.
- **Storage** (`src/public/memory.ts`): `localStorage` keys `advPublic.v1.banked` (list of
  `{code, destinationId, unitId, at}`), `advPublic.v1.rejected` (destination ids),
  `advPublic.v1.settings` (`{includeAdvised}`); corrupt/blocked storage degrades to in-memory for the
  visit (never throws). Names are resolved from the public bank at read time, so a renamed place shows
  its current name; a banked id no longer in the bank is shown greyed "No longer on the map".
- **Holiday bank screen**: `holidayBank.ts` gets a data-source seam (today `GET /adventure/bank`; public:
  the memory list). Rows: place, country, date banked, **Copy link**, tap → opens `/d/<code>` in-page
  (History API, no reload).
- **Deep link**: `/d/<code>` builds a `chosen` view directly (landing = the destination's point with
  `landUnit` = its unit, no spins); the scene's existing "late joiner sees the place at once" path
  renders it. Back/forward work (History API). **Spin the globe** → `/`.
- **Page**: dark, full-screen, phone-first and desktop-correct (operator rule: both, verified at 360 px
  and 1440 px), title "Adventure Time", a one-line footer "Holiday packs are written by AI — check
  before you book. Photos: Wikimedia Commons (credits on each photo)." No analytics, no third-party
  requests from the browser at all (every asset and picture is same-origin).

### 2.5 Hosting

- `adventure.cinnamons.uk` → hub cloudflared ingress → `http://127.0.0.1:<wixy prod port>` (the same
  origin as `ca.cinnamons.uk`); DNS via `cloudflared tunnel route dns`. **No Cloudflare Access app**
  (it is deliberately public). Follow the `commission-subdomain` skill.
- `D:\Servers\Wixy\Storage\.env` gains `WIXY_ADVENTURE_PUBLIC_HOST=adventure.cinnamons.uk` (deployment
  configuration, not code). The deploy is the normal merge-to-main Slots swap.

### 2.6 Security notes (reviewed before delivery)

- The host gate is the security boundary; it runs first and its tests are exhaustive (§2.1).
- CSP on the public host: `default-src 'self'; img-src 'self' data: blob:; connect-src 'self';
  script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; frame-ancestors 'none';
  base-uri 'none'; form-action 'none'`. `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`.
- Pack text is rendered with `textContent` only (as `packView.ts` already does); links only
  `http(s)` with `rel="noopener noreferrer nofollow"` and `target="_blank"`.
- Nothing from a visitor is stored except the rate-limit counters (in memory, IP keys, never logged
  or persisted).

## 3. Out of scope (this version)

Accounts, server-side banking, two-player play / live finger trail on the public page, sharing a
private pack publicly, indexing by search engines.

## 4. Acceptance

1. `https://adventure.cinnamons.uk/` plays a full round on a phone and a desktop, with no login.
2. A first landing on a place researches its pack (pictures from Commons only); the second visitor to
   that place gets it instantly from the cache.
3. Yay keeps the trip in this browser's Holiday bank; Nay hides the place from this browser's future
   draws; both survive a reload; "Forget everything on this device" clears them.
4. Copy link gives `https://adventure.cinnamons.uk/d/<6 chars>`; opening it in a fresh browser shows the
   place and its pack at once.
5. On `adventure.cinnamons.uk`, `/admin`, `/api/admin/*`, `/internal/*` and the site pages are 404; on
   `ca.cinnamons.uk` the public routes are 404; the private game is unchanged.
6. Full Python suite, mypy, ruff, admin-ui typecheck/tests/build (no drift) and e2e green; a new e2e
   spec plays the public game against the fixture server (fake cmd pack).
