# 00010 [q4rx7m] Round 2 item 2 — reaction emojis on Server chat messages

Owner: Builder session 2fad2e1e (build space bs16, branch `cmd/workspace-00029-bs16`).
Operator request (round 2, item 2): "Reaction emojis on messages (new feature - own message
model/API/UI/tests; scope as its own spec note in the ledger, don't retrofit through the
general AI-chat component)."

Architect ruling (2026-09-25, approved with additions): identity = trimmed case-insensitive
sender name + `by_email` audit column (never on the wire); 6-emoji exact code-point allowlist
(heart = U+2764 U+FE0F) with a TS/Python drift guard; `reactions` table with
`ON DELETE CASCADE`; a react on a deleted/unknown seq is 404, never 500; reuse the
`message_updated` event, a no-op PUT writes no event; the reactions element is patched in
place (a playing `<audio>` must keep identity and `currentTime`); chips are not gesture
boundaries, the menu emoji row is; no push; migration number assigned at merge; Inv 49.

Deliverables: `spec/server-chat/04-reactions.md`, a `decisions/` entry, store + route +
client + CSS + tests (python, vitest, e2e), docs (livechat.md, contracts.md, invariants.md).

Status: built in bs16; full-suite verification in progress, then FINAL HANDOFF to the DM (b584352d). Decisions 00164 + 00165, spec/server-chat/04-reactions.md, Inv 49 written.
