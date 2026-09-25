# Subsystem: server chat (the "Server" panel)

A hidden human↔human live chat for admin users, disguised as a **"Server"** nav tab inside
the already CF-Access-gated `/admin`. Not the AI assistant, not visitor-facing — its own
storage, routes, and second auth gate, entirely separate from `chats.py`/`cmdchat.py`/
`draft/media/`. Full decided design: [`spec/server-chat/00-brief.md`](../../spec/server-chat/00-brief.md).
This manual describes the current implementation; where intent and code differ, follow the
code and record the difference in `decisions/`.
Numbered guarantees: [invariants.md](invariants.md) 40–47, 49 (reactions) and 50 (transcription, §15).

## 1. The disguise (why it looks like nothing is here)

- The nav entry says **"Server"**, never "Chat" — it shows real server status (uptime,
  engine version, disk free, media-processing health) with **no visible entry point** into
  the chat.
- **R2 v1.3 (operator decision #974, overriding the brief's original R2 text):** a SINGLE
  tap anywhere inside the Server panel element (not the nav/topbar around it) reveals an
  "Open server settings" button, which re-hides after 10s idle. Tapping the affordance opens
  a PIN pad titled "Unlock server" — a tap that lands within 400ms of the reveal itself is
  ignored, so one accidental rapid double-tap can't reveal-and-open in the same motion.
  Multi-tap has **no meaning on the decoy**. Inside the unlocked chat view, two qualifying
  primary-button taps (≤400ms apart) lock instantly, subject to the v1.5.2 boundary rule below.
- **R3 v1.5.2 (gesture boundaries):** a control that opens an in-page menu, sheet, confirm
  step, dialog or lightbox carries `data-srv-gesture-boundary`. Its tap can complete and lock
  a run started by a preceding ordinary tap, but by itself cannot start a run; a third rapid
  tap on boundary controls still locks. Only primary-button pointerdowns count. This lets a
  causal choice flow such as ⋯ → Delete for everyone → Delete run at human or Playwright speed,
  while a double-tap on the bubble or thread still locks. The settings gear, photo lightbox
  thumbnail, P8 menu trigger, Delete for everyone item, and Delete all messages row are marked;
  final-action buttons and toggles are not. The exact classifier is in
  `admin-ui/src/server/gestures.ts` and is covered by `admin-ui/tests/server/gestures.test.ts`.
- Once unlocked: 10 seconds of no activity fades back to the decoy — or 60 seconds on a
  device where the owner ticked **Extend auto-lock to 1 minute** in the chat's settings sheet
  (§11); a panic button, a multi-tap inside the chat, `Escape`, tab-hidden, or routing away
  all lock instantly. A reload never restores the unlocked state (Inv 42).
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
  (the header is the only place `require_server_token` ever looks). A header value that is not
  pure ASCII fails verification like any other malformed token and gets the same
  `401 {"error":"locked"}` — never a server error (`tokens.verify_unlock_token` rejects it
  before any HMAC work; `TestTokenRequired::test_non_ascii_unlock_token_is_401_locked`).
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

wixy validates **4–16 ASCII digits locally** and never calls cmd for anything else — cmd
charges an attempt **before** checking it, so a stray keypress must never burn one. The
`unlock` route (`routes_livechat.py`) reads the raw JSON body itself instead of binding a
Pydantic model, and rejects every malformed shape (invalid or non-UTF-8 JSON, a non-object
body, a missing or misspelled `pin` key, a non-string or nested `pin`, or a `pin` that is not
4–16 ASCII digits) with one redacted `422 {"error":"invalid_pin"}` **before**
`verifier.verify()` is ever reached; the submitted value appears in no response or log line
(Inv 41).

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
bug" gets a 422 like a locally-invalid PIN does — as `{"error":"invalid","detail":...}`, not
`invalid_pin` — and is provably unreachable in practice, since the route's manual 4–16
ASCII-digit check already rejects anything that could trigger it), while 403/413/415 map to
the closed-fail `unavailable` → 503 — see `pinclient.py`'s own docstrings for the exhaustive
table.

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

Tables: `messages`, `attachments`, `events`, `uploads`, `push_subscriptions`, `reactions`,
`deleted_storage`, `pending_wipe_cleanup`, `pending_scrub`, and `attachment_transcripts` (a voice
note's opt-in transcript, `ON DELETE CASCADE` from its attachment — §15). Schema migrations are
serialized under the SQLite writer lock.
`deleted_storage` retains internal attachment/upload tombstones and retry status; it is not a
message/event tombstone and is never returned to chat clients. `pending_wipe_cleanup` records a
wipe's filesystem sweep token so a crash cannot lose cleanup of orphaned paths. Schema v4 adds the
partial `idx_deleted_storage_pending` index containing only incomplete cleanup rows. Schema v5
adds a per-tombstone generation so a late requeue cannot be cleared by an older cleanup pass, plus
an age index for completed rows. The hourly janitor prunes completed tombstones after seven days;
pending tombstones are never pruned. Schema v6 adds singleton `pending_scrub`, written in the same
transaction as delete/wipe. Startup imports a legacy `scrub.pending` file into this row before
trying to remove it; an access failure retains durable scrub work and the file for retry. Schema v7
adds `reactions` (decisions/00164), described under "Reactions" in §6. Schema v8 adds
`attachment_transcripts` (decisions/00166/00167), described in §15; a database that reaches v8
through a migration path older than this table's own step still gets it via
`_ensure_attachment_transcripts_table`'s idempotent `sqlite_master` check on every connect.
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

**§17.2 migration v2** rebuilds the content-free `events` table on upgrade, accepts
`message_deleted`/`wiped`, makes `message_seq` nullable for `wiped`, and preserves
`sqlite_sequence`'s high-water mark. Every store connection enables `PRAGMA secure_delete=ON`.
The stream emits `message_deleted` as `data: {"seq":int}`, emits `wiped` as `data: {}`, and
skips a stale `message`/`message_updated` event if its message row has already vanished.

### Delete and wipe (P8)

Any unlocked chat user may hard-delete any message for everyone. Deletion removes its message
and attachment rows, media/upload/failed directories, and prior `message`/`message_updated`
events, then appends one `message_deleted` event. Repeating a delete adds no second event and
returns 204 or 202 according to the scrub result. The client removes the bubble optimistically
and removes remote bubbles from the same `message_deleted` event; the stream is the source of
truth.

**Client timeouts, retries and reconciliation.** Delete and wipe requests use a dedicated
30-second timeout (`serverFetch` in `admin-ui/src/server/api/http.ts`; ordinary chat requests
keep 10 seconds and upload chunks 120), so a slow but successful erasure is not abandoned by
the client. A timeout or network failure of either request is an *unknown outcome*
(`ServerErasureOutcomeUnknownError`), distinct from a definite HTTP failure. For the wipe the
class is broader: `wipeChat` (`api/messages.ts`, `isUnknownOutcomeStatus`) also treats a 408 or
any 5xx as unknown, because Cloudflare answers for the origin and a gateway status says nothing
about whether wixy's commit landed. `deleteMessage` still treats any non-OK status as a definite
failure:

- **Delete** is idempotent, so `deleteMessage` (`api/messages.ts`) retries an unknown outcome up
  to three times, after 1, 2 and 4 seconds (at most four requests). If it still cannot be
  confirmed, the bubble is restored with "Couldn't confirm the delete — try again". A definite
  HTTP failure other than 401 is not retried and restores the bubble with "Couldn't delete
  message. Try again."; a 401 locks the chat. If the delete did commit, its `message_deleted`
  event removes the bubble anyway, even after a restore.
- **Wipe** is never retried, because a repeat would delete anything sent since. A definite
  failure (a 4xx) keeps the two-step confirmation open with "Couldn't delete everything — try
  again". On an unknown outcome the settings sheet shows "Couldn't confirm — checking…"
  immediately, before any history request. `thread.ts` (`reconcileUnknownWipe`) then pages the
  whole history and compares server message sequence numbers against the newest sequence the
  client knew when it sent the wipe; browser and server clocks are never compared. That
  boundary is only trustworthy if the history had loaded when the wipe was sent (`boundaryKnown`
  in `thread.ts`). If it had, any message at or before the boundary means the wipe did not
  commit; if it had not, the boundary is 0 and "nothing at or before it" would be vacuously
  true, so the only proof of a commit is an **empty** history. When the wipe did not commit the
  history is restored and the retry message is shown. Otherwise the wipe counts as done,
  messages newer than the boundary are kept, and the `/usage` erasure poll starts. If the
  history request itself fails, the thread keeps retrying that request — never the wipe — after
  1, 2, 4 and 8 seconds and then every 15 seconds, until it gets a definite answer, sees a
  `wiped` event on the stream, or the chat locks. A lock or teardown abandons the check
  (`ServerWipeAbandonedError`) and the sheet resets its control quietly. The sheet's own
  `/usage` poll and its "Status unclear. Check the messages to confirm." ending
  (`settingsSheet.ts`) apply only if `onWipe` itself rejects with an unknown outcome and no
  reconciler exists, which the real thread never does. A `wiped` event from the stream settles
  any of these cases.

Covered by `admin-ui/tests/server/erasureRequests.test.ts`,
`admin-ui/tests/serverThread.test.ts` and `admin-ui/tests/serverSettingsSheet.test.ts`, and by
`e2e/tests/server-chat.spec.ts` (a delete whose response is delayed 12 seconds still ends
removed on both clients).

The settings sheet's two-step **Delete all messages** action requires exactly
`{"confirm":"WIPE"}`. Wipe clears messages, attachments, pending uploads, all events, and the
contents of `media/`, `uploads/`, and `failed/`, then appends one `wiped` event. The client
clears loaded history and pending echoes; the stream remains connected. Message/event sequence
numbers, push subscriptions, `secret.key`, `vapid.json`, and localStorage identity values stay
intact. Delete and wipe never dispatch push notifications.

Both operations enable secure delete and use `PRAGMA wal_checkpoint(TRUNCATE)`. A 204 means the
WAL is empty, deleted text is absent from both database files, and media-file cleanup completed.
The route gives the scrub up to 10 seconds; if a reader still blocks it, the route retains the
database-backed `pending_scrub` row. Delete and wipe transactions record deleted storage IDs and
the scrub marker before commit.
Both routes publish the deletion event immediately after commit and before file cleanup. Every
post-commit cleanup exception is logged and returns 202; committed deletion is never turned into
an error response. Each WAL checkpoint attempt waits no more than 250 ms for SQLite's busy lock;
the route's ten-second deadline includes waiting for `LiveChatStore.scrub_guard()`, and lock
timeout returns pending. A WAL `stat()` error other than `FileNotFoundError` is treated as an
incomplete scrub and retried, not raised from the worker.
If an unlink fails (for example, Windows reports a file-sharing violation), the durable cleanup
record remains pending and the two-second worker retries at startup and while the app runs. It
removes files before retrying the database scrub. `/usage` exposes one `erasurePending` flag;
202 returns `{"erasurePending":true}`, and the settings sheet polls until it clears. `GET /media`
checks that the attachment row still exists
before opening a signed rendition, so an old URL returns 404 even while a locked file awaits
cleanup. Wipe cleanup sweeps only paths without live attachment/upload rows, preserving uploads
created after the wipe transaction. **NTFS/SSD byte-level shredding is not claimed**, since
overwrite-in-place is not reliable on SSDs. If the media worker finishes after deletion removed
its row, its post-finish check re-queues cleanup for any paths it recreated. The worker scans
unreferenced `media/`, `uploads/`, and `failed/` entries once at startup, then repeats that sweep
only while a wipe-sweep token remains pending. It enumerates paths before consulting a batched
snapshot of live attachment/upload rows and acts only on paths without a live row. A failed
startup sweep creates a durable retry token. Chunk writes shield the write-and-row-check sequence
from cancellation. If a late write finds its upload deleted, it
re-marks that upload for durable cleanup, even when an earlier cleanup already completed.
Route-owned and background WAL scrubs serialize under `LiveChatStore.scrub_guard()` and read the
current marker after acquiring the guard; a route skips its scrub if the worker already cleared it.
Media cleanup clears a pending row only if its generation is unchanged; a late requeue increments
the generation so an older cleanup pass cannot lose it.

### Reactions

Full design: [`spec/server-chat/04-reactions.md`](../../spec/server-chat/04-reactions.md);
decisions [00164](../../decisions/00164-server-chat-reactions/decision.md) (server) and
[00165](../../decisions/00165-reactions-patch-in-place-stream-is-truth/decision.md) (client);
guarantees: Inv 49. Not part of the AI chat (`chats.py`/`cmdchat.py`) — decisions/00110's split stands.

A reaction is one row of `reactions(message_seq, sender_key, sender, emoji, by_email, created_at)`,
primary key `(message_seq, sender_key, emoji)`. The reactor is `sender_key`, the trimmed, case-folded
sender name (`livechat/reactions.py::reactor_key`) — the same identity as "mine" and push
self-exclusion, not the device, so one person on two devices is one reactor. `sender` keeps the
spelling first typed; `by_email` is audit only and never returned. The `message_seq` foreign key is
`ON DELETE CASCADE`: with `foreign_keys=ON` on every connection, an OLDER slot process that has never
heard of the table can still hard-delete a message during a blue/green overlap, and the cascade
carries the reactions away (and `secure_delete` zeroes them), so delete and wipe stay erasing
(Inv 46). `_delete_message`/`_wipe` deliberately do not mention the table.

`LiveChatStore.set_reaction(seq, sender, by_email, emoji, reacted, now)` runs in one `BEGIN
IMMEDIATE` transaction: it checks the message exists (else `MessageNotFoundError`, and an
`IntegrityError` from the write maps to the same error), then `INSERT OR IGNORE` / `DELETE`, and
appends a `message_updated` event **only when a row actually changed**. It returns the current message
and whether anything changed. `list_messages`, `get_messages` and `_load_message` all load reactions
through `_load_reactions_for` (allowlist order across emoji, oldest reactor first within one), so
history, the send response and the stream all carry `reactions` via `message_json`.

The six allowed emoji are `REACTION_EMOJIS`, each an exact code-point sequence (the heart is U+2764
U+FE0F) compared with no normalisation. `admin-ui/src/server/reactions.ts` is the browser's copy and
`test_livechat_reactions.py` parses it and fails on any difference.

`PUT /api/admin/server/messages/{seq}/reactions` (`routes_livechat.py::set_reaction`, contract in
[contracts.md](contracts.md)) takes `{emoji, sender, reacted}` — the DESIRED state, so a retry after a
dropped response cannot flip it back. It validates the token, then the emoji, then the sender (the
`POST /messages` rules), then the `seq` (0 or beyond SQLite's integer range is a 404, since the
integer would otherwise raise `OverflowError` and become a 500). On a change it calls
`notifier.publish()`. It dispatches no push: the message hooks fire only for a created message. The
stream needs no change: a `message_updated` is re-read and coalesced like any other, and a message
plus its reaction in one batch collapse into one `message` frame.

## 7. Web Push (`livechat/push.py`, `server/pushToggle.ts`)

Push is an explicit Android-only opt-in. `GET /api/admin/server/push/config` returns
the project's uncompressed P-256 VAPID public key; subscription status and mutations
use the protected `/push/subscriptions/{deviceId}` routes. Subscription endpoints are
validated against the frozen HTTPS push-service allowlist before they are stored. The
VAPID key pair is persisted race-safely in the private server directory's `vapid.json`.

The opt-in is reachable from the UI. Each time the settings sheet opens, `settingsSheet.ts`
mounts `pushToggle.ts` into its push slot — only on an Android-capable browser (an Android user
agent with `PushManager`, `serviceWorker` and `Notification`) and only once the chat has a
display name; the sheet unmounts it on close. Desktop and other browsers never see the control.
`e2e/tests/server-push.spec.ts` proves both: a desktop browser shows no control, and an Android
browser enables and disables the subscription through the sheet.

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
2. **Photo** (Pillow + `pillow-heif==1.7.0`, included by the server extra): an 80MP pixel cap
   is checked immediately after `Image.open()`, before `.load()`/`.convert()`/
   `exif_transpose()` — a decompression bomb (huge declared dimensions, tiny file) is rejected
   without ever decoding pixel data. A still image then goes through, in this order:
   (a) `exif_transpose`; (b) **colour management** — an embedded ICC profile is converted to
   sRGB with the perceptual intent (a failed conversion logs a `WARNING` and continues with the
   pixels as they are, never failing the upload; alpha is carried across); (c) **normalization
   to 8-bit RGB or RGBA** — palette modes (`P`/`PA`) keep their colours, alpha is kept for
   `RGBA`/`LA`/`PA` and for any image with a `transparency` entry (a PNG tRNS chunk or a GIF
   transparent index), 16-bit greyscale (`I;16*`/`I`) is scaled 0–65535 → 0–255 through a
   lookup table (`round(v * 255 / 65535)`, so 32768 becomes 128 — never clipped), and every
   other mode, CMYK included, goes through Pillow's own `convert()`; (d) the **metadata strip**
   — the image is rebuilt from those normalized raw pixels (not a round-tripped save), so EXIF,
   ICC and text chunks are gone, and the profile is not re-attached because the pixels are
   already sRGB; (e) long edge ≤4096 (full) / ≤480 (thumb). The output format then follows
   transparency, not the source format — see the photo table below.
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

**Photo renditions** (`processing.process_photo`; the first matching row applies):

| Source | `full` | `thumb` |
|---|---|---|
| animated GIF | the original bytes, untouched, as `full.gif` — the one documented exception to "metadata stripped" (a GIF carries no EXIF/GPS, and re-encoding an animation buys nothing); its recorded width/height are the original's | the first frame through steps (a)–(d) and the 480px cap: `thumb.png` if that frame has transparency, otherwise `thumb.jpg` |
| has alpha (any other format) | `full.png` | `thumb.png` |
| opaque PNG or opaque static GIF | `full.png` (lossless) | `thumb.jpg` (q80) |
| any other opaque source (JPEG, WebP, HEIC/HEIF) | `full.jpg` (q88) | `thumb.jpg` (q80) |

The signed-media route resolves the `thumb` rendition as `thumb.png` or `thumb.jpg`, whichever
exists (see the media-route paragraph below).

`process(kind, src, *, output_dir, ffmpeg, ffprobe)` dispatches to the three and never
returns a partial/failed result — a caller that catches `MediaProcessingError` has nothing to
clean up beyond `output_dir` itself.

**Uploads (`livechat/uploads.py`, P2b) — §5.5.** `init_upload` checks (cheapest-first): the
media-pipeline gate (ffmpeg **and** ffprobe **and** `pillow-heif` all available — see
`resolve_binaries` below), the declared MIME type against a per-kind allowlist, the declared
size (`sizeBytes` must be at least 1: the route's request model rejects 0 or a negative value
with a 422, and `init_upload` itself refuses it as defence in depth, so such a size cannot
bypass the quota arithmetic) against the per-kind cap (photo 30MiB / voice 25MiB / video
1GiB), then quota
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

**The delete/processing race:** after `finish_attachment` (itself a silent no-op against a
concurrently-deleted row, per `store.py`), the queue re-reads `get_attachment`. If the row is
gone, it journals cleanup for any paths this worker recreated — the journal writes, like every
other store call here, run in worker threads so the event loop never blocks on SQLite; the
erasure worker removes them with the same retryable deletion path as request-side cleanup.

**`resolve_binaries`** (called once at `create_app` time): `WIXY_FFMPEG`/`WIXY_FFPROBE`,
falling back to `shutil.which` — but an **explicit** override must point at a file that
actually exists (`Path(...).is_file()`), or it's treated as unresolved. This catches an
operator typo in the env var as a clean 503 at upload time, rather than deferring the failure
to per-upload processing deep inside the queue. It returns the queue worker's `QueueConfig`, or
`None` when either binary is unresolved. `app.py` then sets `app.state.livechat_media_available`
to true only when that config exists **and** `pillow-heif` imported (`processing.
PILLOW_HEIF_AVAILABLE`), so a missing ffmpeg, ffprobe or HEIF decoder gates media the same way:
uploads return 503 `media_unavailable`, `GET /usage` reports `mediaAvailable: false`, the
decoy's "Media processing" row degrades to `unavailable`, the queue task is never started at
all (nothing valid to run it with), and text chat is unaffected. The janitor still runs (pure
DB/filesystem housekeeping, no ffmpeg dependency).

**Janitor (`livechat/janitor.py`, P2b/P8) — `run_once`/`run_forever`, hourly.** Ages out
uploads >24h (`stale_upload_ids`), unreferenced attachments >24h (`orphan_attachment_ids`,
keyed off `message_seq IS NULL` — never touches anything a message references, regardless of
its processing status), and `failed/` entries >7 days (by directory `mtime`, since there's no
DB row backing them). It rechecks orphan/upload eligibility in the delete transaction and queues
filesystem cleanup only when that conditional delete succeeds. It also prunes completed erasure
tombstones older than seven days, never pending ones. `run_once` takes an explicit `now`, never
reads the clock — every age threshold is test-driven, not slept through. `run_forever` sweeps
once immediately at app start and then hourly, so a test that seeds a live app's store directly
must use real-clock timestamps: a 1970-dated orphan is reaped mid-test (decisions/00157).
It also deletes staged raw uploads left behind on ready attachments; those sources have no
diagnostic-retention window once safe renditions exist.

The same module's `run_scrubber_forever` is a separately supervised app-lifetime task. It resumes
the database-backed scrub marker at startup and attempts `TRUNCATE` every two seconds until the WAL
is empty, then compare-and-clears the marker and performs one best-effort checkpoint. Legacy
`scrub.pending` files are imported once at startup and removed; a denied removal is retried on the
next startup. A failed-original archive is retried by the hourly janitor and its staged original is
removed after the seven-day diagnostic retention window.

**Media route (`routes_livechat_media.py`, P2b) — `GET /media/{attId}/{rendition}`, §5.6.**
The one route besides `POST /unlock` that skips `require_server_token`, since
`<img>`/`<video>`/`<audio>` can't send a custom header — `verify_media_signature` (§3) gates
it instead. `attId` is validated as exactly 32 lowercase hex chars *before* the signature
math runs (cheap defense in depth; a forged id can never pass the HMAC anyway, since it's
covered by the signature). The stored `renditions` tuple carries rendition **names**
(`"full"`, `"thumb"`, `"play"`, `"poster"`), never file paths — the actual filename's
extension (`full.jpg`, `full.png` or `full.gif`; `thumb.png` or `thumb.jpg`) is resolved by
trying each of P2a's possible outputs for that name in turn, since exactly one of them ever
exists per attachment and rendition.
An explicit MIME map (not `FileResponse`'s extension-guessing) sets `Content-Type`, because
`X-Content-Type-Options: nosniff` plus a wrong/generic content type would silently break
playback in the browser. Served via Starlette `FileResponse` (200/206, Range-aware).

## 9. Settings (`WIXY_SERVER_*`, `WIXY_FFMPEG`/`WIXY_FFPROBE`)

| Env var | Setting | Default | Notes |
|---|---|---|---|
| `WIXY_SERVER_PIN_APP_KEY` | `server_pin_app_key` | `"wixy-livechat"` | an identifier, never a secret — **no PIN setting exists** |
| `WIXY_SERVER_MEDIA_QUOTA_MB` | `server_media_quota_bytes` | 20480 MiB (20 GiB) | R10 — enforced at upload init (P2b); MB values multiply by 1024² |
| `WIXY_SERVER_MIN_FREE_MB` | `server_min_free_bytes` | 10240 MiB (10 GiB) | R10 — the disk free-space floor, enforced alongside the quota |
| `WIXY_SERVER_UPLOAD_CHUNK_BYTES` | `server_upload_chunk_bytes` | 8 MiB | clamped to 64 KiB–16 MiB |
| `WIXY_FFMPEG` / `WIXY_FFPROBE` | `ffmpeg_path` / `ffprobe_path` | `""` (resolve via `PATH`) | overrides must point to existing files; either binary missing — or `pillow-heif` not importable — makes media uploads return 503 while text chat works |

`ProjectPaths` (`storage.py`) gets `server_dir`/`server_db`/`server_secret`/`server_vapid`/
`server_media`/`server_uploads`/`server_failed` — created **lazily** (like `reports_dir`),
not by `ensure_project_dirs`: a project that never unlocks the chat never needs the
directory. Plus three per-item helpers (P2b): `server_upload_dir(uploadId)` →
`uploads/<uploadId>/`, `server_attachment_media_dir(attachmentId)` → `media/<id[:2]>/<id>/`
(the two-level fan-out keeps any one directory from accumulating thousands of entries),
`server_failed_dir(attachmentId)` → `failed/<id>/`.

## 10. Background containment and recovery

`wixy_server/background.py` wraps app-lifetime work in `ContainedTaskGroup`. Long-running loops
(`livechat-media` and `livechat-erasure`, among others) use `supervise`: exceptions are logged,
health is recorded, and loops restart with exponential backoff capped at 60 seconds. One-shot
work uses `spawn`, which logs and contains an exception. No worker exception can cancel the
lifespan task group; media-queue items and push recipients are also isolated from sibling items.

The erasure worker starts immediately and retries every two seconds. It removes
`deleted_storage` paths, resumes `pending_scrub` WAL work, and runs the full wipe/orphan sweep at
startup and while `pending_wipe_cleanup` exists. The hourly janitor runs once at startup and then
every hour: it removes stale uploads and unclaimed orphan attachments after 24 hours, removes
raw upload sources for ready attachments, retries archiving failed originals, expires an
unarchived failed original after seven days, and prunes completed cleanup rows after seven days.
It never ages out pending work.

If `/api/admin/server/usage` reports `erasurePending: true`, delete/wipe has committed and the
worker still owes WAL or file cleanup. Check server logs for filesystem errors, restore access,
and allow automatic retry; a restart also retries startup recovery and legacy-marker import.
Do not manually clear `pending_scrub`, `deleted_storage`, or the wipe-sweep token. Schema v6
imports legacy `server/scrub.pending` into `pending_scrub`; an unreadable marker is retained and
a durable row is created so privacy work is not lost.

`/api/admin/system/status` reports `server.mediaProcessing` as `unavailable` when ffmpeg,
ffprobe or `pillow-heif` is unavailable, `degraded` after at least three consecutive
media-queue or erasure-worker failures, and `ok` when media is available without that failure
threshold. The reported failure count resets after five minutes without another failure.

## 11. Frontend: the lock/gesture state machine (P4, `admin-ui/src/server/`)

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
- `createMultiTapDetector`/`attachMultiTapListener` (R3, precision revised to v1.7 by
  decisions/00163: a scroll flick or two different menu items were registering as a
  panic lock) — two RECOGNIZED taps (see below) within `MULTI_TAP_INTERVAL_MS` (400ms),
  `MULTI_TAP_RADIUS_PX` (32px) of each other and resolving to the same tap zone
  (`tapZoneOf`: the nearest `button`/`a[href]`/`[role="button"]`/`[role="menuitem"]`/
  `label`/`.wx-srv-bubble` ancestor, or a shared background zone) count as one
  multi-tap. A gesture-boundary tap closing a run started elsewhere is exempt from the
  radius/zone gates (v1.5's "may close, never open" is unchanged). Attached to
  `document` in the CAPTURE phase for the panel's whole mounted lifetime, so a tap
  inside a `stopPropagation()`'d descendant is still seen; only the reducer's
  `chat`/`fading` states give the resulting event any meaning.

Both detectors are fed by one shared `attachTapRecognizer`: what counts as a TAP at
all (R3 v1.7 part 1) is a primary-button `pointerdown` followed by its own `pointerup`
(same `pointerId`), moved ≤ `TAP_SLOP_PX` (10px) and held ≤ `TAP_MAX_MS` (300ms), never
interrupted by `pointercancel` — what the browser fires when it takes a touch over for
scrolling. A flick, a drag or a long-press is therefore never a tap for either
detector, closing the same false-positive class on R2's decoy reveal too.

Brief v1.5.2's `GESTURE_BOUNDARY_SELECTOR` reads `[data-srv-gesture-boundary]` from the
pointer target or its ancestors. The boundary tap counts normally first, so it can still
complete a run started elsewhere; if it doesn't lock, the detector clears the partial run
afterward. Classify a pair by asking whether tap 1 made control 2 appear under the finger:
causal flows such as settings → sheet option or photo → lightbox close use a boundary, while
independent controls such as Send → 📎/🎤 keep normal cadence. The native file picker doesn't
need a marker, and the mic start/stop toggle deliberately remains non-boundary.

**`panel.ts`** owns everything `lockModel.ts` deliberately doesn't: the idle timer
(`IDLE_LOCK_MS` = 10s, or `IDLE_LOCK_EXTENDED_MS` = 60s for the unlocked chat only — see
"Extend auto-lock to 1 minute" below) and fade timer (`FADE_MS` = 800ms), the token-expiry
timer, R7's suspension bookkeeping (`LockHooks.suspend(reason)` — reference-counted per call,
the idle timer stays paused while ANY suspension is active and restarts with a FRESH full idle
period (10s, or the chat's configured 60s) the moment the last one releases; `filePicker`
alone carries a `PICKER_SUSPEND_MAX_MS` = 5-minute safety auto-release), the R7 activity
listener set (`pointerdown`/`pointermove`/`touchstart`/
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

`panel.ts` calls the `createServerChatView` factory in `server/chatView.ts` after the first
successful unlock. It retains that view through later lock/unlock cycles and disposes it only
when routing away from `/admin/server`.

**Extend auto-lock to 1 minute** is a per-device checkbox in the chat's settings sheet
(`settingsSheet.ts`: a real `<label for>` row, at least 44px tall, default off). It stores `"1"`
under the localStorage key `wx-srv-idle-extended` (`server/idlePreference.ts`; absent, an
unreadable store, or any other value all mean off) and nothing about it is sent to the server.
Only the **unlocked chat's** idle lock — the first-unlock name prompt included — becomes 60s:
`lockModel.idleTimeoutMs(state, idleLockMs)` gives `chat` the duration the UI layer chose and
every other state that runs the idle timer (the decoy's "Open server settings" re-hide, the PIN
pad's idle close) the fixed 10s; the 60s value lives once, as `IDLE_LOCK_EXTENDED_MS` in
`constants.ts`. The 800ms fade, R7 suspensions, every other lock cause and reload are
unchanged. `panel.ts` reads the preference each time it (re)starts the idle timer and
re-schedules when it changes (the sheet's window event, or another tab's `storage` event)
against the recorded start of the current idle period, so a tick or untick applies at once but
never restarts the clock — only real user activity, or a suspension ending, does. The unlock
token lives 12 hours (`UNLOCK_TOKEN_TTL_S`), far past the longer idle window. An open settings
sheet also follows a change made in another tab, so its box never shows a stale "off" over an
active 60s. Covered by `admin-ui/tests/server/{idlePreference,lockModel,panel}.test.ts`,
`admin-ui/tests/serverSettingsSheet.test.ts` and the "auto-lock box" cases in
`e2e/tests/server-lock.spec.ts`.

**The settings sheet never outgrows its host** (`chat.css`). It is anchored to the bottom of
the chat host and is capped to the host's height minus what its content-box adds on top
(bottom padding, safe-area inset, borders — built from the same `--wx-srv-sheet-*` variables as
the padding, so the two cannot drift), scrolls its own contents, and pins its header (with the
close X) to the top of that scroll. Without that, on a short Android phone — where the push
row makes the sheet tallest, at roughly 668px of viewport height or less, or any landscape
phone — a content-height sheet grew upward past the host and its X ended up under the admin's
navigation, unreachable. The "android settings sheet" cases in `e2e/tests/server-lock.spec.ts`
use an Android user agent plus push stubs (so the push row really renders) and hit-test the X,
Delete all messages and Lock at 360x800/668/640/600/560 and 640x360.

Test coverage: `lockModel.ts` and `gestures.ts` both at 100% branch coverage
(`admin-ui/tests/server/{lockModel,gestures}.test.ts`); `panel.test.ts` covers the full
unlock flow, every R6 trigger (asserting `.wx-srv-thread` is actually ABSENT from the DOM,
not just hidden), R7's suspension timer math on a fake clock, and instance survival across
lock/unlock. `e2e/tests/server-lock.spec.ts` drives the same matrix in a real browser with
`page.clock`, desktop and mobile legs both.

## 12. Frontend chat and media (P5b/P6b)

`admin-ui/src/server/chatView.ts` owns the name prompt and stream lifecycle;
`admin-ui/src/server/thread.ts` owns message history, rendering, and the shared composer from
`admin-ui/src/chatComposer.ts`. `chatView.ts` guards the stream with an attach epoch that every
attach, detach and dispose advances: a lock that lands while history is still loading can never
open a stream afterwards, and a stale `locked` event or 401 from a previous unlock is ignored
(Inv 42). The chat composer enables its paperclip for `image/*` and
`video/*`, stages selected files immediately, and keeps Send disabled until every upload has
finished. Its progress element reflects uploaded bytes. A picker opening calls
`hooks.suspend("filePicker")`; the composer releases that suspension on the input's `change`
or `cancel` event. P4 also has a five-minute safety release for browsers that fail to emit
either event.

The 🎤 control uses `server/recorder.ts`. It requests microphone permission, shows a recording
timer, supports stop and cancel, and passes the resulting `File` into the same staged-upload
flow. Locking calls the recorder's `detach()` to discard an unfinished recording and release
the microphone. A new recorder is created on the next attach because a detached recorder is
terminal. Recordings shorter than one second are discarded with a “Too short” hint and never
uploaded.

A voice note that fails to send stays pending in `thread.ts` (`pendingVoiceNote`) with **Retry**
and **Discard** buttons side by side, so the owner is never stuck behind a note that cannot be
sent. Retry reuses the same `clientId` and, once the upload finished, the same attachment, so it
can never post a duplicate. The note is discarded automatically only on a verdict about the note
itself: at the upload stage a 400, 413 or 415 (`isDefinitiveUploadRejection` in
`server/upload.ts`); at the send stage a 422 or any other 4xx except 403, 408 and 429
(`isDefinitiveSendRejectionStatus` in `api/messages.ts`). Anything else (a network block, a
timeout, a 5xx, a gateway 403) keeps the note and offers Retry. A 401 locks the chat and also
keeps the note. An uploaded attachment left
behind by a discard is reaped by the server's janitor. Covered by
`admin-ui/tests/serverThread.test.ts`.

`server/api/uploads.ts` adapts `server/upload.ts` to the authenticated `serverFetch` wrapper.
It captures the current `ServerSession` when an upload starts, sends the chunked
`POST /uploads` → `PUT /uploads/{id}/chunks/{index}` → `POST /uploads/{id}/complete` sequence,
and maps uploaded-byte progress back to the composer. The shared `serverFetch` wrapper
preserves the caller's abort signal while applying its request timeout. Ordinary chat API
requests use a 10-second timeout; upload requests allow 120 seconds per chunk for slower
mobile uplinks; delete and wipe requests use their own 30-second timeout (§6). Locking
detaches the thread but keeps staged files and in-flight uploads in
memory; reattaching supplies a fresh session, while any upload already in flight continues
with its captured session. Removing a chip aborts its upload and makes a best-effort
authenticated `DELETE /uploads/{uploadId}` after init; failed uploads use the same cleanup,
so the server releases pending quota promptly. The aborted chip removal doesn't show an error.
On each reattach, `thread.ts` re-reads loaded history pages to mint fresh signed media URLs
for the new token expiry, and reconciles retained rows against that refreshed range before
advancing the stream cursor so deletes and wipes during a lock cannot resurface old messages.
Leaving the route disposes the view and aborts its uploads.

On send, `thread.ts` posts the staged attachment IDs in the message request. It uses
`server/mediaRender.ts` for processing/failed states, the photo grid and shared lightbox,
native video, and the voice-note player with waveform. The settings button and photo
thumbnails that open the lightbox carry `data-srv-gesture-boundary` per brief v1.5.2's R3
surface boundary. `gestures.ts` consumes that marker: a boundary tap can close a run begun
elsewhere, but an unmatched run is cleared afterward; non-primary clicks do not count.
P8's in-page choice controls use the same marker convention. During each message-list redraw,
unchanged message nodes are reused, so another incoming message does not interrupt active
playback. Replaced or deleted rows dispose their own media; lock detach pauses all players,
clears their sources, and releases each `mediaPlaying` suspension. These files and signed media
URLs remain separate from the site's `draft/media/` and public build, as documented in
[media.md](media.md#private-live-chat-attachments).

**Reactions in the thread** (`thread.ts`, `messageActions.ts`, `reactions.ts`). Under a message's
text and attachments, `renderBubble` adds a `.wx-srv-reactions` row (hidden when empty) of chip
buttons — glyph and count, `aria-pressed` for the reader's own, a `title` listing who reacted. Tapping
a chip calls `toggleReaction(seq, emoji)`, which sends `PUT …/reactions` with the opposite of the
reader's current state and the reader's display name; the menu's new emoji row (six round buttons at
the top of the ⋯ menu and the long-press sheet, `menuitemcheckbox`, each carrying
`data-srv-gesture-boundary` because it appears from the tap that opened the menu) calls the same
function. Chips are **not** gesture boundaries. A tapped chip dims and disables until the answer; a
reaction being added shows at once as a dimmed chip of one; a failure shows one line for five seconds
and a 401 locks. The trap the design answers: when a message differs from its rendered version only in
its reactions (`sameExceptReactions`), `renderThreadList` patches the row in place and calls the open
menu's `update()`, instead of rebuilding the bubble — a rebuild disposes media and would cut off a voice
note or video someone is playing on every reaction. A `PUT` response is applied only if no newer
message state arrived while it was out (`contentRevision`) and the chat was not wiped meanwhile
(`contentGeneration`); otherwise the stream supplies the state. A message from a server that predates
reactions (a blue/green swap) is read as having none. Covered by `admin-ui/tests/serverThread.test.ts`,
`serverMessageActions.test.ts`, `tests/server/{reactions,setReaction}.test.ts` and
`e2e/tests/server-reactions.spec.ts`.

Verification: `admin-ui/` runs `npm run typecheck` and `npm test`; the integrated browser
coverage is `e2e/tests/server-media.spec.ts` together with `server-chat.spec.ts` and
`server-lock.spec.ts`. The fixture server sets a 64 KiB chunk size so the photo case exercises
multiple chunks. Voice coverage launches Chromium with fake media-device and permission
flags and does not install the Playwright clock.

## 13. Delivery status

The feature branch contains the P1–P8 implementation and the fixes from the pre-delivery audit;
P7 closes this manual, invariants, and decision log, and they describe the code as built. The
code parcels are: P1 (settings, storage paths, the `livechat/` package's `models`/`store`/
`tokens`/`pinclient`/`notifier`, `routes_livechat.py` — unlock/history/send/stream/usage, the
`fake_cmd.py` PIN double, the `server` field on `GET /api/admin/system/status`); **P2a**
(`livechat/processing.py`, §8 above); **P2b** (`livechat/{uploads,media_queue,janitor}.py`,
`routes_livechat_media.py`, §8 above — `mediaProcessing` reflects media-dependency availability
(ffmpeg, ffprobe and `pillow-heif`) and supervised media/erasure health (`unavailable`,
`degraded`, or `ok`)); **P3a/P3b** (Web Push — VAPID keys, the service worker, protected push
routes, the dispatch hook, and the Android toggle, mounted in the settings sheet — §7);
**P4** (frontend lock/disguise/PIN-pad core
— §11 above — the router/nav entry, the lock state machine, the decoy, the PIN pad, and the
orchestrating panel that wires both gesture detectors, R7's idle/suspension timers, and every
R6 lock trigger); **P5b** (the real chat view and thread); **P6a/P6b** (upload, recording,
rendering, and media wiring; §12 above); P8 adds hard delete, wipe, transactional erasure
journals, and restartable cleanup (see §6).

Delivery to `main` and live verification are separate release steps.

## 14. Release notes and delivery merge (R14a)

The ONE feature delivery merge from `cmd/workspace-00029` to `main` must be a squash with a
hand-written body whose only `Release-note:` line is exactly
`Release-note: Added a Server page showing your website's server status.` Never accept
GitHub's default squash body: it copies the individual commit messages, including descriptive
trailers, into the release commit. `routes_version.resolve_release_notes` runs plain
`git log --format=%B`, not first-parent history, so every commit's trailer can reach the
owner-facing update popup. After delivery, every commit touching Server chat must carry
exactly `Release-note: General bug fixes and improvements.` and no release-note line may name
the chat, messages, photos, video, voice, PIN, or locking.

## 15. Voice-note transcription (opt-in, private)

Spec: [`spec/server-chat/05-voice-transcription.md`](../../spec/server-chat/05-voice-transcription.md);
privacy and cost note: [decisions/00166](../../decisions/00166-voice-transcription-privacy-and-cost/decision.md);
design record: [decisions/00167](../../decisions/00167-voice-transcription-design/decision.md);
guarantee: [Inv 50](invariants.md). A **Transcribe** button on a ready voice note; never automatic,
never on upload.

**The cmd hop (`livechat/transcribe.py`, `CmdTranscriber`).** cmd's plain `POST /api/transcribe`
retains the audio and transcript (a rolling `dictation-audio/` buffer, the ASR shadow log), where
delete and wipe cannot reach them, so wixy uses it only through cmd's **private mode**: form fields
`private=1` and `cleanup=0` (no LLM sees the text), multipart `audio`, and **no `session_id`, no
`context`**. It first calls `GET /api/transcribe/capabilities` and needs a literal
`{"private": true}` (cached 60 s both ways; the cache is dropped on a transport failure or any
unexpected status — 404, 401, a 5xx other than `asr_warming` — but not on a timeout, a rejection or
`warming`; the probe has a whole-call time limit). False, missing, malformed or unreachable ⇒
unavailable. `available(fresh=True)` skips the cache: a job uses it immediately before any audio
leaves. Response mapping: 200 with `text` (or `raw`) → ok (an empty
string is a valid "nothing said"; more than 200,000 characters is refused as invalid); 503
`asr_warming` → `warming`; other 503/5xx/transport → `unavailable`; 400/413/415/422 → `rejected`;
budget exceeded → `timeout`. No retries. `create_app(..., transcriber=)` is the injection seam
(default `CmdTranscriber()` on the fleet, `None` on standalone); tests and the e2e fixture point it at
`fake_cmd.py`'s double, whose `transcribe_private_supported=False` behaves like today's retaining cmd
(it records what it would have kept in `transcribe_retained`, which the privacy tests assert empty).

**Storage.** `attachment_transcripts(attachment_id PK → attachments(id) ON DELETE CASCADE, status
pending|done|failed, text, failure, engine, created_at, updated_at)`. Every attachment load goes
through one joined `SELECT` (`_SELECT_ATTACHMENT`), so `AttachmentRow.transcript` can never be
missing. The table's existence is ALSO checked independently of `PRAGMA user_version` on every
connect (a plain `sqlite_master` read, free once it exists) — three round-2 branches each
independently claim the next schema version for their own new table, so a database that reached the
current version through a sibling branch's migration must not be left permanently missing this one.
`begin_transcript` decides start/pending/done/gone in one write transaction and announces a
new `pending` with `message_updated`; `finish_transcript` is an `UPDATE` whose row count says whether
the row still exists (a result after delete/wipe is discarded, no event); `fail_stale_pending_
transcripts` runs at startup, and a job cancelled by shutdown records itself `failed` (`interrupted`)
under a shield on its way out — only if the row is still `pending` (`only_if_pending`), so it can
never erase a finished transcript. (Slots restarts Wixy in place with a forced stop, so in a real
deploy the startup sweep, not this handler, is what clears such a row.) The `failure` code
(`unavailable`, `warming`, `timeout`, `rejected`, `invalid_response`, `media_missing`, `too_long`,
`interrupted`, `error`) is server-side only.

**The route and job (`routes_livechat.py`, `livechat/transcription.py`).**
`POST /attachments/{id}/transcribe` answers at once: 404 (not a sent voice note), 409 (not ready),
200 (already `done`), 202 (this process already has a job for it — `TranscriptionRuntime.inflight`
is the single-flight authority), 503 `not_configured`, 429 (6 new jobs a minute per identity), else
the note is claimed in process before the first `await`, a `pending` row is written and a job runs on
the contained group → 202. A `pending` row with no job behind it (its outcome could not be recorded)
is restarted by the next request (`begin_transcript(restart_pending=True)`). The job
(`TranscriptionRuntime.run_job`) waits for the global one-at-a-time slot, reads
`media/<id[:2]>/<id>/play.m4a`, asks cmd afresh whether it still promises private mode, sends it with a budget of **60 s + 0.5 × the
note's seconds**, and records `done`/`failed`, which appends `message_updated`; the stream delivers
`Attachment.transcript` to every device. `GET /usage` gains `transcriptionAvailable`.

**Frontend (`admin-ui/src/server/transcript.ts`).** Per voice note, one `.wx-srv-transcript` block:
Transcribe (only while `transcriptionAvailable`, read once per attach) → "Transcribing…" spinner →
text + per-device Hide/Show (a `Set` in `thread.ts`, memory only) → or an error + Retry. A
transcript-only `message_updated` is patched into the live bubble (`differOnlyInTranscripts` →
`patchTranscriptBlocks`) so a playing `<audio>` is never disposed; anything else still rebuilds the
bubble. A `202` reply cannot overwrite a newer stream update (a quick job's update can beat the
reply). Text is set with `textContent`, never markup; the control is not a gesture boundary.

**Operating it.** See [runbook.md](runbook.md) ("Voice-note transcription"): the feature stays hidden
until cmd's private mode is deployed and the probe answers `true`; verify a real note end to end.
