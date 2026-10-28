# A ringing or connecting call pauses the idle lock

**Symptom.** Tapping Call and not being answered within ~10 s of the last touch idle-locked the chat and dropped the call; the same hit the device being called.

**Decision (operator #2136, 2026-10-28: "Yes, keep it unlocked while ringing").** A device holds the single `voiceCall` idle suspension from the moment it sends an invite (or shows an incoming call) through ringing, connecting and connected/muted. `holdCall()` in `admin-ui/src/server/call/controller.ts` takes it (idempotent, so ringing flows into connected with no gap); `teardownCall` is the only release, so every end path (decline, cancel, ring timeout, setup timeout, failure, socket close, detach, dispose) restarts a fresh countdown.

**Why it is safe.** The server already bounds an attempt: ringing at most 30 s, connecting at most 20 s (`call_broker.py`, unchanged); the client also ends at 30 s / 20 s. The pause therefore cannot outlive a real attempt.

**Still locks immediately.** Escape, panic, multi-tap, tab-hidden/screen-lock policies, token expiry and 401; every actual lock/detach still ends the call and its audio. Only the automatic *idle* lock is affected; device grants unchanged. `voiceCall` is not in `isPickerOrMicOpen`.

**Watch for.** Any new call state must still pass through `teardownCall`; a path that clears `callId`/`outgoingRequest` without it would leak the pause (tests in `tests/server/call.test.ts` cover each end).
