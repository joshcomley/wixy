# The preamble is stripped before the owner sees it; user bubbles are tinted, not brand-filled

## Symptom

With chat working again (decisions/00092), the Chat panel opened on a wall of
text: the entire site-assistant preamble — internal instructions, `CLAUDE.md`
references, `content/*.json` / `pages/` / `partials/` paths, "run `python -m
builder validate`", branch/PR workflow — rendered as the first message in the
transcript, above the owner's actual "Hi!". Roughly 1.4 KB of engine plumbing
shown to a non-developer, in a saturated blue bubble the owner described as
"difficult to read… very in your face".

## Root cause

**The preamble is genuinely part of the conversation's first user message.**
spec/06 §1 composes the create call's prompt as
`<PREAMBLE>\n\n---\n\n<user's first message>`, so cmd's transcript records one
user message containing both. That is correct for the model — it needs the
preamble — but the panel rendered the transcript verbatim, so it also showed the
plumbing. Nothing was malfunctioning; the display simply had no notion that part
of that message wasn't authored by the owner. Confirmed on the wire:

```
index=0 role=user kind=text truncated=False len=1393
  HEAD: 'You are the site assistant for **Cottage Aesthetics** (ca.cinnamons.uk'
  TAIL: '…the Wixy engine from here.\n\n---\n\nHi!'
```

The **bubble styling** was a separate, ordinary design mistake:
`.wx-chat-bubble-user` filled with `--wx-brand-blue` and white text. That is the
same colour as the Publish button, so a passive transcript entry competed with
the panel's primary action, and white-on-blue at `0.875rem` is lower-contrast
body text than everything around it. Fine for a one-line message; awful for a
1.4 KB block, which is why it surfaced now.

## What was decided

- **Strip at the stream boundary, not in the panel.** `routes_chat._owner_visible`
  filters each message as it's streamed. The UI is backend-blind by design
  (spec/independence/05 §1), so "what may the owner see" is a server decision, and
  filtering server-side covers both backends (cmd + the standalone worker) and any
  future client at once.
- **The upstream transcript is left intact.** Only the rendering is suppressed —
  cmd/the worker keep the full first message because the model still needs the
  preamble on every turn. A test asserts this explicitly.
- **A preamble-only first message is dropped entirely**, not rendered empty. That
  is the "New conversation with no opening message" case; an empty bubble would
  look like the owner sent a blank message.
- **Compose and strip live together** in the new `wixy_server/preamble.py`, which
  also now owns `PREAMBLE_TEXT` and the `SEPARATOR`. The separator was an inline
  literal duplicated in `ai/backend.py` and `worker/app.py`; adding a third copy
  in the stripping code would have been one more place to drift, and a drift here
  silently re-leaks the prompt. This is deliberately the same lesson as
  decisions/00092 (a duplicated contract that fell out of sync), applied
  pre-emptively. The module is dependency-free so the worker can import it without
  pulling in main-process code.
- **Matched by prefix, not by message index.** Index conventions belong to
  whichever backend produced the transcript; the preamble is a ~1.4 KB exact
  string this server composed itself, so a prefix match identifies it without
  depending on cmd's numbering. A message merely *quoting* the preamble is left
  alone (tested).
- **User bubbles use `--wx-brand-blue-tint` + `--wx-ink` + a border** — the design
  system's existing pairing, defined in both light and dark themes. Author is
  still obvious from alignment plus tint-vs-canvas. No new tokens invented.

## What to watch for

- **Never "fix" the leak by removing the preamble from the prompt.** It is
  load-bearing: it is what makes the assistant behave as a site assistant for a
  non-developer. The prompt keeps it; only the render drops it.
- **`SEPARATOR` is only a safe split token while the template has no `---` line of
  its own.** `test_preamble.py::test_template_contains_no_thematic_break` guards
  that — if you add a thematic break to `templates/chat_preamble.md`, that test
  fails rather than the first message silently becoming unstrippable. Fix the
  template or change the separator; don't delete the test.
- **The strip runs BEFORE the already-sent diff** in `_stream_events`. Caching the
  raw message while emitting the stripped one would make the diff never match and
  re-send the owner's first message on every poll tick (~1.2 s). There's a test
  pinning this.
- **A backend that truncates mid-preamble** yields a *prefix of* the preamble;
  that's handled and dropped. The owner's own words aren't lost, since they're
  also the conversation title.
- **This is display-layer only.** `chats.json`, the publish pipeline, and the
  ledger are untouched — nothing about what the assistant does to the site
  changed.
