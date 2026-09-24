# Server chat — Architect's technical brief (workspace #29)

Status: **FROZEN v1.5.4** (Architect, 2026-09-24). v1.1 = operator's zero-PIN-state override
(R4/§5.1); v1.2 = delete + wipe addendum (§17); v1.3 = R2 errata: a single tap reveals
(decision #974); **v1.4 = cmd's real PIN contract in §5.1 (app key in the path, richer errors,
retry-safety) + a new 409 `pin_changed` on `/unlock`**; **v1.5 = R3 gesture boundaries (a
tap that opens a menu/sheet may close a double-tap but never open one) + primary button
only**; v1.5.1 = boundaries are not test cadence (no e2e waits for menu flows) + decision
numbers no longer pre-allocated; v1.5.2 = one test for classifying any tap pair
(causal chain → boundary; independent decisions → test cadence) + voice notes under 1 s
are discarded; v1.5.3 = delete/wipe scrub errata (TRUNCATE for both — PASSIVE measured
insufficient), 204-guarantees / 202-pending semantics; v1.5.4 = crash-safe media erasure,
deleted-media URL revocation, and one `/usage.erasurePending` signal. Contracts in §5 are frozen — any change goes
through the Architect (`ask-architect`). Rulings in §1 are binding.

> ⚠️ **Editing this file:** ruff formats Python fenced blocks **inside markdown**, so
> `ruff format --check .` (CI) fails on an unformatted ```python fence here — measured
> 2026-09-14, when this file's store-API stub broke CI branch-wide until PR #221 fixed it.
> Run `ruff format` before committing any edit to this file. Reformatting a fence is
> mechanical and needs no Architect ruling; changing what a signature or comment *says*
> does.

> 🔴 **The wixy repo is PUBLIC** (`gh repo view` → `visibility: PUBLIC`, measured
> 2026-09-14). The PIN value must NEVER appear in any repo file, commit message, PR body,
> todo, decision, test, or doc.
>
> **Operator override (v1.1):** wixy holds **zero PIN state** — not in code, not in
> `Storage\.env`, not in the DB. wixy verifies a submitted PIN by calling cmd's generic,
> app-key-scoped PIN service on loopback, and cmd owns registration and lockout (see R4 and
> §5.1). Tests use a made-up test PIN inside the fake cmd. Do not name the chat
> participants in repo text either ("admin users").

---

## 0. Summary

A hidden human-to-human chat for admin users, inside the already CF-Access-gated `/admin`.
It is disguised as a **"Server"** nav tab showing real server status. A single tap on
that screen reveals **"Open server settings"**, which opens a PIN pad titled
**"Unlock server"**. After
unlock it's a live chat with text, photos, videos, and voice notes, plus opt-in Android push.
There are three ways back to locked (10 s idle fade, panic button, multi-tap in chat), plus a
few fail-closed extras (§1 R6).

**Naming map** (keep it consistent):
- Code package: `wixy_server/livechat/`
- Frontend folder: `admin-ui/src/server/`
- Disguise-consistent URLs: `/admin/server`, `/api/admin/server/*`, `/admin/server-sw.js`
- Storage dir: `Storage/projects/<slug>/server/`
- CSS prefix: `.wx-srv-`
- localStorage prefix: `wx-srv-`
- Doc: `docs/ai/livechat.md`

---

## 1. Rulings (binding)

**R1 — What it is.** Human↔human admin messaging. It is not the AI assistant and not
visitor-facing. It has its own storage and routes, separate from `chats.py`, `cmdchat.py`
and `draft/media/`.

**R2 — Gesture model** (v1.3 ERRATA — operator decision #974: "Single tap. Double tap is
anywhere on the chat view to lock it again." This supersedes the v1–v1.2 multi-tap reveal):
- Locked screen = the **decoy** (real server status) with **no** visible entry point.
- A **single tap** anywhere inside the Server panel (the `.wx-main` panel element, **not**
  the nav or topbar — so tapping another tab never flashes the affordance) → reveals an
  **"Open server settings"** button. It re-hides after 10 s idle.
- Tap it → PIN pad titled **"Unlock server"**.
  - **Debounce:** the affordance ignores any tap within 400 ms of its own reveal, so the
    second tap of an accidental double tap can't open the PIN pad.
- Multi-tap has **no** special meaning on the decoy. Its first tap reveals, and the rest
  are absorbed by the debounce. Multi-tap only matters inside the chat view (R3).
- The idle-fade path ends on this same decoy, so "tap again → unlock server" (mission #1)
  holds on every path. Every lock cause lands in one locked state; the only difference is
  that idle animates a fade and the others are instant.

**R3 — Multi-tap inside the chat view locks.** It counts every pointerdown except those whose
target is inside `textarea`, `input`, `[contenteditable]`, `audio` or `video` (native media
controls), so text editing and seeking never lock. Buttons count: a fast double-tap on Send
sends and then locks, which is acceptable because it fails closed. Detector:
- Uses Pointer Events only, never pointer+touch+mouse together, to avoid double counting.
- Uses `performance.now()` so Playwright `page.clock` controls it.
- Is attached to `document` in the capture phase while the panel is mounted.
- The panel root gets `touch-action: manipulation`.
- **v1.5 — gesture boundaries** (ruling on P8's question, 2026-09-24). A tap that
  *opens a new surface under the finger* is the start of a menu flow, not half of a
  double-tap. Measured on the branch: `gestures.ts` counted the ⋯ trigger tap plus the
  menu-item tap as a double-tap and locked before the delete confirmation appeared —
  at Playwright speed every time, and for a quick human too.
  - **Marker:** every control that opens a sheet, menu, confirm step, dialog or
    lightbox carries `data-srv-gesture-boundary`.
  - **Rule ("may close a run, never open one"):** a pointerdown on a boundary target
    is counted normally first — so it can still complete a double-tap that started
    elsewhere and lock. If it did not lock, the run is cleared immediately afterwards,
    so the next tap always starts a fresh count.
  - **Consequences (each is a test):**
    - ⋯ → "Delete for everyone" → "Delete" never locks, at any speed.
    - A double-tap on a bubble or the thread still locks.
    - A tap elsewhere followed by the ⋯ within 400 ms still locks.
    - Mashing the ⋯ three or more times still locks (taps 2 and 3 pair).
    - An exact double-tap that *starts* on a boundary control does not lock. This is
      the single, deliberate narrowing of R3.
  - **Primary button only:** a pointerdown with `button !== 0` (a mouse right-click or
    middle-click) never counts. The right-click is how the desktop action sheet opens
    (§17.4), so counting it would pair with the menu pick. Touch and pen report
    `button === 0` and are unaffected.
  - **Not a test-cadence problem** (v1.5.1, answering whether e2e waits could replace
    this). `decisions/00148` covers taps on *unrelated* controls (name-prompt Continue,
    then Send) that only a test is fast enough to pair; spacing those in specs is
    correct and stays. A menu flow is different: the next surface appears under the
    finger, and a practised person opens a menu and taps an item in roughly 300–400 ms.
    On desktop the right-click that opens the menu is itself a counted pointerdown
    today, so the pick can pair with it. Both happen to real users at human speed.
    Waits in `server-chat.spec.ts` would hide the defect, not fix it, so **the
    open → pick → confirm e2e runs at full Playwright speed with no added waits**.
    That test is the regression proof that the boundary works.
  - **How to classify any tap pair (v1.5.2 — use this instead of asking case by case):**
    ask *did the first tap make the second control appear under the finger?*
    - **Yes (a causal chain):** the second tap follows by reaction time alone, so a
      real person can land it inside 400 ms. That is a product hazard. Mark the
      *first* control as a boundary, and test the chain at full speed with no waits.
      Examples: ⋯ → menu item, "Delete for everyone" → confirm, ⚙ → settings row,
      thumbnail → lightbox close.
    - **No (two independent decisions):** both controls were already on screen, and
      the second tap is a new intention plus finger travel, so it is well over 400 ms
      for a person. That is test cadence, per `decisions/00148`: specs space those taps
      by `MULTI_TAP_INTERVAL_MS + 100`, and no boundary is added. Examples: Continue →
      Send, **Send → 📎/🎤** (ruled 2026-09-24 on P6b's question), 📎 → Send.
    - **Toggles in place are never boundaries.** When the same spot changes state (🎤
      record → stop, ▶ play → pause), a double-tap there is an accidental double tap.
      Locking and discarding is the safe outcome: R6 discards the recording, so nothing
      is sent. As a boundary, 🎤 would instead record and send a fraction-of-a-second
      blip.
    - **📎 is not a boundary.** It opens the *native* file picker; taps inside that
      picker are not page pointerdowns, and the `filePicker` suspension (R7) covers
      the round trip.
    - **Choice surfaces only:** a boundary is a control that opens an in-page surface
      of *choices* (menu, sheet, confirm step, dialog, lightbox).
  - **Where:** `admin-ui/src/server/gestures.ts` (`createMultiTapDetector`), gaining
    a `GESTURE_BOUNDARY_SELECTOR` beside `EXCLUDED_SELECTOR`. This is a DOM convention,
    not a change to any frozen §6 TS interface.
  - **Controls to mark:** the ones already on the branch — the settings ⚙
    (`thread.ts`, `wx-srv-settings-button`) and the photo thumbnail that opens the
    lightbox (`mediaRender.ts`) — plus every P8 control: the message ⋯ trigger, the
    sheet's "Delete for everyone", and the settings "Delete all messages" row.
    Final-action buttons (Send, the confirm "Delete", "Delete everything", Close)
    are **not** boundaries: they open nothing, and a double-tap on them should still
    lock, per R3's fail-closed choice.

**R4 — The PIN is verified by cmd's PIN service; wixy holds no PIN state (operator override).**
- `POST /unlock` runs after the CF Access middleware. It forwards the submitted PIN,
  together with the app key and the CF email as `subject`, to cmd's loopback PIN-verify
  endpoint through a new single-purpose client, `livechat/pinclient.py` (§5.1).
- cmd owns the registered PIN, the comparison, and the failed-attempt lockout. wixy keeps
  **no** PIN value, hash, or attempt counter. It only maps cmd's answer to 200/401/429/503.
- On success, wixy mints an HMAC unlock token held **only in JS memory**. Never persist it to
  localStorage, sessionStorage, cookies or URLs. The token secret is session state, not
  PIN state.
- Every other server-chat route requires the token as the `X-Wixy-Server-Token` header.
- `<img>`, `<video>` and `<audio>` use per-attachment HMAC-signed URLs (§5.6), because media
  elements can't send headers.
- **Unknown app key or cmd unreachable** → 503 (`not_configured` / `pin_service_unavailable`).
  The feature is closed, never open. The lock screen says "Server settings unavailable".
- **Trust model:** identical to wixy's existing cmd calls (Inv 13, `cmdchat.py`) —
  unauthenticated loopback, same box. The base URL is a hardcoded module constant
  `http://127.0.0.1:9320`, overridable only through the client constructor (tests/E2E).
  No new wixy↔cmd auth.
- **Standalone edition** (her droplet, no cmd): there's no PIN verifier, so `/unlock` → 503
  `not_configured`. The client is injected behind a `PinVerifier` protocol, like
  `AIBackend`, so a standalone verifier can plug in later. Flagged (§15).

**R5 — Transport = SSE over `fetch()`**, not `EventSource` and not WebSocket.
- A `fetch` streaming reader can send the header token, and SSE through cloudflared + CF
  Access is already proven by the AI chat.
- Sends are plain POSTs.
- Server fan-out uses an in-process notifier **plus** a 2 s DB re-check, so a blue/green
  slot-swap overlap (two processes, one SQLite file) can never strand a message.

**R6 — Lock is fail-closed and client-authoritative for display.** Lock triggers:
- 10 s with no user input (unless suspended, R7)
- the panic button
- a multi-tap in chat
- the `Escape` key
- the tab becoming hidden (unless the file picker or mic-permission prompt is open)
- routing away from `/admin/server`
- a page reload (unlock state is never persisted)
- any 401 or `locked` event from the API
- reaching the token's `expiresAt`

Locking **detaches the chat subtree from the document** (keeps the JS object; nothing
readable remains in the DOM), aborts the stream, pauses all media, exits fullscreen,
discards any in-progress recording, and closes the lightbox and sheets. The draft text and
in-flight uploads survive in memory and resume on unlock. **Nothing new starts while locked.**

**R7 — Activity and suspension.**
- Activity = `pointerdown`, `pointermove`, `touchstart`, `touchmove`, `wheel`, `keydown`,
  `input`. **Not** `scroll`: programmatic scroll-to-bottom on an incoming message must never
  keep the chat visible. Incoming messages are not activity.
- Suspensions pause the idle timer and restart it with a fresh 10 s when the last one ends:
  `recording`, `micPermission` (a pending `getUserMedia`), `filePicker` (from the 📎 click
  until `change`/`cancel`, with a 5-minute safety cap) and `mediaPlaying`.
- While fading (800 ms), any activity cancels the fade.

**R8 — Identity.**
- Display name: set on first unlock per device, stored in `localStorage["wx-srv-name"]`,
  1–32 chars, changeable in settings.
- `deviceId`: `crypto.randomUUID()` in `localStorage["wx-srv-device"]`.
- "Mine" = sender name equal case-insensitively, so one person's phone and desktop both
  count as theirs.
- The server stores the CF email per message for audit only and never returns it.

**R9 — Message model.** Optional text (≤4000 chars) plus 0–10 attachments (photo/video/voice)
per message, like the AI composer's staged chips.
- A voice note sends immediately when recording stops, as its own message.
- No editing, deleting, typing indicators, read receipts or unread badges in v1 (§16).

**R10 — Media storage = one normalized rendition per attachment** (plus thumb/poster).
- Metadata is stripped: EXIF/GPS and container metadata.
- Uploaded originals are deleted after successful processing. A failed original is kept 7
  days for diagnosis.
- Rationale: GPS privacy, and D: had only **58.8 GB free** (measured 2026-09-14).
- Quota: `WIXY_SERVER_MEDIA_QUOTA_MB` (default 20480) plus a free-space floor
  `WIXY_SERVER_MIN_FREE_MB` (default 10240). Both are enforced at upload init → 507.

**R11 — Uploads are chunked** (8 MiB chunks, one code path for every kind). Cloudflare
caps a proxied request body at 100 MB, which would otherwise make any video over ~40 s fail
with an opaque 413. Caps:

| Kind | Max size | Max duration |
|---|---|---|
| Photo | 30 MiB | — |
| Voice | 25 MiB | 15 min (client auto-stops at 15:00) |
| Video | 1 GiB | 10 min |

**R12 — Push = standard Web Push, payloadless, VAPID (ES256).**
- The notification text is fixed and generic: title "Server", body "New activity". It never
  includes message text, the sender, or a count.
- Offered **only** on Android (`userAgentData.platform === "Android"` or `/Android/i`
  UA) with PushManager, serviceWorker and Notification support.
- Explicit opt-in toggle in the chat settings sheet.
- The service worker has **no fetch handler**.

**R13 — No trace outside the unlocked view.** The decoy shows only real server data. There's
no unread badge, title change or favicon change. Pushes are generic. Chat data never enters
the site repo, builds, publish, reports, backups, or any public route.

**R14 — Release-note trailer for every commit of this feature**:
`Release-note: Added a Server page showing your website's server status.`
It's true and innocuous; the owner-facing update popup must not reveal the chat.

**R15 — Backups.** The chat store is **not** added to `backup/snapshot.py`'s allowlist. The
standalone snapshot force-pushes to a GitHub repo, which is an inappropriate home for private
media, and the hub mirror isn't installed. Flagged to the operator (§15).

---

## 2. Threat model (for the audit)

- **Adversary:** a bystander who glances at, or briefly picks up, an unlocked admin device.
  Secondary: an admin-session holder without the PIN poking at the API or devtools.
- **Not in scope:** anyone who already has both CF Access and the PIN. Code secrecy is also
  out of scope, since the repo is public; the disguise only works against bystanders.
- **Real gates:** CF Access (Inv 12, unchanged) → cmd PIN service with cmd-side lockout
  (reachable only on loopback, so only after CF Access) → HMAC token bound to the CF email →
  signed media URLs bound to the email and token expiry.
- **PIN never leaves the path browser → wixy → cmd:**
  - never logged or echoed back
  - never stored by wixy
  - the request body is not retried on an ambiguous failure (a double-sent attempt would
    double-count toward the lockout)
- **Hardening that must be tested:**
  - CSRF: mutations need the custom header, which forces a CORS preflight that the origin
    never grants.
  - Path traversal: IDs are validated as 32 hex characters and renditions come from an enum.
  - ffmpeg SSRF/LFI (HLS/concat playlists): magic-byte sniff → explicit `-f <demuxer>` +
    `-protocol_whitelist file` + demuxer allowlist.
  - Decompression bombs: a pixel cap.
  - Push SSRF: endpoint host allowlist, https only.
  - XSS: `textContent` only; links are http(s)-only with `rel="noopener noreferrer"`.
  - `nosniff` on every media response.
  - Tokens never appear in URLs or logs. Media URLs carry only per-file signatures.

---

## 3. Architecture

```
admin-ui  /admin/server  ── server/panel.ts (lock state machine, decoy, PIN pad)
                               └─ server/chatView.ts (thread + composer), attached only when unlocked
   │ fetch + X-Wixy-Server-Token          │ fetch-SSE /stream?after=cursor
   ▼                                       ▼
wixy_server/routes_livechat*.py  (behind CF Access middleware, + require_server_token dep)
   ├─ livechat/pinclient.py  PinVerifier protocol + CmdPinVerifier → cmd :9320 PIN service (no local PIN state)
   ├─ livechat/tokens.py   secret.key, unlock tokens, signed media URLs
   ├─ livechat/store.py    SQLite (WAL) — messages, events, attachments, uploads, push_subscriptions
   ├─ livechat/notifier.py in-process broadcast (anyio.Event swap)
   ├─ livechat/uploads.py  chunk staging/assembly, quota + free-space guard
   ├─ livechat/processing.py  Pillow(+pillow-heif) / ffprobe / ffmpeg — pure functions
   ├─ livechat/media_queue.py lease-based worker in the app task group (crash-resume)
   ├─ livechat/janitor.py  hourly cleanup
   └─ livechat/push.py     VAPID keys, payloadless sender, dispatch hook
Storage/projects/<slug>/server/   (private; see §4)
```

The SSE loop (per connection):
1. `rows = store.events_after(cursor)` in a thread.
2. Emit each event with the **current** full message JSON, coalescing per message.
3. If there are none, wait on the notifier with a 2 s timeout.
4. Send a `: ping` comment every 15 s.
5. Check token expiry each iteration: once expired, send `event: locked` and close.
6. Exit when the client disconnects.

Response headers: `Cache-Control: no-cache`, `X-Accel-Buffering: no`.

---

## 4. Storage layout and schema

```
Storage/projects/<slug>/server/
  server.db (+ -wal, -shm)       SQLite, WAL, busy_timeout=5000, foreign_keys=ON, synchronous=NORMAL
  secret.key                     32 random bytes, created O_EXCL (race-safe across slot processes)
  vapid.json                     {"privateKeyPkcs8B64": ..., "publicKeyB64url": ...}, created O_EXCL
  media/<id[:2]>/<id>/           full.{jpg|png|gif} thumb.jpg | play.mp4 poster.jpg | play.m4a
  uploads/<uploadId>/            chunk-000000 ... ; assembled
  failed/<id>/original.<ext>     kept 7 days on processing failure
```

`ProjectPaths` gets `server_dir`, `server_db`, `server_secret`, `server_vapid`, `server_media`,
`server_uploads` and `server_failed` (P1 adds them all up front). The dirs are created lazily,
following the `reports_dir` precedent.

**Migrations:** `PRAGMA user_version` plus an ordered migration list. v1:

```sql
CREATE TABLE messages(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  sender TEXT NOT NULL, device_id TEXT NOT NULL, by_email TEXT,
  text TEXT, created_at REAL NOT NULL);                       -- epoch seconds (never a formatted string)
CREATE TABLE attachments(
  id TEXT PRIMARY KEY,                                        -- uuid4().hex
  kind TEXT NOT NULL CHECK(kind IN ('photo','video','voice')),
  status TEXT NOT NULL CHECK(status IN ('processing','ready','failed')),
  message_seq INTEGER REFERENCES messages(seq), ordinal INTEGER,
  mime TEXT, width INTEGER, height INTEGER, duration_s REAL, peaks TEXT, -- JSON array or NULL
  renditions TEXT NOT NULL DEFAULT '[]',                      -- JSON array of rendition names present
  bytes_on_disk INTEGER NOT NULL DEFAULT 0, failure TEXT,
  lease_owner TEXT, lease_expires_at REAL,
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE events(
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('message','message_updated')),
  message_seq INTEGER NOT NULL, created_at REAL NOT NULL);
CREATE TABLE uploads(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, mime TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  filename TEXT, by_email TEXT, created_at REAL NOT NULL);
CREATE TABLE push_subscriptions(
  device_id TEXT PRIMARY KEY, sender TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at REAL NOT NULL,
  last_ok_at REAL, consecutive_failures INTEGER NOT NULL DEFAULT 0);
```

**Store API** (P1 implements all of it; P2 and P3 consume it; frozen signatures. All
methods are sync and callers wrap them in `anyio.to_thread.run_sync`):

```python
class LiveChatStore:
    def __init__(self, db_path: Path) -> None: ...  # opens lazily; migrate() on first use
    # messages / events
    def create_message(
        self,
        *,
        client_id: str,
        sender: str,
        device_id: str,
        by_email: str | None,
        text: str | None,
        attachment_ids: Sequence[str],
        now: float,
    ) -> tuple[MessageRow, bool]:
        ...  # (row, created); idempotent on client_id;
        # validates attachments unreferenced + status in
        # (processing, ready); one 'message' event, same txn

    def list_messages(
        self, *, before: int | None, limit: int
    ) -> tuple[list[MessageRow], bool, int]:
        ...
        # ascending rows, has_more, cursor=max event_seq,
        # all in ONE read txn

    def get_messages(self, seqs: Sequence[int]) -> list[MessageRow]: ...
    def events_after(self, cursor: int, limit: int = 200) -> list[EventRow]: ...
    # attachments (P2)
    def create_attachment(
        self, *, att_id: str, kind: AttachmentKind, now: float
    ) -> AttachmentRow: ...
    def claim_processing(
        self, *, owner: str, now: float, lease_s: float
    ) -> AttachmentRow | None: ...
    def renew_lease(self, *, att_id: str, owner: str, now: float, lease_s: float) -> bool: ...
    def finish_attachment(
        self, *, att_id: str, owner: str, result: AttachmentResult, now: float
    ) -> None:
        ...
        # emits 'message_updated' iff message_seq set

    def get_attachment(self, att_id: str) -> AttachmentRow | None: ...
    def media_bytes_used(self) -> int: ...
    def orphan_attachment_ids(self, *, older_than: float) -> list[str]: ...
    def delete_attachment(self, att_id: str) -> None: ...
    # uploads (P2)
    def create_upload(self, row: UploadRow) -> None: ...
    def get_upload(self, upload_id: str) -> UploadRow | None: ...
    def delete_upload(self, upload_id: str) -> None: ...
    def stale_upload_ids(self, *, older_than: float) -> list[str]: ...
    def pending_upload_bytes(self) -> int: ...
    # push (P3)
    def upsert_push_subscription(self, row: PushSubscriptionRow) -> None: ...
    def delete_push_subscription(self, device_id: str) -> None: ...
    def get_push_subscription(self, device_id: str) -> PushSubscriptionRow | None: ...
    def list_push_subscriptions(self) -> list[PushSubscriptionRow]: ...
    def record_push_result(self, *, device_id: str, ok: bool, now: float) -> None: ...
```

Row types (`livechat/models.py`) are frozen slotted dataclasses: `MessageRow` (with
`attachments: tuple[AttachmentRow, ...]` in ordinal order), `AttachmentRow`, `EventRow`,
`UploadRow`, `PushSubscriptionRow`, and `AttachmentResult` (status, mime, width, height,
duration_s, peaks, renditions, bytes_on_disk, failure). The wire serializers
`message_json(row, signer)` and `attachment_json(row, signer)` also live in `models.py`.

**App state (P1 creates):**
- `app.state.livechat_store`
- `app.state.livechat_notifier`
- `app.state.livechat_message_hooks: list[Callable[[MessageRow], Awaitable[None]]]` — run on
  the background task group after a *created* message commits; P3 appends the push dispatch.
- `app.state.livechat_media_available: bool` — set by P2 at startup.

---

## 5. HTTP contracts (FROZEN)

All routes live under `/api/admin/server`, behind the existing CF Access middleware (Inv 12).
**Auth:**
- Every route except `POST /unlock` and `GET /media/*` requires the header
  `X-Wixy-Server-Token`. A token passed as a query parameter is rejected.
- A missing, invalid or expired token → 401 `{"error":"locked"}`. The client locks on any 401.

The FastAPI dependency `require_server_token(request) -> ServerAuth(email: str, exp: int)`
lives in P1's `livechat/tokens.py`. In dev-no-auth mode the email is `""`.

### 5.1 Unlock

`POST /unlock` with body `{"pin": "<digits>"}` (the wixy side of the contract is frozen):
- 200 `{"token": str, "expiresAt": float}`. The TTL is 12 h absolute.
- 401 `{"error":"wrong_pin","attemptsLeft":int|null}` (`null` when cmd doesn't report it).
- 429 `{"error":"locked_out","retryAfterS":int}` plus a `Retry-After` header.
  **The lockout policy is cmd's.**
- 409 `{"error":"pin_changed"}` (v1.4) — the PIN rotated mid-check. Nothing was spent; the
  owner just tries again.
- 503 `{"error":"not_configured"}` when the app key is unknown to cmd, or there's no
  verifier (standalone edition).
- 503 `{"error":"pin_service_unavailable"}` when cmd is unreachable, times out, or faults.
- 422 when the body is malformed. wixy validates **4–16 digits locally and does not call cmd
  below that**, because cmd charges an attempt before checking and a stray keypress must
  never burn one.

**v1.4 — the real cmd contract** (cmd workspace #875, PR #3068; supersedes the earlier
strawman. Frozen from cmd's side pending only a possible security-review diff. Not merged,
deployed or registered yet — delivery blocker #9 stays open.)

```
POST http://127.0.0.1:9320/api/pins/<app_key>/verify     # plural, app key in the PATH
Content-Type: application/json                            # REQUIRED (CSRF guard), else 415
body: {"pin": "<4-16 digits>", "subject": "<CF email or omitted>"}
```

Loopback only, no auth on the hop — exactly like wixy's existing 9320/9321 calls (Inv 13).
cmd refuses a request that arrived through Cloudflare with 403 `same_box_only`.

**Mapping cmd → wixy** (every cmd response carries `Cache-Control: no-store`):

| cmd | body | wixy `/unlock` |
|---|---|---|
| 200 | `{"ok":true,"app_key":…}` | 200 + token |
| 401 | `wrong_pin` + `attempts_left`, `locked`, `lock_scope`, `retry_after_seconds` | 401 with `attemptsLeft`; **if `locked` is true**, 429 with `retryAfterS` instead |
| 429 | `locked` + `lock_scope` + `retry_after_seconds` (PIN not evaluated, nothing spent) | 429 + `Retry-After` |
| 404 | `unknown_app` | 503 `not_configured` |
| 409 | `pin_changed` (not counted) | 409 `pin_changed` |
| 400 | `invalid_app_key` | 503 `not_configured` (misconfiguration) |
| 400 | `invalid_request` | 422 — and log an ERROR: wixy validates first, so this is a wixy bug |
| 403 / 413 / 415 | same-box / too big / content-type | 503 `pin_service_unavailable` + ERROR log (a wixy-side bug or a misrouted deployment) |
| 503 | `unavailable` (nothing spent) | 503 `pin_service_unavailable` |
| connection error | — | 503 `pin_service_unavailable` |

- **`lock_scope`** (`subject` vs `app`) is **not** surfaced to the browser: the copy is the
  same either way, so the screen never teaches a bystander how the lockout works.
- **Retry safety (implement exactly):** cmd charges an attempt **before** checking it, so
  retry **only** on a connection error that provably never reached cmd
  (`httpx.ConnectError`, `httpx.ConnectTimeout`) — at most once. **Never** retry a read
  timeout or any response that didn't arrive. There's no idempotency key by design. A 400,
  403, 404, 409, 413, 415, 429 or 503 spends nothing, so a corrected request is always safe.
- **Timeout:** 5 s.
- **cmd's default ladder for this app** (cmd's to tune, wixy never mirrors it): 5 wrong in a
  row per subject → 60 s, doubling to a 24 h cap; a correct PIN clears that subject; 20 wrong
  across everyone in 15 min trips an app-wide lock. Every lockout raises a warning on cmd's
  `/health`.

**PIN-pad copy** (P4; never reveals the PIN's length, and never says which scope locked):
- 401 → "Wrong PIN — 3 attempts left" (drop the tail when `attemptsLeft` is null)
- 429 → "Too many wrong tries. Try again in 2 minutes."
- 409 → "Please try again."
- 503 → "Server settings unavailable."
- any unexpected status → "Couldn't unlock — try again."

**Settings** (P1): `WIXY_SERVER_PIN_APP_KEY` → `server_pin_app_key`, default
`"wixy-livechat"`. An identifier, not a secret.

**The verifier is injectable:** `create_app(..., pin_verifier: PinVerifier | None = None)`.
- Fleet → `CmdPinVerifier()`.
- Standalone → `None` (503 `not_configured`).
- Tests → a verifier pointed at `fake_cmd.py`, which gains `/api/pin/verify` with a
  settable test PIN, lockout-state endpoints and an app-key registry.

**Mirror contract changes in the fake first** (the ai-chat.md lesson).

**Token format:** `b64url(json{"v":1,"e":email,"iat":int,"exp":int,"n":nonce16}) + "." +
b64url(HMAC-SHA256(secret, b"unlock|" + payload_b64))`.

**Verify:** use `hmac.compare_digest`, require `exp > now`, and require `e == request email`.

### 5.2 History

`GET /messages?before=<seq>&limit=<1..100, default 50>` → 200
`{"messages":[Message], "hasMore":bool, "cursor":int}`. Messages are ascending by `seq`.
`cursor` is the event high-water mark from the same read transaction, and the client opens
the stream with `after=cursor`.

### 5.3 Send

`POST /messages` with body
`{"clientId":str(8..64), "sender":str(1..32, trimmed, no control chars), "deviceId":str(8..64),
"text":str|null(≤4000), "attachmentIds":[hex32](0..10)}`:
- 201 `{"message":Message}`, or 200 with the same message when a `clientId` is replayed.
- 422 `{"error":"invalid","detail":str}` for: empty text with no attachments, an
  unknown/used/failed attachment, too long, or a bad sender.

### 5.4 Stream

`GET /stream?after=<cursor>` → `text/event-stream`. Events:
- `id:<event_seq>` + `event: message` + `data:<Message JSON>` — a new message.
- `event: message_updated` + `data:<Message JSON>` — an attachment's status changed.
- `event: locked` + `data:{}` — the token expired mid-stream; the server closes after it.
- `: ping` comment every 15 s.

The client re-opens with `after=<last id>`, backing off 1→2→5→10 s, and reconnects if it
receives no bytes for 45 s.

### 5.5 Uploads

`POST /uploads` with body `{"kind":"photo"|"video"|"voice", "mimeType":str, "sizeBytes":int,
"filename":str|null}`:
- 201 `{"uploadId":hex32, "chunkBytes":int, "maxBytes":int}`. `chunkBytes` comes from settings
  (default 8 MiB).
- 413 `{"error":"too_large","maxBytes":int}`
- 415 `{"error":"unsupported_type"}`
- 507 `{"error":"storage_full"}` when `media_bytes_used + pending_upload_bytes + size >
  quota` or `disk_free - size < min_free`.
- 503 `{"error":"media_unavailable"}` when ffmpeg, ffprobe or pillow-heif is unavailable.

Declared-MIME allowlists (advisory; processing sniffs the real bytes):
- **photo:** jpeg, png, webp, gif, heic, heif
- **video:** mp4, quicktime, webm, 3gpp, x-matroska
- **voice:** webm, ogg, mp4, mpeg, aac, wav, x-m4a

`PUT /uploads/{uploadId}/chunks/{index}` with a raw `application/octet-stream` body →
204.
- The server reads `request.stream()` with a hard running cap of `chunkBytes` and returns 413
  once exceeded.
- `index` must be in `0..ceil(size/chunkBytes)-1`, otherwise 422.
- Re-PUTting the same index overwrites it, so the call is idempotent. Writes go to `.part`
  and are then renamed.
- Unknown upload → 404.

`POST /uploads/{uploadId}/complete`:
- 202 `{"attachment":Attachment}` (status `processing`).
- 409 `{"error":"incomplete","missing":[int]}`.
- 422 `{"error":"size_mismatch"}` when the assembled size differs from the declared size.

`DELETE /uploads/{uploadId}` → 204.

### 5.6 Media

`GET /media/{attId}/{rendition}?exp=<int>&sig=<b64url>`:
- `rendition` ∈ `full | thumb | poster | play`.
- `sig = b64url(HMAC(secret, f"media|{attId}|{rendition}|{exp}|{email}"))`, and `exp` = the
  requesting token's `exp`. The server mints these inside every Message JSON.
- 200/206 via Starlette `FileResponse`, which handles Range.
- Headers: `Cache-Control: private, no-cache`, `X-Content-Type-Options: nosniff`,
  `Content-Disposition: inline`.
- 403 for a bad or expired signature or an email mismatch. 404 when missing.

### 5.7 Usage

`GET /usage` → `{"usedBytes":int, "quotaBytes":int, "freeBytes":int, "mediaAvailable":bool}`.

### 5.8 Push

- `GET /push/config` → `{"publicKey": b64url uncompressed P-256}`
- `GET /push/subscriptions/{deviceId}` → `{"subscribed":bool}`
- `PUT /push/subscriptions/{deviceId}` with body `{"sender":str, "subscription":{"endpoint":https-url,
  "keys":{"p256dh":str,"auth":str}}}` → 204, or 422 when the endpoint host isn't on the
  allowlist (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`)
  or isn't https.
- `DELETE /push/subscriptions/{deviceId}` → 204.
- **Outside the prefix:** `GET /admin/server-sw.js` (still CF-gated) → the built SW, sent
  with `Content-Type: text/javascript`, `Cache-Control: no-cache` and
  `Service-Worker-Allowed: /admin/`. The route is registered before the `/admin/{rest:path}`
  catch-all.

### 5.9 Wire shapes

```ts
Message    = { seq:number; clientId:string; sender:string; text:string|null;
               attachments:Attachment[]; createdAt:number /* epoch s */ }
Attachment = { id:string; kind:"photo"|"video"|"voice"; status:"processing"|"ready"|"failed";
               width:number|null; height:number|null; durationS:number|null; peaks:number[]|null;
               urls:{ full?:string; thumb?:string; poster?:string; play?:string } }  // ready renditions only
```

### 5.10 System status (decoy data)

P1 adds a `server` field to the existing `GET /api/admin/system/status`:
`{"startedAt": epoch_s, "mediaProcessing": "ok"|"unavailable"}`. `startedAt` is recorded in
`create_app`.

---

## 6. Frontend: state machine and interfaces

`server/lockModel.ts` is a **pure reducer**, `(state, event, now) → {state, effects[]}`,
with 100% branch coverage in vitest. States:

```
decoy ──tap(panel)──▶ revealed ──tapAffordance(≥400ms after reveal)──▶ pin ──submit──▶ verifying ──ok──▶ chat
  ▲                    │ idle 10s                  │ cancel/Esc/idle 10s   │wrong→pin(error)
  │◀───────────────────┘◀──────────────────────────┘                       │lockedOut→pin(countdown)
  │◀── fading(800ms) ◀── idle 10s (no suspension) ── chat
  │◀── instant: panic | multiTap(chat) | Escape | hidden(no picker/mic) | routeAway | 401/locked | token expiresAt
```

- The first unlock without a display name shows a name sub-step inside `chat`; idle applies
  there too.
- Constants live in `server/constants.ts`:
  - `IDLE_LOCK_MS = 10_000`
  - `FADE_MS = 800`
  - `MULTI_TAP_INTERVAL_MS = 400`
  - `MULTI_TAP_COUNT = 2`
  - `PICKER_SUSPEND_MAX_MS = 300_000`

**Interfaces** (frozen, so P4, P5, P6 and P3 can build concurrently):

```ts
// server/types.ts (P4 owns)
export interface ServerSession { readonly token: string; readonly expiresAt: number }
export type SuspendReason = "recording" | "micPermission" | "filePicker" | "mediaPlaying";
export type LockCause = "idle" | "panic" | "multiTap" | "escape" | "hidden" | "routeAway" | "unauthorized" | "expired";
export interface LockHooks {
  suspend(reason: SuspendReason): () => void;   // returns release; idempotent
  lockNow(cause: LockCause): void;
}
export interface ServerChatView {               // P5 implements
  readonly element: HTMLElement;
  attach(session: ServerSession): void;         // panel inserts element, then calls attach → load/resume stream
  detach(): void;                               // panel calls BEFORE removing element: abort stream, pause media,
                                                // exit fullscreen, discard recording, close sheets/lightbox
  dispose(): void;                              // panel teardown: also abort in-flight uploads
}
export type CreateServerChatView = (deps: { api: ServerApi; hooks: LockHooks; win: Window;
                                            session: () => ServerSession | null }) => ServerChatView;
```

`server/api/http.ts` (P4): `serverFetch(path, init, session)` adds the header and maps 401 to
a `ServerLockedError`, which the panel turns into `lockNow("unauthorized")`. Each parcel adds
its own `server/api/<area>.ts` (`unlock`, `messages`, `uploads`, `push`) so the files never
conflict. In-flight uploads and sends capture the session at start and run to completion
after a lock.

**Decoy** (`server/decoy.ts`, P4):
- Paints instantly with skeleton rows, then fills from `/api/admin/system/status` and
  `/api/version`.
- Rows: Status (Online/Unreachable), Uptime, Engine (vN · sha7), Edition, Disk free, Last
  publish, Backups, Media processing.
- Real data only.

**PIN pad** (`server/pinPad.ts`, P4):
- A custom on-screen keypad (0–9, ⌫, ✓) plus physical digits, Backspace, Enter and Escape.
- No `<input type=password>` (avoids password-manager prompts) and no autocomplete.
- Masked dots.
- Errors: "Incorrect PIN"; "Too many attempts — try again in Ns" with a countdown;
  "Server settings unavailable" for 503.

---

## 7. Media processing (P2) — `livechat/processing.py`, pure, typed

**Sniff first** from magic bytes:

| Container | Magic |
|---|---|
| ISO-BMFF | `ftyp`@4 |
| EBML | `1A45DFA3` |
| Ogg | `OggS` |
| WAV | `RIFF…WAVE` |
| MP3 | ID3 / `FFEx` |
| ADTS | `FFF1` / `FFF9` |
| JPEG / PNG / GIF / WEBP / HEIF | their own magics |

Then:
- Map to a demuxer allowlist → pass `-f <demuxer> -protocol_whitelist file` to **every**
  ffprobe/ffmpeg call.
- Anything else → `failed: unsupported`.
- The kind must match the content: a photo must decode as an image, a video must have a video
  stream, a voice note must have an audio stream and no video.

Subprocesses:
- Windows: `creationflags = BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW`. POSIX: a `nice -n 10`
  prefix.
- Hard timeouts: 30 min for video, 5 min for others. Kill on timeout.
- Outputs are written to temp names, then renamed atomically.

**Photo** (Pillow, with pillow-heif registered):
- Pixel cap 80 MP.
- `exif_transpose`, then drop all metadata.
- PNG → `full.png` (optimize). Animated GIF → keep the bytes as `full.gif`. Everything else
  (including webp/heic) → `full.jpg` q88.
- Long edge ≤ 4096. `thumb.jpg` at a 480 px long edge, q80.

**Voice:**
- `play.m4a`: AAC-LC, mono, 64 kb/s, `+faststart`, `-map_metadata -1`.
- `durationS` from ffprobe of the **output**. MediaRecorder webm has no duration.
- `peaks`: decode to s16le mono 8 kHz, compute 64 RMS buckets, normalize to 0..1, 3 dp.

**Video:**
- **Remux** (`-c copy -movflags +faststart -map_metadata -1 -map 0:v:0 -map 0:a:0?`) when
  the video is h264 8-bit yuv420p, its long edge is ≤1920, fps ≤60, and the audio is aac or
  absent.
- **Otherwise transcode:** libx264 veryfast crf 23, long edge ≤1920, yuv420p, aac 128k,
  `+faststart`, `-threads 2`.
- HEVC is transcoded, since it isn't universally playable in browsers.
- Rotation must survive: remux keeps the display-matrix side data, and transcode autorotates.
  Test with a rotated sample.
- `poster.jpg`: `-ss min(1, dur/2)`, long edge ≤ 960.
- Duration cap: 600 s.

**Queue** (`media_queue.py`):
- Runs in the app task group.
- Two limiters: photo/voice CapacityLimiter(2), video CapacityLimiter(1).
- Claim with a DB lease (`owner = f"{pid}-{uuid}"`, lease 120 s, renewed every 30 s), so a
  slot-swap overlap never double-processes.
- At startup it re-queues expired leases (crash-resume).
- Calls `notifier.publish()` after `finish_attachment`.

**Janitor**, hourly:
- uploads older than 24 h
- unreferenced attachments older than 24 h
- `failed/` entries older than 7 days

**Dependencies:**
- `pillow-heif` joins the `server` extra and gets a `requirements.txt` pin. A cp314
  win_amd64 wheel was verified to exist (1.7.0).
- ffmpeg/ffprobe resolve from `WIXY_FFMPEG`/`WIXY_FFPROBE`, falling back to `shutil.which`.
  Missing → ERROR log, `media_available = False`, uploads 503, text chat keeps working.
- Hub has ffmpeg 8.1.2 (gyan full build, libx264 + aac) at the user's WinGet Links. The
  Dockerfile already installs ffmpeg.

---

## 8. Push (P3)

**Keys:** `livechat/push.py` generates the VAPID keys (cryptography EC P-256, persisted
O_EXCL in `vapid.json`).

**Request:** payloadless POST to the endpoint with:
- `Authorization: vapid t=<ES256 JWT {aud: endpoint origin, exp: now+12h, sub: "https://<project.domain>"}>, k=<pub>`
- `TTL: 86400`
- `Urgency: high`
- `Topic: wixy-server` (the push service collapses pending pushes)
- `Content-Length: 0`

PyJWT with cryptography does ES256.

**Dispatch** (registered in `livechat_message_hooks`):
- Every subscription except same `device_id` or same sender (casefold).
- httpx AsyncClient, 10 s timeout, concurrency 4.
- 201 → `record ok`. 404/410 → delete the subscription. Others → record a failure and
  delete after 10 consecutive failures.

**SW** (`admin-ui/src/sw/serverSw.ts` → esbuild 3rd build → `wixy_server/static/admin/server-sw.js`,
committed and drift-checked; its own `tsconfig.sw.json` with the WebWorker lib, and the
`typecheck` script runs both):
- `push` → if some window client is visible + focused with a path starting `/admin/server`,
  do nothing. Otherwise `showNotification("Server", {body:"New activity", tag:"wixy-server",
  renotify:true})`.
- `notificationclick` → close. Focus an `/admin` client and navigate it to `/admin/server`,
  else `openWindow("/admin/server")`.
- **No `fetch` listener** (asserted by a test).

**UI** (`server/pushToggle.ts`): `mountPushToggle(host, deps) → {teardown}`.
- Rendered by P5's settings sheet only when `isAndroidPushCapable()`.
- States: off / on / blocked (explained in plain words) / error.
- Enable (inside the click gesture): `Notification.requestPermission()` →
  `register('/admin/server-sw.js', {scope:'/admin/'})` → `ready` →
  `subscribe({userVisibleOnly:true, applicationServerKey})` → PUT.
- Disable: unsubscribe → DELETE → unregister the SW.

---

## 9. New invariants (P7 folds these into `docs/ai/invariants.md`; each parcel adds the tests)

- **Inv 40 — Server-chat data is private.**
  - It lives only in `Storage/projects/<slug>/server/`.
  - It never enters the site repo, builds, publish, `reports.py` bundles, the backup
    snapshot allowlist, or any public route.
  - It's served only by `/api/admin/server/*` with an unlock token or a signed media URL.
  - Tests: the backup allowlist excludes it; the public catch-all can't reach it; the report
    bundle lacks it.
- **Inv 41 — wixy holds zero PIN state.**
  - The PIN is verified only by cmd's app-key-scoped PIN service over loopback (same trust
    model as Inv 13). cmd owns registration and lockout.
  - wixy never stores, logs, echoes or commits a PIN value (the repo is public).
  - A verifier that's unreachable or missing → 503, never an open gate.
  - The unlock token lives only in JS memory.
  - Mutations need the header token. Media uses email+expiry-bound signed URLs. A token in a
    query string is rejected.
- **Inv 42 — Lock is fail-closed.** Every R6 trigger → locked. Locking removes the chat
  subtree from the document, aborts the stream, pauses media and discards recording. The
  decoy shows only real server data. No badge, title, favicon or push text ever reveals chat
  activity.
- **Inv 43 — Idle "activity" is user input only.** `scroll` events and incoming messages
  never count, so a programmatic scroll can't keep the chat visible.
- **Inv 44 — Stored media.**
  - One normalized, metadata-stripped rendition per attachment. Originals are deleted after
    success.
  - Every ffmpeg/ffprobe call uses a sniffed explicit demuxer + `-protocol_whitelist file`.
  - Quota and free-space floor are enforced at upload init.
- **Inv 45 — The server-chat service worker has no fetch handler.** It's registered only on
  explicit opt-in on Android. Push is payloadless with fixed generic text.
- **Inv 12 amendment:** add a sentence saying the server-chat PIN token is an additional
  in-app gate layered on top of CF Access, never a replacement.

---

## 10. Parcels (Builder-sized; most run concurrently)

Waves:
- **Wave 1** (all start now): P1, P2a, P3a, P4, P5a, P6a.
- **Wave 2** (after P1 lands on the feature branch): P2b, P3b, P5b.
- **Wave 3:** P6b.
- **Close-out:** P7 plus DM integration.

### P1 — Backend core (Builder A) · everything else depends on it, so land it first

- **Settings** (`settings.py`) — add all of these up front:

  | Env var | Setting | Default | Validation |
  |---|---|---|---|
  | `WIXY_SERVER_PIN_APP_KEY` | `server_pin_app_key` | `"wixy-livechat"` | non-empty (**no PIN setting exists**) |
  | `WIXY_SERVER_MEDIA_QUOTA_MB` | `server_media_quota_bytes` | 20480 MB | — |
  | `WIXY_SERVER_MIN_FREE_MB` | `server_min_free_bytes` | 10240 MB | — |
  | `WIXY_SERVER_UPLOAD_CHUNK_BYTES` | `server_upload_chunk_bytes` | 8 MiB | clamp 64 KiB–16 MiB |
  | `WIXY_FFMPEG` | `ffmpeg_path` | `""` | — |
  | `WIXY_FFPROBE` | `ffprobe_path` | `""` | — |

- **Storage:** add all the `ProjectPaths` properties (§4).
- **New modules:** `livechat/{__init__,models,store,tokens,pinclient,notifier}.py`.
- **Fake cmd:** `wixy_server/tests/fake_cmd.py` gains the `/api/pin/verify` double (§5.1).
- **Routes:** `routes_livechat.py` — unlock, messages GET/POST, stream, usage.
- **System status:** the `server` field (§5.10).
- **app.py wiring:** store, notifier, hooks list, `startedAt`.
- **Tests:**
  - migrations; idempotent create; paging; cursor atomicity
  - token tamper, expiry and email binding (use the `test_auth_gate_integration` JWT pattern
    for a real email)
  - the full §5.1 v1.4 mapping table, one case each: 200; 401 with `attempts_left`; 401 with
    `locked: true` → **429**; 429; 404 → 503 `not_configured`; 409 → 409; 400
    `invalid_app_key` → 503; 400 `invalid_request` → 422 + ERROR log; 403/413/415 → 503;
    503 → 503
  - a PIN shorter than 4 digits is rejected locally and **cmd is never called** (assert no
    request reached the fake)
  - the outgoing request shape: path `/api/pins/<app_key>/verify`, JSON content-type,
    `subject` carries the CF email
  - one retry on ConnectError/ConnectTimeout; **no** retry on a read timeout (assert the
    fake saw exactly one request)
  - a grep-style test that the PIN never reaches a log record or a response body
  - `Settings` has no PIN field
  - every route 401 without a token; a query token is rejected
  - SSE: after-cursor, coalescing, `locked` on expiry, ping, a cross-"process" write picked up
    by the 2 s re-check (write via a second store instance)
- **Docs:** create `docs/ai/livechat.md` (overview, auth, store, routes); add the §5 routes to
  `contracts.md`; add the modules to `architecture.md`.

### P2a — Media processing, pure (Builder B, wave 1)

- `livechat/processing.py`, as specified in §7.
- `pillow-heif` dependency.
- CI: `sudo apt-get update && sudo apt-get install -y ffmpeg` in ci.yml's `pytest` and `e2e`
  jobs.
- Tests run **real ffmpeg** on generated samples (`testsrc`/`sine` via ffmpeg in a fixture;
  **never skip if ffmpeg is missing — fail loudly**):
  - EXIF GPS stripped + orientation applied; HEIC decodes; animated GIF kept
  - the remux-vs-transcode decision table; rotation preserved; container metadata (location)
    stripped
  - voice → m4a with duration and peaks
  - an HLS playlist disguised as `.mp4` is rejected by the sniff and never fetched; a concat
    list is rejected
  - a decompression bomb is rejected; kind/content mismatch is rejected

### P2b — Uploads, queue, janitor, media routes (Builder B, wave 2)

- `livechat/{uploads,media_queue,janitor}.py` plus `routes_livechat_media.py`: §5.5, §5.6
  and the `media_available` detection at startup.
- **Tests:**
  - chunk-cap 413; missing chunks 409; exact size; quota 507 and free-space 507 (injectable
    `disk_usage`)
  - signature tamper / expiry / email-mismatch 403; Range 206; nosniff
  - lease exclusivity across two store instances; crash-resume; janitor ages (injectable clock)
- **Docs:** the media section of `livechat.md`.

### P3a — Push core and SW (Builder C, wave 1)

- `livechat/push.py`: keys, JWT, sender, allowlist.
- `sw/serverSw.ts` + `tsconfig.sw.json` + the 3rd esbuild build + the `/admin/server-sw.js`
  route.
- **Tests:**
  - the VAPID JWT verifies with the public key; exact headers against a fake push endpoint
    (httpx MockTransport)
  - 410 deletes the subscription; the allowlist rejects http and foreign hosts
  - vitest on the SW handlers (focused-client skip, fixed text, `notificationclick`
    navigation, no fetch listener)

### P3b — Push routes, dispatch hook, toggle UI (Builder C, wave 2)

- §5.8 routes; register the dispatch in `livechat_message_hooks`.
- `server/api/push.ts`, `server/pushToggle.ts`.
- **Tests:** the self-exclusion rules; e2e `server-push.spec.ts` (§11).
- **Docs:** the push section.

### P4 — Frontend lock and disguise (Builder D, wave 1; stubs `/unlock` in vitest until P1 lands)

- **Router:** a `server` route (Route union, `routeFromSegments`, `segmentsFor`).
- **Nav:** `NAV_ROUTES` gets `{route:{kind:"server"}, label:"Server"}` **last**.
- **shell.ts:** a `mountPanel` branch plus a `ShellDeps` injection seam like chat's.
- **Modules:** `server/{constants,types,lockModel,gestures,panel,decoy,pinPad}.ts`,
  `server/api/{http,unlock}.ts`, and `server/lock.css` (imported from `style.css`). The
  panel mounts P5's `createServerChatView` through an injected factory; use a stub until P5b.
- **Tests:** vitest covers the reducer, the gesture detector (synthetic PointerEvents,
  exclusions, `performance.now`) and suspension accounting. e2e `server-lock.spec.ts` (§11).
- **Docs:** the lock/gesture section of `livechat.md`; `editor-and-admin-ui.md` nav mention.

### P5a — Shared chat extraction (Builder E, wave 1; a pure refactor of the AI chat)

- Extract `chatThreadScroll.ts` (48 px stick-to-bottom + jump pill) and `lightbox.ts` from
  `chatPanel.ts`, and make the AI panel use them.
- Generalise `chatComposer.ts` with these options:
  - `accept`
  - `acceptFile(file) → boolean`
  - `renderChipPreview(file) → HTMLElement` (non-image chips)
  - `extraButtons: HTMLElement[]` (a slot after 📎)
  - `upload(file, {onProgress, signal})`
- Defaults must keep the AI composer byte-for-byte identical in behaviour and class hooks.
  `chat-ux.spec.ts`, `composer-*.spec.ts` and the vitest suites must stay green, unmodified
  except for import paths.

### P5b — Server chat view (Builder E, wave 2)

- **Modules:** `server/{chatView,thread,stream,identity,linkify,settingsSheet}.ts`,
  `server/api/messages.ts`, `server/chat.css`.
- **Layout:** mirrors the Inv 24 corollary exactly — flex column, the thread is the only scroll
  region, the composer is pinned by layout, `env(safe-area-inset-bottom)`.
- **Thread:**
  - header: title "Server", name chip, ⚙ settings, and a **panic ✕** (`aria-label="Close"`)
  - day separators; own messages on the right, others on the left with sender + time
  - history paging via a top sentinel IntersectionObserver
  - an optimistic echo reconciled by `clientId`, removed on send failure (the composer keeps
    the draft)
- **stream.ts:** fetch-SSE with the reconnect/backoff/45 s watchdog. Plain text + linkify
  (http(s) only).
- **Name prompt** on first unlock.
- **Settings sheet:** name, storage used (`/usage`), push slot (P3b), Lock.
- **Attachment rendering** goes through a `renderAttachments(attachments, ctx)` registry so P6
  plugs in.
- **Tests:** vitest for the stream parser and reconnect, and linkify XSS cases. e2e
  `server-chat.spec.ts` (§11).

### P6a — Frontend media modules (Builder F, wave 1; against frozen §5 contracts with fetch mocks)

- **`server/upload.ts`** — the chunked uploader: init → PUT chunks with per-chunk retry
  (3×, backoff) → complete; progress and abort; a 413/415/507/503 → a plain-English error.
- **`server/recorder.ts`** — MediaRecorder.
  - MIME preference: `audio/webm;codecs=opus`, then `audio/mp4`, then `audio/ogg;codecs=opus`.
  - Tap to start / tap to stop, with a timer and a cancel.
  - Auto-stops at 15:00.
  - **Minimum length 1 s (v1.5.2):** a recording shorter than 1 s is discarded, never
    uploaded or sent, and a brief "Too short" hint shows instead. This catches an
    accidental start/stop more than 400 ms apart, which R3 does not lock.
  - `suspend("micPermission")` around `getUserMedia`, `suspend("recording")` while recording.
  - Fully releases the mic tracks on stop, cancel or detach.
- **`server/mediaRender.ts`:**
  - photo grid → the shared lightbox (full rendition)
  - video (`poster`, `preload="none"`, `playsinline`, `controls`)
  - voice player (play/pause, peaks waveform, elapsed/duration)
  - processing state ("Processing…") and failed state ("Couldn't process this file")
  - `suspend("mediaPlaying")` while any media plays

### P6b — Media wiring (Builder F, wave 3)

- 📎 accepts `image/*,video/*` with `suspend("filePicker")` until `change`/`cancel`.
- 🎤 goes in the `extraButtons` slot.
- Register the renderers; uploads survive lock/unlock.
- e2e `server-media.spec.ts` (§11).
- Docs: the frontend media section.

### P7 — Docs and invariant close-out (DM or any finishing Builder)

- Invariants 40–45 + the Inv 12 amendment in `invariants.md`.
- `runbook.md`: the ffmpeg/pillow-heif dependency, the new env vars, the quota, and the
  the cmd PIN-service dependency (app key, registration via cmd, 503 when cmd is down).
- `testing.md`: the new specs, ffmpeg in CI, `page.clock`.
- `glossary.md`: decoy, unlock token, lock causes.
- **Decisions** — **no pre-allocated numbers** (v1.5.1: the earlier 00144–00148
  reservations were overtaken; 00144 and 00148 are already used by other entries).
  Each entry takes the next free number (max+1 across `decisions/`) at the moment it is
  committed:
  - server-chat architecture (SSE-over-fetch, SQLite, token model, disguise, zero PIN
    state via the cmd PIN service)
  - media pipeline (single rendition, chunked uploads, ffmpeg hardening, quota)
  - push (payloadless VAPID, Android-only, generic text)
  - lock and gesture model (the R2/R3/R6/R7 readings, including the v1.5 gesture
    boundaries and primary-button rule)

### Integration rules for DM

- Committed bundles (`admin.js`, `admin.css`, `server-sw.js`) **will** conflict between
  parcels. Never hand-merge them: take either side, run `npm run build` in `admin-ui`, and
  commit.
- `app.py`, `style.css` and `settings.py` conflicts are trivial additive merges.

---

## 11. E2E matrix (the fixture's FakeCmdServer registers a made-up test PIN for the app key, and sets `WIXY_SERVER_UPLOAD_CHUNK_BYTES=65536`)

Add `/test/server/reset-pin-lockout` to `fixture_server.py`; it clears the fake cmd's lockout
state. Every spec runs a **desktop leg
and a mobile leg** (390×844, `isMobile`, `hasTouch`).

**`server-lock.spec.ts` (P4)** — use `page.clock.install()` before `goto`:
1. The nav shows "Server"; the decoy shows real rows; no affordance is visible.
2. A single tap in the panel reveals "Open server settings", and it re-hides after 10 s.
   A tap on the nav doesn't reveal it. A double tap on the spot where the button appears
   reveals it but does **not** open the PIN pad (400 ms debounce). Tapping the button
   after 400 ms opens the pad.
3. Unlock:
   - The pad title is "Unlock server".
   - A wrong PIN shows "Incorrect PIN".
   - 5 wrong → lockout message + countdown (reset endpoint afterwards).
   - The right PIN → name prompt → chat.
4. Idle:
   - At 9 s it's still visible. A mouse move at 9 s pushes it out: still visible at +9 s.
   - At +10.5 s it's the decoy, and `.wx-srv-thread` is absent from the DOM.
   - An incoming message plus its auto-scroll at 5 s does **not** extend idle.
5. The panic ✕ locks instantly; so does a double-tap on the thread. A double-tap in the
   textarea does **not** lock. Escape locks.
6. Routing away and back locks; reload locks; a synthetic hidden `visibilitychange` locks.
7. Drafts survive: type, panic, unlock → the text is restored.

**`server-chat.spec.ts` (P5)** — two browser contexts with different names:
- A→B live delivery within 3 s; alignment is correct.
- History paging over 120 seeded messages; day separator.
- Echo reconciliation; stream reconnect after a forced drop (test endpoint).
- Layout-invariants leg, desktop + mobile: the thread scrolls, `.wx-main` doesn't, the
  composer is fully on-screen, the jump pill behaves, and there's no horizontal overflow.

**`server-media.spec.ts` (P6)** — small committed fixtures (a jpeg with GPS EXIF, a 2 s mp4,
a rotated mov):
- A photo → thumb → lightbox.
- A multi-chunk upload shows progress.
- A video goes processing → ready → plays (`readyState`).
- Voice runs in its own describe with `--use-fake-device-for-media-stream
  --use-fake-ui-for-media-stream` and no clock: record 2 s → the bubble shows ~0:02 → plays.
- An upload continues across panic + unlock.

**`server-push.spec.ts` (P3b):**
- A desktop UA shows no toggle.
- An Android UA (`userAgent` override) shows the toggle.
- With `addInitScript` stubbing `serviceWorker.register` and `PushManager.subscribe` →
  PUT → status subscribed; disable → DELETE.
- `/admin/server-sw.js` is served as JS with `Service-Worker-Allowed`.
- Real push delivery is live-verified on the operator's Android phone, since headless
  Chromium has no push service.

---

## 12. Deploy and live verification (DM)

1. **Before** the delivery merge: cmd's PIN service is merged, deployed on hub, and the PIN is
   registered under the app key `wixy-livechat`. The cmd-side team does that registration
   themselves under operator decision #973, so the PIN value never passes through wixy, this
   workspace, or any chat again; the operator can also set or rotate it himself at
   `https://cmd.cinnamons.uk/pins`. Nothing PIN-related is written to wixy's Storage or `.env`.
   Confirm it by unlocking against live cmd from a dev run
   (`pytest -o addopts="" -m live_cmd` gains one PIN round-trip test that reads the PIN from
   an env var at run time, never from a file).
2. After Slots deploys, confirm the pillow-heif import in the active slot's environment. The
   decoy's "Media processing" row reads **OK**, which proves that the Devfleet-launched
   process resolves ffmpeg/ffprobe; if not, set `WIXY_FFMPEG`/`WIXY_FFPROBE` in `.env` to the
   absolute paths.
3. Drive `ca.cinnamons.uk/admin/server` with the `verify` skill:
   - decoy → single tap → "Open server settings" → PIN → text, photo, video, voice
   - two sessions see live updates; idle lock; panic
   - mobile viewport
4. **Android push** needs the operator's phone. Hand him the one-step instruction: Server →
   unlock → ⚙ → Notifications on.

---

## 13. Audit (opus tier via `audit` skill) — acceptance criteria

These are the §1 rulings R4–R13, the §2 hardening list, invariants 40–45 with tests present,
and §5 contracts matched exactly. Also:
- No PIN value in the git history of the delivery PR, and no PIN state anywhere in wixy.
- The unlock path is closed (503) whenever cmd is down.
- No token in any URL or log.
- The 2 s re-check covers the two-process case.
- Leases prevent double processing.
- Every ffmpeg call is hardened.
- The SW has no fetch handler.

---

## 15. Operator-level flags (routed to the Orchestrator)

1. **PIN leak:** the pushed todo on the public repo's workspace branch contains it. Alerted
   separately.
2. ~~R2 gesture reading~~ **RESOLVED** (decision #974): a single tap reveals it; a double
   tap re-locks only inside the chat. Applied as the v1.3 errata.
3. **Disk:** 58.8 GB free on D:. Defaults are a 20 GB chat-media quota, a 10 GB free floor,
   no originals kept, and video capped at 1080p. Confirm or adjust.
4. **No backup** of chat history (R15). Confirm he's OK with that.
5. **Push text** is always "Server — New activity", with no content. Confirm.
6. **Public repo:** the chat's *code* (and so the disguise) is readable by anyone on GitHub;
   only the PIN is secret. Confirm acceptable. If not, making the repo private is a GitHub
   setting, with no design change.
7. **Not requested, not built:** deleting messages or wiping the chat. Does he want it?
   Non-blocking.
8. **Standalone edition:** the chat can't be unlocked on her future droplet until a
   standalone PIN verifier exists (there's no cmd there). OK for now?
9. **Dependency (OPEN):** the delivery merge is blocked until cmd's PIN service PR (#3068,
   cmd workspace #875) is merged, deployed on hub, **and** `wixy-livechat` is registered.
   Its contract is frozen from cmd's side, so wixy builds against it now (§5.1 v1.4).

## 16. Out of scope (v1)

- editing messages (deleting and wiping are now **in** scope: §17, v1.2)
- typing indicators, read receipts, presence, unread counts
- iOS push
- multiple rooms
- search
- backups of chat
- server-side identity beyond CF Access

---

## 17. v1.2 addendum — delete a message and wipe the chat (operator decision #975)

The operator's answer: "yes, add delete or wipe". The ruling is that **both** are built: delete
one message, and wipe everything. The addendum is purely **additive**:
- The frozen §5 routes, the §6 TS interfaces (`ServerSession`, `LockHooks`,
  `ServerChatView`, `serverFetch`) and the existing §4 store method signatures are
  unchanged.
- New surface only: two store methods, two routes, two SSE event types, and UI entry points.
- One small in-flight schema/stream amendment (A1, §17.2) goes to P1, which has not merged
  yet.

### 17.1 Semantics (binding)

- **Anyone unlocked can delete any message, for everyone.** Wipe lets anyone erase
  everything, so an "own messages only" rule would be inconsistent.
- **Hard delete, no tombstone.** The message simply disappears on every client: no "message
  deleted" placeholder, no trace in the thread.
- **Delete a message** removes:
  - its row
  - its attachment rows
  - its media dirs (`media/<id[:2]>/<id>/`)
  - its earlier `message` and `message_updated` events

  Then it appends one `message_deleted` event. Deleting an already-deleted message is
  idempotent.
- **Wipe** removes every message, attachment, media file, pending upload (row and dir) and
  `failed/` entry, and every event. Then it appends one `wiped` event.
  - Not touched: `seq` numbering (AUTOINCREMENT never reuses), push subscriptions,
    `secret.key`, `vapid.json`, and localStorage names.
  - In-flight uploads from another device then get a 404 on their next chunk or complete, and
    show "Upload cancelled".
- **Scrubbing:**
  - Every connection sets `PRAGMA secure_delete=ON`, so deleted rows are zeroed in the main
    DB file.
  - **v1.5.3 ERRATA — delete and wipe BOTH use `PRAGMA wal_checkpoint(TRUNCATE)`.**
    The earlier `PASSIVE` rule for delete was wrong, measured 2026-09-24 with a
    connection held open as in a live server: a message inserted and deleted inside
    the WAL, followed by a *complete* PASSIVE checkpoint (`busy=0`), still left the
    deleted text in `server.db-wal`, because PASSIVE never resets or truncates the
    WAL file. Only TRUNCATE (0 bytes) removed it.
  - **A reader can block the scrub (measured):** a reader holding a snapshot taken
    *before* the delete makes TRUNCATE return `busy=1`, with the deleted text still
    in the main DB file. Once that reader finished, the retry returned `(0,0,0)` and
    both files were clean. A reader whose snapshot was taken *after* the delete also
    returns `busy=1`, but the files are already clean. So `busy` alone cannot say
    whether text survives, and the completion test below is deliberately
    conservative.
  - **The scrub routine** (`LiveChatStore.scrub(deadline_s: float) -> bool`) runs on
    a fresh connection, outside any transaction, after the delete/wipe commit:
    - Loop `PRAGMA wal_checkpoint(TRUNCATE)`, with the busy timeout capped to the
      remaining time so SQLite itself waits out short readers.
    - **Complete** means the call returned `busy == 0` **and** `server.db-wal` is 0
      bytes or absent.
    - The deadline is **10 s** total, counted from the commit.
- **Result → response** (the deletion itself is already committed and broadcast
    before scrubbing starts):
    - Scrub complete within the deadline → **204**. **Every 204 carries the raw-byte
      guarantee**: the deleted text is in neither `server.db` nor `server.db-wal`.
    - Deadline passed → leave the durable erasure record in place **before**
      responding, then respond **202 `{"erasurePending": true}`**, meaning deleted
      for everyone, with file removal or leftover-byte erasure still finishing.
    - **Never** an error status, and **never** a rollback. The message is already
      gone from every screen, so an error would make the sender's screen restore a
      message that no longer exists anywhere.
  - **The background erasure worker** (app task group): retry recorded file removal
    first, then run `scrub` every 2 s. It also runs once at startup, so a crash or slot
    swap mid-erasure still finishes. Route and worker scrubs serialize per store and
    re-read the pending marker under the guard; if one already cleared it, the other skips
    its redundant scrub. It is idempotent across both slot processes.
  - **Media-file cleanup (v1.5.4):** delete and wipe record attachment/upload IDs for
  filesystem cleanup in the same SQLite transaction that removes their rows. Wipe also
  records a token for sweeping unreferenced paths. The app worker retries file removal at
  startup and every 2 s; an OS unlink error keeps cleanup pending rather than being ignored.
    It scans unreferenced media/upload/failed entries once at startup and repeats only while a
    wipe-sweep token is pending. Each scan batches live attachment/upload IDs in one DB read;
    a failed startup scan creates a durable token so legacy orphans keep retrying without a full
    tree scan on every ordinary two-second tick.
    `GET /media/{attId}/{rendition}` must verify that the attachment row still exists before
    opening a file, so an old signed URL returns 404 even if Windows temporarily holds the
    deleted file open.
  - **Pending status (v1.5.4):** `/usage` exposes one `erasurePending` boolean. Delete/wipe
    return 202 `{"erasurePending":true}` while any recorded file removal or DB scrub remains;
    the settings sheet polls until it is false. A 204 requires both
    the raw-WAL guarantee above and completed file cleanup.
  - **Readers stay short (store invariant):** no store method returns with an open
    statement or transaction, and no caller holds a transaction across an `await`.
    The store already does this (per-call connections; `fetchall`/`fetchone` inside
    `_read_txn`); it is now a tested rule, so in practice a blocking snapshot is one
    query long and the 10 s wait covers it. 202 is the pathological path: the other
    slot's process mid-swap, or an external reader.
  - Media files are unlinked. **Honest limit:** no byte-level shredding of files on
    NTFS/SSD, since overwriting in place is not reliable on SSDs anyway. Documented in
    `livechat.md`.
- **Race with the media queue** (P2b behaviour; the frozen signature is unchanged):
  - `finish_attachment` on a row that no longer exists is a silent no-op, with no event.
  - After `finish_attachment`, the queue re-reads `get_attachment`. If it's `None`, the queue
    `rmtree`s that attachment's media dir. `delete_message`/`wipe` also `rmtree`. Both are
    idempotent, so whichever runs last cleans up.
  - A chunk write and its post-write upload-row check are shielded from request cancellation.
    If a late write finds the upload row deleted, it re-marks the upload cleanup record before
    retrying file removal, including when an earlier cleanup had already completed.
- Delete and wipe never trigger a push.

### 17.2 Amendment A1 — to P1, only if P1 has NOT yet merged to the feature branch

A1 is a tiny in-flight change so the v1 schema never needs a rebuild migration. As of
2026-09-14, P1 has not merged, so A1 applies to P1. If P1 has already merged by the time
this is read, P8 does all of this instead as migration v2, rebuilding the content-free
`events` table while preserving its `sqlite_sequence` high-water mark. v1.5.4 adds migration
v3 for durable deleted-storage and wipe-cleanup records, migration v4 adds a partial index over
pending deletions so completed tombstones are retained without being scanned on every retry tick,
and migration v5 adds a generation used to compare-and-clear each cleanup pass after file removal.

1. `events.type CHECK IN ('message','message_updated','message_deleted','wiped')`, and
   `events.message_seq` becomes **nullable** (NULL for `wiped`).
   `EventRow.type`'s Literal gains the two values; `EventRow.message_seq: int | None`.
2. Every connection sets `PRAGMA secure_delete=ON`.
3. The SSE stream:
   - emits `message_deleted` as `data: {"seq": int}` and `wiped` as `data: {}`;
   - **skips** a `message` or `message_updated` event whose message no longer exists;
   - still coalesces per message.
4. `finish_attachment` on a missing row → a no-op with no event, per §17.1.

### 17.3 New contracts (additive; frozen once published)

**Store:**
- `delete_message(self, *, seq: int, now: float) -> list[str]` returns removed attachment ids
  and records durable file-deletion tombstones in the same write transaction.
- `wipe(self, *, now: float) -> tuple[list[str], list[str]]` returns removed (attachment ids,
  upload ids), records those deletions and a wipe-sweep token in that transaction.
- The route-level `delete_message_for_scrub` / `wipe_for_scrub` variants also return the WAL
  scrub token (and wipe token) used by the response/retry flow. Neither route owns an untracked
  post-commit `rmtree` list.
- Both delete and wipe publish to the notifier and run the checkpoint above.

**HTTP** (header token required, like every §5 route):
- `DELETE /api/admin/server/messages/{seq}` → **204** (DB scrub and media cleanup complete), or
  **202 `{"erasurePending": true}`** (v1.5.4). Idempotent:
  repeating it on an already-deleted message re-runs cleanup and answers 204 or 202 the same way.
- `POST /api/admin/server/wipe` with body `{"confirm":"WIPE"}` → **204** or the same **202
  response**. Any other body → 422. The literal
  guards against an accidental call. Never re-POST a wipe to poll: a repeat would also
  delete anything sent since.
- `GET /api/admin/server/usage` exposes **`erasurePending: bool`** (true while any durable
  file removal or DB scrub remains). This is how a client polls completion.

**SSE:**
- `event: message_deleted` / `data: {"seq": n}` — the client removes that bubble if present
  and otherwise does nothing.
- `event: wiped` / `data: {}` — the client clears the thread and all loaded history, sets
  `hasMore = false`, and drops pending echoes. The stream continues.

### 17.4 UI (binding)

**Message actions:** long-press (touch, 500 ms, cancelled by >10 px movement), right-click
(`contextmenu`), or a hover "⋯" button (desktop) opens a small action sheet with these
entries:
- **Copy text** — text messages only.
- **Delete for everyone** — a single confirm line inside the sheet: "Delete this message for
  everyone?" [Delete] [Cancel].
- **Cancel.**

Details:
- Deletion is optimistic: the bubble fades out and is removed. It's restored with a plain
  error line only on a real failure (network error, 4xx/5xx). **202 is success**: the
  bubble stays removed, and no extra UI is shown for a single message.
- The long-press counts as activity. A double-tap on a bubble still locks (R3), and a
  long-press is never a multi-tap.
- Bubbles set `-webkit-touch-callout: none` so iOS doesn't show its own callout.
- **Taps inside the flow (v1.5):** the ⋯ trigger, "Delete for everyone" and the settings
  "Delete all messages" row each carry `data-srv-gesture-boundary` (R3, v1.5), so the
  open → pick → confirm sequence can never trip the double-tap lock.

**Wipe:** the settings sheet gets a destructive row, "Delete all messages". It uses a
two-step confirm: "Delete every message, photo, video and voice note for everyone? This can't
be undone." [Delete everything] [Cancel]. It sends `{"confirm":"WIPE"}`, then the local
`wiped` handling runs immediately. The server's `wiped` event is then a no-op for this client.
On **202**, the sheet shows "Deleted. Erasing leftover traces…" and polls `/usage`
every 1 s until `erasurePending` is false. Then it shows "Done"; after 60 s it stops
polling quietly, since the server keeps scrubbing regardless.

**Lock interplay:** while locked, nothing is shown and nothing starts. A delete or wipe that
started before a lock completes (like sends, R6). Events that arrive while locked are
replayed from the cursor on unlock.

### 17.5 Parcel P8 — delete and wipe (one Builder, a vertical slice)

**Starts after P1, P2b and P5b are on the feature branch.** It touches the store, the media
dirs and the chat view, so it goes last to avoid colliding with in-flight work.

**Backend:**
- the §17.3 store methods (+ migration v2 if A1 missed P1)
- the routes in `routes_livechat.py`
- media, upload and failed cleanup
- the P2b queue re-check, if P2b didn't already do §17.1's race rule

**Frontend:**
- `server/messageActions.ts` (long-press, contextmenu, ⋯ sheet)
- the wipe row in `settingsSheet.ts`
- `message_deleted`/`wiped` handling in `thread.ts`/`stream.ts`
- `server/api/messages.ts` gains `deleteMessage` / `wipeChat`

**pytest:**
- delete removes rows, events and files, and is idempotent
- wipe removes everything, including an in-flight upload (its next chunk → 404) and `failed/`
- `PRAGMA secure_delete` reads 1 on store connections
- **on every 204 from delete or wipe, a unique marker string from the deleted text is
  absent from the raw bytes of `server.db` + `server.db-wal`, and the WAL is 0 bytes**.
  Keep a second store connection open during the test, since the last-close
  auto-checkpoint would otherwise mask a broken scrub (measured: the first probe was
  fooled exactly this way).
- **characterisation guard:** an insert+delete kept inside the WAL, then a *complete*
  PASSIVE checkpoint, leaves the marker in `-wal`. This pins why the rule is TRUNCATE,
  so nobody "optimises" back to PASSIVE.
- **stale reader:** open a raw connection, `BEGIN` + `SELECT` *before* the delete, and
  inject a short deadline → 202 + `scrub.pending` exists (the marker may remain).
  Release the reader, run one scrubber tick → the sentinel is gone, `/usage`
  `erasurePending` is false, and the marker is absent.
- **startup resume:** durable erasure work present at startup is resumed and removed.
- **reader invariant:** after each public store read method returns, a TRUNCATE on
  another connection with `busy_timeout=0` returns `busy == 0`.
- Hold a rendition file open during delete and wipe: both return media cleanup pending; the old
  signed URL returns 404 while the bytes remain on disk; a reopened store's worker removes the
  file after the handle closes.
- Inject an unlink failure and prove it remains pending for retry rather than being reported
  complete.
- Complete a tombstone, run another cleanup tick, and prove the completed row is retained but
  neither selected nor sent through filesystem cleanup again.
- Requeue an upload tombstone between file removal and the previous cleanup pass clearing its
  state; prove the generation check preserves the requeue and a later pass removes the late bytes.
- Prove unreferenced storage is scanned at startup and while a wipe token remains pending, not
  on ordinary ticks, and that the scan uses one batched live-ID read rather than per-entry DB
  connections.
- Delete and fully clean an upload during an in-flight chunk request, then let the chunk write
  land late; prove the post-write check requeues cleanup and the recreated bytes are removed.
- a delete racing a processing attachment leaves no media dir behind
- a stream spanning a delete emits `message_deleted`, and skips the stale `message` event on
  replay from an old cursor
- a `wiped` replay from an old cursor clears
- a wipe body other than `{"confirm":"WIPE"}` → 422

**e2e** (`server-chat.spec.ts` gains a "delete and wipe" describe, two contexts, desktop +
mobile):
- A deletes B's message via the ⋯ or long-press sheet → it vanishes on both within 3 s.
- The old media URL for a deleted photo → 404.
- Wipe from A's settings → B's thread empties live; reload shows empty.
- A long-press never locks; a double-tap on a bubble still locks.

**Docs:**
- a `livechat.md` section on delete and wipe, with the honest filesystem limit
- `contracts.md` gets the two routes and two events
- invariant **46** in `invariants.md`
- a decision entry, next free number at commit time (delete/wipe semantics: hard delete, no tombstone, anyone-can-delete,
  scrubbing)

**Audit (§13) gains:**
- the raw-bytes absence test
- idempotence
- the 422 confirm guard
- no push on delete/wipe

### 17.6 New invariant

**Inv 46 — Delete and wipe are hard deletes, without chat-visible tombstones.**
- Content rows are removed with `secure_delete=ON`, then a TRUNCATE checkpoint runs.
  **204 means the deleted text is provably absent from `server.db` + `server.db-wal`.**
  202 means deleted, with one durable `erasurePending` signal for WAL scrub and media cleanup. It is never
  an error and never a rollback.
- Internal storage tombstones are recorded in the same transaction as row deletion; they never
  appear in history or events. Failed unlinks remain pending for startup/two-second retry.
- The media route checks the live attachment row; deleted media URLs 404 even while a locked file
  remains on disk pending retry.
- Clients remove content on `message_deleted`/`wiped`.
- Honest limit: no byte-level file shredding.
