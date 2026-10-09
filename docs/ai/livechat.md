# Subsystem: server chat (the "Server" panel)

A hidden human↔human live chat for admin users, disguised as a **"Server"** nav tab inside
the already CF-Access-gated `/admin`. Not the AI assistant, not visitor-facing — its own
storage, routes, and second auth gate, entirely separate from `chats.py`/`cmdchat.py`/
`draft/media/`. Full decided design: [`spec/server-chat/00-brief.md`](../../spec/server-chat/00-brief.md).
This manual describes the current implementation; where intent and code differ, follow the
code and record the difference in `decisions/`.
Numbered guarantees: [invariants.md](invariants.md) 40–47, 48 (permanent unlock), 49 (reactions),
50 (transcription, §15), 51 (reply to a message, §12), 52 (view-once media, §17) and
53 (live drawing, §18).

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
  device where the owner ticked **Unheard voice notes** (`heardStore.ts`, `thread.ts`): nothing on the server tracks whether a voice
note was listened to — this is per-device state in localStorage `wx-srv-voice-heard`
(`{since, ids[]}`, newest 1000 ids; unreadable storage = nothing remembered; never sent anywhere).
A received voice note (sender not this device's name, not view-once, `ready`, created at or after
`since` — the device's first run of the feature, so old history is not suddenly "unheard") is
unheard until: playback reaches `HEARD_THRESHOLD` (90%) *during natural playback* (dragging a paused
note to the end does not count; `onVoiceListened` in `MediaRenderContext`), its transcript is
requested (`requestTranscription`), or it is dismissed. When any unheard note's bubble has scrolled
above the thread viewport, `.wx-srv-unheard-tab` ("N unread voice notes", bottom-left; the jump pill
is bottom-right) appears. It opens `.wx-srv-unheard-view`, a full-screen overlay below the header
(panic ✕ and lock gestures stay reachable) listing the same `renderBubble(…, embedded)` bubbles —
same player, skip buttons and transcript block, minus the message-action menu — each with a Dismiss
button. A note finished while the view is open stays until the view closes; transcript updates patch
in place. `detach()`/`teardown()` close it.

**Composer focus + the header ... menu.** With `promoteToFullWidthOnMultiline` (Server chat only) the
text box takes its own full-width line the moment it is focused (`chatComposer.ts`
`promotedByFocus`), not only once the text wraps. When focus leaves it goes back to its place —
unless the draft has grown past one line (a newline, or it still wraps in the narrow inline box) —
but never mid-gesture: collapsing at the instant of a blur moved every control (and the thread
above) under the tap that caused it, so a double-tap on a message or a tap on a button missed
(measured by the `server-tap-precision`/`server-reply`/`server-view-once` e2e). The collapse waits
`COLLAPSE_AFTER_BLUR_MS` (450ms) after the blur and for no pointer to be down; a refocus cancels it.
Attach/mic stay at the left and Send keeps its place at
the right edge (`margin-left: auto` in the promoted row), so no button moves when the box jumps up.
The header's `⋯` button (`.wx-srv-more-button`, first of the right-hand buttons) opens
`.wx-srv-more-menu`; its first item, **Canvas**, calls `POST /messages/canvas` and scrolls to the new
message. A **canvas message** (schema v14, `messages.canvas INTEGER NOT NULL DEFAULT 0`; wire
`canvas: true`; no text, no attachments) renders as a full-width bubble holding
`.wx-srv-canvas-surface`, a muted theme-coloured surface at a fixed 4:5 aspect ratio (a ratio, not a
pixel height, so the pen's uniform draw-space scale stays right at every width — spec 07 §1). It
exists so the pen, whose drawings anchor to a message, has reserved space instead of drawing over
other text. The pen is still turned on with its own button. Quoting a canvas shows only the sender.

**Extend auto-lock to 1 minute** in the chat's settings sheet
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

A device the owner has told to **keep itself unlocked** has a second way to obtain the unlock
token: a device grant (§16), created only with the PIN, which mints the same token through
`POST /unlock-with-grant`. It replaces typing the PIN — never the token, never CF Access.

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
`deleted_storage`, `pending_wipe_cleanup`, `pending_scrub`, `attachment_transcripts` (a voice
note's opt-in transcript, `ON DELETE CASCADE` from its attachment — §15), `device_grants`
(schema v9, §16 — auth credentials, not chat content, so delete/wipe leave them alone), and
`drawings`/`drawing_strokes` (schema v13, Inv 53, §18 — cascade on the anchor message, exactly
like reactions). Schema migrations are serialized under the SQLite writer lock.
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
Schema v9 adds `device_grants` (Inv 48), described in §16. Schema v10 adds
`messages.reply_to_seq` (nullable, self-referencing, `REFERENCES messages(seq) ON DELETE
SET NULL`) for reply-to-a-message (round 2 ruling item 10, Inv 51), plus the partial index
`idx_messages_reply_to` — required, not tuning: `wipe()`'s bulk `DELETE FROM messages` searches
this child column once per deleted row for the `SET NULL` action, and unindexed that measured
17.6s vs 0.2s at 20,000 messages (one in three a reply). A reply persists only the target's seq;
its quote (sender, a 300-code-point text snippet, and a media summary) is resolved at read time
from the target's live row by `list_messages`/`get_messages`, one level only, and is never stored.
Schema v13 adds `drawings`/`drawing_strokes` (Inv 53, live drawing — the pen tool), described in
§18; the number is 13, not 11 or 12, because those were already spent by view-once media and the
Spotlight→Tease rename (decisions/00172) by the time this feature landed.
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
display name; the sheet unmounts it on close. Desktop and other browsers see an
informative note that notifications are currently supported on Android devices only.
`e2e/tests/server-push.spec.ts` proves both: a desktop browser shows no toggle control,
and an Android browser enables and disables the subscription through the sheet.

After a message commits, the registered dispatch hook sends a payloadless Web Push
request to every subscription except the message's device and case-insensitive sender.
Requests use a shared HTTPX client with a 10-second timeout and concurrency capped at
four. A 201 records success; 404/410 deletes the subscription; other failures are
counted and the subscription is deleted after ten consecutive failures.

The service worker is served at `/admin/server-sw.js` before the admin SPA catch-all.
It emits only the generic `Server` title, with a body chosen at random from a small fixed set of
equally generic phrases (`NOTIFICATION_BODIES` — Inv 45; rotating avoids Chrome flagging a
site that repeats byte-identical notifications as spam, degrading the display), issues it silently for
a visible focused Server page to satisfy the browser's `userVisibleOnly` push contract
without disrupting the user, and routes notification clicks to `/admin/server`. It has
no fetch handler. Upon showing the notification, `handlePush` notifies active clients via
both `postMessage({ type: "push-shown" })` and a `BroadcastChannel("wx-server-push")` event
to confirm display.

`server/pushToggle.ts` derives an **honest state** rather than trusting the server's record alone:
1. `Notification.permission === "denied"` immediately yields a `blocked` state with guidance to allow notifications in site settings.
2. If the server says subscribed, the browser verifies that a service worker registration exists at scope `/admin/` and that `pushManager.getSubscription()` returns an active subscription whose endpoint equals the server's stored endpoint.
3. If the server says subscribed but the browser lacks permission, lacks a registration, or has a mismatched/missing subscription, the toggle enters a `needs_re-enabling` state with a single-tap repair button ("Re-enable notifications") that re-subscribes and updates the server.
4. When enabled, a "Send me a test notification" button allows verification. Tapping it starts a visible 10-second countdown ("Sending in 10s… you can switch away from Chrome now") before the request fires (operator report, round 2: dispatching immediately made it impossible to actually leave the foreground before the push arrived, so a foreground-only failure could never be distinguished from a true backgrounded-delivery failure). After the countdown, it calls `POST /api/admin/server/push/subscriptions/{deviceId}/test` (token-gated, rate-limited to 1 request per 5 seconds per device). This route sends one payloadless push to the calling device's own subscription only (bypassing sender exclusion) after re-validating the endpoint.
5. Round-trip evidence: If the service worker confirms display within ~60 seconds via BroadcastChannel or client postMessage, the UI reports "Your phone received the test and showed it." If the push service accepts the request (201) but the phone does not confirm within that window, it reports "Google accepted it but your phone did not confirm within ~60 seconds" alongside plain-English troubleshooting hints (check Android Settings -> Apps -> Chrome -> Notifications is On; Chrome -> Settings -> Site settings -> Notifications must allow this site; battery saver / "restrict background" can delay or drop them). The wait was originally 10 seconds; extended after a live investigation (round 2) on a real device could not tell "arrives late" apart from "never arrives" in that window. If the push service rejects the request, it reports "The push service rejected it (status N)".

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
| `WIXY_SERVER_MIN_FREE_MB` | `server_min_free_bytes` | 1024 MiB (1 GiB) | R10 — the disk free-space floor, enforced alongside the quota |
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
(`livechat-media`, `livechat-erasure`, and `livechat-view-once-backstop`, among others) use `supervise`: exceptions are logged,
health is recorded, and loops restart with exponential backoff capped at 60 seconds. One-shot
work uses `spawn`, which logs and contains an exception. No worker exception can cancel the
lifespan task group; media-queue items and push recipients are also isolated from sibling items.

The erasure worker starts immediately and retries every two seconds. It removes
`deleted_storage` paths, resumes `pending_scrub` WAL work, and runs the full wipe/orphan sweep at
startup and while `pending_wipe_cleanup` exists. The hourly janitor runs once at startup and then
every hour: it removes stale uploads and unclaimed orphan attachments after 24 hours, removes
raw upload sources for ready attachments, retries archiving failed originals, expires an
unarchived failed original after seven days, and prunes completed cleanup rows after seven days.
It never ages out pending work. The view-once backstop (`livechat-view-once-backstop`, spec 06) runs
once at startup and then every 30 seconds: it sweeps claimed view-once messages older than 600
seconds where the claimant disconnected or abandoned the download, permanently deleting their
database rows and storage.

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
`wrong`/`lockedOut`/`unavailable` error), `verifying`, `chat`, `fading`, plus the two round-2 states
`granting` and `shielded` (§16). One deliberate
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

**Recording keeps the screen awake.** While a voice note records (including paused),
`recorder.ts` holds a Screen Wake Lock (`navigator.wakeLock.request("screen")`, injectable as
`wakeLock`), so the phone's own display timeout cannot background the page — a `hidden` lock
(which `recording` deliberately does not excuse) would otherwise detach the chat and discard the
note. Released in `cleanup()`; a late-resolving request releases itself; unsupported or refused
is silent. Idle-lock suspension and the fresh full idle period on stop were already R7 behaviour.

**Voice-note playback controls** (`mediaRender.ts` `renderVoice`): a full-width waveform with a
playhead line (`--wx-srv-seek` 0..1 on `.wx-srv-voice-scrub`, driven by `timeupdate`) and, below it,
a draggable tab (`.wx-srv-voice-seek-tab`, `role=slider`, pointer-captured drag, arrow keys ±5s) so a
finger never covers the line. Under that one row: back, play/pause and forward icon buttons (44px)
and the elapsed time. A tap on back/forward jumps 10s (`VOICE_SKIP_S`); holding past
`VOICE_HOLD_DELAY_MS` (350ms) scrubs continuously at `VOICE_HOLD_SEEK_RATE` = 2.5x net of normal
playback (100ms ticks, real elapsed time) until release. Keyboard activation (click with `detail` 0)
also skips 10s. Seeking never touches the `mediaPlaying` suspension; pointer events count as R7 activity.

**Extend auto-lock to 1 minute** in the chat's settings sheet
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

A device the owner has told to **keep itself unlocked** has a second way to obtain the unlock
token: a device grant (§16), created only with the PIN, which mints the same token through
`POST /unlock-with-grant`. It replaces typing the PIN — never the token, never CF Access.

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
`deleted_storage`, `pending_wipe_cleanup`, `pending_scrub`, `attachment_transcripts` (a voice
note's opt-in transcript, `ON DELETE CASCADE` from its attachment — §15), `device_grants`
(schema v9, §16 — auth credentials, not chat content, so delete/wipe leave them alone), and
`drawings`/`drawing_strokes` (schema v13, Inv 53, §18 — cascade on the anchor message, exactly
like reactions). Schema migrations are serialized under the SQLite writer lock.
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
Schema v9 adds `device_grants` (Inv 48), described in §16. Schema v10 adds
`messages.reply_to_seq` (nullable, self-referencing, `REFERENCES messages(seq) ON DELETE
SET NULL`) for reply-to-a-message (round 2 ruling item 10, Inv 51), plus the partial index
`idx_messages_reply_to` — required, not tuning: `wipe()`'s bulk `DELETE FROM messages` searches
this child column once per deleted row for the `SET NULL` action, and unindexed that measured
17.6s vs 0.2s at 20,000 messages (one in three a reply). A reply persists only the target's seq;
its quote (sender, a 300-code-point text snippet, and a media summary) is resolved at read time
from the target's live row by `list_messages`/`get_messages`, one level only, and is never stored.
Schema v13 adds `drawings`/`drawing_strokes` (Inv 53, live drawing — the pen tool), described in
§18; the number is 13, not 11 or 12, because those were already spent by view-once media and the
Spotlight→Tease rename (decisions/00172) by the time this feature landed.
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
display name; the sheet unmounts it on close. Desktop and other browsers see an
informative note that notifications are currently supported on Android devices only.
`e2e/tests/server-push.spec.ts` proves both: a desktop browser shows no toggle control,
and an Android browser enables and disables the subscription through the sheet.

After a message commits, the registered dispatch hook sends a payloadless Web Push
request to every subscription except the message's device and case-insensitive sender.
Requests use a shared HTTPX client with a 10-second timeout and concurrency capped at
four. A 201 records success; 404/410 deletes the subscription; other failures are
counted and the subscription is deleted after ten consecutive failures.

The service worker is served at `/admin/server-sw.js` before the admin SPA catch-all.
It emits only the generic `Server` title, with a body chosen at random from a small fixed set of
equally generic phrases (`NOTIFICATION_BODIES` — Inv 45; rotating avoids Chrome flagging a
site that repeats byte-identical notifications as spam, degrading the display), issues it silently for
a visible focused Server page to satisfy the browser's `userVisibleOnly` push contract
without disrupting the user, and routes notification clicks to `/admin/server`. It has
no fetch handler. Upon showing the notification, `handlePush` notifies active clients via
both `postMessage({ type: "push-shown" })` and a `BroadcastChannel("wx-server-push")` event
to confirm display.

`server/pushToggle.ts` derives an **honest state** rather than trusting the server's record alone:
1. `Notification.permission === "denied"` immediately yields a `blocked` state with guidance to allow notifications in site settings.
2. If the server says subscribed, the browser verifies that a service worker registration exists at scope `/admin/` and that `pushManager.getSubscription()` returns an active subscription whose endpoint equals the server's stored endpoint.
3. If the server says subscribed but the browser lacks permission, lacks a registration, or has a mismatched/missing subscription, the toggle enters a `needs_re-enabling` state with a single-tap repair button ("Re-enable notifications") that re-subscribes and updates the server.
4. When enabled, a "Send me a test notification" button allows verification. Tapping it starts a visible 10-second countdown ("Sending in 10s… you can switch away from Chrome now") before the request fires (operator report, round 2: dispatching immediately made it impossible to actually leave the foreground before the push arrived, so a foreground-only failure could never be distinguished from a true backgrounded-delivery failure). After the countdown, it calls `POST /api/admin/server/push/subscriptions/{deviceId}/test` (token-gated, rate-limited to 1 request per 5 seconds per device). This route sends one payloadless push to the calling device's own subscription only (bypassing sender exclusion) after re-validating the endpoint.
5. Round-trip evidence: If the service worker confirms display within ~60 seconds via BroadcastChannel or client postMessage, the UI reports "Your phone received the test and showed it." If the push service accepts the request (201) but the phone does not confirm within that window, it reports "Google accepted it but your phone did not confirm within ~60 seconds" alongside plain-English troubleshooting hints (check Android Settings -> Apps -> Chrome -> Notifications is On; Chrome -> Settings -> Site settings -> Notifications must allow this site; battery saver / "restrict background" can delay or drop them). The wait was originally 10 seconds; extended after a live investigation (round 2) on a real device could not tell "arrives late" apart from "never arrives" in that window. If the push service rejects the request, it reports "The push service rejected it (status N)".

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
| `WIXY_SERVER_MIN_FREE_MB` | `server_min_free_bytes` | 1024 MiB (1 GiB) | R10 — the disk free-space floor, enforced alongside the quota |
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
(`livechat-media`, `livechat-erasure`, and `livechat-view-once-backstop`, among others) use `supervise`: exceptions are logged,
health is recorded, and loops restart with exponential backoff capped at 60 seconds. One-shot
work uses `spawn`, which logs and contains an exception. No worker exception can cancel the
lifespan task group; media-queue items and push recipients are also isolated from sibling items.

The erasure worker starts immediately and retries every two seconds. It removes
`deleted_storage` paths, resumes `pending_scrub` WAL work, and runs the full wipe/orphan sweep at
startup and while `pending_wipe_cleanup` exists. The hourly janitor runs once at startup and then
every hour: it removes stale uploads and unclaimed orphan attachments after 24 hours, removes
raw upload sources for ready attachments, retries archiving failed originals, expires an
unarchived failed original after seven days, and prunes completed cleanup rows after seven days.
It never ages out pending work. The view-once backstop (`livechat-view-once-backstop`, spec 06) runs
once at startup and then every 30 seconds: it sweeps claimed view-once messages older than 600
seconds where the claimant disconnected or abandoned the download, permanently deleting their
database rows and storage.

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
`wrong`/`lockedOut`/`unavailable` error), `verifying`, `chat`, `fading`, plus the two round-2 states
`granting` and `shielded` (§16). One deliberate
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

**Recording keeps the screen awake.** While a voice note records (including paused),
`recorder.ts` holds a Screen Wake Lock (`navigator.wakeLock.request("screen")`, injectable as
`wakeLock`), so the phone's own display timeout cannot background the page — a `hidden` lock
(which `recording` deliberately does not excuse) would otherwise detach the chat and discard the
note. Released in `cleanup()`; a late-resolving request releases itself; unsupported or refused
is silent. Idle-lock suspension and the fresh full idle period on stop were already R7 behaviour.

**Voice-note playback controls** (`mediaRender.ts` `renderVoice`): a position bar (`input[type=range]`,
`.wx-srv-voice-seek`) follows `timeupdate` and seeks on drag, plus two 44px buttons. A tap on
`−10`/`+10` jumps 10s (`VOICE_SKIP_S`); holding past `VOICE_HOLD_DELAY_MS` (350ms) scrubs
continuously at `VOICE_HOLD_SEEK_RATE` = 2.5x net of normal playback (ticks every 100ms, using real
elapsed time) until release. Keyboard activation (click with `detail` 0) also skips 10s. Seeking
never touches the `mediaPlaying` suspension; the pointer events count as ordinary R7 activity.

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

The 🎤 control uses `server/recorder.ts`. It requests microphone permission, hides the composer
text input and Send button in favour of a dedicated recording row, provides a Pause/Resume button
that freezes the elapsed recording timer and excludes paused intervals from the delivered audio
duration, supports stop and cancel, and passes the resulting `File` into the same staged-upload
flow. Locking calls the recorder's `detach()` to discard an unfinished recording and release
the microphone. A new recorder is created on the next attach because a detached recorder is
terminal. Recordings shorter than one second are discarded with a “Too short” hint and never
uploaded.

The Server-chat composer inserts a newline on Enter (sending is the Send button). When the draft
contains a newline or soft-wraps in the inline row, the textarea moves above the controls at full
width and keeps that layout until the draft clears; it grows to 180px, then scrolls internally.
The shared AI chat composer keeps its Enter-to-send default. While a voice note uploads/sends, the
recording row stays in place with disabled controls and a centered throbber; the in-flight state
has an accessible status label.

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

### Reply to a message (round 2 ruling item 10, Inv 51)

`server/replyTo.ts` is the one place both the composer's reply preview and every rendered quote
build from: `replyToFromMessage(message)` mirrors the server's `reply_to_json` client-side (a
required drift guard — both are asserted against the shared fixture
`spec/server-chat/fixtures/reply-to-cases.json`, by `test_livechat_reply_to_driftguard.py` and
`admin-ui/tests/server/replyTo.test.ts`), and `renderReplyQuoteContent` renders the shared inner
quote block (accent bar, sender or "You", a 2-line-clamped snippet, and a 40px thumbnail or a text
label) that every context wraps differently: a sent bubble wraps it in a `<button class="wx-srv-
quote">` (tap-to-scroll, `data-srv-gesture-boundary`, an accessible name reading "Show the
original message from <name>"); the composer's reply bar (`.wx-srv-reply-bar`, above the input
row, hidden by default like the jump pill) and the optimistic echo wrap it in a plain, non-
interactive `<div>`.

`thread.ts` picks a target via the message action menu's "Reply" item (`messageActions.ts`, first
above "Copy text" on every confirmed message); the target becomes part of the composer's own
draft — a local `ServerComposerDraft` wraps `chatComposer.ts`'s frozen `takeDraft`/`restoreDraft`/
`discardDraft` alongside the reply target, rather than widening that shared-with-the-AI-chat
component's type, since only server chat uses its `keepInputLive` draft mechanism at all. A failed
send restores the reply target with the text; a successful one discards it. A voice note captures
the reply target the moment recording stops (the bar clears at once) and keeps it across retries
(same `clientId`). Escape never cancels a reply (R3's panic lock is unrelated); only ✕, a send, the
target's own deletion, and a wipe do. A lock (`detach()`) keeps the pending reply in memory exactly
like the draft text, but does abort an in-flight scroll-to-original.

Tapping a sent bubble's quote (`scrollToOriginal` in `thread.ts`) scrolls to the original, centres
it, and highlights it for ~1.5s (`scrollIntoView`'s own `behavior` option is `"auto"` under
`prefers-reduced-motion`, never a CSS `scroll-behavior` — that would also make `loadOlderPage`'s
own precise `scrollTop` restoration animate, breaking its "never visually jump" guarantee). If the
original isn't loaded yet, it pages backwards with the existing `before` cursor at its own larger
page size (`SCROLL_TO_ORIGINAL_PAGE_SIZE`, 100 vs. the ordinary 50) via the same
`loadOlderPage`, which returns one of `"loaded"|"blocked"|"exhausted"|"error"` rather than a bare
boolean — `"blocked"` (another load, ordinary or a sibling scroll-to-original, holds the single
history-load slot) is distinct from `"exhausted"` precisely so a second quote tapped mid-page
retries instead of wrongly concluding its target was deleted. A `scrollToOriginalGeneration`
counter aborts a stale run's continuation (never its underlying network call) on a lock, a wipe, or
another tap; the quote shows busy (`.wx-srv-quote-busy`) meanwhile. Never found once paging
exhausts (deleted in the meantime) removes the quote via the same path `message_deleted` uses.

Client-side erasure (Inv 46/Inv 51) — see Inv 51's own text for the full three-mechanism picture
(audit F3/F9: an earlier version of this doc called `message_deleted` the "only signal", which is
false and reads as an invitation to delete the other two as redundant). Live and unlocked, the
server does not fan out `message_updated` for a reply on the target's delete, so
`message_deleted{seq}` is what `removeQuotesTargeting(seq)` reacts to: it removes the
`.wx-srv-quote` element IN PLACE from every loaded bubble and pending echo whose quote targets
`seq`, and cancels the composer's pending reply if it targets `seq`, never re-rendering a whole
bubble (the same voice/video cut-off trap Inv 46's own client mechanism avoids for delete) —
clearing the pending reply's bar content too, not merely hiding it (F8). Across a lock, where that
event is never delivered (the stream resumes from a fresh cursor on reattach), `patchQuote` and
`attach()`'s own pending-reply check do the equivalent job, because the server always resolves
`replyTo` fresh on every read. Quote freshness the other direction is a real `message_updated`,
fanned out server-side by `finish_attachment` to every reply of the message whose attachment just
finished — the same `patchQuote` path patches just that bubble's quote, in place.

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
200 (already `done` when not re-transcribing), 202 (fresh job, or re-transcribing an existing `done`
row via `?retranscribe=1` / `?force=1` which replaces it in place via
`begin_transcript(restart_done=True)`, or this process already has a job for it —
`TranscriptionRuntime.inflight` is the single-flight authority), 503 `not_configured`, 429 (6 new jobs
a minute per identity), else the note is claimed in process before the first `await`, a `pending` row is
written and a job runs on the contained group → 202. A `pending` row with no job behind it (its outcome
could not be recorded) is restarted by the next request (`begin_transcript(restart_pending=True)`). The job
(`TranscriptionRuntime.run_job`) waits for the global one-at-a-time slot, reads
`media/<id[:2]>/<id>/play.m4a`, asks cmd afresh whether it still promises private mode, sends it with a budget of **60 s + 0.5 × the
note's seconds**, and records `done`/`failed`, which appends `message_updated`; the stream delivers
`Attachment.transcript` to every device. `GET /usage` gains `transcriptionAvailable`.

**Frontend (`admin-ui/src/server/transcript.ts`).** Per voice note, one `.wx-srv-transcript` block:
Transcribe (only while `transcriptionAvailable`, read once per attach) → "Transcribing…" spinner →
text + per-device Hide/Show (a `Set` in `thread.ts`, memory only) + Re-transcribe (re-POSTs with
`?retranscribe=1`, replacing finished text in place; if the re-transcribe attempt fails, the prior
successful transcript text is preserved rather than wiped) → or an error + Retry. A
transcript-only `message_updated` is patched into the live bubble (`differOnlyInTranscripts` →
`patchTranscriptBlocks`) so a playing `<audio>` is never disposed; anything else still rebuilds the
bubble. A `202` reply cannot overwrite a newer stream update (a quick job's update can beat the
reply). Text is set with `textContent`, never markup; the control is not a gesture boundary.

**Operating it.** See [runbook.md](runbook.md) ("Voice-note transcription"): the feature stays hidden
until cmd's private mode is deployed and the probe answers `true`; verify a real note end to end.

## 16. Device grants and the lock checkboxes (round 2, `spec/server-chat/03-permanent-unlock.md`)

**What it is.** A per-device setting, switched on with the PIN from the settings sheet, that keeps
the chat unlocked on that device until someone locks it on purpose. Spec §1 is the ruling and
Inv 48 the rule; this section is the code as built.

### Server

- **Migration v9** (`store._SCHEMA_V9_DEVICE_GRANTS`, `_LATEST_SCHEMA_VERSION` — the one place the
  version lives; tests import it) adds `device_grants(id, secret_hash, email, label, created_at,
  last_used_at, revoked_at)`. `CREATE TABLE IF NOT EXISTS`, so it is idempotent across a blue/green
  overlap. `livechat/grants.py` owns the constants (five live grants per identity, 30-day idle
  expiry, seven-day revoked-row retention, the 10-failures-a-minute limit), `new_grant()`, the
  strict canonical-base64url secret parser and the display-label cleaner.
- **Routes** (contracts.md): `POST /device-grants` (guard → token → label → cmd PIN → create),
  `POST /unlock-with-grant` (guard → failure limit → validate → redeem → mint),
  `DELETE /device-grants/{id}` and `DELETE /device-grants` (guard → token → revoke). The PIN check is
  the extracted `_verify_pin` helper `/unlock` also uses; `_request_guard_refusal` is the shared
  guard. `LiveChatStore.redeem_device_grant` runs every check against a fixed dummy hash when the id
  is unknown so an unknown id and a wrong secret cost the same, and stamps `last_used_at` only on
  success.
- **Failure limiter** (`GrantFailureLimiter`, `app.state.livechat_grant_limiter`): per identity, in
  memory, per process. It stops a misbehaving client hammering the database; it is not the security
  control (a 256-bit secret cannot be guessed).
- **Janitor** (hourly, `janitor.run_once`): revokes live grants unused for 30 days, deletes rows
  revoked for more than seven (`secure_delete` zeroes them).
- **Other identity's grant = 404.** Revoking someone else's grant, or an unknown or malformed id, is
  `404 {"error":"not_found"}` — indistinguishable. Revoking your own already-revoked grant is 204
  *while its row still exists* — the janitor deletes it after 7 days, past which a repeat DELETE is
  404 like an unknown id (audit F3, accepted: the client already clears its local keys on any
  non-2xx response here, so this is harmless in practice). `Cache-Control: no-store` is set on the
  two responses that carry a credential.
- **Bound tokens end their session on revoke (§9, audit F4).** `POST /device-grants` and
  `POST /unlock-with-grant` both mint a token carrying the grant id as payload key `"g"` (32
  lowercase hex; `POST /unlock`'s PIN-minted tokens never carry it). `require_server_token`
  re-checks a `"g"`-bearing token's grant is still live (`store.is_device_grant_live`, a read-only
  PK lookup, no write) on every request; `GET /stream`'s loop repeats the same check on its
  existing ~2s tick; a bound `GET /media` URL carries `&g=` and folds the grant id into its HMAC
  (`media|{attId}|{rendition}|{exp}|{email}|{g}`), so it dies with the grant too. Revoking a grant
  therefore ends every session and media link minted from it within about 2 seconds — not just
  future mints. **No route ever exchanges a bound token for an unbound one** — that would be a way
  around this fix. `DELETE /device-grants` ("Sign out other devices") revokes every OTHER live
  grant of the identity, reading the caller's OWN grant off its own token's `"g"` and sparing it
  (an unbound caller — a plain PIN session — spares nothing, so it revokes all of them); the copy
  "Done — your other devices are signed out." is therefore literally true. `DELETE
  /device-grants/{ownId}` — turning the setting off — kills the session bound to it at once, on
  purpose.

### Client (`admin-ui/src/server/`)

- `deviceGrant.ts` — the two localStorage keys and their events; `api/grants.ts` — the four calls
  (all send the guard headers; `createDeviceGrant` attaches the token by hand because a wrong PIN is
  a 401 that must NOT be read as "locked").
- `lockModel.ts` — the reducer takes `LockContext.grantActive` as an input (no second machine):
  with it, `lock idle` and `lock routeAway` are ignored from `chat`/`fading`. New states:
  `granting` (a mount is minting this visit's token — the panel shows NOTHING, not even the decoy)
  and `shielded` (§8, below). Pure policy functions: `pausesGrant`, `hiddenPolicy`, `classifyHide`,
  `shieldOutcome`, `effectiveLockSettings`.
- `panel.ts` — **mount**: with the setting on and not paused, `startGrantUnlock` goes
  `decoy → granting → chat` (no decoy, no PIN); a 401 whose body is `{"error":"grant_invalid"}`
  clears both keys, ANY OTHER 401/failure (an edge/guard failure the route itself never sends,
  offline, 429) keeps the grant and
  shows the decoy without forgetting it. A hide while `granting` drops the in-flight attempt
  (`retryGrantUnlockOnVisible = true`) rather than adopting a late answer; the next return to the
  decoy retries the mint from scratch. **Pausing**: panic, a multi-tap, Escape, and a lock caused by
  a checkbox all set `wx-srv-grant-paused` immediately. A background switch pauses at the MOMENT the
  shield begins (`beginShield` sets `shieldPausedGrant`), not when it later resolves — a page
  reloaded, closed or discarded mid-shield is found paused, never silently left unlocked. Only a
  restore (`commitShieldRestore`) undoes that pause; `grantUsable()` still treats a shielded-but-not-
  yet-resolved chat as active so a token due to expire while shielded can keep renewing. A correct
  PIN clears the pause before the transition. **Renewal**: `armSessionTimers` schedules a re-mint
  `GRANT_RENEW_BEFORE_MS` (5 min) before expiry and one last try at expiry; a renewal re-attaches the
  chat view with the new session (`ServerChatView.attach` may be called again while attached — the
  view reopens its stream from the saved cursor and refreshes the signed media URLs, which are bound
  to the OLD token's expiry). A renewal is put off while a voice note or video is playing (it would
  restart), never past the last minute. `hooks.lockNow("unauthorized")` renews instead of locking
  while a grant is active — unless a renewal happened in the last 10 s (then the server is refusing
  tokens for a reason a fresh one will not fix, so it locks). Failure with `grant_invalid` clears the
  keys and locks; any other failure retries every 30 s until the token really expires (a departure
  from the original brief, found necessary by the independent review — a transient renewal failure
  must not strand an active grant locked). A `disposed` flag is set in `teardown()` and checked by
  every async continuation (`adoptSession`, the renewal callback, the shield resolver) so a renewal
  or shield outcome landing after teardown never re-attaches a torn-down chat or re-arms a timer.
  **Unload**: a reload, navigation or closing tab fires `pagehide` (`persisted` false) and then
  `visibilitychange → hidden`; `panel.ts` ignores that hide (`unloading`), otherwise every reload
  would count as a tab change and pause the grant (found by `server-permanent-unlock.spec.ts`; a unit
  test cannot see it because jsdom never unloads). A page entering the back/forward cache
  (`persisted`) stays an ordinary background switch. **Idle while away**: the idle period is checked
  on return against the wall clock, not a timer (a suspended tab runs no timers); if it already ran
  out, the lock fires with cause `idleAway` INSTANTLY on return — a touch does not get a chance to
  restore what was already idle. An idle fade already in progress when the page went away is
  completed on return (`onVisible` finishes it) rather than left for a stray touch to cancel.
  **A PIN unlock is never itself bound (§9, audit F4):** `grantActive` reads false for the brief
  window between a successful PIN verify and `bindGrantAfterPinUnlock` settling
  (`pendingGrantBind`), even if a stored grant is present and unpaused — otherwise a device that
  re-entered its PIN after a panic would run a never-auto-locking chat on an unbound 12h token, the
  same hole by another door. That function fires right after `verifyOk`: if the device holds an
  unpaused grant it exchanges via `unlock-with-grant` at once (the pause was already cleared, so
  the grant is eligible the instant the exchange starts); success adopts the bound session
  (`adoptSession`, same as a renewal); `grant_invalid` forgets the grant but never locks the PIN
  session just obtained; a network error leaves both alone. Early-return paths (no grant, paused,
  superseded by a lock/re-verify/teardown) all run before the function's first `await`, so
  `pendingGrantBind` is never left stuck true.
- `settingsSheet.ts` — the "Keep this device unlocked" row (ticking opens an inline PIN pad and
  stores NOTHING until the server says yes; unticking clears locally FIRST, **locks the chat at
  once via `hooks.lockNow("grantOff")` (§9, audit F4 — the server never re-mints on revoke, so
  nothing could undo this)**, then a best-effort `DELETE`), "Sign out other devices", the auto-lock
  row greyed out while the setting is on, and the two lock rows below. The "On" note reads "On ·
  Lock with the ✕ or a double-tap. Turning this off locks the chat — you'll need the PIN next
  time." — the consequence stated plainly before the tap that causes it. The inline pad is marked `data-srv-gesture-exempt`, so tapping its digits in
  quick succession never counts as R3's multi-tap. The greyed-out auto-lock row carries its own note
  ("Off — nothing to extend while this device is kept unlocked") so the reason is not silent; each
  dynamic note (`keepNote`, the auto-lock note, `lockNote`, `signOutStatus`) is `role="status"` and
  linked from its checkbox(es) via `aria-describedby` (`lockNote` is shared by both lock checkboxes,
  since one note explains the pair) — a screen reader announces WHY a row changed state, not just
  that it did (reviewer finding, round 2).

### "Lock when I change tab" / "Lock when I lock my screen" (§8)

Both boxes are per device, always shown, ticked by default. A hidden document in an open chat:

| tab | screen | on `hidden` | on return |
|---|---|---|---|
| on | on | lock at once | — |
| off | off | nothing (idle still applies unless a grant is active) | — |
| on | off | shield | restore only on a screen-lock event seen between hide and return |
| off | on | shield | restore only on NO screen-lock event **and** a proven device |

A **shield** puts the decoy up and detaches the chat like a lock, but keeps the in-memory session.
On return the decoy stays up until a `screenState = "locked"` event arrives or `SHIELD_WAIT_MS`
(500 ms) passes.

**The cause of a hide is judged from WHEN the lock event was dispatched, not merely whether one
happened (Architect ruling, §8, full text linked from decisions/00161)**: `screenLockEvidence`
(`lockModel.ts`) takes every screen-lock event's `performance.now()` timestamp plus the hide and
end times and asks two questions — CAUSAL (an event landed in
`[hideAt - SCREEN_LOCK_EVIDENCE_BEFORE_MS, hideAt + SCREEN_LOCK_EVIDENCE_AFTER_MS]` = `[hideAt -
1000, hideAt + 2000]` ms — a device may report the lock just ahead of the page actually hiding, so
the window opens 1 s early) and ANY (an event landed anywhere in `[hideAt, endAt]`, including one
batched and delivered only once the frozen page resumes). `classifyHide` then gives `screenLock`
(causal evidence), `tabChange` (device **proven** and NO event at all, causal or batched, in the
whole window) or `ambiguous` (anything else — including a proven device with a merely-batched
event, which says nothing about why THIS hide happened) and `shieldOutcome` restores the chat only
for a KNOWN cause whose own box is unticked. **Ambiguous always stays locked.** The proof
(`wx-srv-screenlock-proven = "1"`) is set ONLY by a causal event, never a batched one, and is
cleared on mount whenever there is no detector able to have earned it (permission not granted, or
no Idle Detection API at all) — a stale proof from a since-revoked permission cannot keep restoring
chats a device can no longer actually prove.

**A second background switch inside one absence taints the shield** (`shieldTainted`): the evidence
window is anchored to the ORIGINAL hide, so a hide → show → hide before the first shield resolves
makes the cause of the second hide unreadable against it. The taint makes the eventual return stay
locked regardless of what the evidence says, and is also set if a lock event fires while a restore
is only waiting on a token renewal (`restoreAfterRenewal`) — a screen lock arriving mid-renewal
must win over a renewal that happens to land first.

A device becomes proven the first time a CAUSAL screen lock is seen during a hidden interval, and
loses it when the permission goes or the detector stops. Until then "tab off + screen on" locks on
every switch and the sheet says why. A screen lock while the page stays visible (desktop Win+L)
locks at once if the screen box is ticked. A checkbox-caused lock pauses an active grant — see
"Pausing" above for exactly when. R7's picker/mic exemption still prevents a lock or a shield.

The only way to tell a screen lock from a tab switch is Chromium's Idle Detection API
(`screenWatcher.ts`; not Safari or Firefox; a permission asked for from a tap, and only when the owner
makes the two boxes differ). Where it is unsupported or denied the two boxes **follow each other**:
`effectiveLockSettings` uses the tab box's value when they agree and locks when they disagree, so
losing the detector can never quietly turn a lock the owner asked for into no lock. On return from
a shield the idle period is checked against the wall clock: an idle period that ran out while away
still locks unless a grant is active.

**On-device timing is unverified.** How an Android phone orders `visibilitychange` and the detector's
events across a power-button lock, an app switch and a tab switch has not been measured on the
operator's phone. The design fails closed without that: an unproven device keeps locking on every
switch. Verify on the phone before telling the owner the two boxes can differ there.

## 17. View-once media and tease reveal (round 2 item 13, `spec/server-chat/06-view-once-media.md`)

View-once photos and videos disappear permanently once viewed. The item is used up the moment
the server hands its bytes over once, through a claim-bound route; the server erases the message
straight after that through the ordinary Inv 46 delete path. The display duration (2 s, 5 s, 30 s,
or no time limit) is solely how long the client shows it.

### Schema (migration v11; `view_tease` renamed from `view_spotlight` in migration v12, decisions/00172 — a pure rename, no behavior change)
- `messages.view_once_s`: `INTEGER` (`CHECK(view_once_s IS NULL OR view_once_s IN (0, 2, 5, 30))`) — `0` = no limit; `NULL` = ordinary message.
- `messages.view_tease`: `INTEGER NOT NULL DEFAULT 0` (`CHECK(view_tease IN (0, 1))`) — photo only.
- `messages.view_claim_id`: `TEXT` (32 lowercase hex characters generated by claimant).
- `messages.view_claimed_at`: `REAL` (epoch seconds).
- `messages.view_claim_email`: `TEXT` (CF identity of claimant).
- `idx_messages_view_claimed`: partial index on `messages(view_claimed_at) WHERE view_claimed_at IS NOT NULL`.
- `attachments.view_once_renditions`: `TEXT` (JSON list, view-once only).

### Fail-closed linklessness (Inv 52)
In the same write transaction that creates the view-once message, the store:
1. copies the attachment's `renditions` into `view_once_renditions`;
2. sets `renditions = '[]'`.
Consequences:
- `attachment_json` and reply quote's `thumbUrl` mint no URLs in any code path (including older slot processes).
- `GET /media/{attId}/{rendition}` returns 404 for any attachment whose message is view-once.
- Send requires attachment `status == "ready"` (422 `not_ready`), so media processing never runs after send.

### Routes
- `POST /messages/view-once`: Dedicated send route (older processes answer 404/405, failing closed). Holds exactly one attachment (photo or video) and no text.
- `POST /messages/{seq}/view-once/open`: Atomically claims the view. Sender cannot open own message (403 `own_message`). First claimant wins (200 with `{durationS, tease, kind, mime}`); subsequent claims return 409 `already_opened`.
- `GET /messages/{seq}/view-once/content`: Requires header `X-Wixy-View-Claim: <claimId>`. Verifies digest match and expiration (`now < view_claimed_at + 600`, else 410 `expired`). Streams the raw photo/video rendition with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- **Post-download erasure:** When the response body has been delivered completely, the server erases the message via `delete_message_for_scrub` and `_finish_committed_erasure` on the contained task group (Inv 47). A broken connection erases nothing, allowing retry.
- **Backstop janitor:** Supervised loop running at least every 30 s erases claimed view-once messages older than 600 s.

### Client: sending
- **Redesigned twice on operator report (round 2), then ratified with conditions.** Attempt 1 was
  a small "①" badge in the corner of a staged photo/video chip, with its picker appended INSIDE
  that 56px chip — a box with `overflow: hidden` — so the picker rendered completely invisible on
  every tap, on every device (not merely small: genuinely clipped to zero visible area). Attempt 2
  (a composer-bar button + `position: fixed` sheet) fixed the clipping but always retargeted to
  the most-recently-staged file, clearing the previous flag automatically. The Architect's
  ratification (`spec/server-chat/06-view-once-media.md` §3.1, amended; decisions/00169) kept
  attempt 2's button/sheet but REVERSED its targeting rule to sticky, and added the conditions
  below.
- **Current design:** a full-size, clearly labelled button (`.wx-srv-view-once-toggle-button`,
  "⏱ View once") in the composer's button row, next to 🎤/📎. It is ALWAYS rendered (never
  `hidden`, so its position never jumps) and `disabled` whenever nothing staged is a photo or
  video. It carries `data-srv-gesture-boundary` (it opens a new surface, the sheet, under the
  finger).
- **Sticky target (ratification condition #3):** once a file is flagged, that flag STAYS on that
  exact file. Staging a further file never moves it. Only removing the specifically-flagged file
  clears it — the button then falls back to the most recently staged eligible file, unflagged.
  Before anything is flagged, the button targets the most recently staged eligible file by
  default (so it always has SOME target to open the sheet against).
- **The sheet shows the one file it targets** (condition #1): a thumbnail (reusing the same
  preview URL the chip itself renders from) and the file name, so there is no doubt which staged
  attachment it applies to when several are staged. Duration choices (2 s / 5 s / 30 s / no
  limit) plus a Tease switch for photos; a separate "Send normally" button clears the flag
  (condition #4, only shown once something is flagged).
- **The chip carries its own status marker** (condition #4): a small, non-interactive "⏱ 5s"-style
  label drawn INSIDE the 56px chip's own box (a status badge, not a popup — no clipping concern
  for something that fits within the box it lives in).
- **Escape stays the panic lock** (condition #6): the sheet has no Escape handler of its own, so
  the keypress bubbles to the document-level panic-lock listener unimpeded; the sheet's own close
  affordances are its ✕, "Send normally"/a duration pick, or a tap on its backdrop.
- Driven by `ChatComposerOptions.onChipsRendered`, a generic hook (fires on every chip re-render,
  including the last chip's removal, with the FULL currently-staged file list) any composer
  caller can use without reaching into the shared component's internal DOM. A transition to a
  FULLY EMPTY staged list always disables the button (nothing to apply it to) but must NOT touch
  the sticky flag itself — `takeServerDraft()` (the send path) clears the live composer as an
  implementation detail of lifting the draft, which re-renders chips with none staged, and
  `sendViewOnceDraft` is about to read that exact File's flag moments later. Only a file
  specifically absent from an otherwise NON-EMPTY staged list is treated as a real removal.
- A hard guard in `sendViewOnceDraft` additionally refuses to send if more than one staged file
  is flagged — defense in depth (the sticky, single-target UI design already makes this
  unreachable through normal use, but `fileViewOnceSettings` is exposed to callers/tests).
- **Real-click e2e coverage** (condition #7): `e2e/tests/server-view-once.spec.ts` clicks the
  actual button and sheet at desktop, 360px and 390px viewports, asserting both a genuine
  bounding box AND that `document.elementFromPoint` at its centre resolves to the control itself
  — the stronger check a plain `toBeVisible()` cannot give (an invisible overlay stacked above a
  control at a higher z-index still passes `toBeVisible()` while silently eating the click).

### Client: viewer and tease reveal
- Fullscreen overlay (`viewOnceViewer.ts`):
  - Photos drawn to `<canvas>` from `createImageBitmap(blob)` (blocks context menu and "Save image").
  - Videos play in `<video>` with no controls, `playsinline`, `disablePictureInPicture`, and `controlsList="nodownload noremoteplayback"`.
  - Countdown SVG ring begins on first painted frame.
  - Closes on: timer ending, ✕ button, Escape, `visibilitychange` -> `hidden`, lock/detach, wipe. Does NOT close on `message_deleted`.
  - Resource release: closes `ImageBitmap`, clears canvas, revokes object URLs, empties video src, drops Blob references.
  - Idle suspension (Inv 43 / R7): timed views hold `viewOnce` suspension, released on close; video holds `mediaPlaying`; no-limit photo holds no suspension.
- Tease reveal (photos only):
  - Automatic Lissajous path: `x = cx + Ax·sin(3θ + π/2)`, `y = cy + Ay·sin(2θ)`, 16 s cycle, clamped to drawn image.
  - Opaque black mask with circular cut-out, outer 15% feathered via radial gradient.
  - Size slider (6% to 35% radius of shorter side, default 12%) and Speed slider (0.5x to 3x in 0.25 steps, default 1x, `.wx-srv-view-once-speed-slider`), each a labelled row ("Size", "Speed") so both fit a 360px phone. Both are the recipient's own controls, never sent or stored. The size slider stays the only `.wx-srv-view-once-slider` (the e2e locator is strict).
  - **Speed is a clock, not a divisor.** The path is a function of an animation clock that advances each frame by `frame gap x speed` (`advanceTeasePhase`, `teasePaint.ts`) and is never rewritten, so moving the slider never makes the cut-out jump; `(wall time x speed) mod cycle` would. At 1x the clock equals wall time since first paint. The drag-resume timings stay real time.
  - Dragging moves cut-out under pointer; releasing pauses for 1.5 s, then resumes toward Lissajous path easing smoothly over 600 ms without jump.
  - `prefers-reduced-motion`: static centered cut-out, automatic movement disabled, and no Speed slider (nothing to speed up).
  - The maths and painting live in `teasePaint.ts` (`computeTeaseCoords`, `advanceTeasePhase`, `teaseGeometry`, `paintPhoto`, `paintTeaseMask`); `viewOnceViewer.ts` re-exports the older names.
- Compose-time Tease preview (`teasePreview.ts`, mounted by `thread.ts`'s View-once sheet): ticking Tease shows the sender's own staged photo with the real moving cut-out at the default size and speed, drawn by the same `teasePaint.ts` code as the viewer. It reuses the staged file's existing preview URL, stops on untick, sheet close, or when its element leaves the page (a lock tears the chat down), shows nothing if the image fails to decode, and paints once under reduced motion. The sheet scrolls (`max-height: 100%`) so a short phone never loses its top or close button.

### Honest limits
- A screenshot, screen recording, or external camera cannot be prevented by a web application.
- While displayed, bytes reside in recipient browser memory. View-once guarantees the server retains nothing and the ordinary client never shows it twice.
- OS app-switcher snapshots may be captured when hiding. The viewer closes on hide, but the operating system's snapshot mechanism is outside browser control.

## 18. Live drawing: the server (spec/server-chat/07-live-drawing.md, Architect ruling
2026-09-26, Inv 53)

The pen tool: either person draws freehand on top of the thread, live, and the drawing
sticks to the message it was drawn near and scrolls with the chat. This section is the
SERVER half (schema, routes, the live relay); the client half (the drawing surface,
gestures, rendering) is §19.

### Anchoring and coordinates (the client's job, stored verbatim)
A drawing anchors to one message (`anchor_message_seq`) and stores its geometry in *draw
space*, the drawer's own thread-column width in CSS px (`column_width`, `CHECK BETWEEN
200 AND 4000`): `x` from the column's left edge, `y` from the anchor bubble's top edge,
both integers. The server never computes or re-derives a position — it stores exactly what
the client measured and validated, and a viewer rescales by `viewer column width /
column_width` entirely client-side (spec §1).

### A drawing is a session; each stroke is its own row (F2)
A **drawing** (`drawings` table) is every stroke made from turning the pen on to turning it
off (or the session ending). It carries `client_id` (the create idempotency key, exactly
`create_message`'s own `clientId` pattern), the anchor, `sender`/`device_id`/`by_email`
(audit only, never on the wire), `column_width`, and a `rev` that increments on every
stroke appended. Each **stroke** (`drawing_strokes`, primary key `(drawing_id,
stroke_id)`) is stored the moment it ends (pointerup) — colour and width are per-stroke,
because the operator can change the pen mid-drawing — never batched until the session ends,
so a closed tab loses at most the stroke under the finger. `stroke_id` is the append
idempotency key: a repeat is a no-op that changes nothing and appends no event, the exact
shape as `set_reaction`'s "only a real change appends the event" rule.

### Schema v13 (`_SCHEMA_V13_DRAWINGS`, `wixy_server/livechat/store.py`)
```sql
CREATE TABLE drawings(
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL UNIQUE,
  anchor_message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
  sender TEXT NOT NULL, device_id TEXT NOT NULL, by_email TEXT,
  column_width REAL NOT NULL CHECK(column_width BETWEEN 200 AND 4000),
  rev INTEGER NOT NULL DEFAULT 1, created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE INDEX idx_drawings_anchor ON drawings(anchor_message_seq);
CREATE TABLE drawing_strokes(
  drawing_id INTEGER NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
  stroke_id TEXT NOT NULL, ord INTEGER NOT NULL,
  color TEXT NOT NULL, width INTEGER NOT NULL, points TEXT NOT NULL,
  created_at REAL NOT NULL, PRIMARY KEY(drawing_id, stroke_id));
```
The number is **13**, not the spec's original placeholder of 12 — the Spotlight→Tease
rename (decisions/00172) landed first and took v12, so this feature's migration was
renumbered past it at build time; the spec text is amended in place to say 13, marked as an
amendment, rather than left wrong. Both foreign keys are index-covered — `idx_drawings_anchor`
for `drawings.anchor_message_seq`, and `drawing_strokes`'s own primary key (which leads with
`drawing_id`) for its FK to `drawings.id` — the same lesson reply-to's schema v10 measured
(17.6s vs 0.2s at 20,000 rows). `ON DELETE CASCADE` on both is load-bearing for the same
reason as reactions' (decisions/00164): an older blue/green-overlap process that has never
heard of these tables can still hard-delete a message, and the cascade — not that older
process — removes the drawing and its strokes with it (Inv 46/49/53).

### Persistence rides the existing event machinery (F3, no new event type)
A create, an appended stroke, or a delete each appends exactly one EXISTING
`message_updated` event for the anchor — identical in shape to a reaction changing. The
`Message` wire shape carries only a summary, `drawings:[{id,rev}]` (`DrawingSummary`,
`models.py`), never the strokes: a history page of 50 messages must not carry megabytes of
points. A client that sees a summary entry it lacks, or a newer `rev` than it has, fetches
the body with `GET /messages/{seq}/drawings` — `{"drawings":[{id,rev,sender,columnWidth,
strokes:[{strokeId,color,width,points}]}]}`. The `events` table itself is untouched: no
rebuild, no new `EventType`, so replay/coalescing/reconnect/blue-green behaviour are
unchanged for every OTHER consumer of that table.

### Routes (`routes_livechat.py`, token required on every one)
`POST /drawings` (create + first stroke, idempotent on `clientId`, 404 on an unknown/deleted
`anchorSeq`, 409 `full` past 20 drawings on one anchor); `POST /drawings/{id}/strokes`
(append, idempotent on `strokeId`, 404 on an unknown/deleted drawing, 409 `full` past 200
strokes); `DELETE /drawings/{id}` (204, always, idempotent — either person may delete any
drawing, Inv 46's pattern, no ownership check); `GET /messages/{seq}/drawings` (every
drawing for that anchor, with strokes; `[]` rather than 404 for an unknown `seq`, since the
summary already told the client whether to bother asking). Validation (422 `invalid`):
colour is one of the 8 hex values in `livechat/drawings.py` (`DRAWING_COLORS`), width is one
of `{2,4,8,14}` (`DRAWING_WIDTHS`) — both shared with the browser's own copy
(`admin-ui/src/server/drawings.ts`) through the reaction-emoji drift guard's own pattern,
enforced by `test_livechat_drawings.py`; points are 2-1000 integer pairs with `x` in
`[-50, columnWidth+50]` and `y` in `[-20000, 20000]`, checked as the RESULT of the client's
own Ramer-Douglas-Peucker simplification, never re-simplified server-side. Full contract:
[contracts.md](contracts.md) §2/§4.

### The live relay: a separate, deliberately lossy channel (F3, Inv 53)
`POST /drawings/live` batches a stroke's in-progress points (~every 50ms client-side, at
most 200 points/batch and 30 batches/second per DEVICE — `SlidingWindowRateLimiter`,
429 `rate_limited` + `Retry-After` past the cap; the budget is the authenticated identity
(`_live_relay_budget_key`: the device grant when the token is grant-bound, else a hash of the
token), never a body field, because a token holder chooses every body field and a budget keyed
by `drawingClientId` is reset by inventing a new id per request; two people drawing at once are
two tokens, so neither throttles the other; the limiter drops idle keys once a window, so its
table stays bounded by the keys active within one window). Every id and counter in the body is
bounded like its create/append twin (`drawingClientId`/`strokeId` 8-64 characters, `anchorSeq`
1..2^53-1, `batch` 0..10,000,000, else 422), because a frame is copied verbatim into up to 64
queued frames per open stream. The relay is a NEW in-memory
`DrawingBroker` (`livechat/drawing_broker.py`) — deliberately NOT the `LiveChatNotifier`,
which carries no payload and only means "re-read the database". Each open `/stream`
connection registers its own `LiveDrawingQueue` (a `deque(maxlen=64)`, oldest dropped past
capacity — the "bounded queue of 64 items, overflow drops the oldest" the spec asks for) via
`broker.register()`, drains it every stream-loop tick (before the ordinary persisted-event
poll, so a live frame's latency is never held up by a coalescing pass over unrelated
messages), and unregisters on disconnect. `LiveDrawingQueue.event` is raced against
`LiveChatNotifier.current_event` through a shared `wait_on_any` helper (`notifier.py`), so
the stream loop wakes on either wire without needing two poll loops. Both events are
captured at the TOP of each loop iteration, before the queue is drained and before any
awaited read: a `push`/`publish` swaps in a fresh event and sets the old one, so an event read
only at the wait (after the grant check and `events_after` have yielded) is already the fresh
unset one, and a frame pushed in that gap would sit for the whole 2 s re-check. The relay is sent to
EVERY open connection, including the posting tab's own — the client, not the
server, ignores a frame for a drawing it is itself drawing, matched by `drawingClientId`.
The loop checks token expiry and grant liveness BEFORE it drains the queue, so a locked stream is
never handed a queued frame.
A final `{...,"cancel":true}` withdraws a stroke; `cancel:true` skips colour/width/points
validation entirely (a withdrawal carries no real stroke to validate).
**Nothing about a live batch ever reaches `server.db`, a file, or a log line** — the broker
holds a frame only as long as it takes to hand it to each queue; live points are chat
content exactly like a stored stroke, so Inv 40/46/53 apply to them too. The SSE frame
itself carries **no `id:` line**, so it can never advance anyone's replay cursor (wire shape:
[contracts.md](contracts.md) §4). Revocation, token expiry, and the `locked` event apply
unchanged, because the relay rides the same stream connections those already gate — `POST
/drawings/live` requires the token like every other route.
**Honest limit:** during a blue/green overlap, a live frame reaches only streams on the SAME
process, because the broker is in-process — a deploy overlap lasts minutes, and stored
strokes still reach everyone within 2s through the existing cross-process database re-check
(§6 above). No push notification for drawings, exactly like reactions.

### Erasure (F4, Inv 53)
Deleting the anchor message cascades to its drawings and strokes (the schema's own FK, not
application code — proven directly by deleting the anchor through a raw `DELETE FROM
messages` connection that has never imported the drawing store methods at all). Deleting a
drawing removes its row and, by cascade, its strokes. A wipe explicitly clears both tables
in the same transaction as every other one, even though the cascade already covers it, so
the wipe's intent is never implicit. There are no drawing files (rendering is client-side
SVG), so nothing is queued in `deleted_storage`.

### Privacy (Inv 40)
Drawings live only in the private Server-chat `server.db`, under
`Storage/projects/<slug>/server/` — nothing about them (not even a hint of their existence)
reaches the site repo, a build, a publish, a `reports.py` diagnostic bundle, or a backup
snapshot; `wixy_server/tests/test_reports.py` pins a drawing-specific sentinel absent from
the report bundle alongside the existing whole-`server_dir` exclusion.

### Tests
`wixy_server/tests/test_livechat_drawings.py` (palette allowlist, the TS/Python drift
guard, migration v12→v13 on a database frozen at v12 and on a fresh database, store
create/append/delete idempotency and limits, `CHECK` constraint enforcement, ordering, a
concurrency test with two `LiveChatStore` connections appending to the same drawing at
once, and the cascade-erasure raw-bytes proofs) and
`wixy_server/tests/test_routes_livechat_drawings.py` (auth on every route, the full
validation matrix, every error code, the live relay's rate limit and per-connection
isolation, the bounded queue's drop-oldest policy, and the `drawing_live` SSE frame never
disturbing the replay cursor).

## 19. Live drawing: the client (the pen) (round 2, `spec/server-chat/07-live-drawing.md`)

Either person can draw freehand on the thread with the pen. A drawing sits on the message it
was drawn on and scrolls with it. It appears live on the other screen while it is being
drawn, is stored stroke by stroke, and can be selected and deleted for everyone. The server
side (schema, routes, the live relay and erasure) is §18. This section covers the client
(`admin-ui/src/server/`). The design decisions are in decisions/00176.

### Module map
- `drawings.ts`: the palette (`DRAWING_COLORS`, 8 hex values), the thicknesses
  (`DRAWING_WIDTHS` = 2/4/8/14), their spoken labels, the server's limits mirrored as
  constants, and the client tuning (`RDP_EPSILON_PX`, `LIVE_BATCH_INTERVAL_MS`,
  `LIVE_STROKE_TIMEOUT_MS`, `LIVE_KEEPALIVE_MS`, `SECOND_FINGER_WINDOW_MS`/`_SLOP_PX`,
  `SELECT_HIT_RADIUS_PX`, `DRAWING_Y_SPLIT_PX`). **Drift guard both ways:** the two lists are
  each one `export const NAME = [...] as const;` line. The server's
  `test_livechat_drawings.py` parses them, and `tests/server/drawings.test.ts` parses
  `wixy_server/livechat/drawings.py` (the reaction-emoji guard's pattern, Inv 49).
- `drawingGeometry.ts` (pure): draw space ↔ viewer space, `chooseAnchor`, RDP simplification
  and `prepareStoredPoints`, `strokesBounds`/`svgBox`, `pathData`, `hitTestDrawings`.
- `drawGesture.ts` (pure, the caller supplies every timestamp): the pointer state machine
  (idle / stroke / pan / draining) that turns Pointer Events into stroke and pan effects.
- `drawingLive.ts`: the lossy live channel. `createLiveSender` belongs to the drawer and
  `createLiveReceiver` to every other screen.
- `drawingModel.ts` (pure data): this client's record of stored and pending drawings, and the
  rules that reconcile it with the server.
- `drawingSync.ts`: storing strokes, deleting drawings, and fetching what a summary says is new.
- `drawingLayer.ts`: everything in the DOM: the Pen button, the toolbar, the Draw surface, the
  `<svg>`s, live previews, Select mode and the lifecycle. `thread.ts` mounts it.
- `api/drawings.ts`: the routes, the verdict mapping, and validation of everything read back
  (`parseStoredDrawing`, `parseDrawingSummaries`, `parseLiveFrame`). Path data is built only
  from these checked integers, never from a server string (§1).

### The Pen button and the toolbar
- **The Pen button is in the chat HEADER** (`.wx-srv-pen-button`, "✎", before ⚙), not the
  composer: a third composer control pushed the text box under its 120 px floor on a 360 px
  phone (decisions/00169). It is a 44×44 px button whose visible 36 px face
  (`.wx-srv-pen-face`) matches ⚙ and ✕. A `-4px` margin keeps the header row's 36 px layout.
  It carries `data-srv-gesture-boundary`, `aria-pressed` (pen on/off), and `aria-expanded` (toolbar open/collapsed).
  It does nothing while locked. While the pen is on, tapping the Pen button toggles the toolbar open or collapsed
  without turning the pen off.
- **Header Settings cog swap & Undo/Redo:** While the pen is on, the header settings cog
  (`.wx-srv-settings-button`) is hidden, and **Undo** (`.wx-srv-pen-undo`) and **Redo**
  (`.wx-srv-pen-redo`) buttons take its place for strokes made during the current drawing session.
  Undo pops the latest stroke; if it was the drawing's sole stroke, the drawing is deleted locally
  and via `sync.deleteDrawing` (and a live cancel frame is emitted), while for multi-stroke drawings
  remaining strokes are re-stored under a new key. Redo restores undone strokes and stores them
  on the anchor message. Both buttons carry `data-srv-gesture-boundary`.
- **Keyboard parity:** `Ctrl+Z` / `Cmd+Z` (undo) and `Ctrl+Y` / `Ctrl+Shift+Z` / `Cmd+Shift+Z`
  (redo) operate undo/redo globally while draw mode is active.
- **Header Close button abandons:** In draw mode, clicking the header Close button
  (`.wx-srv-panic-button`, ✕) immediately abandons in-progress session drawings (discards active
  and stored strokes from model, view, and server, resets undo/redo stacks) and exits draw mode
  without a confirmation dialog and without locking the chat (Inv 42 exception). Outside draw mode,
  ✕ locks the chat as panic. (Escape continues to lock immediately even mid-stroke).
- **The toolbar** (`.wx-srv-pen-toolbar`, `role="toolbar"`) sits between the header and the
  thread. It holds the 8 colour swatches and the 4 thicknesses (in Draw mode), a **Draw |
  Select** switch, **Collapse** (in Draw mode, `.wx-srv-pen-collapse`, which tucks the toolbar away so the full thread
  area is drawable while strokes stay live), and **Done** (which exits pen mode and clears undo/redo session history). In Select mode it shows the hint,
  **Next drawing** (the keyboard route to a drawing) and **Delete drawing**
  (`data-srv-gesture-boundary`, since it opens the confirmation). "Delete this drawing for
  everyone?" then replaces them with Delete / Cancel. Notices use the status line
  (`role="status"`, cleared after 5 s).
- **On a phone (≤ 480 px) it is two fixed lines in every mode, whatever the device's font**
  (`chat.css`, the `max-width: 480px` block):
  - Line 1 is what the mode acts on: the colours, the selection's two buttons, or the delete
    question with Delete / Cancel.
  - Line 2 is always **Draw | Select, then the mode's slot** (the thicknesses in Draw mode, the
    hint in Select mode, nothing during the question), **then Collapse (in Draw mode), then Done**.
    The switch comes first, so it never moves under the finger when the mode changes.
  - The slot is the only part that gives. The thicknesses start at 24 px wide each (always
    44 px tall) and grow back towards 44 px into the room the labels leave, and the hint wraps
    inside it (at most three lines fit the 44 px line). Collapse displays an icon without its label on phone widths.
  - DOM order is the desktop line's (and so the keyboard's). CSS `order` arranges the phone's
    two lines, and the hint is a direct child of the toolbar, not of the select group.
- **Why it is built this way (measured, decisions/00176 #13):** the first layout gave line 2
  fixed-width thicknesses. It fitted two lines in Windows' Segoe UI but needed THREE (146 px)
  in Ubuntu's DejaVu Sans, which is what CI's runner draws `system-ui` with, and in Verdana,
  on both a 360 and a 390 px phone. Its Select mode also pushed "Delete drawing" onto a line of
  its own, and the switch jumped from after the thicknesses to the line's start on every mode
  change.
- **Measured now (real Chromium):** 100 px, two lines, in every mode at 390 and 360 px, in
  Segoe UI, DejaVu Sans, Arial (the same letter widths as Linux's Liberation Sans) and Verdana,
  with nothing clipped or overflowing. The thicknesses measure 40–44 px wide in Segoe UI or
  Arial and 35–42 px in DejaVu Sans or Verdana. On desktop the toolbar is one line, 54 px.
  `server-drawing.spec.ts` checks all of this in every mode, with the device's own font and
  again with a forced wide one (`useWideFont`: Verdana, or else DejaVu Sans). Only a font far
  larger than any default would wrap line 2, and it would still never overflow.
- **The thread stays where it is** (`keepThreadInPlace`): any change in the toolbar's height
  (pen on or off, a mode switch, a notice, the question) adds that change to
  `thread.scrollTop`. Without this, the newest messages slid under the composer when the pen
  came on, and a view stuck to the bottom later jumped about 90 px.

### Layout and anchoring (§1)
- `thread.ts` wraps `.wx-srv-message-list` in `div.wx-srv-thread-content` (`position:
  relative`). The drawing layer (`.wx-srv-drawing-layer`: `z-index: 1`, `pointer-events:
  none`, `overflow-anchor: none`) is the list's sibling inside that wrapper, **never inside the
  list**, because `renderThreadList` removes children of the list that it does not know about.
- Each drawing is one `<svg class="wx-srv-drawing" data-anchor-seq="N">` (`aria-hidden`).
  Its `viewBox` is in draw space. Its box is the anchor's top plus the bounds × the scale
  `s = viewer column width / columnWidth`, so the browser scales x, y and the stroke width
  uniformly and a circle stays a circle. The box is clipped to the thread's visible width, so
  there is never a sideways scrollbar. Vertically it is never clipped, so a drawing below the
  last bubble grows the scroll area.
- **Positions are always read from the live DOM**, never copied. They are re-read on every
  `renderThreadList` (`drawingLayer.syncMessages`, called before the stick-to-bottom
  decision), by a ResizeObserver on the column and the thread (images loading, rotation, the
  toolbar), and once per frame during a stroke.
- **The anchor** is the confirmed bubble whose top is the nearest one at or above the first
  stroke's start. A start above every bubble anchors to the topmost bubble, with a negative
  offset. Anchors come from `drawingAnchors()`/`drawingAnchorElement()` in `thread.ts`: only
  confirmed, connected bubbles, never an optimistic echo or a bubble fading out after a
  delete. A new drawing declares `columnWidth` = the measured column, clamped to 200–4000.
- **One drawing per pen session (§2):** later strokes join the session's drawing. A stroke
  starts a new drawing on its own nearest anchor if it starts more than
  `DRAWING_Y_SPLIT_PX` (16 000 px of draw space) from the first anchor, so no point can
  cross the server's ±20 000 bound, or if the drawing already has 200 strokes. The session
  ends when the pen turns off, on any lock, when the page is hidden (the pen stays on), or on
  a wipe.

### The Draw surface and gestures (§5)
- In Draw mode, `div.wx-srv-draw-surface` lies over the thread inside `.wx-srv-thread-wrap`:
  `z-index: 1` (below the jump pill's 2), `touch-action: none`, pointer capture, and a right
  inset that leaves a desktop scrollbar draggable. It carries `data-srv-gesture-exempt`, so
  the multi-tap lock ignores it and rapid dots never lock. Escape still locks at once; ✕ abandons
  the drawing session and exits draw mode without locking (Inv 42 exception).
- **One finger, pen or mouse draws.** A second TOUCH finger that lands within 150 ms of the
  first and before the first has moved 12 px cancels the stroke (a live `cancel`, nothing
  stored) and starts a two-finger pan that scrolls by the centroid's movement. Any other extra
  pointer is ignored until every pointer lifts (`drawGesture.ts`).
- The mouse wheel over the surface is passed on to the thread. A ctrl+wheel is a trackpad
  pinch and is swallowed, so zoom stays off.
- For the length of one stroke the thread is held in place (`ChatThreadScroll.hold()` in
  `admin-ui/src/chatThreadScroll.ts`, shared with the AI chat). A message arriving
  mid-stroke then shows the jump pill instead of sliding the chat out from under the finger.
- A finished stroke is simplified with RDP at 0.75 px, rounded to integers inside the
  server's bounds, and deduplicated (`prepareStoredPoints`). A tap becomes a two-point dot. A
  stroke still over 1 000 points is simplified again with a doubled tolerance, and evenly
  thinned as a last resort, so it is never refused for its length.

### Live strokes (§4, `drawingLive.ts`)
- **Sender:** at most one `POST /drawings/live` in flight, at least 50 ms apart (so at most 20
  a second, inside the server's 30) and at most 200 points each. Each batch after a stroke's
  first starts with the previous batch's last point, so the receiver draws connected pieces
  and a lost batch shows as a gap. `batch` increases per stroke. A 429 pauses sending for the
  server's `retryAfterS` (clamped to 0.25–10 s). A finger held still re-sends its last point
  every 2 s. A cancel frame goes out only if something was sent. Live posts time out after
  4 s rather than the usual 10. The timer always re-arms to the earliest thing owed: a stale
  keepalive timer once held a new stroke's preview back by up to 2 s (red/green tested).
- **Receiver:** it ignores frames for this screen's own drawings (the server relays to every
  stream), frames for a stroke already stored or cancelled (remembered for 60 s), and batches
  older than one already drawn. A stroke with no update for 5 s is dropped. Previews are
  their own `<svg class="wx-srv-drawing wx-srv-drawing-live">`. The stored stroke replaces
  the preview when a fetch brings it (`finish`), and a late frame never brings it back.
- An incoming frame is not input: watching someone draw does not keep the chat awake
  (Inv 43).

### Storing, retries and delete (`drawingSync.ts`)
- **Each own drawing has a FIFO queue**, with one write in flight at a time. The first
  stroke is `POST /drawings` (the create, idempotent by `clientId`). The rest are `POST
  /drawings/{id}/strokes` (idempotent by `strokeId`). A write with an unknown outcome (a
  network error, a timeout, a 5xx, 408, 429, or a 403, which only Cloudflare Access or a WAF
  can send here) is retried with the SAME keys after 1, 2, 4 and 8 s, then every 15 s.
- **Verdicts:** 404 drops the drawing and tombstones its id. 409 on create means the message
  already has 20 drawings (a notice). 409 on append moves the remaining strokes into a new
  drawing on the same anchor (`model.split`), and the pen session continues there. 422 drops
  only that stroke ("Couldn't save part of the drawing."). A 401 locks the chat.
- **A lock pauses everything:** timers are cleared and nothing new is sent with a token that
  was let go. The next unlock resumes with the fresh token. Answers already in flight still
  apply.
- **Delete** (Select mode): the drawing leaves the screen at once, and its id is tombstoned.
  - A drawing with an id is deleted by that id (`DELETE`, retried after 1, 2 and 4 s). Its
    unsent strokes are held back. An append already in flight is harmless: it either lands
    before the delete (which removes it too) or after it (and gets a 404).
  - A drawing whose create has not answered yet may or may not exist on the server, and only
    that create's verdict can say. The create alone is carried on, retried with the same
    `clientId` on the usual backoff and through locks, until it answers. The drawing is then
    deleted by the id it gives. If the create is refused outright, nothing was made.
  - If the delete fails ("Couldn't delete the drawing. Try again."), or a lock interrupts
    it, the drawing comes back whole. Its held-back strokes are queued again and stored, and
    a refetch brings the server's version.

### Reconciliation (`drawingModel.ts`)
- **A summary only triggers a fetch; the GET is the only authority.** When a message's
  `drawings: [{id, rev}]` summary lists something unknown or newer, or leaves out an id this
  client knows, one `GET /messages/{seq}/drawings` runs after 60 ms. The need is checked
  again when the timer fires: usually the drawer's own create answer has arrived by then. At
  most one fetch runs per message (a newer summary re-runs it once afterwards), and at most 4
  overall. A missing or malformed `drawings` field means "unknown", never "none", as in a
  blue/green overlap with an older server.
- **The epoch rule:** a fetch removes a drawing for being absent only if this client knew
  that drawing before the fetch was sent. Otherwise a fetch the server answered just before
  this client's own create committed would delete the drawing it had just made.
- An answer older than one already applied for the same message is dropped. Own drawings are
  matched to fetched ones by `strokeId`, so a fetch that beats the create's answer adopts the
  drawing and never shows it twice. Tombstones are drawing ids only, never content.
- **The drawer never re-fetches its own strokes:** for an own drawing, every revision up to
  the number of strokes SENT is already accounted for (verified in e2e: the drawer makes no
  GET). Only the other screen's drawings trigger stick-to-bottom
  (`onRemoteContent` → `afterContentChange(false)`); this screen's own confirmations never do.

### Select mode
- Drawings stay `pointer-events: none` even in Select mode. The spec allows them to take
  pointer events there, but they are instead hit-tested geometrically: a tap within 12 viewer
  px of a stroke's visible edge (thickness included) selects the whole drawing, and the
  closest drawing wins. A selection therefore never blocks scrolling.
- A tap is recognised from Pointer Events with the lock recognizer's own rule (moved at most
  `TAP_SLOP_PX` = 10 px, held at most `TAP_MAX_MS` = 300 ms), in capture listeners on the
  thread, and never from `click`. Measured in Chromium's phone emulation, a touch tap produced
  `pointerup` and no click at all. A tap that selects swallows its follow-on click for 700 ms,
  so a link or photo underneath does not also act. Selecting shows a dashed outline
  (`.wx-srv-drawing-selection`).
- **Accepted hazard (driver ruling, KEEP AS SPEC):** a select tap followed within 400 ms by
  "Delete drawing" locks the chat, because the button is a gesture boundary and the tap is an
  ordinary one. The same pattern exists today for a bubble tap followed by ⚙. The e2e acts
  at a human pace between controls.

### Lock, lifecycle and erasure
- `thread.ts` calls `drawingLayer.detach()` FIRST in its own `detach()`. The pen turns off,
  and a stroke in progress is withdrawn with a live cancel posted at once, while this unlock's
  token is still in hand (`liveSender.shutdown()`). The surface, live previews, observers and
  every timer then go. Stored and pending drawings stay in memory, like the thread's messages
  and draft.
- `attach(session)` resumes the store queue and fetches with the fresh token. `teardown()`
  (leaving the panel) drops everything.
- `messageDeleted(seq)` (both the optimistic delete and the `message_deleted` event) removes
  that message's drawings and previews in place. A message that disappears from the rendered
  list does the same. `wiped()` turns the pen off and drops every drawing, preview, queue and
  fetch.
- A drawing is patched in place: the same `<svg>` and the same `<path>` per `strokeId`. A
  bubble is never re-rendered for a drawing, so the voice/video cut-off trap from reactions
  cannot happen here.

### Tests
- vitest: `admin-ui/tests/server/{drawings,drawingGeometry,drawGesture,drawingLive,
  drawingModel,drawingSync,drawingsApi,drawingLayer,threadDrawing}.test.ts`, plus
  `serverStream.test.ts` (the `drawing_live` frame, no cursor move) and
  `serverChatCss.test.ts` (the pen classes that are toggled hidden).
- e2e: `e2e/tests/server-drawing.spec.ts`, with two identities, desktop, and 390 and 360 px
  phones with touch. B sees A's stroke live before A lifts, then stored in the same place,
  and it survives a reload. The drawing scrolls with its message and follows it when the
  message above grows. B selects and deletes it and it vanishes for both. Deleting the anchor
  message removes it. Rapid dots never lock, and Escape mid-stroke locks at once and B's
  preview goes. At phone widths every control is hit-tested with `elementFromPoint`, one
  finger draws, and two fingers scroll without drawing. The fixture runs ONE chat per worker
  with no reset, so assertions are scoped per anchor
  (`svg.wx-srv-drawing[data-anchor-seq="N"]`).

### Honest limits
- **Text re-wraps at other widths (spec §1).** A drawing stays on the right message, but on a
  much narrower or wider screen a circle drawn around particular words may not sit exactly on
  them. Both people mostly use phones of similar widths, where the scale is about 1.
- **Blue/green overlap:** live frames reach only streams on the same server process. Stored
  strokes still reach everyone through the database re-check.
- **A reconnect mid-stroke** misses that stroke's live preview. The stored stroke arrives
  with the next `message_updated`.
- **On a narrow phone with a wide font the thickness buttons get narrower**: 35–36 px wide at
  360 px in DejaVu Sans or Verdana, never below 28 px, and always 44 px tall.
- **The select-then-delete boundary hazard** described above.
- **A lost create answer can re-create a drawing the other person has just deleted.**
  Deletes keep no record of client ids (the same tombstone-free design as messages, Inv 46).
  So if a create's answer is lost and the other person deletes the drawing before the retry
  arrives, the retry creates it again.
- **Leaving the panel stops a pending delete:** a delete still waiting on its create (above)
  ends if the panel is torn down before that create answers.
