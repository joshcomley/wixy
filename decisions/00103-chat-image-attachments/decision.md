# Chat image attachments — cmd compresses server-side, wixy validates + references by upload id

## The ask

"we also need the ability to upload/paste images in the chat, and have them auto-compress
like in cmd" — a live, mid-session operator request, not part of the original W0/PR1-6
brief. The owner wants to show the assistant a photo (e.g. "what do you see in this
image?", or pointing at a specific treatment photo) from the chat composer, the same way
cmd's own web UI lets an operator drop an image into a chat.

## What was decided

**cmd does its own image compression server-side; wixy does NOT re-implement it.**
Confirmed by reading cmd's own source (`engine/upload_processing.py`,
`engine/upload_routes.py`, `docs/ai/contracts.md`, `src/ts/compose-attachments.ts`): cmd's
own web chat UI does zero client-side compression — it base64-encodes raw bytes and lets
the SERVER resize+re-encode. The real work is `POST /api/uploads` (cmd portal, 9320):
`ImageOps.contain` to a **1568px longest edge** (LANCZOS, aspect-preserved, no-op if
already smaller — chosen to sit safely under Anthropic's "2000px + multiple images"
rejection ceiling, per cmd's own source comment), `exif_transpose` first, convert to
**WEBP quality 85 method 6**, animated GIF/WEBP → first frame only. Cap: **5MB per
attachment** (cmd-enforced, HTTP 413). Building a second Pillow pipeline in wixy for this
would be pure duplication of behavior cmd already owns and tunes.

**Wire format is two-step and reference-based, never bytes-in-the-send-call:**

1. `POST {cmd portal}/api/uploads` — `{kind:"image", name, media_type, bytes_b64,
   session_id?}` → 201 `{id, original:{...}, converted:{width,height,media_type,...},
   processing_ms}`. New `CmdChatClient.upload_attachment()`
   (`wixy_server/cmdchat.py:413`) does this; returns `UploadResult(upload_id, width,
   height)` (`cmdchat.py:108`) — `width`/`height` are the CONVERTED (post-resize)
   dimensions, the right numbers for a UI preview caption, not the original upload's
   (mirrors the `contentSrc`-vs-display-URL "two forms of the same value" split
   decisions/00095 established elsewhere in this repo).
2. `POST {cmd portal}/api/session/{id}/send` — **the SAME route wixy already calls** for
   plain text (`CmdChatClient.send_message`, `cmdchat.py:385`) — gains an `attachments:
   [{kind:"image", upload_id}]` field, included ONLY when non-empty (an ordinary text send
   has byte-identical wire shape to before this feature). cmd resolves each `upload_id` to
   the already-converted bytes on disk and builds a native Anthropic `image` content block
   — the payload on `/send` itself stays tiny regardless of the original image's size.

**`supports_attachments: bool` capability flag on `AIBackend`, mirroring the EXISTING
`supports_handover_chains` pattern exactly** (`wixy_server/ai/backend.py:69`).
`CmdAIBackend.supports_attachments = True` (`backend.py:132`, full implementation).
`AnthropicAIBackend.supports_attachments = False` (`anthropic_backend.py:79`) — the
standalone/anthropic backend (milestone 6) has no attachment mechanism of its own, and per
this repo's own CLAUDE.md, milestone 6 is one of the independence-phase milestones (2, 3,
4, 6, 7) marked **SECURITY-GATED** ("open the PR, peer-message the spec author session...
merge only after an explicit approval reply — never auto-merge on green CI alone").
Building attachment support there would require engaging that heavier process —
deliberately not done here, mirroring the identical judgment call already made for the
SAME backend/capability-split shape in decisions/00101 (the chat-activity-enum work).
`routes_chat.py`'s `send_message` (`routes_chat.py:184`) and the new `upload_attachment`
route (`routes_chat.py:215`) both **422** — never silently drop — when an attachment is
attempted against a backend with `supports_attachments = False`.

**wixy does its own THIN validation guard before forwarding to cmd — not a compression
pipeline.** New module `wixy_server/chat_attachments.py`: `validate_attachment(data,
content_type)` checks size (5MB cap, matching cmd's own exactly — `_MAX_UPLOAD_BYTES`,
`chat_attachments.py:21`), content-type (`image/{png,jpeg,gif,webp}`, matching cmd's own
accepted set exactly — `_ALLOWED_CONTENT_TYPES`, `chat_attachments.py:26`), and that the
bytes are genuinely Pillow-readable. Deliberately does NOT resize/re-encode (unlike
`wixy_server/media.py`'s `process_upload`, a different consumer — published site images,
not a model's vision input) — cmd's own `/api/uploads` already does that work
authoritatively server-side, so re-implementing it in wixy would be pure duplication. A
bad upload gets an immediate, clear wixy-side 422 rather than a slower round-trip to cmd
for its own 413/400.

**v1 scope: attachments work ONLY in an already-open conversation's composer (`/send`),
NOT the "New conversation" first-message flow (`new-chat`).** Deliberate, not an
oversight. cmd's `new-chat` endpoint also appeared to accept an `attachments` field in the
docs found during research — but with a shape notably WITHOUT the `kind` field `/send`'s
shape has, and this discrepancy was never resolved with full confidence. Rather than guess
at an unconfirmed wire shape for a secondary entry point, scope was limited to the
well-confirmed, thoroughly-tested `/send` mechanism. A future session extending to the
new-conversation flow should re-confirm cmd's exact new-chat attachment wire shape first
(its own `docs/ai/contracts.md`, not guessed from this entry).

**Frontend** (`admin-ui/src/chatPanel.ts`, `mountConversationView`): a 📎 attach button
(hidden unless `StateResponse.chatAttachmentsSupported` is true — read once at mount, not
polled), a hidden file input, paste-image and drag-drop handlers (a plain text paste is
unaffected — `preventDefault()` fires only when at least one pasted item is an image
file), and a chip row showing each pending attachment (spinner while uploading, ✕ to
remove). `send()`'s early-return guard changed from `text === ""` to `text === "" &&
pendingAttachments.length === 0`, so an image-only send (no caption) is allowed; Send is
disabled while any attachment is still uploading.

## Accepted limitation: cmd's read-side has no attachment field

cmd's own `GET /sessions/{id}/messages` (the read/transcript endpoint wixy already polls
for the chat stream) has **no attachment field on decoded messages at all** — a historical
message that was image-only shows as blank/empty text on reload. This is a known,
confirmed-via-research v1 limitation, not a bug wixy introduced and not something to build
around: cmd's read-side genuinely doesn't expose it, so there is nothing for wixy to
surface differently. A future fix would need to land in cmd itself.

## What to watch for

- **The one genuinely unconfirmed assumption**: cmd's own docs state an attachment only
  becomes a real vision content block if the send resolves to `method=="stream-json"`; a
  send routed instead to `dispatch`/`writeconsole`/`sendkeys` downgrades to a text-footer
  `@<path> (WxH)` mention relying on the model's own Read tool, not a native image block.
  Wixy's conversations use the subscription bucket + `model: "claude-sonnet-5"`, which
  SHOULD resolve to `stream-json` (matching how every other programmatically-spawned,
  never-dispatched-to-a-visible-window chat on this fleet behaves) — but this was an
  assumption at implementation time, settled only by live production verification (see
  this decision's own follow-up verification, or a later correction entry if it turned out
  wrong).
- `bucket="credit"` + attachments is rejected by cmd (400); non-Claude "foreign" providers
  other than gemini reject attachments outright. Not relevant to wixy's own conversations
  today (subscription bucket, Claude), but relevant if the model/bucket ever changes.
- If a second admin-facing image-upload path is ever added (the new-conversation
  first-message flow, or a non-chat use), re-confirm cmd's exact wire shape for that path
  rather than assuming it matches `/send`'s — the two shapes were observed to differ in
  the `kind` field during this feature's own research.
