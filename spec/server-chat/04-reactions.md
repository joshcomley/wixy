# Server chat — reactions on messages

Architect ruling, 2026-09-25. Binding for workspace 29 round 2, item 2. Folded into
`00-brief.md` (§4, §5, §6, Inv 46) at the next reconciliation.

**Operator request (relayed by the Orchestrator):** "Reaction emojis on messages (new feature
— own message model/API/UI/tests; scope as its own spec note in the ledger, don't retrofit
through the general AI-chat component)."

This is the Server chat's own feature. It shares nothing with `chats.py` / `cmdchat.py` (the
AI assistant); decisions/00110's split between the two chats stands.

## 1. What a reaction is

One person puts one emoji on one message. It is a small, public mark: it says who reacted and
with what, and nothing else.

- **Who "one person" is:** the trimmed, case-folded **sender name** — the same identity that
  decides which bubbles are "mine" (R8) and which device a push skips. It is not the device.
  The same person on a phone and on a desktop is one reactor, so a reaction made on one shows
  as theirs on the other, and tapping it there removes it instead of counting twice. Accepted
  consequence: renaming yourself makes your old reactions read as someone else's, exactly as
  your old messages stop aligning right.
- **How many:** one row per (message, reactor, emoji). A person may hold several *different*
  emoji on one message; they cannot hold the same emoji twice.
- **Which emoji:** a fixed list of six, WhatsApp's quick set — thumbs up, red heart, face with
  tears of joy, face with open mouth, crying face, folded hands. Each entry is an **exact
  code-point sequence**, compared as a plain string with no normalisation: the heart is
  U+2764 U+FE0F, with its variation selector, so a bare U+2764 is refused. Anything else is a
  422. The server's list is `wixy_server/livechat/reactions.py`; the browser's copy is
  `admin-ui/src/server/reactions.ts`, and a test parses the second and fails if they differ.
- **Desired state, not a toggle.** The request says whether the reaction should be present or
  absent. A retry after a dropped response therefore cannot flip it back.
- **No push, no unread mark.** A reaction never notifies anyone; the push hooks fire only for a
  created message. Reacting to a message also never changes the disguise.

## 2. Data

A new table, in the next free schema version (assigned at merge; see the decision entry):

```sql
CREATE TABLE IF NOT EXISTS reactions(
  message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
  sender_key TEXT NOT NULL,   -- reactor identity: sender.strip().casefold()
  sender TEXT NOT NULL,       -- as first typed; what the chips show
  emoji TEXT NOT NULL,        -- one entry of the allowlist
  by_email TEXT,              -- CF Access identity, audit only, never on the wire
  created_at REAL NOT NULL,
  PRIMARY KEY(message_seq, sender_key, emoji));
```

- **`ON DELETE CASCADE` is deliberate.** Every store connection runs with `foreign_keys=ON`.
  During a blue/green overlap an OLDER process, which knows nothing about this table, can still
  hard-delete a message. Without the cascade that delete would die on a foreign-key error. With
  it, the reactions go with the message and `secure_delete` zeroes them like any other deleted
  row.
- **`sender_key` is `casefold()`, not SQLite's `NOCASE`.** `NOCASE` folds ASCII only; push
  self-exclusion already uses `casefold()`, and a reaction has to agree with it.
- **`events` is untouched.** A reaction change appends the existing `message_updated` event, which
  the stream already re-reads and coalesces.

## 3. API

One route, under `/api/admin/server`, behind the same two gates as every chat route (CF Access +
the unlock token):

**`PUT /messages/{seq}/reactions`** — body `{"emoji": str, "sender": str, "reacted": bool}` (no
other keys; `reacted` must be a real boolean).

- `sender` follows exactly the `POST /messages` rules: trimmed, 1–32 characters, no control
  characters.
- → **200 `{"message": <Message>}`** — the message as the server now holds it, with `reactions`.
- A request that changes nothing (adding what is already there, removing what is not) still
  answers 200, but writes **no event**.
- → **404 `{"error": "not_found"}`** for an unknown or already-deleted `seq`. This includes a
  `seq` too large for SQLite, and it is never a 500: a foreign-key failure inside the write is
  mapped to the same 404.
- → **422 `{"error": "invalid", "detail": str}`** for an emoji off the list or a bad sender;
  → 422 (FastAPI's validation shape) for an unknown key or a non-boolean `reacted`.
- → 401 `{"error": "locked"}` without a valid token, like every other route.

`<Message>` gains `reactions: [{emoji: str, count: int, senders: [str]}]` — only emoji with at
least one reactor, in allowlist order, `senders` oldest first. `by_email` is never returned. History
(`GET /messages`), the send response and the stream all carry it, because they all build a message
through `message_json`.

## 4. Stream

`message_updated` already means "this message's current state changed", and the stream loop
already re-reads the current message and coalesces per message. A reaction change appends one
`message_updated`. Nothing about the stream changes; the frame simply carries `reactions`.

## 5. Client

**Chips.** Under a message's text and attachments, one chip per emoji: the glyph and a count. A
chip is a button (`aria-pressed`, a spoken label such as "Thumbs up, 2 reactions, including yours.
Tap to remove yours", and a `title` listing the names). Mine are highlighted. Tapping a chip sets
my reaction to the opposite of what it is now. A chip needs no gesture boundary: it is an
independent control, so two quick taps on chips still count toward the double-tap lock, as any
toggle does.

**The menu's emoji row.** The message's existing ⋯ menu (and the touch long-press sheet) gets a
row of the six emoji at the top. Each is a `menuitemcheckbox`, checked when I hold it, and each
carries `data-srv-gesture-boundary`: it appears because of the tap that opened the menu, which is
the causal-flow case (R3 v1.5.2). Picking one applies it and closes the menu.

**Feedback.** A tapped chip dims and is disabled until the server answers. A reaction being
*added* shows at once as a dimmed chip with a count of one. A failure leaves the old state and
shows one line under the message — "That message was deleted." for a 404, otherwise "Couldn't
update the reaction. Try again." — for five seconds. A 401 locks the chat.

**The trap: never rebuild a bubble for a reaction.** The thread used to rebuild a message's whole
bubble whenever the message object changed, which disposes its media. A reaction from the other
person would therefore have cut off a voice note or video that someone was playing — for every
reader, on every reaction. When a new version of a message differs from the rendered one *only in
its reactions*, the client patches the reactions row in place and updates the open menu; the bubble
node, its `<audio>`/`<video>`, the playback position and the open menu are untouched. Anything
else that changed (an attachment finishing processing, fresh signed URLs after a re-unlock) still
rebuilds, as before.

**The stream is the one ordered source of truth.** The PUT response is applied only if no newer
message state arrived while the request was out and the chat was not wiped meanwhile; otherwise
the stream's own frame supplies the state. That way a slow response can never overwrite fresher
state, and can never bring a wiped or deleted message back.

**Older server.** During a blue/green swap the page can briefly talk to a server that predates
reactions; its messages carry no `reactions`. The client reads that as "none".

**Phone.** The emoji row wraps inside the menu's own width (round 36 px buttons, six of them in
under 15 rem), the chips wrap inside the bubble, and neither creates sideways page scroll at 360
px.

## 6. Erasure (Inv 46)

Deleting a message removes its reactions (the cascade); wiping the chat removes every reaction. The
raw-bytes tests after delete and after wipe include a reactor name and an emoji sentinel. A
reaction to a message that has been deleted is a 404, so a reaction can never resurrect one.

## 7. Not doing

- No free-form emoji picker and no custom emoji: the fixed list is what keeps the stored value
  and the validation trivial.
- No push, unread mark or sound for a reaction.
- No reaction history, no "who reacted when", and no per-device identity.
- No rate limit beyond the chat's own; a reaction is one small row.

**Invariant 49** (`docs/ai/invariants.md`) records the numbered guarantees.
