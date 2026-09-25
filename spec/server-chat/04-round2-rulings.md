# Server chat — Architect rulings, round 2: reactions, voice-note transcription, reply to a message

Architect, 2026-09-25. Binding. Builders write their own feature specs (e.g. `04-reactions.md`); this file records the rulings those specs must follow.

======================== ITEM 2 — REACTIONS: APPROVED with small additions ========================
(a) Sender-name identity (trimmed, case-insensitive): APPROVED.
    - It is consistent with R8, where "mine" means sender name, and with push self-exclusion.
    - Accepted consequence: renaming yourself means your old reactions stop reading as
      yours, exactly as your old messages stop aligning right.
    - ADD a `by_email` column (the CF identity) for audit, like `messages.by_email`. It is
      never returned on the wire.
    - The `sender` is validated with exactly the POST /messages rules (1–32 chars, trimmed,
      no control chars).
(b) 6-emoji allowlist: APPROVED. 👍 ❤️ 😂 😮 😢 🙏 is exactly WhatsApp's quick set, which is
    what both users already know.
    - Define each entry as an EXACT code-point sequence. ❤️ is U+2764 U+FE0F, with the
      variation selector. Compare exact strings with no normalisation, and 422 anything
      else.
    - The drift guard between the TS and Python constants is required, as sketched.
(c) ON DELETE CASCADE: APPROVED, and the rationale is right: `foreign_keys=ON` everywhere,
    and an older slot process can hard-delete a message during a blue/green overlap.
    - A react on a deleted or unknown seq must map the FK IntegrityError to 404, never a
      500.
    - The raw-bytes tests after delete and after wipe must include the reactor name and the
      emoji.
(d) Reusing `message_updated`: APPROVED. Its meaning is "this message's current state
    changed"; it coalesces in the SSE loop, and it replays from the cursor.
    - A no-op PUT writes no event (as sketched).
    - The in-place patch of the reactions element is REQUIRED (the voice/video cut-off trap
      you found). Test it: a playing `<audio>` element keeps its identity and `currentTime`
      across a reaction update.
- Chips are not gesture boundaries, and the menu's emoji row is (R3 v1.5.2 classification):
  confirmed.
- The migration number is assigned at merge (no hard-coding in the spec); invariant 49 is
  fine. No push on reactions: confirmed.

======================== ITEM 3 — VOICE TRANSCRIPTION: BLOCKED on a cmd-side "no-retain" mode ========================
FINDING (read in the cmd repo today, not assumed). cmd's POST /api/transcribe PERSISTS what it
transcribes, in two places:
1. engine/transcribe.py `_save_dictation_debug`:
   - on EVERY path, cleanup=0 included, it writes the audio clip plus a JSON sidecar with the
     raw and cleaned transcript to `<CMD_STORAGE_DIR>/dictation-audio/`;
   - it keeps a rolling 50 clips and is on by default (`CMD_TRANSCRIBE_SAVE_AUDIO=1`).
2. hub-voice/asr_server.py + asr_shadow.py: the ASR service's background shadow pass
   (default `ASR_SHADOW_ENGINE=parakeet`) appends `primary_text` and `shadow_text` — the full
   transcript — to `Storage/logs/asr-shadow.jsonl`. The shadow wav is deleted; the text is
   kept.
Also, the cleanup path logs the raw and cleaned text at INFO (skipped with cleanup=0, but the
private mode must forbid it outright).

Using it as-is would copy private chat voice notes and transcripts into cmd's storage and
logs, where the chat's delete and wipe can never reach them. That breaks Inv 40 (chat data
lives only in `server/`) and Inv 46 (delete/wipe erase everything). NOT acceptable.

RULING:
(a) Depend on cmd — YES, but ONLY through a new cmd-side **private mode**. This is cross-repo
    work in cmd; the Orchestrator should open it as its own cmd task, exactly as with the PIN
    service.
    - `POST /api/transcribe` with form field `private=1` means:
      - no dictation debug-buffer save;
      - no transcript text in any log line;
      - it tells the ASR service not to shadow and not to log text (a
        `X-Voice-Private: 1` header or an equivalent field on the :9390 call, honoured by
        asr_server.py);
      - the uploaded bytes are held in memory only, and any temp file is deleted in
        `finally`.
    - A capability probe, `GET /api/transcribe/capabilities` → `{"private": true}`, lets
      wixy refuse to send anything to a cmd that cannot promise it.
    - cmd tests: with private=1, nothing is added under `dictation-audio/`, nothing is added
      to `asr-shadow.jsonl`, and a sentinel phrase in the audio's transcript appears in no
      log file.
    - wixy calls it ONLY with `private=1` + `cleanup=0`, with NO `session_id` and NO
      `context`, and only after the probe says `private: true` (cached 60 s).
    - Probe false or unreachable → the feature is unavailable: the Transcribe button is
      hidden, and the route answers 503 `{"error":"not_configured"}`.
    - The standalone edition is always unavailable.
(b) STORE the transcript: YES.
    - Table `attachment_transcripts(attachment_id TEXT PRIMARY KEY REFERENCES
      attachments(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN
      ('pending','done','failed')), text TEXT, failure TEXT, engine TEXT, created_at REAL NOT
      NULL, updated_at REAL NOT NULL)`.
    - CASCADE + secure_delete + the existing scrub give delete/wipe erasure. The raw-bytes
      tests after delete and after wipe must include a transcript sentinel.
    - An insert or update after the attachment was deleted → the FK error means "gone";
      discard the result, never a 500.
(c) `cleanup=0`, no `session_id`, no `context`: AGREED, plus `private=1` as above.
(d) Limits:
    - single-flight per attachment and a global 1 in flight: AGREED;
    - 6/min per identity: AGREED;
    - max duration = the existing voice cap (15 min, R11), not a new number;
    - **cmd timeout = 60 s + 0.5 × the note's duration in seconds** (a 15-minute note on the
      CPU engine will not finish in 60 s).
AMENDMENT — the route must be ASYNCHRONOUS. Cloudflare cuts a proxied origin response at 100 s
(a 524), and a long note can take longer than that.
- `POST /api/admin/server/attachments/{id}/transcribe` (token required):
  - → **202 `{"transcript":{"status":"pending"}}`** after upserting a `pending` row, then
    run the job via `ContainedTaskGroup.spawn` (Inv 47), single-flight;
  - → **200** with the stored transcript when it is already `done`;
  - a `failed` row is reset to `pending` and re-run (that is the retry).
- On completion, set `done` or `failed` and append `message_updated`. The Attachment JSON
  gains `transcript: null | {status, text?}`, which both devices render from the stream: a
  spinner while pending, the text (with a per-device Hide/Show) when done, and a plain error
  plus Retry when failed.
- At startup, stale `pending` rows (a crashed job) → `failed`, so the user can retry.
- The privacy/cost note goes in its own decisions/ entry, as the operator asked. It must
  state:
  - the cmd no-retain guarantee and its tests;
  - loopback only, no third party, no per-request cost (it shares the hub GPU/CPU with
    dictation);
  - no LLM sees the text;
  - the transcript is erased with its message;
  - Parakeet's English-centric accuracy caveat.
- Every commit: `Release-note: General bug fixes and improvements.` (R14a).
SEQUENCING: the wixy side is built now against a fake cmd implementing the private-mode
contract and probe, and may merge once its tests pass. It is safe to merge early: without a
`private: true` probe answer the button stays hidden and the route answers 503, so no audio is
ever sent to a retaining cmd. It switches itself on when cmd's private mode is live. The
operator-visible feature is "done" only when that cmd change is deployed and one real private
transcription has been verified end to end, with nothing new under `dictation-audio/` or in
`asr-shadow.jsonl`.

======================== ITEM 10 — REPLY TO A MESSAGE: APPROVED, with these rulings ========================
Operator request (round 2, item 10, delivery task a7e1a1aa): pick a message and write a reply that
quotes it. A quoted preview sits above the composer, the sent bubble carries a quote header, and
tapping the quote scrolls to the original. Architect ruling, 2026-09-25, on the Delivery Manager's
three questions.

(1) SCHEMA — a nullable self-referencing column, NOT a mapping table.
- Migration (its number is assigned at merge):
    ALTER TABLE messages ADD COLUMN reply_to_seq INTEGER
      REFERENCES messages(seq) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_reply_to
      ON messages(reply_to_seq) WHERE reply_to_seq IS NOT NULL;
- Why a column: a message quotes at most one message, and the reference is fixed at send and never
  edited. A mapping table adds a join and a second lifecycle for nothing. (Reactions needed a table
  because one message has many.)
- The index is REQUIRED, not tuning. Measured 2026-09-25 (Python 3.14's sqlite3, 20,000 messages,
  one in three a reply): `DELETE FROM messages`, which is what wipe runs, took 17.6 s without the
  index and 0.2 s with it, because each deleted row's SET NULL action searches the child column.
  The same applies to any other FK that points at `messages(seq)`, e.g. reactions: its lookup must
  be index-covered (a primary key that leads with `message_seq` qualifies).
- `ALTER TABLE ... ADD COLUMN` with this REFERENCES clause is legal under `foreign_keys=ON`,
  because the column's default is NULL (probed the same day). An unknown target on insert raises
  `FOREIGN KEY constraint failed` (see (3) for how the route avoids that).
- Blue/green overlap: an older slot process ignores the column on read and inserts NULL on write.
  Its hard delete still nulls the replies, because the action lives in the schema, not in code.

(2) ERASURE (Inv 40, Inv 46) — store the reference, NEVER a copy of the quoted content.
- The reply row holds only `reply_to_seq`. The quote (the target's sender, a text snippet and a
  media summary) is computed at READ time from the live target row, in the same read transaction
  as the page (`list_messages` / `get_messages` load the targets and their attachments by seq,
  including targets outside the page). Deleting or wiping the target therefore erases its words
  everywhere, quotes included.
- FORBIDDEN: copying the quote into the reply, which is how WhatsApp does it. The deleted message's
  text would survive inside every reply to it, and Inv 46 would be broken.
- Target deleted → the reply stays and its quote disappears: ON DELETE SET NULL, with NO
  placeholder. An "Original message deleted" line is exactly the chat-visible tombstone Inv 46
  forbids. A deleted message leaves no trace in the thread, and a reply to it simply becomes an
  ordinary message. Wipe removes everything, as today.
- Client, on `message_deleted{seq}`:
  - remove the quote element IN PLACE from every loaded bubble and pending echo whose
    `replyTo.seq` equals that seq. Never re-render the whole bubble, which is the same voice/video
    cut-off trap as reactions;
  - cancel the composer's pending reply if it targets that seq.
  This client rule IS the mechanism, and it also covers a delete made by an older slot process.
  The server does NOT fan out `message_updated` for replies on delete.
- Required tests, extending the existing ones:
  - Server raw bytes after deleting a target that has replies: the target's sentinel text is in
    neither `server.db` nor its WAL, and the reply survives with `replyTo: null`. The same after a
    wipe.
  - A bare `DELETE FROM messages WHERE seq = ?` (the older-process case) nulls the reply.
  - Client: after `message_deleted` for the target, no DOM node (bubble quotes, echoes, the
    composer bar) contains its sentinel, and a playing `<audio>` in the reply keeps its identity
    and `currentTime`.
- Push is already payloadless, so nothing new leaves the server.
- The pending reply lives in memory only, as part of the composer draft (see (4)). Never
  localStorage, sessionStorage or IndexedDB.

(3) WIRE CONTRACT.
- Send: the `POST /messages` body gains an optional `replyToSeq: int | null`.
  - 422 `invalid` if it is present and not an integer >= 1 (booleans rejected).
  - Inside `create_message`'s existing BEGIN IMMEDIATE transaction: if the target row exists,
    store it. If it is missing (deleted in the meantime, or never existed), store NULL and send it
    as a plain message (201). That is exactly what would have happened had the delete landed a
    moment later. Never a 500 (the FK would otherwise raise IntegrityError).
  - An idempotent `clientId` retry returns the stored row unchanged.
- The Message JSON gains `replyTo: null | {seq, sender, text, truncated, media}`:
  - `sender`: the target's stored sender.
  - `text`: the target's text cut to 300 code points (Python `text[:300]`; TS
    `Array.from(text).slice(0, 300).join("")`), or null. `truncated` is true exactly when it was
    cut. No other transformation; the client collapses whitespace with CSS.
  - `media`: null when the target has no attachments, else
    `{kind: "photo"|"video"|"voice"|"mixed", count, durationS, thumbUrl}`.
    - `kind` is the attachments' shared kind, or `"mixed"`.
    - `durationS` is the single voice note's or video's duration when `count == 1`, else null.
    - `thumbUrl` is a signed URL (the page's own MediaSigner) of the FIRST attachment's `thumb`
      (photo) or `poster` (video) rendition, only when that attachment is `ready`; otherwise
      null. Never the `full` or `play` rendition.
  - It is present in GET /messages, the POST /messages response and every SSE `message` /
    `message_updated` frame, since all of them go through `message_json`.
- Quote freshness: the target's text never changes, but its attachments' state does
  (processing → ready/failed). `finish_attachment` therefore also appends `message_updated` for
  each direct reply to the finished attachment's message (`SELECT seq FROM messages WHERE
  reply_to_seq = ?`, which the index serves) in the same transaction. So a quote gains its
  thumbnail when the video finishes processing. The client patches the quote element in place.
- One level only: a quote shows the target's own content, never the target's own quote.
- Drift guard (REQUIRED, as for the emoji allowlist): the composer preview builds the same
  `replyTo` object client-side from the loaded target (`replyToFromMessage`). One shared JSON
  fixture of cases is asserted by both pytest and vitest. It must cover:
  - text under, at and over 300 code points, including an emoji astride the boundary;
  - attachment-only messages: single, multiple of one kind, and mixed;
  - an attachment that is processing versus ready;
  - a voice note's duration.

(4) UI.
- Trigger: the EXISTING message action menu (⋯, long-press, right-click), as the Delivery Manager
  proposed.
  - "Reply" is the FIRST item, above "Copy text", on every confirmed message: text or media, mine
    or theirs.
  - NO swipe-to-reply: a sideways swipe fights the phone's back-swipe and thread scrolling, and
    the menu path is what the operator described.
  - "Reply" is NOT a gesture boundary. It opens no surface under the finger, and the next tap
    normally lands in the input, which is excluded. The ⋯ trigger already is a boundary.
- Composer bar: above the input row. It shows "Replying to You|<name>", the quote (the same
  renderer as the bubble) and a ✕ button (aria-label "Cancel reply").
  - Picking Reply on another message replaces the target.
  - Picking Reply focuses the input. On a phone that raises the keyboard, which is intended here,
    unlike Settings.
  - The bar never disables, blurs or resizes the input itself (the recent fix stays true). If the
    thread is at the bottom when the bar appears or disappears, it stays at the bottom.
- ESCAPE STAYS THE PANIC LOCK (R3). It does not cancel a reply. Only ✕, a send, the target's
  deletion and a wipe cancel it.
- Draft semantics: the reply target is part of the composer draft.
  - `takeDraft` / `restoreDraft` / `discardDraft` carry it, so a failed send restores it.
  - A lock keeps it in memory exactly like the draft text (the thread keeps every message across a
    lock too).
  - A voice note captures the reply target at the moment recording stops: the note becomes a reply
    and the bar clears. Its retries keep it (same `clientId`).
- Optimistic echo: the echo renders the quote from the client-built `replyTo`, and the confirmed
  message replaces it with the server's.
- Sent bubble: a quote block at the top of the bubble, containing:
  - an accent bar and the sender name, "You" when the target's sender `isMine` (R8);
  - the snippet, clamped to 2 lines, with "…" when `truncated`;
  - a 40 px thumbnail when there is a `thumbUrl`, else a text label: "Photo", "Video",
    "Voice note · 0:42", "3 photos", "2 videos", "2 voice notes" or "4 attachments".
  The quote is a `<button>` whose accessible name reads like "Show the original message from
  <name>".
- Tapping the quote scrolls to the original, centres it and highlights it for about 1.5 s (an
  instant scroll and no animation under `prefers-reduced-motion`).
  - Not loaded yet → page backwards with the existing `before` cursor (limit 100) until it is
    loaded or `hasMore` is false. The quote shows busy meanwhile. Abort on a lock, a wipe or
    another tap.
  - Not found (deleted in the meantime) → remove the quote.
  - The quote button carries `data-srv-gesture-boundary`. By the v1.5.2 test, its tap makes a
    different control (the original) appear under the finger. So a double-tap on a quote never
    locks either.
- "Copy text" copies only the reply's own text. Deleting a reply deletes only the reply.
- Verify on a narrow phone viewport as well as desktop (the composer bar and quote block must not
  overflow or truncate the name badly).

(5) IDENTITY / AUDIT: nothing new. A reply is an ordinary message with its own `sender`,
`device_id` and `by_email`, and the reference is structural. No `by_email` on the reference.

(6) PROCESS.
- This is a schema migration and it touches Inv 46, so it needs an opus audit before merge, with
  this item as the acceptance criteria. It is not otherwise security-gated (no new auth surface).
- New invariant (the next free number at merge): "A reply stores only the quoted message's seq.
  The quote is derived at read time, and it vanishes with the original."
- Update docs/ai/livechat.md, contracts.md, invariants.md (including Inv 46's *Enforced by*) and
  the CLAUDE.md store-schema table in the same PR.
- Every commit: `Release-note: General bug fixes and improvements.` (R14a).
