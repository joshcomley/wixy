# 00009 [pr7] PR 7 — chat image paste/upload with auto-compression

## What
New feature request from the operator (not in the original brief): let the site owner
paste/drop/upload an image into the AI chat composer, "auto-compressed like in cmd"
(cmd's own web chat UI).

## Research done
Dispatched an Explore agent against the `cmd` repo (`D:\Servers\Cmd\Storage\clones\cmd`).
Findings:
- **cmd's own compression is entirely SERVER-SIDE**, not client-side canvas work. The
  client (`src/ts/compose-attachments.ts`) just base64-encodes raw bytes and POSTs them
  unmodified. `engine/upload_processing.py` does the actual work:
  `MAX_LONGEST_EDGE = 1568` (resize via `ImageOps.contain`, LANCZOS, aspect-preserved,
  no-op if already smaller), convert to **WEBP quality 85 method 6**, `exif_transpose`
  first, animated formats → first frame. Caps: 5MB per-attachment (server-enforced, 413),
  30MB aggregate (client-only, informational). The 1568px number is chosen specifically
  to sit safely under Anthropic's 2000px-plus-multi-image API rejection ceiling.
- **Wire format is two-step, reference-based**, not multipart-with-the-message:
  1. `POST /api/uploads` — JSON `{kind, name, media_type, bytes_b64, session_id?,
     project?}` → 201 `{id, original:{...}, converted:{...}, ...}`. This is the SAME
     compression pipeline above — cmd does all the work, wixy doesn't need its own
     Pillow pipeline for this feature at all.
  2. `POST /api/session/{id}/send` — the SAME route wixy already calls — gains an
     `attachments: [{kind: "image", upload_id: "<id>"}]` field alongside the existing
     `text`/`idempotency_key`. `text` may be blank if `attachments` is non-empty
     (image-only sends allowed). The route resolves `upload_id` to the converted WEBP
     bytes server-side and builds a native Anthropic `image` content block — IF the send
     resolves to the `stream-json` method; otherwise it downgrades to a text-footer
     `@<path> (WxH)` mention relying on the agent's own Read tool.
  3. Caveat: `bucket="credit"` + attachments is rejected (400); non-Claude "foreign"
     providers other than gemini reject attachments outright. Wixy's own conversations
     (subscription bucket, `model: "claude-sonnet-5"`) should be unaffected, but this
     needs live confirmation once implemented (does a real wixy-created conversation's
     send resolve to stream-json? — untested assumption, verify for real before calling
     this done).
- cmd's `/messages` read-side response shape (`docs/ai/contracts.md`) DOES model a
  `type: "attachment"` JSONL event kind, separate from user/assistant text — needs
  checking against wixy's own `ChatMessage`/`_message_from_dict` (currently has no
  attachment field at all) to decide how a historical message's attachment should
  render on reload.

## Design sketch (not yet built)
- `wixy_server/cmdchat.py`: new `upload_bytes(data, name, media_type, session_id) ->
  UploadResult` (calls cmd's `/api/uploads`); extend `send_message` to accept
  `attachments: list[str] | None`.
- `wixy_server/ai/backend.py`: add `supports_attachments: bool` capability flag
  (mirrors the existing `supports_handover_chains` pattern) + an `upload_attachment`
  protocol method. `CmdAIBackend.supports_attachments = True` (full impl);
  `AnthropicAIBackend.supports_attachments = False` for now — the standalone/anthropic
  backend's OWN worker has no such mechanism yet, and (like decisions/00101's finding)
  building one is milestone-6-gated (security review required) — same judgment call as
  that decision: implement fully for the live fleet backend, explicitly flag the gap for
  the other rather than silently half-supporting it.
- `wixy_server/routes_chat.py`: new `POST .../conversations/{id}/attachments` route
  (multipart, mirrors `media.py`'s existing upload convention) forwarding to cmd;
  `SendMessageIn` gains `attachmentIds`. A 422 if attachments are attempted against a
  backend with `supports_attachments = False` — never silently drop.
- `GET /api/admin/state` (or conversation summary) needs to expose whether attachments
  are supported so the admin-ui can decide whether to show the attach affordance at all
  (the UI is otherwise backend-blind by design, spec/independence/05 §1).
- `admin-ui/src/chatPanel.ts`: paste/drop/file-picker handlers on the composer (no
  existing paste handling anywhere in admin-ui today — genuinely new), an
  uploading/attached-chip row, include `attachmentIds` on Send.
- Full test/lint/build gate + e2e + a decisions/ entry + live verification (attach a
  real image to a real conversation, confirm the model can actually describe what's in
  it — not just that the upload/send calls succeeded).

## Status
Research phase done; design sketched above; implementation not yet started (paused
mid-research by the Before & After thumbnail bug report, PR6/00008 — resume here).
