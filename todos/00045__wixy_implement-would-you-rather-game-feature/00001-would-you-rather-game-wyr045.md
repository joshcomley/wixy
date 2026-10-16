---
id: 00001
id6: wyr045
workspace: 00045__wixy_implement-would-you-rather-game-feature
created: 2026-10-16
---

# Build the Would-you-rather chat game

Mission: ⋯-menu game in the hidden Server chat. Both vote skip/play; both answer (own
pick + guess of the other's pick); results hidden until BOTH press Reveal; two photos per
round painted on Hub's GPU at show time; ~2000-question bank from ten Luna writers,
deduped by this session.

Authoritative design: `.scratch/wyr-brief.md` (workspace root). Delivery record
3025e7e3-7160-4d7c-a8de-5c64b2b4e070 holds tasks T1–T8 (also in the brief).

Key proven facts:
- ComfyUI works NOW: `E:\ImageGenLab\ComfyUI\.venv\Scripts\python.exe main.py --listen
  127.0.0.1 --port 8199 --reserve-vram 1 --disable-auto-launch`, env
  `CUDA_VISIBLE_DEVICES=GPU-979a6afe-ab94-c670-7af5-3cfded2e5770` (RTX 5060 Ti),
  `CUDA_DEVICE_ORDER=PCI_BUS_ID`. Krea 2 Turbo NVFP4 graph in `.scratch/wyr-intake/comfy_smoke.py`
  (verified: 24.4s cold, 1024² photo).
- Writers write `.scratch/wyr-intake/agent-NN/batch-*.jsonl`; assemble with
  `.scratch/wyr-intake/dedupe.py`.
- Backend pattern = drawings feature (summary on Message + GET full view per seq +
  message_updated events); frontend pattern = drawingSync/wyrModel + wyrCard; erasure =
  FK cascade + explicit DELETE in _wipe.
- R14a: all commit trailers exactly `Release-note: General bug fixes and improvements.`
