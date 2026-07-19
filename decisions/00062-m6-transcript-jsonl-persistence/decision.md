# M6 transcript JSONL persistence: durability only, a separate volume, no rehydration

## Context

spec/independence/05 §2: "the worker persists conversations as JSONL
compatible with the existing chat panel's message model — the UI is
backend-blind." `wixy_server/worker/state.py`'s own docstring (written in the
prior slice) already documents "a worker restart losing in-flight
conversation state is an accepted tradeoff... not solved here" — this entry
records exactly what THIS slice does and doesn't change about that.

## Scope: write-side durability, not full rehydration

Implemented: every completed turn's messages are written to
`<transcripts_root>/<conv_id>/transcript.jsonl` (one JSON object per line, the
SAME shape `WorkerMessage.to_json()`/`ChatMessage` already use — no bespoke
format). NOT implemented: reading these files back to rebuild `WorkerState`
on worker startup. After a restart, an old `conv_id` still 404s from the
API's perspective exactly as it did before this slice — only the RAW message
history now durably exists on disk, for forensics/backup/support purposes
(and as a hook for something else to add rehydration later without needing a
format migration first).

This was a deliberate scope call, not an oversight: the spec's own wording
("persists... as JSONL compatible with... the message model") is a statement
about FORMAT compatibility, not an explicit rehydration requirement, and
`state.py`'s existing docstring had ALREADY made "in-flight state lost on
restart" a documented, accepted decision for this milestone (itself flagged
as "the largest single milestone," warranting scope discipline). Building
full rehydration would mean also reviving `workspace_provisioned`/
`branch_name`/`pr_url`/idempotency tracking coherently, none of which spec
asks for explicitly — a genuinely separate feature, not "the JSONL line item."
If the Fable review disagrees, that's exactly the kind of finding a review
round exists to catch; better than guessing ahead of an ambiguous spec
sentence.

## Written once per turn, in one place, not scattered

`_run_and_track`'s outer `finally` (decisions/00060's own exception-safety
redesign) calls `write_transcript` exactly once per turn, using whatever
`conv.messages` holds at that point — not a call at every individual
`conv.append()` site (there are several, across `runner.py` and `app.py`'s
route handlers). This means:
- One extra file write per turn, not one per streamed message chunk.
- It ALWAYS runs — success, a caught `WorkspaceError`/`GitHubApiError`, or an
  entirely unanticipated exception the outer guard catches — because it's a
  `finally`, not conditional on which path the turn took.
- Each write is a full REWRITE of the file (not a true incremental append),
  atomically (tmp-file-in-the-same-dir + `os.replace`, this codebase's own
  `atomic_write_json` convention, adapted for raw JSONL text since that
  helper only handles a single JSON value). "JSONL" describes the file's
  CONTENT shape (line-delimited JSON), not a mandate that every write be a
  true `O(1)` append — for a bounded-size (dozens of messages) per-conversation
  transcript, a full rewrite is cheap and far simpler than incremental-append
  bookkeeping.

## A separate volume from the git scratch clones — not a detail, a safety property

`WorkerSettings.transcripts_root` (`/data/worker-transcripts`,
`docker-compose.yml`'s own dedicated `worker-transcripts` volume) is
DELIBERATELY not a subdirectory of `scratch_root` (`/data/worker-scratch`,
where each conversation's git clone lives). The agent has unrestricted Bash
access inside its clone for the rest of its turn (spec §3, the same
constraint decisions/00060 is built around) — if the transcript file lived
inside that clone, a broad `git add -A`/`git commit` (a common enough agent
habit, not a hypothetical) would risk committing the conversation transcript
straight into the OWNER'S SITE REPO history. Keeping transcripts on a wholly
separate path makes this impossible rather than merely unlikely: the agent's
clone directory never contains a transcript file at all, at any point.

This also means the scratch-clone idle sweep (decisions/00060,
`sweep_idle_workspaces`) never touches transcripts — they're meant to survive
indefinitely (the owner's durable conversation history, analogous to
`wixy_server.chats`'s own `chats.json`, never swept), a fundamentally
different retention policy from the disposable, 7-day-idle-swept git clones.
