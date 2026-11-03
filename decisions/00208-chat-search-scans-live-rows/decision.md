# Chat search reads the live rows with no index

## Asked for

"I need a search function in Wixy chat to find and jump to messages." Added mid-build, in the same
delivery: a date strip at the top of the chat once scrolled back before today, and a Message info
item in a message's ⋯ menu with the exact send time.

## Decided

**No search index.** `LiveChatStore.search_messages` reads `messages.text` and finished
`attachment_transcripts.text` on every search and folds them in Python
(`livechat/search.py`). SQLite FTS5 was rejected, and not on speed:

- An index is a second copy of every message. Inv 46 promises that a delete or a wipe erases chat
  text, proved by raw-byte tests on the database file. Every erasure path would have to reach the
  index too, including a delete issued by an OLDER process during a blue/green overlap, which is
  exactly why the reactions table had to rely on cascades (decisions/00164). FTS5 also keeps deleted
  terms in its segments until they merge unless its own secure-delete option is on.
- FTS5 tokens match whole words or prefixes, its folding is not this chat's (curly apostrophes, `ß`),
  and substring search needs the trigram tokenizer, which is a bigger copy still.
- It is not needed. Measured on made-up messages, every search a full scan, nearly every row taking
  the slower non-ASCII path: 12,000 messages + 1,200 transcripts (the real chat's size on
  2026-11-03) 52-64 ms; 200,000 + 20,000 about 1.3 s. `test_search_adds_no_table_holding_a_copy_of_the_chat`
  pins the absence of a table.

**A POST, not a GET.** What somebody searched for must not sit in a URL, where access logs and
anything between the browser and the server keep it. The response is `no-store`. Nothing is logged,
and the client keeps the query only in memory until a close, lock or wipe.

**View-once is never searched**, not even a row that somehow carries text (Inv 52's spirit: seen
once, on its own terms). A pending or failed transcript is not searched either.

**The server does all the matching and returns the excerpt in parts** (`[{text, match}]`) plus the
matched words as written. Offsets were rejected: Python counts code points and JavaScript UTF-16
units, so any emoji would shift them. It also means no second implementation of folding in the
client to drift. Bubble marks use the CSS Custom Highlight API with those literal strings, so a
bubble's DOM is untouched and a playing voice note is not disturbed.

**A jump shows only the message's neighbourhood (the detached view).** The first build loaded
everything back to the target in one big response and rendered it, keeping history contiguous. It was
rejected by measurement: at 12,000 messages it built 565,354 page elements (46 per bubble, mostly
each bubble's menu and emoji picker) and took 5.2 s on a fast desktop, and with the browser's CPU
slowed 4 times it had not finished after 200 s. Making bubbles lighter would only have shrunk a cost
that need not exist, and every later arrival would still have paid to walk all of them. Instead
`GET /messages?around=` fetches 50 messages and the thread renders that stretch alone, cut off from the
newest messages (still held and arriving) by an unloaded gap. Measured the same way, CPU slowed 4 times,
12,000 messages: 155 ms and 25 bubbles to the very oldest. Everything else in the thread already copes
with partial history, so the only new states are "rendering stops at `high`" and paging newer. A lock
leaves the view, because `attach` refreshes everything held down to the oldest, page by page, and
would otherwise walk the whole gap. A jump of more than three screens within what is on screen goes
straight there rather than scrolling smoothly (also for quote jumps).

**Live results.** A delete leaves the results at once, from the event. An arrival or change is asked
about with `only: <seq>`, one at a time, so a reconnect's burst of events cannot become a burst of
searches; the client never decides on its own whether a message matches.

## Date strip

An overlay in the thread wrapper, not `position: sticky` on the separators: sticky separators stack
on each other at the same offset, and a wider older date shows around a narrower newer one, and
today's separator must not stick at all. `syncDayStrip` bisects the day separators on every scroll
and after every render, so a chat of hundreds of days measures only a handful. Hidden on today, and
hidden while that day's own separator is at the top, so a date is never said twice. It takes no
taps (`pointer-events: none`).

## Message info

Built only from what `Message` already carries, so nothing new leaves the server. `by_email` and
`device_id` stay server-side: they have never been sent to the chat. The chat records no delivered
or read state, so none is offered.

## Watch for

- A chat near 200,000 messages takes over a second per keystroke-pause, on a worker thread. If it
  ever gets there, fix the scan's constant (`fold` on non-ASCII text) before reconsidering an index.
- Quote jumps (`scrollToOriginal`) moved to the neighbourhood too, replacing spec/server-chat's "paging backwards":
  search makes replying to a months-old message routine, and tapping that quote would otherwise be the very cost
  above. Opening an old banked trip (`ensureMessageLoaded`) still pages 100 at a time; it could use it as well.
- A search's read transaction briefly holds back a WAL truncate; the scrub already retries
  (Inv 46), and the scan is tens of milliseconds at today's size.
- A transcript the reader has hidden is found by search, and the list shows its excerpt. The bubble
  then shows the note without the words marked until they show the transcript.
