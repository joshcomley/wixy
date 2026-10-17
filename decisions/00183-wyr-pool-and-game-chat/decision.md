# Symptom / ask
Operator follow-on to decisions/00182: "generate the next 20 in advance ... might as well generate the next 100 if it's just running on the GPU", and a per-card chat: each game card's conversation is kept associated with that card AND persisted to the main chat.

# Decided
- **Pool, not eager attachment.** Pictures for upcoming questions are painted ahead into `server/wyr-pool/<question_id>/{a,b}.png` (default 100, `WIXY_WYR_POOL_SIZE`, `0` = off), never as attachments on messages that do not exist yet. Starting a round takes a pooled pair, MOVES its PNGs into `uploads/<id>/assembled` and attaches both in the existing one-transaction path, BEFORE the response, so `POST /wyr` already carries both photo attachments. An empty pool, a failed staging or no generator falls back to the 00182 on-demand job unchanged.
- **Reversal of 00182's "never ahead of time", on purpose.** That rule was the operator's first wording; this follow-on replaces it. The privacy reasoning still holds because a pooled pair is bank-derived and tied to no conversation: a wipe does not clear it, and the moment it is consumed it is an ordinary attachment under Inv 46. Inv 54 now says so.
- **One GPU gate.** The filler uses the same lazily created `CapacityLimiter(1)` as on-demand jobs (`wyr_image_limiter`), so there is exactly one ComfyUI job at a time. It yields to a waiting round via a plain `WyrDemand` counter (checked before each pair, so a round waits at most for one pair already running), stops 1 GiB above the chat's free-space floor, backs off 30 s doubling to 5 min on failure, and idles 60 s when full. A generator that is down or whose output folder is misconfigured (00182) just means `unavailable` and a 5-minute wait.
- **Crash/overlap-safe disk protocol.** A pair becomes visible only by an atomic rename out of `<id>.tmp`; a consumer reserves a pair by renaming it to `<id>.taken-<token>` (one taker, recognisable leftovers); a replayed `clientId` restores its reservation. Startup removes `*.tmp`/`*.taken-*` only when older than 15 minutes (a younger one may be the older process's live work in a blue/green overlap) and removes pooled pairs for questions played since. When the whole bank has been played the repeat guard restarts, so nothing is pruned then.
- **Game chat = association table (schema v16).** `wyr_chat(message_seq PK -> messages ON DELETE CASCADE, anchor_seq -> messages ON DELETE CASCADE)` + an index on `anchor_seq`. A game-chat message is an ordinary message (it stays in the main chat in order) plus one row, so no `messages` ALTER and no `events` rebuild (the drawings and `wyr_rounds` precedent), and an older blue/green process that has never heard of the table still cascades the rows away. Deleting the anchor removes the associations but leaves the messages (they are main-chat messages first). No dates are stored. v15 is deployed and is never edited; v16 is additive (`CREATE ... IF NOT EXISTS`), tested from a real v15 database.
- **Wire.** `Message.wyrRef: int | null` (always present from a v16 server); `POST /messages` takes optional `wyrSeq` (a missing round is 404 and creates nothing; a bad shape is 422 like `replyToSeq`). The anchor message itself is never game chat.

# Why not
- Attaching pictures to a not-yet-existing round or pre-creating message rows: dated rows and half-created chat content for a conversation nobody has started.
- A `messages.wyr_ref` column: an ALTER on the hottest table and an older process would ignore it on delete paths.
- A second limiter or a priority queue for the filler: ComfyUI renders serially anyway; the demand counter plus a single gate is enough and keeps one place that decides "one job at a time".

# Watch for
- Pool files are plain `unlink`/`rmtree` removals of bank-derived pictures; only consumed pictures are chat content.
- A long play session can outrun the GPU (~25-45 s per pair); a round then falls back to on-demand painting exactly as before.
- `wyr_used_ids()` is derived from `wyr_rounds`; the pool's played-question pruning uses it, so it inherits the "wipe forgets everything" property.

# Audit round 3 follow-ups (pool hygiene)
- A reservation (`<id>.taken-<token>`) is stamped (`os.utime`) when it is taken: a directory rename does not touch the directory's own mtime, so the stale sweep used to measure the pair's PAINT age and could remove a reservation an in-flight `POST /wyr` was mid-move on.
- If `store.create_wyr_round` raises after a pair was reserved (busy database, cancelled request) the pair is restored to the pool instead of stranded.
- The pool loop re-runs the cleanup sweep every 10 minutes (it used to run only at startup despite its "periodic" docstring), so a pair for a question played mid-session or a reservation stranded by a failed take is removed within that window.
