# Chat create sends cmd's required `spawned_by_session_id`, and pins Sonnet 5

## Symptom

In the deployed admin panel (`ca.cinnamons.uk` → Chat), typing a message and
clicking **Start** showed a red `request failed with status 502` next to the
composer. No conversation was created. Every attempt failed the same way, so
the Chat panel was completely unusable — not a flake or a transient cmd hiccup.

## Root cause

Two independent things, both in the create call
(`CmdChatClient.new_chat` → `POST /api/project/<project>/new-chat`).

**1. The 502: a missing required body field.** cmd made
`spawned_by_session_id` **required** on its two chat-creation APIs (its
`engine/spawn_lineage.py::normalize_spawned_by(..., required=True)`, per cmd's
own decisions/00071 — "parentage must be a conscious decision", so an
omitted/null value is a deliberate 400 rather than a defaulted one). Wixy's
create call still sent `{"prompt": ...}` alone. cmd answered **400**;
`CmdChatClient.new_chat` correctly raised `CmdChatError` on the non-202; and
`routes_chat.create_conversation` correctly translated that to a **502**
(spec/06 §3's "couldn't reach cmd" case). So every layer behaved as specified
— the 502 was Wixy faithfully reporting that cmd had rejected the request. The
bug was purely the stale request shape. Reproduced directly against the live
portal:

```
$ curl -X POST http://127.0.0.1:9320/api/project/cottage-aesthetics-preview/new-chat \
       -H 'Content-Type: application/json' -d '{"prompt":"probe"}'
{"error":"spawned_by_session_id is required: ..."}   # HTTP 400
```

**Why CI never caught it — the part worth remembering.** `wixy_server/tests/
fake_cmd.py` accepted *any* new-chat body. A test double laxer than the real
service cannot catch contract drift: cmd's fleet-wide sweep for this field
missed Wixy (Wixy is a separate repo, not a cmd caller anyone greps), and the
suite stayed green against a fake that no longer resembled cmd. The fake now
enforces the requirement (400 on omitted/null), which is what makes the
regression tests real rather than self-satisfying.

**2. The model was Opus, not Sonnet 5.** spec/06 §1 originally said "Do NOT
pass `model`/`effort` — omit for the cmd account defaults". That instruction is
now wrong: cmd defaults a freshly created Claude chat to **Opus**
(`engine/chats/model_select.py`'s `DEFAULT_CLAUDE_MODEL = "opus"`, stored on
the chat row at creation time), so omission no longer means "the account
default" in any useful sense — it means Opus.

## What was decided

- **Send `spawned_by_session_id: ""`** — cmd's documented sentinel for a
  deliberately unparented, top-level chat. That is exactly what a Wixy
  conversation is: started by the site owner in the admin panel, never
  subordinate work spawned by another agent's session. (Wixy also has no cmd
  session id of its own to parent to — it is a server, not a chat.) Exposed as
  `cmdchat.UNPARENTED_SPAWNED_BY`.
- **Send `model: "claude-sonnet-5"`** (operator decision, 2026-07-29), as
  `cmdchat.CHAT_MODEL`. This matches the standalone edition's existing
  `wixy_server/worker/runner.py::DEFAULT_MODEL`, so both editions now run the
  owner-facing assistant on the same model. `effort` stays omitted (account
  default) — only the model was decided.
- **spec/06 §1 was corrected**, not worked around: the payload block and the
  "omit `model`/`effort`" bullet now state both fields, with the reason. Per
  the project CLAUDE.md, reality beats a cited fact and the contradiction gets
  logged — this entry is that log.
- **The fake enforces cmd's contract.** Deliberately chosen over "just fix the
  caller": fixing only the caller would leave the next cmd-side contract change
  equally invisible.

## What to watch for

- **`cmdchat.py` is the only module that talks to cmd, and its request shapes
  are only as fresh as the last time someone checked cmd's code.** The unit
  suite runs against a fake, so a cmd-side contract change is invisible until
  the live smoke test (`@pytest.mark.live_cmd`, skipped in CI) or production
  runs. When cmd changes a chat-creation/send contract, mirror it in
  `fake_cmd.py` *first*, then fix the caller. The other cmd calls were
  re-verified against cmd's code during this fix and are still current: send
  (`/api/session/<id>/send`, `text` + `idempotency_key`, 202), readiness
  (404→200), chain, and the Cmd-Chats `/sessions/<id>/{messages,status}` pair.
- **A 502 out of `create_conversation` does not necessarily mean cmd is down.**
  It means "cmd did not return 202", which includes a 400 from a stale request
  shape. The offline banner reads the same in both cases; check the
  `HTTPException` detail (it carries cmd's own error body, truncated to 500
  chars) before concluding cmd is unreachable.
- **`CHAT_MODEL` is a product decision, not a default to inherit.** If cmd's
  `DEFAULT_CLAUDE_MODEL` changes again, Wixy is unaffected — which is the
  point of pinning. Changing the tier the owner's assistant runs on means
  editing that constant and its two literal assertions in
  `test_cmdchat.py` / `test_routes_chat.py` (asserted as literals precisely so
  the change has to be re-decided, not silently re-satisfied).
