# 00005 [p3r8vk] Settings checkbox: confirm before playing audio messages

## What (operator's words, 2026-09-27)
"Another thing, please, on play, can we have a setting in settings that is a checkbox for prompt
before confirm before playing audio messages? So that if someone's in a quiet place and they
accidentally tap play rather than transcribe, it pops up a prompt for them, but only if that
checkbox is checked."

Folded into the same builder parcel as [8mz3wl]/[n4t8qk] (workspace 00036, session
6488657b-33ed-455d-97ef-783f12ac3236, Gemini 3.8 Flash High) as item D.

## Current state (read, not guessed)
- Per-device settings checkboxes follow `admin-ui/src/server/idlePreference.ts`: a localStorage
  key read/written through small helpers, a settings-dialog row styled as the full-width 44px
  label row (`admin-ui/src/server/chat.css` ~1085 and ~1189, the "Extend auto-lock to 1 minute"
  checkbox from bs13/decisions/00161), and a `storage`-event listener so a second tab of the same
  browser sees the change.
- Voice/audio messages render a play affordance in the message bubble (the player card in
  `admin-ui/src/server/thread.ts` ~line 722 / mediaRender modules). The operator's scenario:
  Play and Transcribe sit next to each other and a mis-tap plays audio out loud.

## What to build
1. A new per-device preference (new small module beside `idlePreference.ts`, same shape):
   "Ask before playing audio messages", default OFF (unchecked = today's exact behaviour).
2. A settings-dialog checkbox row for it, reusing the auto-lock row's full-width layout.
3. When ON, tapping play on a voice/audio message first opens a small confirm prompt (house
   style, not a bare `window.confirm` if the codebase has a dialog pattern — check what the
   wipe/delete confirmations use); confirming plays, cancelling does nothing. Gate ONLY the
   audio/voice play affordance — not video, not transcription, not the Tease viewer.
4. Tests: vitest for the preference module + the gated play path (prompt shown when ON, sound
   only after confirm; no prompt when OFF); one e2e case at a phone width (the quiet-place
   scenario is a phone scenario) covering checkbox-on -> tap play -> prompt -> cancel (no play)
   and confirm (plays). Default-OFF behaviour needs a guard test so the untapped path is
   byte-identical to today.
5. Own commit with its own `Release-note:` trailer, plain English for the site owner.

## Links
Server chat feature (spec/server-chat/00-brief.md); the per-device settings pattern from the
permanent-unlock work (spec/server-chat/03-permanent-unlock.md, Inv 48, decisions/00161).
