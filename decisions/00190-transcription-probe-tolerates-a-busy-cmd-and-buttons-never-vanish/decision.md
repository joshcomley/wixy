# Decision

**Status:** accepted. Refines [00166](../00166-voice-transcription-privacy-and-cost/decision.md)
and [00167](../00167-voice-transcription-design/decision.md); the privacy rule is unchanged.

## Symptom

"Transcription isn't available right now", no Retry, and after a reload no Transcribe button at all.

## Root cause (measured 2026-10-27)

- It was NOT the GPU. The speech service (`Cmd-VoiceAsr`) runs on the RTX 2070 SUPER (pinned by UUID,
  decisions/00668 in cmd), with Parakeet on the CPU as its warm automatic fallback; the RTX 5060 Ti is
  not involved. The service answered fast the whole time (`/healthz` ~2 ms, also while transcribing).
- The failed job's row lasted 2.04 s: wixy's capability probe gave up at `PROBE_TIMEOUT_S = 2.0`, while
  cmd's own access log shows it answering that same probe 2.2 s later (21:20:58 -> 21:21:00 UTC). cmd
  is a busy single process (it also restarted five times that evening for deploys; startup ~30-40 s),
  so a 2 s answer budget is routinely missed.
- Wixy treated that non-answer as "private mode withdrawn": the job failed `unavailable`, the answer
  was cached for 60 s (so every accept in that minute got 503), and the UI hid Transcribe/Retry whenever
  the flag was false — and rechecked only on a 15 s timer, so a flapping flag could leave it hidden.
  Three such failures are on record (18, 23, 27 Oct).

## Decided

1. The probe distinguishes a definitive answer (200 true/false, 4xx) from a non-answer (timeout,
   transport error, 5xx). Only definitive answers are cached 60 s; a non-answer is cached 5 s, and
   cheap (accept-time/usage) questions keep answering yes for up to 10 min after cmd's last definitive
   yes. A definitive "no" is never softened.
2. The job's `fresh=True` ask stays the authority and is never served from memory: it retries a
   non-answer 3 times (8 s each, 1 s apart); if cmd still cannot answer, NO audio is sent. This keeps
   00166's rule (never send audio unless cmd just promised private mode).
3. The UI never removes Transcribe, Retry or Re-transcribe because of the availability flag. If the
   server says no, the block shows "Transcription isn't available right now." and keeps the button. Each tap told "unavailable" also raises a fresh pop-up (replacing the
   last), because the red line is identical on a second tap and looks like the tap did nothing.

## CPU fallback

Already exists where it belongs: if the GPU engine (whisper) fails or CUDA is missing, cmd's ASR
service falls back to the CPU engine (Parakeet, or whisper-on-CPU on a failed CUDA load), including for
private requests. Wixy deliberately has no ASR of its own and never uses cmd's retaining route.

## Watch

If "isn't available" still shows with the service healthy, look at cmd's event-loop latency, not the GPU.
