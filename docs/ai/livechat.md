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
- A rapid multi-tap (≥2 taps, ≤400ms apart) anywhere on the decoy reveals an "Open server
  settings" button, which re-hides after 10s idle. Tapping it opens a PIN pad titled
  "Unlock server".
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

## 8. Settings (`WIXY_SERVER_*`, `WIXY_FFMPEG`/`WIXY_FFPROBE`)

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
directory.

## 9. What P1 built vs. what's still to come

P1 (this doc, this PR) is the backend core everything else depends on: settings, storage
paths, the `livechat/` package (`models`/`store`/`tokens`/`pinclient`/`notifier`),
`routes_livechat.py` (unlock/history/send/stream/usage), the `fake_cmd.py` PIN double, and
the `server` field on `GET /api/admin/system/status` (§5.10 — `{"startedAt":epoch_s,
"mediaProcessing":"ok"|"unavailable"}`; `mediaProcessing` is a placeholder `"ok"` until P2
sets `app.state.livechat_media_available` for real at startup).

Later parcels (see the brief's §10 wave plan):
- **P2a/P2b** — media processing (ffmpeg/Pillow pipeline), chunked uploads, the media
  queue, `GET media/*`.
- **P3a/P3b** — Web Push is built: VAPID keys, the service worker, protected push
  routes, dispatch hook, and standalone Android toggle module.
- **P4/P5/P6** — the frontend: lock state machine, the decoy, the PIN pad, the chat view,
  media rendering, the recorder/uploader.
- **P8** — hard delete-a-message / wipe-the-chat (spec §17.3/§17.4), on top of the A1
  schema/stream headroom P1 already laid down (§6 above).
