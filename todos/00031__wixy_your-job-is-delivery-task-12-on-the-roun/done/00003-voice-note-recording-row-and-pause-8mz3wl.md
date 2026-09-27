# 00003 [8mz3wl] Voice note: dedicated recording row (hide text box + Send) plus a Pause/Resume button

## What (operator's words, 2026-09-26, with a screenshot of the live phone UI)
"When I'm recording a voice note, the message input box all squished up still shows, and the send
button, but really it should just become a nice, pretty, dedicated record row there whilst
recording, and then return back to the text version once I've finished recording. There should
also be a pause button, which if we get rid of the input text box and the send button during a
recording, there should be room for a pause button. And the pause is just pause the recording, and
then I can resume it."

**Sequencing: do this AFTER the live-drawing feature (spec/server-chat/07) is fully shipped** —
the operator explicitly said so when this was reported mid-drawing-work.

## Current state (read, not guessed)
- `admin-ui/src/server/recorder.ts`: `createVoiceRecorder()`, `RecorderState = "idle" | "starting"
  | "recording" | "stopping"` (line 10) — **no "paused" state, no pause/resume method** on the
  `VoiceRecorder` interface (line 53-61: `start/stop/cancel/toggle/detach` only). The internal
  `MediaRecorderLike` interface (line 17-25) only declares `start()`/`stop()` — the real
  `MediaRecorder` DOM API already has native `.pause()`/`.resume()` (fires `onpause`/`onresume`),
  so the browser-side capability exists and just isn't wired through yet.
- `admin-ui/src/server/thread.ts`: the recording controls (`recordButton` line 253, HR
  `cancelRecordingButton` line 259, `recordingStatus` line 264) are passed as
  `extraButtons: [recordButton, cancelRecordingButton, recordingStatus, viewOnceButton]` (line 659)
  to `mountChatComposer()` — i.e. they render ALONGSIDE the textarea and `.wx-chat-send-button` in
  the same row today, which is the "squished" layout the screenshot shows. `updateRecorderUi()`
  (line 552) is the single function that reflects recorder state into the DOM — toggles
  `recordButton`'s icon/label, `cancelRecordingButton.hidden`, and `recordingStatus`'s text
  ("Recording 0:05" via `formatRecordingTime`, line 547).
- CSS: `.wx-srv-record-button`, `.wx-srv-record-cancel`, `.wx-srv-record-status` in
  `admin-ui/src/server/chat.css` (~lines 91-160) size these controls to sit in the existing
  composer row (`--wx-srv-control-h` sized buttons).
- Stopping today auto-sends: `recordButton`'s click handler calls `recorder.stop()` when
  `state === "recording"` (thread.ts line 637-640), whose `onStop` callback (line 589) builds the
  file and calls `sendVoiceNote()` immediately. The operator did not ask to change this — only the
  LAYOUT during recording, plus adding pause/resume.

## What to build
1. **`recorder.ts`**: add `"paused"` to `RecorderState`; add `pause()`/`resume()` to the
   `VoiceRecorder` interface, backed by the real `MediaRecorder.pause()`/`.resume()` (guard the
   call against `state !== "recording"` for pause / `!== "paused"` for resume, matching the
   existing guards on `stop()`/`cancel()`). The elapsed-time timer must stop advancing while
   paused and resume from where it left off (`onTimer` already reports `elapsedMs`; check whether
   the internal accumulator needs a "paused-at" checkpoint rather than just gating the interval).
   Decide whether a browser without native pause support (rare, but check `MediaRecorder.prototype
   .pause` exists) should hide the pause button entirely rather than silently no-op — the
   composer's own pattern elsewhere (e.g. the Speed slider hidden under reduced motion,
   decisions/00174) is "omit the control if it would do nothing," not disable it.
2. **`thread.ts`**: while `voiceRecorder.state` is `"recording"` or `"paused"`, hide the
   composer's own textarea and `.wx-chat-send-button` and show a dedicated row instead: elapsed
   timer, a Pause/Resume toggle button, the existing Cancel, and whatever affordance finishes +
   sends (today's `recordButton` doubling as stop-and-send is fine to keep, just re-themed for the
   dedicated row). Check whether `mountChatComposer()` (`admin-ui/src/server/chatComposer.ts`)
   needs a new option to hide the input/send pair, or whether this is simpler to do by having
   `thread.ts` set `hidden` on the textarea/send button directly from `updateRecorderUi()` (match
   whichever pattern the composer already uses elsewhere for hiding its own parts — look at how
   view-once's "always-visible button that disables instead of hiding on desktop, but takes its
   own line and hides other things on phones" was done, decisions/00169/00170 era, for the
   established house style before inventing a new one).
3. **CSS**: a new dedicated recording-row layout (`chat.css`), reusing `--wx-srv-control-h` sizing
   conventions. Follow the CSS/render doctrine (CLAUDE.md): design for desktop AND mobile from the
   start, verify at a narrow width (Playwright real viewport, not just desktop), and if a class is
   toggled via `hidden` add the `.<class>[hidden] { display: none }` rule PLUS an entry in
   `admin-ui/tests/serverChatCss.test.ts`'s `HIDDEN_TOGGLED_CLASSES` array (this file already
   guards exactly this trap — a `[hidden]` attribute losing to a same-specificity `display: flex`
   base rule; the real incident that test exists for is a phone-only bug found in this same file's
   history).
4. **Tests**: vitest for the recorder state machine (pause freezes the timer, resume continues it
   from the same value, cancel/stop from a paused state behave the same as from recording) and for
   `updateRecorderUi()`'s DOM effects (input+send hidden while recording/paused, restored on
   idle/stopping-done); a real-browser e2e (Playwright, mic permission + `MediaRecorder` are
   real-browser-only concerns jsdom cannot exercise) covering record -> pause -> resume -> stop and
   confirming the sent note's duration excludes the paused interval, at desktop and at least one
   phone width, following this file's own real-click-target lesson if the new controls are dense
   at 360px.

## Links
Reported live via the operator's phone (screenshot attached to the request), Server chat feature
(spec/server-chat/00-brief.md, the wider voice-note work under todos/TODO-00029.md).
