# M3 — Chef prompts, validation and pictures (Sonnet 5.5)

Read `modes-common.md` first. Your files: Appendix A row M3. Spec: §3 in full, §4 (chef side of
twists), A.4. Tests: §8.3, the real-run trial §8.4 (bar: ≥38/40 random toastie baskets accepted and
≥11/12 pictures confirmed closed toasted sandwiches; every flagged phrase read by hand; a wrongly
rejected good toastie is a defect). Docs: your share of §9.

**Order:** the chef-fix parcel owns `cookout_ai.py`, `fake_cmd.py` and the AI tests and is mid-change.

1. **Now (Phase A):** `tooling/cookout/mode_tiles.py` and the two tile pictures
   `admin-ui/data/cookout-mode-{classic,toastie}.webp` (render on the hub's ComfyUI behind the same
   empty-queue gate the picture tooling uses — a 600-picture pilot is rendering now; never jump its
   queue or live games). Look at them yourself, send me their paths, then a small early PR once I
   clear it — M4's build needs them.
2. **After I tell you the chef fix has merged (Phase B):** merge the feature branch and build §3 on top
   of the chef fix's high-precision scan (do not reintroduce fatal prose gates — §3.4: dish-word notes are
   `signals`, never rejections). M1's A.1 module will have landed by then.
3. Trial §8.4 on the real chef through cmd, report `triad/cookout/modes/toastie-trial.md`, then FINAL
   HANDOFF.
