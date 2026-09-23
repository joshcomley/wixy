# Subsystem: server chat (the "Server" panel)

A hidden human↔human live chat for admin users, disguised as a **"Server"** nav tab inside
the already CF-Access-gated `/admin`. Not the AI assistant, not visitor-facing — its own
storage, routes, and second auth gate, entirely separate from `chats.py`/`cmdchat.py`/
`draft/media/`. Full decided design: [`spec/server-chat/00-brief.md`](../../spec/server-chat/00-brief.md)
(the Architect's frozen technical brief — read it for anything this file doesn't cover).
Numbered guarantees: [invariants.md](invariants.md) 40–45.

## 1. The disguise (why it looks like nothing is here)

- The nav entry says **"Server"**, never "Chat" — it shows real server status (uptime,
  engine version, disk free, media-processing health) with **no visible entry point** into
  the chat.
- **R2 v1.3 (operator decision #974, overriding the brief's original R2 text):** a SINGLE
  tap anywhere inside the Server panel element (not the nav/topbar around it) reveals an
  "Open server settings" button, which re-hides after 10s idle. Tapping the affordance opens
  a PIN pad titled "Unlock server" — a tap that lands within 400ms of the reveal itself is
  ignored, so one accidental rapid double-tap can't reveal-and-open in the same motion.
  Multi-tap has **no meaning on the decoy**. A multi-tap (≥2 taps, ≤400ms apart) still locks
  instantly once inside the unlocked chat view — that reading (R3) is unchanged; see §10.
- Once unlocked: 10s of no activity fades back to the decoy; a panic button, a multi-tap
  inside the chat, `Escape`, tab-hidden, or routing away all lock instantly. A reload never
  restores the unlocked state (Inv 42).
- Locking **detaches the chat subtree from the document** — nothing chat-shaped remains
  readable in the DOM once locked.

This is the frontend's job (P4/P5/P6); P1 (this doc's main subject) is the backend those
panels talk to.

## 2. Auth: two independent gates, stacked

1. **CF Access** (Inv 12, unchanged) — the same JWT gate every `/admin*`/`/api/admin*` route
   already has. Nothing server-chat-specific here.
2. **The unlock token** — a second, in-app gate layered ON TOP of CF Access, never a
   replacement for it (Inv 12 amendment). See §3.

**wixy holds zero PIN state** (Inv 41) — not in code, not in `Storage/.env`, not in its own
DB. There is no PIN field anywhere in `Settings` (`wixy_server/tests/test_routes_livechat.py
::TestSettingsHaveNoPinField` asserts this directly — a grep-style guard against ever adding
one). The PIN is verified entirely by cmd; see §4.

## 3. Unlock tokens and signed media URLs (`livechat/tokens.py`)

- `POST /api/admin/server/unlock` (§5.1 of the brief) mints an **unlock token** on a
  correct PIN: `b64url(json{v,e,iat,exp,n}) + "." + b64url(HMAC-SHA256(secret,
  b"unlock|" + payload_b64))`, `secret` = 32 random bytes at `Storage/projects/<slug>/
  server/secret.key` (created race-safely across blue/green slot processes,
  `tokens.load_or_create_secret`). TTL 12h absolute.
- The token is bound to the CF Access email (`e`) that requested it — `require_server_token`
  (the route-level gate every other route calls first) rejects a token presented under a
  *different* email, so it can't outlive a change of admin on the shared device.
- Held **only in JS memory** on the client — never localStorage/sessionStorage/cookies/URLs.
  Sent as the `X-Wixy-Server-Token` header; a token in a query string is rejected outright
  (the header is the only place `require_server_token` ever looks).
- **Signed media URLs** (§5.6, for P2b's `GET media/*` — `<img>`/`<video>`/`<audio>` can't
  send custom headers): `MediaSigner` mints `?exp=<token's own exp>&sig=<HMAC(secret,
  "media|{attId}|{rendition}|{exp}|{email}")>` per attachment, per response — never
  precomputed or stored, always freshly signed against the CURRENT requester's (email, exp).

## 4. The PIN itself: `livechat/pinclient.py` (the zero-PIN-state hop)

`POST /unlock` forwards the submitted PIN + the CF email (as `subject`) to cmd's
app-key-scoped, loopback-only PIN-verify service — `CmdPinVerifier`, the only place a PIN
value ever exists in this process, and only for the duration of one outbound HTTP call.
Settings: `WIXY_SERVER_PIN_APP_KEY` → `server_pin_app_key` (default `"wixy-livechat"` — an
**identifier**, not a secret). cmd owns the registered PIN, the comparison, and the
failed-attempt lockout (per-subject **and** app-wide ladders); wixy never sees or stores
either.

**Real contract** (cmd workspace #875 PR #3068 — supersedes the brief's original
strawman shape; see brief §5.1's own "v1.4" note for the full mapping table):

```
POST http://127.0.0.1:9320/api/pins/<app_key>/verify     # app key in the PATH, plural "pins"
Content-Type: application/json                            # required (CSRF guard), else 415
body: {"pin": "<4-16 digits>", "subject": "<CF email, omitted if empty>"}
```

wixy validates **4–16 digits locally** and never calls cmd below that — cmd charges an
attempt **before** checking it, so a stray keypress must never burn one (`UnlockIn`'s
pydantic `pattern=r"^\d{4,16}$"` 422s before the route handler, and therefore before
`verifier.verify()`, ever runs).

**Retry policy** (`CmdPinVerifier._post_with_narrow_retry`) — the one place in this whole
feature where getting retries wrong double-counts a wrong PIN toward the owner's real
lockout: **at most one retry, and only on a connection error that provably never reached
cmd** — `httpx.ConnectError` (refused/DNS) or `httpx.ConnectTimeout` (timed out
*establishing* the connection). Both mean nothing was ever written to the socket. Every
other transport failure (`ReadTimeout`, a dropped connection mid-response) gets exactly one
attempt, because the request MAY already have reached cmd.

**Mapping cmd → wixy's own `/unlock` response** (`pinclient._map_response`, verbatim from
the brief's table): cmd's 200 is trusted only if the body genuinely says `ok: true` (a
malformed/garbage 200 is treated as `unavailable`, never as success — the one outcome that
mints a token must never come from trusting a status code alone); a 401 with `locked: true`
normalizes to the SAME outcome a genuine 429 produces (the owner sees one consistent
"try again in Ns", never two different UI paths for what is functionally the same lockout);
404 (`unknown_app`) → `not_configured`; 409 (`pin_changed` — cmd's PIN rotated mid-check,
nothing spent) → wixy's own 409; 400 `invalid_app_key` (misconfiguration) → `not_configured`;
400 `invalid_request`, 403, 413, 415 are all wixy-side bugs or a misrouted deployment
(logged as `ERROR`) — but **not the same wixy-side outcome**: 400 `invalid_request` maps to
**422** (the frozen contract's own distinction: "wixy validates first, so this is a wixy
bug" gets the SAME status a locally-invalid PIN would, provably unreachable in practice
since `UnlockIn`'s 4-16-digit pattern already rejects anything that could trigger it),
while 403/413/415 map to the closed-fail `unavailable` → 503 — see `pinclient.py`'s own
docstrings for the exhaustive table.

**Tests use a fake cmd** (`wixy_server/tests/fake_cmd.py`'s `/api/pins/{app_key}/verify`
double — `FakeCmdState.register_pin_app(app_key, pin)`) — the real PIN value never appears
anywhere in this repo (it's public on GitHub); see
[`spec/server-chat/00-brief.md`](../../spec/server-chat/00-brief.md)'s own banner about that.

## 5. Store (`livechat/store.py`) — `LiveChatStore`, SQLite (WAL)

One `server.db` per project at `Storage/projects/<slug>/server/server.db`. A fresh
`sqlite3.Connection` per call (never held across calls — safe under `anyio.to_thread.
run_sync` handing different calls to different worker threads, and correct across a
blue/green slot-swap overlap, since WAL + `busy_timeout=5000` handle cross-process
contention at the file level). Every method is **synchronous**; route handlers wrap each
call in `anyio.to_thread.run_sync`.

Tables: `messages`, `attachments`, `events`, `uploads`, `push_subscriptions` — schema +
every method signature are in the brief's §4 (frozen; P2/P3 only ever call what P1 built).
Two transaction shapes:
- `BEGIN IMMEDIATE` for writes needing a race-safe conditional check (an attachment's lease
  claim, `create_message`'s idempotent client-id insert) — serializes concurrent claimants
  across threads AND processes.
- `BEGIN` (deferred) for a multi-SELECT read needing one consistent snapshot —
  `list_messages`'s cursor is the events high-water mark from the SAME transaction as the
  messages it returns.

**Attachment leases** (`claim_processing`/`renew_lease`/`finish_attachment`, consumed by
P2's media queue): `lease_owner`/`lease_expires_at` columns; a lease past its expiry is
reclaimable by a different owner (crash-resume); `finish_attachment` is a silent no-op if
the caller no longer holds the lease (stolen) **or the row no longer exists at all**
(§17.1 — a future delete/wipe race).

**A cold-start concurrency fix (P2b, 2026-09-14):** `_connect()`'s migration check-then-act
(read `user_version`, `CREATE TABLE` if not yet migrated) is not itself atomic across
connections, and `PRAGMA journal_mode = WAL`'s one-time conversion does **not** respect
`busy_timeout` the way ordinary reads/writes do — it fails immediately with `OperationalError:
database is locked` rather than retrying. Both surfaced the moment P2b's media queue started
polling `claim_processing` concurrently with the very first request against a brand-new DB
file (measured: 100% failure across 160 concurrent cold-start connections without the fixes
below, 0% with them). Fixed with: every `CREATE TABLE` in the schema now says `IF NOT EXISTS`
(a racing duplicate migration attempt becomes a harmless no-op), and the `journal_mode = WAL`
switch retries with a short backoff (up to ~1s) instead of raising on the first
`OperationalError` — see `LiveChatStore._connect`'s own comments for the measured detail.
This applies to every SQLite database opened by more than one connection near true first-ever
startup (blue/green included), not just the media queue's own polling.

## 6. The SSE stream (`GET /stream?after=<cursor>`)

Full wire shape: [contracts.md](contracts.md) §4. Per-connection loop
(`routes_livechat._stream_events`):

1. Check token expiry — past it, emit `event: locked` and close.
2. Fetch `events_after(cursor)`. None → wait up to 2s on `LiveChatNotifier` (in-process
   `anyio.Event` swap), then re-poll.
3. Some → advance `cursor` to the batch's max `event_seq` (forward progress guaranteed
   regardless of what's emitted), group by `message_seq`, fetch each group's CURRENT
   message content, and emit one **coalesced** frame per message (a `message` + a
   `message_updated` for the same message in one batch collapse into a single `message`
   frame).
4. Every 15s, a bare `: ping` comment line, independent of the poll cadence.

**Why the 2s re-check matters more than the notifier**: `LiveChatNotifier` only wakes SSE
loops in the SAME process. A blue/green slot-swap runs two processes against one SQLite
file for a window — a message a sibling process writes is picked up by THIS loop's next 2s
re-check even though that write never touched this process's notifier at all. Proven
directly in `test_routes_livechat.py::TestStreamEvents
::test_cross_process_write_is_picked_up_by_the_2s_recheck` (two `LiveChatStore` instances,
one db file, the writing instance's own notifier never called).

**§17.2 amendment A1** (delete a message / wipe the chat — the store methods and routes
themselves are P8's future work, not built yet): the `events` table already accepts
`message_deleted`/`wiped` event types and a nullable `message_seq` (NULL for `wiped`), and
the stream loop already knows how to render them — `message_deleted` as `data:
{"seq":int}`, `wiped` as `data:{}`, and it **skips** (emits nothing for) a `message`/
`message_updated` event whose row has since vanished. This is schema/stream headroom only;
nothing in P1 ever inserts either event type.

## 7. Web Push (`livechat/push.py`, `server/pushToggle.ts`)

Push is an explicit Android-only opt-in. `GET /api/admin/server/push/config` returns
the project's uncompressed P-256 VAPID public key; subscription status and mutations
use the protected `/push/subscriptions/{deviceId}` routes. Subscription endpoints are
validated against the frozen HTTPS push-service allowlist before they are stored. The
VAPID key pair is persisted race-safely in the private server directory's `vapid.json`.

After a message commits, the registered dispatch hook sends a payloadless Web Push
request to every subscription except the message's device and case-insensitive sender.
Requests use a shared HTTPX client with a 10-second timeout and concurrency capped at
four. A 201 records success; 404/410 deletes the subscription; other failures are
counted and the subscription is deleted after ten consecutive failures.

The service worker is served at `/admin/server-sw.js` before the admin SPA catch-all.
It emits only the generic `Server` / `New activity` notification, suppresses it for a
visible focused Server page, and routes notification clicks to `/admin/server`. It has
no fetch handler. `server/pushToggle.ts` keeps enablement in the settings sheet's
caller: permission, worker registration, subscription, and protected PUT all happen
from the enable click; disable unsubscribes, deletes the server row, and unregisters.
## 8. Media processing, chunked uploads and the queue (P2a/P2b)

**Processing (`livechat/processing.py`, P2a) — pure, no DB/settings coupling.** Every
function takes explicit input/output paths and (for voice/video) explicit `ffmpeg`/
`ffprobe` paths; callers own everything stateful. The pipeline for every attachment:

1. **Sniff magic bytes first** (`sniff`/`sniff_path`) — before ffmpeg/ffprobe ever sees the
   file. This is the load-bearing hardening: an HLS playlist or ffconcat script renamed to
   `.mp4` has no recognised magic bytes, so it's rejected here and never reaches a
   subprocess (§2's ffmpeg SSRF/LFI concern). The sniffed container is checked against the
   claimed kind (`MediaProcessingError("kind_mismatch")` on a mismatch) before any
   processing starts.
2. **Photo** (Pillow + pillow-heif): an 80MP pixel cap checked immediately after
   `Image.open()`, before `.load()`/`.convert()`/`exif_transpose()` — a decompression bomb
   (huge declared dimensions, tiny file) is rejected without ever decoding pixel data.
   `exif_transpose` + a full metadata strip (rebuilt from raw pixel bytes, not a
   round-tripped save). PNG stays PNG; an animated GIF keeps its original bytes untouched
   (no EXIF/GPS to strip, and re-encoding a multi-frame animation buys nothing); everything
   else (including WEBP/HEIC) becomes JPEG q88. Long edge ≤4096 (full) / ≤480 (thumb).
3. **Voice**: AAC-LC mono 64kb/s `m4a`, duration from the **output** (MediaRecorder webm has
   none in its own header), 64-bucket RMS peaks normalized against the clip's own loudest
   bucket.
4. **Video**: remux (`-c copy`) iff h264/yuv420p/long-edge≤1920/fps≤60/audio is aac-or-absent
   — the display-matrix rotation side data survives untouched (`-map_metadata -1` strips
   metadata *tags*, not stream side data). Otherwise transcode (libx264 veryfast crf23, same
   caps), relying on ffmpeg's default autorotate to bake rotation into the pixels. A poster
   frame at `-ss min(1, dur/2)`, long edge ≤960.
5. **Subprocess hygiene**: Windows `BELOW_NORMAL_PRIORITY_CLASS|CREATE_NO_WINDOW`, POSIX
   `nice -n 10`; hard timeouts (30min video / 5min else) with kill-on-timeout; every
   ffprobe/ffmpeg call pins `-f <demuxer> -protocol_whitelist file`; every rendition write is
   atomic (temp name, then `os.replace`).

`process(kind, src, *, output_dir, ffmpeg, ffprobe)` dispatches to the three and never
returns a partial/failed result — a caller that catches `MediaProcessingError` has nothing to
clean up beyond `output_dir` itself.

**Uploads (`livechat/uploads.py`, P2b) — §5.5.** `init_upload` checks (cheapest-first): the
media-pipeline gate, the declared MIME type against a per-kind allowlist, the declared size
against the per-kind cap (photo 30MiB / voice 25MiB / video 1GiB), then quota
(`media_bytes_used + pending_upload_bytes + size > quota`) and the free-space floor
(injectable `disk_usage`, default `shutil.disk_usage`). `write_chunk` is idempotent
(`.part` then rename); `assemble` verifies every expected chunk is present (`missing` list on
409), checks the assembled size against the declared size (422 on mismatch), and is itself
**idempotent on retry** — a `/complete` replay after the first one already promoted the
upload returns the same attachment rather than re-assembling or erroring (same posture as
`create_message`'s `clientId` replay).

**The upload id becomes the attachment id.** There is no separate "original file path"
column on `AttachmentRow` — the convention *is* the pointer: the media queue looks for its
source at `uploads/<attachmentId>/assembled`. The `uploads` DB row stays alive (for
`pending_upload_bytes` accounting) until the queue resolves the attachment, success or
failure, at which point it — and the staged file — are removed (success) or the original is
archived to `failed/<id>/original.<ext>` (failure, kept 7 days).

**The queue (`livechat/media_queue.py`, P2b) — `run_forever`, one app-lifetime task.**
Claims via `store.claim_processing` (`owner=f"{pid}-{uuid}"`, 120s lease), spawns one child
task per claim into an unbounded dispatch group, then feeds `processing.process()` off the
event loop via `anyio.to_thread.run_sync`. Concurrency: a `video` claim acquires a
`CapacityLimiter(1)`, everything else acquires a shared `CapacityLimiter(2)` — chosen
**after** claiming, since `claim_processing`'s frozen signature has no kind filter. The
per-attachment lease-renewal loop starts the moment a row is claimed, **before** it may have
to wait behind a full limiter, so a claim queued behind busy workers never goes lease-stale
and gets double-claimed. **Crash-resume needs no special code**: `claim_processing`'s own
query (unclaimed OR lease expired) already re-surfaces a row orphaned by a killed process the
instant its lease lapses — `run_forever`'s ordinary claim loop on the next startup *is* the
recovery path.

**The §17.1/A1 delete race, the queue's own half** (P8's delete/wipe routes are the other
half, built later): after `finish_attachment` (itself a silent no-op against a
concurrently-deleted row, per `store.py`), the queue re-reads `get_attachment`; `None` means
a delete/wipe won the race, and the media bytes this worker just wrote are `rmtree`'d.

**`resolve_binaries`** (called once at `create_app` time): `WIXY_FFMPEG`/`WIXY_FFPROBE`,
falling back to `shutil.which` — but an **explicit** override must point at a file that
actually exists (`Path(...).is_file()`), or it's treated as unresolved. This catches an
operator typo in the env var as a clean 503 at upload time, rather than deferring the failure
to per-upload processing deep inside the queue. Feeds `app.state.livechat_media_available`
and the queue worker's `QueueConfig`; when `None`, the queue task is never started at all
(nothing valid to run it with) and the janitor still runs (pure DB/filesystem housekeeping,
no ffmpeg dependency).

**Janitor (`livechat/janitor.py`, P2b) — `run_once`/`run_forever`, hourly.** Ages out
uploads >24h (`stale_upload_ids`), unreferenced attachments >24h (`orphan_attachment_ids`,
keyed off `message_seq IS NULL` — never touches anything a message references, regardless of
its processing status), and `failed/` entries >7 days (by directory `mtime`, since there's no
DB row backing them). `run_once` takes an explicit `now`, never reads the clock — every age
threshold is test-driven, not slept through.

**Media route (`routes_livechat_media.py`, P2b) — `GET /media/{attId}/{rendition}`, §5.6.**
The one route besides `POST /unlock` that skips `require_server_token`, since
`<img>`/`<video>`/`<audio>` can't send a custom header — `verify_media_signature` (§3) gates
it instead. `attId` is validated as exactly 32 lowercase hex chars *before* the signature
math runs (cheap defense in depth; a forged id can never pass the HMAC anyway, since it's
covered by the signature). The stored `renditions` tuple carries rendition **names**
(`"full"`, `"thumb"`, `"play"`, `"poster"`), never file paths — the actual filename's
extension (`full.jpg` vs `full.png` vs `full.gif`) is resolved by trying each of P2a's
possible outputs for that name in turn, since exactly one of them ever exists per attachment.
An explicit MIME map (not `FileResponse`'s extension-guessing) sets `Content-Type`, because
`X-Content-Type-Options: nosniff` plus a wrong/generic content type would silently break
playback in the browser. Served via Starlette `FileResponse` (200/206, Range-aware).

## 9. Settings (`WIXY_SERVER_*`, `WIXY_FFMPEG`/`WIXY_FFPROBE`)

| Env var | Setting | Default | Notes |
|---|---|---|---|
| `WIXY_SERVER_PIN_APP_KEY` | `server_pin_app_key` | `"wixy-livechat"` | an identifier, never a secret — **no PIN setting exists** |
| `WIXY_SERVER_MEDIA_QUOTA_MB` | `server_media_quota_bytes` | 20480 MB | R10 — enforced at upload init (P2b) |
| `WIXY_SERVER_MIN_FREE_MB` | `server_min_free_bytes` | 10240 MB | R10 — the disk free-space floor, enforced alongside the quota |
| `WIXY_SERVER_UPLOAD_CHUNK_BYTES` | `server_upload_chunk_bytes` | 8 MiB | clamped to 64 KiB–16 MiB |
| `WIXY_FFMPEG` / `WIXY_FFPROBE` | `ffmpeg_path` / `ffprobe_path` | `""` (resolve via `PATH`) | overrides for a deploy where the binaries aren't on `PATH` |

`ProjectPaths` (`storage.py`) gets `server_dir`/`server_db`/`server_secret`/`server_vapid`/
`server_media`/`server_uploads`/`server_failed` — created **lazily** (like `reports_dir`),
not by `ensure_project_dirs`: a project that never unlocks the chat never needs the
directory. Plus three per-item helpers (P2b): `server_upload_dir(uploadId)` →
`uploads/<uploadId>/`, `server_attachment_media_dir(attachmentId)` → `media/<id[:2]>/<id>/`
(the two-level fan-out keeps any one directory from accumulating thousands of entries),
`server_failed_dir(attachmentId)` → `failed/<id>/`.

## 10. Frontend: the lock/gesture state machine (P4, `admin-ui/src/server/`)

The router/nav/shell wiring is ordinary (`router.ts` gets a `server` route with no
parameters; `shell.ts`'s `NAV_ROUTES` gets it last, and an injectable `mountServerPanel` seam
mirrors the AI chat panel's own `mountChatPanel` pattern — real DOM listeners would otherwise
leak across shell unit tests that never tear the panel down).

**`lockModel.ts`** is a PURE reducer, `(state, event, now) => {state, effects[]}` — every
decision about what state comes next lives here, with no DOM/timer/network access, so it has
100% branch coverage in vitest. States: `decoy`, `revealed`, `pin` (with an optional
`wrong`/`lockedOut`/`unavailable` error), `verifying`, `chat`, `fading`. One deliberate
design choice: R6's eight lock triggers (`idle`, `panic`, `multiTap`, `escape`, `hidden`,
`routeAway`, `unauthorized`, `expired`) are ALL modelled as one `{type:"lock", cause}` event
rather than eight bespoke ones — `idle` is the sole exception, going through `fading` first
only when raised from `chat` (every other state locks straight to `decoy`). There is
deliberately no "needs a display name" sub-state tracked here: §6's first-unlock name prompt
is the mounted chat view's own internal concern (R8 — it reads `localStorage["wx-srv-name"]`
itself), since the frozen `ServerChatView` interface (`types.ts`) has no hook to report one
back.

**`gestures.ts`** — TWO independent Pointer-Events-only detectors, both excluding
`textarea`/`input`/`[contenteditable]`/`audio`/`video` targets (so text entry and native
media seeking never trigger either one) and both using `performance.now()` (so Playwright's
`page.clock` controls them deterministically in e2e):
- `createTapDetector`/`attachTapListener` (R2 v1.3) — fires on every single qualifying tap,
  no counting. `panel.ts` attaches this to the panel's OWN root element (not `document`) —
  "not nav/topbar" is free that way, since an event outside the root's subtree never reaches
  a listener attached to it.
- `createMultiTapDetector`/`attachMultiTapListener` (R3, unchanged) — two taps within
  `MULTI_TAP_INTERVAL_MS` (400ms) count as one multi-tap. Attached to `document` in the
  CAPTURE phase for the panel's whole mounted lifetime, so a tap inside a
  `stopPropagation()`'d descendant is still seen; only the reducer's `chat`/`fading` states
  give the resulting event any meaning.

**`panel.ts`** owns everything `lockModel.ts` deliberately doesn't: the idle timer
(`IDLE_LOCK_MS` = 10s) and fade timer (`FADE_MS` = 800ms), the token-expiry timer, R7's
suspension bookkeeping (`LockHooks.suspend(reason)` — reference-counted per call, the idle
timer stays paused while ANY suspension is active and restarts with a FRESH 10s the moment
the last one releases; `filePicker` alone carries a `PICKER_SUSPEND_MAX_MS` = 5-minute safety
auto-release), the R7 activity listener set (`pointerdown`/`pointermove`/`touchstart`/
`touchmove`/`wheel`/`keydown`/`input` — deliberately NOT `scroll`, so a programmatic
scroll-to-bottom on an incoming message can never keep the chat visible), a dedicated
`document` `keydown` listener for `Escape`, and a `visibilitychange` listener whose `hidden`
lock is skipped only while `filePicker` or `micPermission` is suspended (R6's one named
exception — `recording`/`mediaPlaying` do NOT excuse it).

Locking always runs `ServerChatView.detach()` then removes `element` from the document — the
view instance itself is created once (on the first successful unlock) and kept alive across
every subsequent lock/unlock cycle within one page visit, only ever `dispose()`d when the
panel itself is torn down (routing away from `/admin/server`, which `panel.ts` treats as one
more R6 lock cause so cleanup runs through the same path). This is the mechanism draft text
and in-flight uploads survive a lock on (R6) — `attach(session)` is called again with a
FRESH `ServerSession` on each unlock, never a stale one.

**Until P5b lands**, `panel.ts` calls its own `createStubServerChatView` — a placeholder
honouring the frozen `ServerChatView` contract closely enough (a `.wx-srv-thread` root
matching the real view's eventual class, a draft-preserving textarea, a panic button calling
`hooks.lockNow("panic")`) that this parcel's own tests — including `e2e/tests/
server-lock.spec.ts` — exercise real detach/panic/draft-survival behaviour today, and stay
correct once the real factory replaces it via `ServerPanelDeps.createServerChatView`.

Test coverage: `lockModel.ts` and `gestures.ts` both at 100% branch coverage
(`admin-ui/tests/server/{lockModel,gestures}.test.ts`); `panel.test.ts` covers the full
unlock flow, every R6 trigger (asserting `.wx-srv-thread` is actually ABSENT from the DOM,
not just hidden), R7's suspension timer math on a fake clock, and instance survival across
lock/unlock. `e2e/tests/server-lock.spec.ts` drives the same matrix in a real browser with
`page.clock`, desktop and mobile legs both.

## 11. What's built vs. what's still to come

**Built:** P1 (settings, storage paths, the `livechat/` package's `models`/`store`/`tokens`/
`pinclient`/`notifier`, `routes_livechat.py` — unlock/history/send/stream/usage, the
`fake_cmd.py` PIN double, the `server` field on `GET /api/admin/system/status`); **P2a**
(`livechat/processing.py`, §8 above); **P2b** (`livechat/{uploads,media_queue,janitor}.py`,
`routes_livechat_media.py`, §8 above — `mediaProcessing` on the system-status field is now
the real `app.state.livechat_media_available` value, not the P1-era placeholder `"ok"`);
**P3a/P3b** (Web Push — VAPID keys, the service worker, protected push routes, the dispatch
hook, and the standalone Android toggle module); **P4** (frontend lock/disguise/PIN-pad core
— §10 above — the router/nav entry, the lock state machine, the decoy, the PIN pad, and the
orchestrating panel that wires both gesture detectors, R7's idle/suspension timers, and every
R6 lock trigger).

Not yet built (later parcels, see the brief's §10 wave plan):
- **P5b** — the real chat view/thread (`server/chatView.ts`) that plugs into P4's
  `CreateServerChatView` factory seam, replacing its stub (P5a's shared-chat-extraction
  refactor IS built and merged).
- **P6b** — wiring the recorder/uploader/media-render modules into the real chat view (P6a's
  frontend media modules themselves ARE built).
- **P8** — hard delete-a-message / wipe-the-chat (spec §17.3/§17.4), on top of the A1
  schema/stream headroom P1 already laid down (§6 above) and the queue's own delete-race
  half P2b already laid down (§7 above).
