# Reactions on the client — patch in place, and let the stream be the one truth

The server half is decisions/00164; the behaviour is in
[`spec/server-chat/04-reactions.md`](../../spec/server-chat/04-reactions.md) §5.

## The trap found while planning

`thread.ts` rebuilds a message's whole bubble whenever the message object changes
(`rendered.message !== message`), and a rebuild disposes the bubble's media: it pauses the
`<audio>`/`<video>`, drops its source and releases the `mediaPlaying` idle-lock suspension. That was
fine while a message only changed when an attachment finished processing — a moment when nobody is
playing it. A reaction is different. It arrives as a `message_updated` for a message that may be a
voice note someone is listening to right now, so the first reaction to it from the other person
would have **cut off the playback for every reader**, on every reaction. Nothing in the server, the
stream or a unit test of the rendering would have shown it; only playing a note while someone
reacted would.

## What was decided

### When only the reactions differ, patch in place

`sameExceptReactions(previous, next)` compares `seq`, `clientId`, `sender`, `text`, `createdAt` and
the attachments — whole, including their signed URLs. If that is all equal, the thread keeps the
bubble node and replaces just the contents of its `.wx-srv-reactions` row, and tells the message's
action menu (`controller.update`) so an **open menu stays open** and its emoji row shows the new
checked state. Anything else that changed still rebuilds, exactly as before — an attachment
finishing processing, or fresh signed URLs after a re-unlock (which need new `src` values anyway).

The requirement, from the Architect's ruling: **a playing `<audio>` keeps its identity and
`currentTime` across a reaction.** It is tested at both levels:

- `admin-ui/tests/serverThread.test.ts` — the node is the same object, its position is untouched,
  `pause`/`load` are never called, the `mediaPlaying` suspension is not released and the menu is
  still open. Mutation-checked: with the patch path disabled, two of these fail.
- `e2e/tests/server-reactions.spec.ts` — in a real browser one person records an eight-second
  voice note and plays it while the other reacts; the `<audio>` node is tagged and must survive, with
  no `pause`, `emptied` or `ended` event fired and `currentTime` not reset.

### The stream is the one ordered source of truth

A tap sends the PUT, which answers with the message as the server held it at commit. That response
can be **older** than something already delivered: another person's reaction may commit after mine and
stream in before my response is read. Applying the response then would overwrite fresher state, and
nothing would repair it, because the stream's cursor has already moved on. It could also bring back a
message that was wiped or deleted while the request was out.

So the response is applied only when (a) no other message state arrived while the request was in
flight (`contentRevision` unchanged) and (b) the chat was not wiped meanwhile (`contentGeneration`
unchanged); a deleted message is refused by `addConfirmed` as it always was. When it is skipped the
stream's own frame supplies the state, and that frame is never older than what it replaces because
the server reads the current row when it emits it. Three tests pin this: a stale response after a
newer frame, a response after a wipe, and a response after a delete.

### Feedback without a second source of truth

There is deliberately no optimistic count. A tapped chip dims and disables (`aria-busy`) until the
answer; a reaction being *added* shows at once as a dimmed chip of one. The state a reader sees is
either the last state the server confirmed or a visibly pending one — never a guess that then has to
be reconciled.

### An older server is not a crash

`addConfirmed` reads a message with no `reactions` (from a server that predates them, during a
blue/green swap or after a rollback) as having none. The alternative — `message.reactions.map` on
`undefined` — would fail the render of the whole thread, not just the chips, for a state the
deployment model makes reachable.

## What to watch for

- **Any new field that changes without changing the media** wants the same treatment: extend
  `sameExceptReactions`' idea rather than letting it fall through to a rebuild. A rebuild is only
  safe when nothing can be playing.
- **The comparison is deliberately strict about attachments.** If signed URLs ever become
  non-deterministic per response (they are an HMAC of attachment, rendition, expiry and email today),
  every reaction would rebuild again and the audio test would fail — which is the point of the test.
- **`contentRevision` is coarse**: any message event, not just this message's, makes a response
  skip. That is the safe direction; the stream frame always follows.
- Chips are **not** gesture boundaries and the menu's emoji buttons **are** (R3 v1.5.2's rule: does
  the earlier tap make the later control appear?). A chip taps twice quickly like any other toggle
  and counts toward the double-tap lock.
