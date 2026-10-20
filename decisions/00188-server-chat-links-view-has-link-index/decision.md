# 00188 — Links view backed by a stored `messages.has_link` index

**Ask (workspace 00052):** from the ⋯ menu, show only the chat messages that contain web links; the chat grows
forever, so index "has a link" and backfill it. Plus: a voice note you have listened to must leave the unread
list live, not on refresh.

**Decided**
- `messages.has_link INTEGER` (schema v18), set in the `create_message` INSERT from `links.text_has_link` (the
  same `http(s)://` rule the client linkifies with, so the view never disagrees with the bubbles). Partial
  indexes on `has_link = 1` (listing) and `has_link IS NULL` (settling). Text is never edited, so there is no
  update path; delete/wipe remove the row and the flag with it (Inv 46: no residue).
- **Nullable on purpose.** NULL = "not indexed yet". The v18 migration backfills every existing row in bounded
  batches inside its transaction. A process older than v18 during a blue/green overlap keeps inserting rows
  without the flag; `list_link_messages` settles those first (`index_pending_links`: a single indexed probe when
  clean). A `NOT NULL DEFAULT 0` column would have silently hidden every message an old process wrote.
- Listing is keyset paged on `seq` (`GET /messages/links?before&limit`), reusing the history hydration
  (`_hydrate_messages`), so a page costs the same however large the chat is.
- Rejected: scanning/regex-ing message text per request (O(chat)); a separate links table (needs its own cascade
  to honour Inv 46); client-side filtering of loaded history (only sees what is paged in).

**Voice notes.** The unread-voice-notes list used to keep a finished note "until the view closes". It now drops
the item as soon as the note is heard (90 % of natural playback, transcript request, or dismiss) and has stopped
playing — it waits for `ended`/`pause` so a note is never cut off under the listener.

**Watch for:** keep `links.text_has_link` and `linkify.ts` `textHasLink` in step; any new INSERT into `messages`
that carries text must set `has_link` (otherwise it is settled lazily, which is correct but costs a write).

## Follow-ups in the same workspace
- **Full-width thread:** `.wx-srv-thread-wrap` cancels `.wx-main`'s side padding (`--wx-srv-gutter`) and the thread
  pads its own messages by it. The layout invariant "no horizontal overflow" is now asserted on `.wx-main` (the
  panel box is narrower than the full-bleed band by design).
- **Would-you-rather topics:** shared server-side choice (`wyr_topics`, schema v19) rather than per-device, because either
  player's Next starts the next round; the pool filler follows it. Rejected: a per-device preference sent with each
  create (two players would draw from different topics).
