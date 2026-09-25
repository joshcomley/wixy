# Server chat — Architect rulings, round 2: reactions and voice-note transcription

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
