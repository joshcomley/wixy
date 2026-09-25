# Server chat reactions — the server-side design

## The ask

Workspace 29, round 2, item 2 (relayed by the Orchestrator): "Reaction emojis on messages (new
feature — own message model/API/UI/tests; scope as its own spec note in the ledger, don't retrofit
through the general AI-chat component)." The spec note is
[`spec/server-chat/04-reactions.md`](../../spec/server-chat/04-reactions.md); this entry records
why the design is the way it is. The client half is decisions/00165.

Architect ruling (2026-09-25) approved the plan below with five additions: a `by_email` audit
column, an exact code-point allowlist, a foreign-key failure that maps to 404, a required
in-place-patch test, and Invariant 49.

## What was decided

### The reactor is the case-folded sender name — not the device

A message's "mine" (R8) and push's self-exclusion both already mean "the display name,
case-insensitively". A reaction uses the same identity. Keying on `device_id` looked natural and is
wrong for a two-person chat: the same person on a phone and on a desktop would count twice, and a
reaction made on one device would not read as theirs on the other, so they could never take it back
there.

The key is stored as `sender_key = sender.strip().casefold()`, **not** as a `COLLATE NOCASE`
column. SQLite's `NOCASE` folds ASCII letters only, so "Émilie" and "éMILIE" would be two people
to the store and one person to push and to the client. `casefold()` is what `push.py` already uses.
The display spelling is kept separately (`sender`, as first typed) so a chip's tooltip reads
naturally. Accepted consequence, as for messages: renaming yourself orphans your old reactions.

`by_email` (the CF Access identity) is stored for audit, like `messages.by_email`. It is never on
the wire.

### Six emoji, each an exact code-point sequence

Thumbs up, red heart, face with tears of joy, face with open mouth, crying face, folded hands —
WhatsApp's quick set, which both users already know. Compared as plain strings with **no
normalisation**: the heart is U+2764 U+FE0F, so a bare U+2764 is a 422, as is a skin-tone variant or
a doubled emoji. The list lives in `livechat/reactions.py`; the browser's copy is
`admin-ui/src/server/reactions.ts`, and `test_livechat_reactions.py` parses the TypeScript file and
fails if the two ever differ. A free-form picker was rejected: the fixed list keeps validation and
storage trivial and cannot be used to stash arbitrary text in the chat database.

### One PUT that sets the desired state

`PUT /messages/{seq}/reactions` with `{emoji, sender, reacted}`. Not a toggle: a client whose
response was dropped may retry, and a toggle would then flip the reaction back. A request that
changes nothing answers 200 and writes **no event**, so a retry storm or a double-tap cannot spam
every reader's stream. An unknown or deleted `seq` is 404 — including a `seq` larger than SQLite's
64-bit integer, which would otherwise raise `OverflowError` and become a 500.

### The table cascades, deliberately

```sql
reactions(message_seq REFERENCES messages(seq) ON DELETE CASCADE, sender_key, sender, emoji,
          by_email, created_at, PRIMARY KEY(message_seq, sender_key, emoji))
```

Every store connection runs `PRAGMA foreign_keys = ON`. During a blue/green overlap an OLDER
process — one that has never heard of `reactions` — can still hard-delete a message with a plain
`DELETE FROM messages`. Without `ON DELETE CASCADE` that delete fails on a foreign-key error and
the owner sees a 500 for an action that used to work. With it the reactions go with the message and
`secure_delete` zeroes them like any other deleted row, so Inv 46 holds across the overlap. The
tests prove all three: a delete/wipe leaves neither the reactor name nor the emoji in the raw
database and WAL bytes, and a raw `DELETE FROM messages` on a foreign-keys-on connection carries the
reactions away. (Mutation-checked: without the cascade those three tests fail with
`FOREIGN KEY constraint failed`.)

`set_reaction` still checks the message exists under the same write lock before it writes, and maps
an `IntegrityError` from the write to the same not-found error. The check makes the error
unreachable in practice — the lock stops a delete from landing in between — and the mapping is the
backstop the ruling asked for; a test injects the error to keep it honest.

### The event is the existing `message_updated`

Its meaning is "this message's current state changed". The stream loop already re-reads the current
message, coalesces per message, and replays from the cursor. Reusing it means no new event type, no
change to the `events` table (already widened in migration v2), and no change to the stream —
`message_json` simply carries `reactions`. A new message plus a reaction in one batch coalesces into
one `message` frame carrying both.

### No push

The push hooks fire only for a created message, so a reaction never notifies anyone. Delete and
wipe already never notify; reactions follow.

## What to watch for

- **Migration numbers collide across parallel builds.** Round 2 has three builds adding a table
  (device grants, reactions, voice transcripts). The version is assigned at merge: rebase on the
  then-current `main`, take max+1, keep every step conditional (`if current < N`) and idempotent
  (`CREATE TABLE IF NOT EXISTS`). The tests compare against `_LATEST_SCHEMA_VERSION`, not a
  literal, so they do not need editing for a renumber.
- **`reactions` is new content the erasure paths must know about** if erasure ever stops relying on
  the cascade. Today `_delete_message` and `_wipe` do not mention it; the cascade does the work, and
  the raw-bytes tests are what would catch a regression.
- **Renaming orphans reactions**, by design (see above). If the chat ever gains real accounts, key
  on the account instead.
- **The six-emoji list is in two languages.** Change both; the drift test fails until you do.
