# 00011 [vt9c4m] Round 2 item 3: opt-in voice-note transcription (wixy side, against a fake cmd)

## What
A "Transcribe" button on each voice-note bubble in the Server chat. Click -> wixy sends the note's audio to cmd's
on-box ASR through a NEW cmd-side "private mode" (`POST /api/transcribe` with `private=1`, `cleanup=0`, no
`session_id`, no `context`), stores the transcript in a new `attachment_transcripts` table (ON DELETE CASCADE), and
both devices render it from the stream. Never automatic, never on upload.

## Why
Operator asked (round 2 item 3): opt-in per note, plus its own privacy/cost ledger entry. The cmd change (private
mode + `GET /api/transcribe/capabilities` probe) is a SEPARATE cmd task owned by the Orchestrator; this build is the
wixy side only, developed against a fake cmd, and stays hidden (button hidden, route 503 `not_configured`) until the
probe says `private: true`.

## Context+current-state
Brief + Architect ruling from the DM/Architect (peer, 2026-09-25). Owned ids: decisions 00166 (privacy/cost note),
00167 (design record), 00168 spare; Invariant 50; spec/server-chat/05-voice-transcription.md. Build space bs17, branch
cmd/workspace-00029-bs17, based on origin/main (NOT the stale cmd/workspace-00029). Migration number is assigned at
merge (three builds add one in parallel): rebase on then-current main and take max+1 before the DM merges.

BUILT (2026-09-25): backend (store table + joined attachment load, CmdTranscriber private-mode client + 60 s probe cache,
TranscriptionRuntime job/limits, async route, usage flag, fake cmd double), frontend (transcript.ts block, in-place
patch, stale-202 guard, CSS), tests (pytest, vitest, Playwright desktop + 402px phone), docs/spec/decisions/Inv 50.
Found and fixed by the e2e suite: a fast job's stream update can beat the HTTP reply (decisions/00167 #10).
Independent adversarial review found 1 high + 2 medium + 3 low (0 critical); all fixed with new mutation-checked tests: probe re-check now genuinely bypasses the 60s cache before sending; attachment_transcripts existence checked independent of schema version (3 sibling round-2 branches each claim v7); TranscriptionRuntime.inflight is now the real single-flight authority and a job-less pending row is restarted; only_if_pending guard on the shutdown record; New-messages pill no longer raised by a transcript update. Full pytest 1906/1906, admin-ui vitest 1358/1358, e2e 85/85 (every server-*.spec.ts), all clean after merging today's main.
FINAL HANDOFF sent to DM 2026-09-25 (base c55e8ba, candidate 417e6cd). Awaiting exact-SHA clearance before PR/merge.
## Relevant files+commits
Backend: wixy_server/livechat/{models,store,transcribe,transcription}.py, routes_livechat.py, app.py,
tests/fake_cmd.py. Frontend: admin-ui/src/server/{mediaRender,thread,transcript,api/messages}.ts + CSS.

## How to continue + acceptance
Acceptance: full pytest, ruff check + `ruff format --check` (never plain `ruff format`), mypy, admin-ui typecheck +
vitest + build with zero drift, Playwright e2e at desktop AND a 402px phone; raw-bytes erasure tests (delete + wipe)
with a transcript sentinel; a playing voice note must survive a transcript arriving. Hand-off = full head SHA to DM
`b584352d`.


UPDATE 2026-09-25: New DM session (707d6dec) returned candidate 417e6cd NOT CLEARED — 1 HIGH blocking (H1: a lone UTF-16 surrogate in cmd's transcript text crashed the SQLite bind, swallowed, left the row pending forever with no Retry). Fixed in _parse_success (transcribe.py) with a UTF-8 round-trip check, mapped onto the existing invalid outcome; proven with a red-first client test AND a full end-to-end route-level reproduction, both mutation-checked. Also addressed M1 (docs wording, two independent limiters) and L1 (fake_cmd docstring note). Rebased onto current main (real conflict in thread.ts resolved cleanly, bundle rebuilt, both branches' e2e specs run together clean 25/25). Backend pytest 1909/1909, admin-ui vitest 1377/1377, all clean. FINAL HANDOFF #2 sent to DM (candidate ccc3526). Awaiting re-review + clearance.