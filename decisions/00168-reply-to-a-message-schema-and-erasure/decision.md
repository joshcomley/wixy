## Symptom / request

Round 2, item 10 (operator request, delivery task `a7e1a1aa`): pick a message in the Server chat
and write a reply that quotes it — a quoted preview above the composer, a quote header on the sent
bubble, and tapping the quote scrolls to the original. The Delivery Manager raised three questions
for the Architect: schema shape, erasure semantics, and the wire contract. Full ruling:
`spec/server-chat/04-round2-rulings.md`, "ITEM 10 — REPLY TO A MESSAGE".

## Root cause / design tension

Two real constraints pull against each other: a reply needs to show the quoted message's content
(sender, text, media), but Inv 40/Inv 46 require that deleting or wiping a message erases it
completely, with no chat-visible tombstone. The naive approach (copy the quoted sender/text/media
summary into the reply row at send time, the way WhatsApp does it) would let a deleted message's
words survive forever inside every reply that ever quoted it — a durable Inv 46 violation baked
into the schema.

## Decision

1. **Schema**: `messages.reply_to_seq INTEGER REFERENCES messages(seq) ON DELETE SET NULL`
   (schema v10 — assigned at merge, after v7-v9 were claimed by reactions, voice transcription and
   device grants, which all shipped while this feature was being built), plus the partial index
   `idx_messages_reply_to`. A nullable self-referencing column, not a mapping table — a message
   quotes at most one message, fixed at send and never edited. Reactions
   (`decisions/00164-server-chat-reactions`, shipped earlier this round) need a table because one
   message can have many; a reply doesn't.
2. **Erasure**: the reply row stores ONLY the seq. The quote (sender, a 300-code-point text
   snippet, a media summary) is computed at READ time from the target's live row, in the SAME
   transaction as the page that returns it (`LiveChatStore.list_messages`/`get_messages`), one
   level only (a target's own quote is never resolved — no chained quotes). Deleting or wiping the
   target therefore erases its words everywhere it was quoted, automatically, because the erasure
   lives in the schema's foreign key (`ON DELETE SET NULL`), not in application code — this holds
   even for a bare `DELETE FROM messages WHERE seq = ?` issued by an older blue/green slot process
   that has never heard of `reply_to_seq`, as long as `PRAGMA foreign_keys = ON` is set on that
   connection (already true for every connection `LiveChatStore._connect()` opens).
3. **The index is required, not tuning.** `wipe()`'s bulk `DELETE FROM messages` deletes every row
   in the table; for each one, SQLite's FK enforcement must search the child column
   (`reply_to_seq`) for dependents to null. Measured 2026-09-25, Python 3.14's sqlite3, 20,000
   messages with one in three a reply: 17.6s unindexed, 0.2s indexed.
4. **`create_message` never lets the FK raise into a 500.** It checks the target's existence
   inside its own `BEGIN IMMEDIATE` transaction (race-free — the transaction already holds the
   write lock) and silently stores `NULL` when the target is missing, sending the message as
   plain — exactly what would have happened had the delete landed a moment later.
5. **Client mechanism for erasure**: the server does NOT fan out `message_updated` for a reply
   when its target is deleted (that would be a lot of noise for a single delete). Instead,
   `message_deleted{seq}` — already the erasure signal for the target's own bubble — is also the
   client's cue to remove the `.wx-srv-quote` element IN PLACE from every loaded bubble/echo that
   quotes that seq, and to cancel the composer's pending reply if it targets that seq. Never a full
   bubble re-render (the same voice/video playback cut-off trap Inv 46's own delete handling
   avoids).
6. **Quote freshness the other direction IS a real `message_updated`**: when an attachment finishes
   processing, `finish_attachment` appends one for the message that owns it AND for every message
   whose `reply_to_seq` points at it — so a quote gains its thumbnail the moment the target's photo
   or video becomes ready, using the same index.
7. **Wire validation**: `POST /messages`'s optional `replyToSeq` is typed loosely in the pydantic
   model (not `int | None`) because pydantic v2 silently coerces `True`/`False` to `1`/`0` for an
   `int` field (measured 2026-09-25) — validated by hand in the route instead, matching every other
   business rule there, rejecting anything that isn't a real `int >= 1`.
8. **Drift guard**: the client (`replyToFromMessage` in `admin-ui/src/server/replyTo.ts`) rebuilds
   the identical `ReplyTo` shape from an already-loaded `Message`, for the composer's preview and
   the optimistic echo — built independently of the server's `reply_to_json`. Both are asserted
   against the same shared JSON fixture (`spec/server-chat/fixtures/reply-to-cases.json`) so they
   cannot silently drift apart; it covers text exactly at/under/over the 300-code-point boundary
   (including an emoji straddling it, to prove code-point-safe truncation never splits a surrogate
   pair the way a naive UTF-16 slice would), single/multiple/mixed attachments, processing vs.
   ready, and a voice note's duration.
9. **Scroll-to-original's history call is a tri-state result, not a boolean.** `loadOlderPage` (the
   function `scrollToOriginal` reuses at a larger page size, 100 vs. the ordinary 50) returns
   `"loaded"|"blocked"|"exhausted"|"error"`. `"blocked"` (another load — ordinary scroll paging, or
   a sibling `scrollToOriginal` run — already holds the single history-load slot) had to be made
   distinct from `"exhausted"`: collapsing them to one boolean made a second quote tapped while the
   first was still paging get treated as "target deleted" and have its quote wrongly removed,
   caught by a mutation check during this build.

## What to watch for

- Any future code that touches `messages.reply_to_seq` directly (a migration, a bulk update) must
  keep `PRAGMA foreign_keys = ON` on its connection, or the `ON DELETE SET NULL` erasure guarantee
  silently stops firing.
- A future feature that ALSO needs a self-referencing or cross-row FK on `messages` should check
  `idx_messages_reply_to`'s cost lesson first: an unindexed child column on a table `wipe()` bulk-
  deletes is an O(n) tax per row, not a rare edge case.
- The drift-guard fixture (`spec/server-chat/fixtures/reply-to-cases.json`) is the first instance
  of a JSON fixture shared between pytest and vitest in this repo. Reactions (shipped earlier this
  round) used a different drift-guard shape instead — `test_livechat_reactions.py` parses
  `admin-ui/src/server/reactions.ts` directly rather than sharing a JSON fixture — so this pattern
  has no precedent to follow yet, only to set for whatever needs it next.
- This folder was renumbered `00164` -> `00168` at merge: the builder's own PR used `00164`, which
  by then collided with `decisions/00164-server-chat-reactions` (reactions merged to `main` first).
  Same discipline as the schema-version bump above — decision numbers are assigned at merge from
  the current max, never hard-coded in a stale branch.

## Audit refinements (opus audit, relation `443a3ba7`, round 4 — all fixed at merge)

The merge onto `main` (commit `369292a`) combined this feature's client-side rendering with
reactions' own "patch in place, don't rebuild" optimization (`sameExceptReactions`), which exposed
gaps neither feature's own build had reason to find in isolation:

- **`sameExceptReactions` didn't know about `replyTo`.** A reply bubble kept alive by that
  optimization (its own text/attachments unchanged) never picked up a target's deletion (still
  showing the deleted quote) or a target's attachment finishing processing (thumbnail never
  arrived). Fixed by a new `patchQuote` patched alongside `patchReactions` on the same branch.
- **A pending (not-yet-sent) reply's target deleted during a lock** was never re-checked on
  reattach — the live stream's `message_deleted` cancellation never fires across a lock (the stream
  resumes from a fresh cursor). Fixed in `attach()`, reusing the same "was this seq retained but not
  refreshed" check the history-reconciliation logic already does.
- **Three narrower races** (a stale history page arriving after a delete, a failed-send draft
  restore, a failed-delete restore) could each put a deleted target's words back into a quote or
  the reply bar. Fixed by sanitizing `replyTo` against `deletedSeqs` at `addConfirmed` (the single
  choke point for the first and third) and in `restoreServerDraft` (the second).
- **`scrollToOriginal`'s "blocked" retry was `await Promise.resolve()`** — a microtask-only yield
  that never let a sibling load's in-flight network fetch actually resolve, freezing the tab.
  Fixed to yield via a real macrotask (`setTimeout`).
- **A paging `"error"` (network/auth failure) was treated the same as `"exhausted"`** (genuinely
  ran out of history), wrongly removing a quote whose target might still exist. Fixed by tracking
  which of the two actually happened.
- A crafted `replyToSeq >= 2**63` caused an unhandled `OverflowError` (500) instead of the promised
  422 — SQLite's integer range wasn't guarded here the way the sibling `set_reaction` route already
  guards it. Fixed with the same `_SQLITE_MAX_INTEGER` check.
