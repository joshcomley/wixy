# 00006 [t6w2qb] "Re-transcribe" button at the bottom of a voice note's transcript

## What (operator's words, 2026-09-27)
"Another piece of work, please, to queue up is on the transcribing, can you add a try again
button? Sometimes it works better a second time. Sometimes I've changed the transcription
implementation of the back end. So a try again button would be handy whilst I'm getting that
right." — then, on placement: "I'll just re-transcribe; would be probably a better thing at the
bottom."

Context: the operator is actively iterating on cmd's transcription backend and wants to re-run
transcription on an existing voice note without re-recording it.

Folded into the same builder parcel as [8mz3wl]/[n4t8qk]/[p3r8vk] (workspace 00036, session
6488657b-33ed-455d-97ef-783f12ac3236, Gemini 3.8 Flash High) as item E.

## Current state (read, not guessed)
- `POST /attachments/{id}/transcribe` (wixy_server/livechat/routes_livechat.py) answers
  immediately: it upserts a `pending` row through `LiveChatStore.begin_transcript` and hands
  `TranscriptionRuntime.run_job` to the background group (module docstring in
  `wixy_server/livechat/transcription.py`). Single-flight per attachment, one job in flight
  globally, 6 new jobs a minute per identity. The outcome appends the existing `message_updated`
  event, so every device re-renders from the stream on its own.
- The hop to cmd is private-mode only (`wixy_server/livechat/transcribe.py`, Inv 50): the
  transcript lives ONLY in the attachment's `attachment_transcripts` row and is erased with its
  message (`ON DELETE CASCADE`). **None of this may change.**
- The UI already has the opt-in Transcribe affordance on a voice note and renders the transcript
  under it (admin-ui/src/server/thread.ts — find the exact render; the operator says the
  re-transcribe action belongs "at the bottom" of the transcript).

## What to build
1. A "Re-transcribe" action at the bottom of an existing transcript that re-POSTs the same
   transcribe endpoint and shows the pending state again until the `message_updated` event
   re-renders the new text. Same availability rules as the first transcribe (only when the
   feature is available; only for messages whose audio still exists).
2. **First check whether the route already allows a re-run** on a completed (or failed) row —
   the docstring says `begin_transcript` *upserts* a pending row, so this may be pure UI. If the
   store/route refuses a re-run, a SMALL server change to allow replacing a finished transcript
   row in place is in scope (same row, same cascade-delete, same table).
3. Hard boundaries: do NOT touch `transcribe.py` (the private hop), the erasure/delete/wipe
   paths, the schema, or Inv 50's capability gate. A re-transcribe of a deleted/wiped message
   must fail exactly like any other request for a gone attachment. If anything bigger seems
   needed, STOP and BLOCKER the DM (session 7b7869b2-d494-4423-bcb3-98e4575f1ef5).
4. Rate limiting: the existing 6/min/identity limit already covers repeat presses; the button
   should still disable itself while its own request is in flight (instant-feedback doctrine).
5. Tests: pytest red/green for the store/route behaviour (re-run on a completed row replaces the
   transcript; re-run on a pending row stays single-flight; gone attachment errors the same as a
   first transcribe of a gone attachment); vitest for the button's states; one e2e — transcribe a
   voice note, see text, tap Re-transcribe, see pending then text again — reusing the fake-cmd
   transcription fixture the existing transcription specs use. Own commit + own `Release-note:`
   trailer.
6. If the server route changes at all, update docs/ai/livechat.md's transcription section in the
   same commit (doc-maintenance contract).

## Links
spec/server-chat/05-voice-transcription.md; Inv 50 in docs/ai/invariants.md; round-2 item 3
(opt-in transcription) shipped as PR #262.
