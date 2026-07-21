# 00088 — Composer draft recovery: keystroke-persisted drafts + Restore/Discard banner

## Symptom / request

Operator, 2026-07-21: "if ever something's being edited, but then the page reloads for
whatever reason, mid-edit some text, it should remember the text. And if you go back to
the same thing to edit it again, it should pop up and say, hey, you were editing this
before, would you like to restore, would you like to recover what you had typed
previously?" Until now the composer's textarea lived only in the DOM: a reload (or
crash, or an accidental back-navigate) mid-edit destroyed uncommitted typing.

## What was decided

- **Persist per keystroke.** With a `draftKey` (new `ComposerOptions` field), every
  `input` event writes `{ text, updatedAt }` to `localStorage` under
  `wx-composer-draft:<key>` — same-origin (shell and preview are one FastAPI app), so a
  reload is lossless at any instant. Writes are wrapped in try/catch: editing must
  never break over a full/blocked store (recovery is best-effort).
- **The key is the binding's identity**, derived by the overlay (`composerDraftKey`):
  `<page>:<key>` for page/global-scope keys; item-scope (`.`-prefixed) keys add the
  item's index inside its innermost list (`<page>:<listKey>[<index>]<key>`) — otherwise
  every item of a list would share one draft.
- **Reopening offers, never forces.** When the composer opens and a stored draft
  DIFFERS from the fresh seed, an in-composer banner shows — "You were editing this
  before (<relative time>). Restore what you typed?" — with **Restore** (refills the
  textarea THROUGH the input pipeline: live preview + auto-grow refit + re-save) and
  **Discard** (drops the draft). A stored draft identical to the seed is cleared
  silently — nothing to recover.
- **Commit and cancel both clear the draft.** It exists only to outlive sessions that
  ended WITHOUT either; one wrapper covers all four exit paths (Ctrl+Enter, Esc, ✓, ×).

**Scope:** the text composer only. The structured control sheets (opening hours, price
list) edit whole arrays with their own row editors — serializing that state is a
different shape of problem and wasn't asked for; if the operator wants it there, that's
a follow-up of its own, not a gap in this one.

## Why

The composer's value is the operator's typed words; anything that can destroy them
silently is a data-loss bug, and the fix belongs at the point of typing (per-keystroke
persistence), not in a crash handler. The banner (not auto-restore) keeps the fresh
seed truthful — the operator explicitly asked to be ASKED, and Restore/Discard is one
tap either way with the recovered text visible before committing.

## What to watch for

- Item-index identity shifts when list items are REORDERED between sessions (a draft
  saved for item 2 is then offered on whatever now sits at index 2). Accepted: the
  banner shows the text for review before it lands, and Discard is one tap. A
  content-hashed identity was rejected as over-engineering for the gain.
- Item indexes are computed among the list's DIRECT `[data-wx-list-item]` children —
  both real templates use that shape; a template with deeper item wrappers would index
  -1 for all its items (shared draft — still recoverable, just not per-item).
- The banner inserts between the toolbar and the textarea; `fit()` (auto-grow) ignores
  it by measuring the textarea only, and the maximized layout lets it scroll with the
  textarea — don't move it outside `.wx-composer-inner`.
- Drafts persist until commit/cancel/discard — they do NOT expire. A draft whose
  underlying binding is later renamed just never matches a composer again (harmless
  storage litter, a few hundred bytes each).
