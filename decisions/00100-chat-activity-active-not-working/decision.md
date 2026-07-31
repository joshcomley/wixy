# cmd's `activity` "is working" literal is `"active"`, not `"working"`

## What happened

Mandated live-verification of decisions/00099's own fix (confirming `working: true` is
now actually observable in production) found the "working" indicator **still always
false**, despite the fix already being deployed and live.

Two independent live runs against production (`ca.cinnamons.uk`), each creating a real
chat conversation with a genuine request known to keep cmd busy for tens of seconds:

- **Run 1** (120s, polling only wixy's own `GET .../conversations` and `GET .../state`
  every ~1.5-2s): the conversation reached `status: "ready"` at t≈12s and stayed there;
  `working` was `false` on every single one of 66 polls. Cross-checking cmd's raw
  `GET /sessions/<id>/status` directly (this box hosts both wixy and cmd) via two
  separate queries and reconciling their `idle_secs` fields against wall-clock time
  showed the session was genuinely, continuously active from roughly t≈2s to t≈32s —
  squarely inside the window where every poll read `working: false`.
- **Run 2** (90s, this time polling cmd's own `/status` endpoint directly ALONGSIDE
  wixy's two endpoints, once per second, so every row is time-correlated): cmd's raw
  `activity` field cycled `"active"` / `"idle"` repeatedly across the whole real work
  window (consistent with genuine, ongoing tool-call activity), while wixy's `working`
  read `false` on all 61 polls, no exceptions.

Reading cmd's own source directly (`D:\Servers\Cmd\Storage\clones\cmd\engine\chats\
session_introspect.py:_activity`) settled it conclusively:

```python
def _activity(age_secs: float | None) -> str:
    """Invariant-3 thresholds over the store's mtime age."""
    if age_secs is None:
        return "unknown"
    if age_secs <= SESSION_ACTIVE_SECS:  # = 8, engine/sessions.py
        return "active"
    if age_secs <= SESSION_IDLE_SECS:  # = 600, engine/sessions.py
        return "idle"
    return "done"
```

The real enum is `"unknown" | "active" | "idle" | "done"` — a threshold over how long
ago the session's own JSONL store was last written to (`<=8s` → active, `<=600s` → idle,
else done). **`"working"` is never a value `activity` takes.** decisions/00099's own fix
— `_is_working(activity) -> activity == "working"` / `activityState`'s `status?.activity
=== "working"` — checked for a string cmd never sends, so it always evaluated `false`,
identically to the bug it was meant to fix, just for a different reason.

## Why decisions/00099 got the literal wrong

Two things lined up to produce a plausible-but-wrong answer:

1. `spec/06-ai-chat.md`'s prose read *"...working / idle / dead"* — read as a direct
   quote of cmd's wire values, when it was (at best) an imprecise gloss. (`spec/05-editor.md`
   §6 independently describes the SAME dot as "working/idle/**done**" — the two spec
   files don't even agree with each other, let alone with cmd's real source.)
2. decisions/00099's own single live sample happened to capture `activity: "idle"`
   (quoted in that decision's own "What happened" section) during a session that WAS
   genuinely busy at that instant — which is fully consistent with the real mtime-age
   mechanism (a brief gap since the last store write is enough to read `"idle"` even
   mid-task) but was never cross-checked against a moment where `activity` reads
   whatever the POSITIVE "is-working" case actually looks like. That decision's own
   quoted evidence — `{"process": {"liveness": "working", ...}, "activity": "idle"}` —
   already contained the answer sitting one key away: `"working"` IS a real literal cmd
   sends, just for `process.liveness`, a different field spec/06 explicitly says to
   prefer `activity` OVER. The two fields have adjacent but distinct vocabularies, and
   the investigation attributed the wrong field's literal to `activity`.

decisions/00099 correctly diagnosed the BUG CLASS (enum, not timestamp) but stopped
verifying one step short of the ACTUAL VALUE, and shipped a fix that was right in kind
and wrong in substance — invisible again, for the same structural reason as before: the
fix's own test doubles (`fake_cmd.py`, `chatPanel.test.ts`'s `statusEvent`, `e2e/
fixture_server.py`'s `/test/chat/set-activity`) were rewritten to script `"working"` as
the active-literal, carrying the SAME wrong assumption the implementation now made, so
every automated test passed again.

## The fix

Both sides now compare against the real literal:

- `wixy_server/chat_working.py`: `_is_working(activity) -> activity == "working"` →
  `activity == "active"`.
- `admin-ui/src/chatPanel.ts`: `activityState`'s `status?.activity === "working"` →
  `=== "active"`.
- Every test double rewritten again: `wixy_server/tests/test_chat_working.py` (all
  `session.status["activity"] = "working"` → `"active"`; the "dead" test repurposed to
  `"done"`, the real terminal-ish value — `"dead"` isn't real either),
  `wixy_server/tests/test_routes_chat.py` (2 call sites), `admin-ui/tests/
  chatPanel.test.ts` (`statusEvent("working")` → `statusEvent("active")`),
  `e2e/tests/chat-ux.spec.ts` (`/test/chat/set-activity` body), plus docstring/comment
  corrections in all of the above, `e2e/fixture_server.py`, `docs/ai/{contracts,
  ai-chat}.md`, and a correction note added to `spec/06-ai-chat.md`'s own "working / idle
  / dead" line (spec is decided/authoritative for product intent, but a plain factual
  error about an external system's wire contract is corrected in place with a citation,
  per this repo's own "prefer reality, record a decision" rule for cited facts spec gets
  wrong) — plus a correction pointer added to decisions/00099 (its own text, including
  its "what to watch for" bullet, still says `"working"|"idle"|"dead"` verbatim; left
  as-is with a correction appended, not rewritten, per this project's append-only
  decision-log convention) and a second correction line on decisions/00034's existing
  correction blockquote (which had relayed 00099's wrong literal onward).

Live-reverified a third time after redeploy: a fresh real conversation, polled the same
way as Run 2 above, now shows `working: true` observed via both `GET .../conversations`
and `GET .../state`, correlated with cmd's own `activity: "active"` at the same moments.

## What to watch for

- **The real enum, confirmed from cmd's own source, is `"unknown" | "active" | "idle" |
  "done"`.** `"working"` and `"dead"` are not values this field takes anywhere in this
  codebase going forward.
- **`process.liveness` is a DIFFERENT field with an OVERLAPPING-sounding but distinct
  vocabulary** (it does use `"working"` as a real literal) — spec/06 already says prefer
  `activity` over it; this incident is the concrete story of what goes wrong when the
  two get crossed. If a future reader is ever tempted to reach for `process.liveness`
  instead of `activity` for a "is it working" check, re-read this decision first.
- **Fixing the bug CLASS is not the same as fixing THE bug.** "It's an enum, not a
  timestamp" was necessary but not sufficient — the specific literal still had to be
  independently confirmed against the real system, not inferred from spec prose or a
  single sample. When a fix's own verification stops at "the mechanism is now sound"
  rather than "the specific expected observable now actually occurs," it can ship a
  second, equally-invisible bug under the exact same "all tests green" cover as the
  first one.
- **Don't stop at the first live sample; confirm the POSITIVE case specifically.**
  decisions/00099's live sample happened to land on the negative case (`"idle"`) during a
  busy session — a fact fully consistent with the real mechanism, but easy to
  misinterpret as "activity doesn't reflect real state" rather than "activity has a
  brief window where it legitimately reads idle mid-task." Confirming a signal's
  TRUE-side value, not just observing its false side once, is what this decision's own
  two verification runs did differently (both explicitly polled through a full active
  window and time-correlated against cmd's own raw response, not just wixy's).
- **When an external system's own source is readable, read it — don't stop at spec
  prose or docstrings describing it.** `engine/chats/session_introspect.py` and
  `engine/sessions.py` were one `Grep` away and settled this conclusively in minutes;
  both prior incidents (decisions/00099 and its own predecessor, decisions/00034) relied
  on spec prose plus a small number of live samples instead.
