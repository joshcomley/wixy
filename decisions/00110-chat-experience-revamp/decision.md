# Chat experience revamp — full-height layout, shared composer, attachment thumbnails everywhere

## The ask

Operator report (2026-08-02, with a phone screenshot of the admin Chat tab): "The chat
experience is not so great in Wixy. It should be exactly on a par with CMD." The
specifics, quoted:

- "the text is overflowing the chat input box"
- "it's not stickied at the bottom. You don't realize you have to scroll in a sort of
  double-scroll way to get to the chat input box at the bottom"
- "when you start a chat, you can't attach an image"
- "when you attach an image, it doesn't embed in the chat as a little preview thumbnail
  that you can tap on to expand"
- "we need a revamp of the chat experience in Wixy so that it's a full-screen experience
  just where the chat input area at the bottom is stickied and that it scrolls to the
  end of the chat with you … Show the previews for attachments and all that stuff so it
  just feels like a beautiful, seamless chat experience."

The same message considered sharing cmd's own chat control and then withdrew it:
"although actually for separate publication of Wixy, forget that" — so the revamp is
Wixy's own, consistent with the independence phase (Wixy must publish standalone).

## Root causes (confirmed against the code, not guessed)

1. **Double-scroll / stranded composer.** `.wx-main` is the shell's only scroll region
   (decisions/00085's root-scroll contract). The conversation view stacked its children
   in normal flow — header, banners, task card, reasoning toggle, a `max-height: 60vh`
   internally-scrolling thread, THEN the composer — so on a phone the stack was taller
   than the viewport: `.wx-main` scrolled (outer) AND the thread scrolled (inner), and
   the composer sat below the fold, under the phone's system bar (no safe-area padding).
2. **Overflowing input.** The composer textarea was fixed `rows=2`, `resize: vertical`,
   no auto-grow.
3. **No attach on chat start.** decisions/00103 deliberately scoped attachments to the
   open-conversation `/send` path because cmd's new-chat attachment wire shape was
   unconfirmed.
4. **No thumbnails in the transcript.** cmd's decoded-messages read API has no
   attachment field (00103's accepted limitation). Worse, production sends with
   attachments resolve to cmd's DRIVER methods (its auto-method resolver — wixy's
   `send_message` passes no explicit method), which embed a raw
   `Attachments:\n@C:\...\converted.webp (800x600)` footer IN the message text — and the
   panel rendered that footer verbatim as prose (the screenshot's ugly wall of paths).

## What was decided

### Layout: one scroll region, composer pinned by layout

The conversation view is now a full-height flex column inside `.wx-main`
(`.wx-chat-conversation-view { display:flex; flex-direction:column; height:100% }`):
header/banners/task card are `flex:none`, ONLY the thread scrolls (`flex:1;
min-height:0; overflow-y:auto`, the `60vh` cap deleted), and the composer is the last
`flex:none` child — pinned at the bottom by layout, never `position: sticky`, never
reachable only by scrolling. `padding-bottom: env(safe-area-inset-bottom)` keeps it
clear of the phone's gesture bar. The shell's `100dvh` +
`interactive-widget=resizes-content` (already present) rides it above the on-screen
keyboard. E2E asserts: thread scrolls, `.wx-main` does NOT, composer fully within the
viewport.

The thread now STICKS to the bottom only while you're already at the bottom (48px
hysteresis): the old unconditional `scrollTop = scrollHeight` on every render yanked
you down on every 1.2s poll while reading history. Scrolled up + new arrivals = a
"↓ New messages" jump pill. Late-loading thumbnail images re-stick via their `load`
event.

### One shared composer (`admin-ui/src/chatComposer.ts`)

Both the "New conversation" box (list view) and the open-conversation composer are the
SAME component now (a `mode` switch preserves every legacy class hook the tests and
e2e select). It owns: auto-growing textarea (native `field-sizing: content` where the
engine has it — Chrome/Edge 123+, Firefox 132+, Safari 18.4+ — a 44–180px-clamped
scrollHeight fallback elsewhere; 16px font on ≤720px so focusing never read-zooms),
image attachments via 📎/paste/drag-drop staged as uploads with spinner chips, submit
gated on no-upload-in-flight, Enter/Shift+Enter, and `allowEmptySubmit` for the list
view's "start with nothing" case.

### Attachments on chat start — cmd's new-chat shape CONFIRMED from source

00103 left new-chat attachments unbuilt because the wire shape was unconfirmed. It is
now confirmed by reading cmd's own source: the route docstring (`cmd server.py
api_project_new_chat`: "attachments[] mirrors the per-session send route's shape: each
entry is {upload_id}") plus `_stage_new_chat_attachments` (reads ONLY `upload_id`,
tolerates the extra `kind` key), and `workspace_provisioner.py` drains them into REAL
stream-json image content blocks on the first turn. `POST /api/uploads` accepts a
session-less upload ("The new-chat compose passes project only (no session yet)").
So: new wixy route `POST /api/admin/chat/uploads` (session-less stage), and
`create_conversation`/`CmdChatClient.new_chat` forward `attachmentIds`. An image-only
start (no text) is allowed, exactly like cmd.

### Transcript thumbnails — TWO redundant recovery mechanisms, zero cmd changes

cmd's read-side gap is closed entirely wixy-side:

1. **Footer parse** (`chat_attachments.extract_attachment_footer`, run inside the cmd
   client so the cmd-ism stays contained): mirrors cmd's OWN
   `src/ts/render/attachment-mentions.ts` contract exactly (same footer regex, same
   cmd-uploads path sentinel strictness, same whole-footer strip). Recovers every
   driver-routed send INCLUDING history from before this feature — with dims parsed
   from the `(WxH)` suffix.
2. **Send log** (`chat_sends.py`, `Storage/projects/<slug>/chat-sends.json`): wixy
   records every attachment-carrying send (create and `/send`). A stream-json-routed
   send leaves NO trace in cmd's read-back (the decoder drops image blocks), so the
   stream re-decorates matching user messages from the log. Matching is deterministic:
   exact text (both sides stored decoder-stripped), duplicates paired by ordinal FROM
   THE END (stable across re-polls, reconnects, restarts). Already-decorated
   (footer-parsed) messages are never stomped.

The bytes come from cmd's own `GET /api/uploads/{id}/bytes` (confirmed in cmd source,
`upload_routes.py` — serves the converted WEBP inline), proxied through a new wixy
route `GET /api/admin/chat/uploads/{upload_id}/bytes` (`Cache-Control: immutable`;
upstream 404/410 mirrored, never flattened to 502) so the browser never sees cmd's
localhost surface. The UI renders a 120px thumbnail grid in the bubble; tap opens a
lightbox (backdrop/✕/Esc close, focus restored).

One structural consequence handled deliberately: an image-only FIRST message reads
back as preamble-only text (the model's prompt is `<preamble>` alone when the owner
attaches without typing). `_owner_visible` would drop it as pure preamble — it now
keeps a preamble-only message that carries attachments, emitted as `text: None` so the
bubble renders thumbnails-only.

### Optimistic local echo

A sent message paints instantly as a dimmed bubble with its thumbnails (from the same
proxy URLs the server copy will use — no blob-URL lifetime coupling to the composer)
and a "sending…" caption; it's reconciled FIFO by exact text as server copies stream
in, removed immediately on send failure (composer keeps text + chips for the same-
idempotency-key retry, per spec/06 §3), and expires after 30s unmatched so nothing can
duplicate forever. cmd's own UI does the same with its `OptimisticAttachment`.

### Small polish folded in

- Reasoning toggle moved into the conversation header row (it used to eat a full row).
- The empty thread reads "Starting your conversation — the assistant will be right
  with you…" while provisioning (after pressing Start, "No messages yet." read as
  broken), and "No messages yet — say hello below." when ready.
- Bubbles get `overflow-wrap: anywhere` (long paths/URLs can't widen the thread).
- The fake cmd double now mirrors cmd's real 404 for an unknown upload id (both
  `/send` and new-chat) — the repo's own "the fake must not be laxer than the real
  service" rule (docs/ai/ai-chat.md) — plus `GET /api/uploads/{id}/bytes` serving a
  real 8x8 WEBP, and records new-chat attachments for assertions.

## What to watch for

- **cmd's send METHOD resolution can change under us.** The footer parse exists
  because today wixy's sends resolve to driver methods; if cmd's resolver changes so
  wixy conversations resolve to stream-json, the send log silently becomes the carrier
  instead — both are covered, but a transcript rendering regression here means checking
  which mechanism stopped matching, not whether thumbnails work at all.
- **`field-sizing: content`** is new-ish (2024+ engines). The JS fallback covers old
  engines; if the fallback is ever deleted, very old browsers get a fixed 2-row box
  again (the original complaint).
- The send log prunes at 200 sends — decoration beyond that relies on the footer
  parse (fine: the 80-message stream window can't show older sends anyway).
- The earlier full-e2e-suite run on the hub box flaked once with the fixture server
  dying mid-run (11 ECONNREFUSED failures across unrelated specs); a clean re-run
  passed 41/41. Same class of environmental flake as decisions/00025/00027/00030's
  disk-I/O contention — recorded here so it isn't misread as a chat regression.
