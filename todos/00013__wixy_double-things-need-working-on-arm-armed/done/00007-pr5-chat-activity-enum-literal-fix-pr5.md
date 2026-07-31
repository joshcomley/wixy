# 00007 [pr5] PR 5 — cmd's "is working" literal is `"active"`, not `"working"`

## What
Not in the original brief — found while performing the mandated live-verification of
PR4's own fix (00006 above). Two independent live runs against production, each ~90-120s
polling a real conversation known to keep cmd busy: `working` never went `true`, despite
the underlying cmd session being demonstrably active throughout (confirmed by
time-correlating wixy's own `working` flag against cmd's raw `/status` endpoint polled
directly, once per second).

Root cause: decisions/00099 (PR4) correctly diagnosed `activity` as an enum, not a
timestamp, but guessed the wrong literal for the "is working" case — `"working"`, taken
from `spec/06-ai-chat.md`'s prose and a single live sample that happened to read `"idle"`,
never confirmed against a genuinely active moment. Reading cmd's own source directly
(`engine/chats/session_introspect.py:_activity`, `engine/sessions.py`'s
`SESSION_ACTIVE_SECS=8`/`SESSION_IDLE_SECS=600`) settled it: the real enum is
`"unknown"|"active"|"idle"|"done"`. `"working"` is never a value `activity` takes — it's
a literal the separate `process.liveness` field uses instead, sitting right next to
`activity` in decisions/00099's own quoted evidence, misattributed to the wrong field.

## The fix
`_is_working`: `activity == "working"` → `activity == "active"`. `activityState`:
`status?.activity === "working"` → `=== "active"`. Every test double rewritten again.
Docs (`contracts.md`, `ai-chat.md`) and `spec/06-ai-chat.md`'s own wrong "working / idle /
dead" line corrected in place with a citation (spec is decided/authoritative for intent,
but a plain factual error about an external wire contract is corrected per this repo's
own "prefer reality, record a decision" rule).

## Outcome — DONE 2026-07-31
Merged as PR #136 (github.com/joshcomley/wixy), merge commit `fa91ccf`. Full test/lint/
build gate green (979 pytest, 571 vitest, ruff, mypy). CI's `image-boot-proof` job flaked
once on an unrelated external dependency (a real git-fetch of `cottage-aesthetics-
preview.git` during the standalone edition's container-startup lifespan hung past the
30s healthz budget) — confirmed as a transient infra flake, not a regression, via an
identical-commit rerun that passed clean in 1m20s (this exact job has a 100% pass rate in
this repo's history otherwise, including 40 minutes earlier on PR4's own run).

**Live-verified CONFIRMED on production** after deploy: a fresh real conversation showed
`working:true` via BOTH `GET .../conversations` and `GET .../state`, correlated with
cmd's own `activity:"active"` at the same poll. This is the actual, final confirmation
the whole PR2→PR4→PR5 chain was chasing.

**Also discovered, deliberately NOT fixed**: the standalone/anthropic AI backend
(`wixy_server/worker/`) shares this exact code path (`_is_working`/`activityState` are
edition-agnostic by design) but its own `activity` field is a real timestamp
(`ConversationState.activity = message.timestamp`), not cmd's enum — a separate,
pre-existing bug, invisible the same way (zero test coverage for this path). Out of
scope: not live anywhere (`ca.cinnamons.uk` runs fleet edition only), needs real
protocol-shape design work, and `WIXY_EDITION=standalone` is milestone 6, which this
repo's own CLAUDE.md marks SECURITY-GATED (peer review required, never auto-merge on
green CI alone). Fully documented for a future session.

## Links
`decisions/00100-chat-activity-active-not-working/decision.md` (the fix),
`decisions/00101-standalone-backend-activity-format-mismatch/decision.md` (the flagged,
unfixed finding). Correction sections added to `decisions/00099` and `decisions/00034`.
