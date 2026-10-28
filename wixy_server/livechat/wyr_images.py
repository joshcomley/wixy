"""On-demand image painting for the would-you-rather game (workspace 00045).

Talks to a local ComfyUI instance over loopback HTTP — the same pattern as
`pinclient.py`/`transcribe.py` talking to cmd: an external service wixy does not own,
probed per use, with the game degrading to text-only cards when it is unreachable.
On the fleet this is the Devfleet-supervised `ComfyUi` child on hub (127.0.0.1:8199,
pinned to the RTX 5060 Ti); the standalone edition passes no generator at all.

The default model is Krea 2 Turbo (NVFP4) — the pick of Hall topic 00072's on-Hub
benchmark ("use Krea 2 Turbo day to day"); Boogu Image Turbo is the fast/Apache-2.0
alternative. Both were benchmarked rendering a 1024x1024 photo in ~9-25 s while the
voice services stay resident.

ComfyUI keeps what it renders: `SaveImage` writes a PNG into ComfyUI's own output directory and
the prompt graph stays in its `/history`. Both are chat content (Inv 54) that delete/wipe can
never reach from outside, so every run cleans up after itself — it deletes its own history
entry, its own output files (`output_dir`, which MUST be the directory ComfyUI writes to; the
fleet runs ComfyUI with a dedicated `--output-directory`) and, for a run it abandons, cancels
the queued/running job. `purge_leftovers` sweeps anything a crashed run left behind.

Both option images go in ONE `/prompt` submission as two sampling chains sharing the
loaded UNET/CLIP/VAE, so the second image never pays a model reload.
"""

from __future__ import annotations

import logging
import os
import random
import time
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

_LOGGER = logging.getLogger(__name__)


class ImageGenerationError(Exception):
    """A generation run failed (submit refused, run failed server-side, timed out, or
    the output could not be fetched). The caller logs it and the round proceeds
    text-only — never a 5xx to the chat."""


@dataclass(frozen=True, slots=True)
class ImageModelConfig:
    """One proven model recipe (all measured on hub in Hall topic 00072's bench)."""

    unet: str
    clip: str
    clip_type: str
    vae: str
    steps: int
    cfg: float
    sampler: str
    scheduler: str


IMAGE_MODELS: dict[str, ImageModelConfig] = {
    "krea2-turbo-nvfp4": ImageModelConfig(
        unet="krea2_turbo_nvfp4.safetensors",
        clip="qwen3vl_4b_fp8_scaled.safetensors",
        clip_type="krea2",
        vae="qwen_image_vae.safetensors",
        steps=8,
        cfg=1.0,
        sampler="euler",
        scheduler="simple",
    ),
    "boogu-turbo-nvfp4": ImageModelConfig(
        unet="boogu_image_turbo_hotfix_nvfp4.safetensors",
        clip="qwen3vl_8b_fp8_scaled.safetensors",
        clip_type="boogu",
        vae="ae.safetensors",
        steps=4,
        cfg=1.0,
        sampler="lcm",
        scheduler="sgm_uniform",
    ),
}
DEFAULT_IMAGE_MODEL = "krea2-turbo-nvfp4"
FILE_PREFIX = "wyr_"
SLOT_TAGS = ("a", "b", "c")
"""Output-name suffix of sampling chains 0, 1, 2 (`<prefix>_a`, `_b`, `_c`; SaveImage 16/26/36)."""

_SUBMIT_TIMEOUT_S = 30.0
_DOWNLOAD_TIMEOUT_S = 60.0
_GENERATION_BUDGET_S = 300.0
_PROBE_TIMEOUT_S = 5.0
_STALE_OUTPUT_AFTER_S = 900.0
_CANCEL_SETTLE_S = 5.0
_SWEEP_PAGE = 200
_SWEEP_MAX_PAGES = 50


class ComfyImageGenerator:
    """Drives one ComfyUI HTTP API (`/prompt` + `/history` + `/view`). All methods are
    synchronous — route code calls them via `anyio.to_thread.run_sync`."""

    def __init__(
        self,
        base_url: str,
        *,
        model: str = DEFAULT_IMAGE_MODEL,
        output_dir: Path | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._config = IMAGE_MODELS.get(model, IMAGE_MODELS[DEFAULT_IMAGE_MODEL])
        self._output_dir = output_dir
        self._transport = transport
        # Sticky: once ComfyUI is seen writing somewhere other than `output_dir`, this server
        # can never delete the pictures it renders, so it stops rendering (Inv 54).
        self._misconfigured = False

    def purge_leftovers(self) -> int:
        """Delete stale `wyr_*` files in ComfyUI's output directory — what a run that crashed (or
        was cancelled mid-write) left behind. Files younger than the generation budget may
        belong to the OLDER process of a blue/green overlap, still working, and are kept.
        Returns how many were removed."""
        if self._output_dir is None:
            return 0
        removed = 0
        cutoff = time.time() - _STALE_OUTPUT_AFTER_S
        try:
            for path in self._output_dir.glob(f"{FILE_PREFIX}*"):
                try:
                    if path.stat().st_mtime >= cutoff:
                        continue
                    path.unlink()
                    removed += 1
                except OSError:
                    _LOGGER.warning("wyr: could not remove leftover %s", path)
        except OSError:
            _LOGGER.warning("wyr: could not list %s", self._output_dir)
        return removed

    def sweep_leftovers(self) -> int:
        """Remove what no live run can own: stale `wyr_*` output files AND the ComfyUI history
        entries of `wyr_*` runs that are finished and old. Run at startup and periodically, it is
        the backstop for a run orphaned by a killed process (ComfyUI finishes and writes after the
        replacement process already started) and for a cancelled run whose history entry appeared
        after the delete — including one interrupted before it saved anything, whose entry has no
        outputs and is recognised by the prompt graph it carries (`wyr_` filename prefixes). Young
        files and entries are left alone: they may belong to the older process of a blue/green
        overlap, still working. All of ComfyUI's history is walked, a page at a time, so a busy
        shared instance cannot push an orphan out of view. Returns the number of files plus
        history entries removed."""
        removed = self.purge_leftovers()
        if self._output_dir is None:
            return removed
        cutoff = time.time() - _STALE_OUTPUT_AFTER_S
        try:
            with httpx.Client(base_url=self._base_url, transport=self._transport) as client:
                orphans: list[str] = []
                seen: set[str] = set()
                for page in range(_SWEEP_MAX_PAGES):
                    resp = client.get(
                        "/history",
                        params={"max_items": _SWEEP_PAGE, "offset": page * _SWEEP_PAGE},
                        timeout=_PROBE_TIMEOUT_S,
                    )
                    if resp.status_code != 200:
                        break
                    entries = resp.json()
                    fresh = [pid for pid in entries if pid not in seen]
                    if not fresh:
                        break  # an old build ignoring `offset` repeats the same page
                    for prompt_id in fresh:
                        seen.add(prompt_id)
                        if self._is_orphaned_wyr_entry(entries[prompt_id], cutoff):
                            orphans.append(prompt_id)
                    if len(entries) < _SWEEP_PAGE:
                        break
                if orphans:
                    client.post("/history", json={"delete": orphans}, timeout=_PROBE_TIMEOUT_S)
                    removed += len(orphans)
        except httpx.HTTPError, ValueError, AttributeError:
            _LOGGER.warning("wyr: could not sweep ComfyUI history", exc_info=True)
        return removed

    def _is_orphaned_wyr_entry(self, entry: dict[str, Any], cutoff: float) -> bool:
        """True for a finished history entry of one of OUR runs with nothing young left behind:
        none of its output files is recent and (when it has none) it is itself old. Entries of
        other applications' runs are never ours."""
        assert self._output_dir is not None
        graph: Any = None
        prompt = entry.get("prompt")
        if isinstance(prompt, list) and len(prompt) > 2:
            graph = prompt[2]
        mine = False
        if isinstance(graph, dict):
            for node in graph.values():
                inputs = node.get("inputs") if isinstance(node, dict) else None
                prefix = inputs.get("filename_prefix") if isinstance(inputs, dict) else None
                if isinstance(prefix, str) and prefix.startswith(FILE_PREFIX):
                    mine = True
                    break
        names = [
            str(image.get("filename", ""))
            for node_out in (entry.get("outputs") or {}).values()
            for image in node_out.get("images", [])
        ]
        wyr_names = [n for n in names if n.startswith(FILE_PREFIX)]
        if not mine and not wyr_names:
            return False
        for name in wyr_names:
            try:
                if (self._output_dir / name).stat().st_mtime >= cutoff:
                    return False  # a run may still own it
            except OSError:
                pass  # file gone: nothing left for the entry to describe
        if wyr_names:
            return True
        # No outputs (interrupted/failed before saving): judge by the entry's own timestamps.
        stamps: list[float] = []
        for message in (entry.get("status") or {}).get("messages") or []:
            if isinstance(message, list) and len(message) == 2 and isinstance(message[1], dict):
                ts = message[1].get("timestamp")
                if isinstance(ts, int | float):
                    stamps.append(ts / 1000.0)
        return not stamps or max(stamps) < cutoff

    def _forget_run(
        self, client: httpx.Client, prompt_id: str | None, prefix: str, *, cancel: bool
    ) -> None:
        """Best-effort removal of everything ComfyUI retains about one run: its history
        entry, its output files, and (for an abandoned run) the queued/running job itself."""
        if prompt_id is not None:
            if cancel:
                for endpoint, body in (
                    ("/queue", {"delete": [prompt_id]}),
                    ("/interrupt", {"prompt_id": prompt_id}),
                ):
                    try:
                        client.post(endpoint, json=body, timeout=_PROBE_TIMEOUT_S)
                    except httpx.HTTPError:
                        pass
                # An interrupted run only writes its history entry when its executor stops, a
                # moment AFTER the interrupt: wait for it, or the delete below would run first.
                settle_deadline = time.monotonic() + _CANCEL_SETTLE_S
                while time.monotonic() < settle_deadline:
                    try:
                        seen = client.get(f"/history/{prompt_id}", timeout=_PROBE_TIMEOUT_S)
                        if seen.status_code == 200 and prompt_id in seen.json():
                            break
                    except httpx.HTTPError, ValueError:
                        pass
                    time.sleep(0.25)
            try:
                client.post("/history", json={"delete": [prompt_id]}, timeout=_PROBE_TIMEOUT_S)
            except httpx.HTTPError:
                _LOGGER.warning("wyr: could not delete ComfyUI history for a finished run")
        if self._output_dir is not None:
            try:
                for path in self._output_dir.glob(f"{prefix}_*"):
                    try:
                        path.unlink()
                    except OSError:
                        _LOGGER.warning("wyr: could not remove %s", path)
            except OSError:
                _LOGGER.warning("wyr: could not list %s", self._output_dir)

    def available(self) -> bool:
        """Cheap liveness probe before any GPU work is queued for a round."""
        if self._misconfigured:
            return False
        try:
            with httpx.Client(transport=self._transport) as client:
                resp = client.get(f"{self._base_url}/system_stats", timeout=_PROBE_TIMEOUT_S)
        except httpx.HTTPError:
            return False
        if resp.status_code != 200:
            return False
        return self._output_dir_matches(resp)

    def _output_dir_matches(self, resp: httpx.Response) -> bool:
        """ComfyUI reports its own launch arguments in `/system_stats`. When they are there, the
        folder it was told to write to MUST be the one this server was told to clean — a typo, or
        ComfyUI started without `--output-directory`, would silently retain every picture. Older
        ComfyUI builds that report no arguments are caught by the post-run check instead."""
        if self._output_dir is None:
            return True
        try:
            argv = resp.json().get("system", {}).get("argv")
        except ValueError, AttributeError:
            return True
        if not isinstance(argv, list):
            return True
        reported: str | None = None
        for i, arg in enumerate(argv):
            if arg == "--output-directory" and i + 1 < len(argv):
                reported = str(argv[i + 1])
            elif isinstance(arg, str) and arg.startswith("--output-directory="):
                reported = arg.split("=", 1)[1]
        if reported is None:
            _LOGGER.error(
                "wyr: ComfyUI was started without --output-directory, so this server cannot "
                "know where it keeps pictures; pictures are DISABLED until it is started with "
                "--output-directory %s",
                self._output_dir,
            )
            self._misconfigured = True
            return False
        if os.path.normcase(os.path.normpath(reported)) != os.path.normcase(
            os.path.normpath(str(self._output_dir))
        ):
            _LOGGER.error(
                "wyr: ComfyUI writes to %s but WIXY_COMFY_OUTPUT_DIR is %s; pictures are "
                "DISABLED (this server could not delete them)",
                reported,
                self._output_dir,
            )
            self._misconfigured = True
            return False
        return True

    def generate_pair(
        self,
        prompt_a: str,
        prompt_b: str,
        out_dir: Path,
        *,
        seed_a: int,
        seed_b: int,
    ) -> tuple[Path, Path]:
        """Render both options' scenes; returns the two downloaded PNG paths inside
        `out_dir` (which must exist). Raises `ImageGenerationError` on any failure —
        nothing partial is returned."""
        paths = self.generate_many([prompt_a, prompt_b], out_dir, seeds=[seed_a, seed_b])
        first, second = paths
        if first is None or second is None:
            made = [tag for tag, path in zip(SLOT_TAGS, paths, strict=False) if path is not None]
            raise ImageGenerationError(f"missing outputs: {made}")
        return first, second

    def generate_many(
        self,
        prompts: Sequence[str],
        out_dir: Path,
        *,
        seeds: Sequence[int] | None = None,
    ) -> list[Path | None]:
        """Render `1..3` prompts in ONE `/prompt` submission (one sampling chain each, sharing the
        loaded UNET/CLIP/VAE) and return one downloaded PNG path per prompt inside `out_dir`
        (which must exist), `None` for a slot whose picture ComfyUI did not produce or whose
        download failed. A whole-run failure (submit refused or unreachable, a failed or timed-out
        generation, an output-directory mismatch, no picture at all) raises
        `ImageGenerationError`. Slot `i` is written as `<prefix>_<a|b|c>`."""
        if not 1 <= len(prompts) <= len(SLOT_TAGS):
            raise ValueError(f"generate_many takes 1..{len(SLOT_TAGS)} prompts, got {len(prompts)}")
        if seeds is None:
            seeds = [random.SystemRandom().randrange(2**32) for _ in prompts]
        elif len(seeds) != len(prompts):
            raise ValueError("generate_many needs one seed per prompt")
        cfg = self._config
        prefix = f"{FILE_PREFIX}{uuid.uuid4().hex[:12]}"
        graph: dict[str, dict[str, object]] = {
            "1": {
                "class_type": "UNETLoader",
                "inputs": {"unet_name": cfg.unet, "weight_dtype": "default"},
            },
            "2": {
                "class_type": "CLIPLoader",
                "inputs": {"clip_name": cfg.clip, "type": cfg.clip_type, "device": "default"},
            },
            "3": {"class_type": "VAELoader", "inputs": {"vae_name": cfg.vae}},
        }
        for index, (prompt, seed) in enumerate(zip(prompts, seeds, strict=True)):
            tag = SLOT_TAGS[index]
            base = 10 * (index + 1)
            graph[str(base + 1)] = {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": prompt, "clip": ["2", 0]},
            }
            graph[str(base + 2)] = {
                "class_type": "ConditioningZeroOut",
                "inputs": {"conditioning": [str(base + 1), 0]},
            }
            graph[str(base + 3)] = {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 1024, "height": 1024, "batch_size": 1},
            }
            graph[str(base + 4)] = {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["1", 0],
                    "seed": seed,
                    "steps": cfg.steps,
                    "cfg": cfg.cfg,
                    "sampler_name": cfg.sampler,
                    "scheduler": cfg.scheduler,
                    "positive": [str(base + 1), 0],
                    "negative": [str(base + 2), 0],
                    "latent_image": [str(base + 3), 0],
                    "denoise": 1.0,
                },
            }
            graph[str(base + 5)] = {
                "class_type": "VAEDecode",
                "inputs": {"samples": [str(base + 4), 0], "vae": ["3", 0]},
            }
            graph[str(base + 6)] = {
                "class_type": "SaveImage",
                "inputs": {"images": [str(base + 5), 0], "filename_prefix": f"{prefix}_{tag}"},
            }
        wanted = SLOT_TAGS[: len(prompts)]

        with httpx.Client(base_url=self._base_url, transport=self._transport) as client:
            prompt_id: str | None = None
            # A run is only left alone once ComfyUI has reported it finished; ANY other exit
            # (timeout, an unreadable answer, an unexpected error) cancels it so it cannot go
            # on to write pictures after this server has stopped looking.
            completed = False
            try:
                try:
                    resp = client.post(
                        "/prompt",
                        json={"prompt": graph, "client_id": uuid.uuid4().hex},
                        timeout=_SUBMIT_TIMEOUT_S,
                    )
                except httpx.HTTPError as exc:
                    raise ImageGenerationError(f"submit unreachable: {exc}") from exc
                if resp.status_code != 200:
                    raise ImageGenerationError(f"submit refused: HTTP {resp.status_code}")
                try:
                    prompt_id = resp.json()["prompt_id"]
                except (ValueError, KeyError) as exc:
                    raise ImageGenerationError(
                        f"submit returned no prompt_id: {resp.text!r:.200}"
                    ) from exc

                deadline = time.monotonic() + _GENERATION_BUDGET_S
                images: dict[str, str] = {}
                while time.monotonic() < deadline:
                    try:
                        history = client.get(f"/history/{prompt_id}", timeout=_SUBMIT_TIMEOUT_S)
                    except httpx.HTTPError:
                        time.sleep(0.5)
                        continue
                    if history.status_code != 200:
                        time.sleep(0.5)
                        continue
                    entry = history.json().get(prompt_id)
                    if entry is None:
                        time.sleep(0.5)
                        continue
                    completed = True
                    status = entry.get("status") or {}
                    if status.get("status_str") != "success":
                        raise ImageGenerationError(f"generation failed: {str(status)[:200]}")
                    for node_out in entry.get("outputs", {}).values():
                        for image in node_out.get("images", []):
                            filename = image.get("filename", "")
                            for tag in wanted:
                                if filename.startswith(f"{prefix}_{tag}"):
                                    images[tag] = filename
                    break
                else:
                    raise ImageGenerationError("generation timed out")
                if not images:
                    raise ImageGenerationError("missing outputs: none")
                if self._output_dir is not None and not all(
                    (self._output_dir / name).is_file() for name in images.values()
                ):
                    # ComfyUI wrote the pictures somewhere this server does not clean. Stop
                    # rendering for good rather than keep leaving chat content behind.
                    self._misconfigured = True
                    _LOGGER.error(
                        "wyr: ComfyUI's pictures are not in WIXY_COMFY_OUTPUT_DIR (%s); "
                        "pictures are DISABLED until it names the folder ComfyUI writes to",
                        self._output_dir,
                    )
                    raise ImageGenerationError("output directory mismatch")

                paths: list[Path | None] = []
                downloaded = 0
                for tag in wanted:
                    if tag not in images:
                        paths.append(None)
                        continue
                    try:
                        view = client.get(
                            "/view",
                            params={"filename": images[tag], "subfolder": "", "type": "output"},
                            timeout=_DOWNLOAD_TIMEOUT_S,
                        )
                        usable = view.status_code == 200 and bool(view.content)
                    except httpx.HTTPError as exc:
                        _LOGGER.warning("wyr: download of slot %s failed: %s", tag, exc)
                        paths.append(None)
                        continue
                    if not usable:
                        _LOGGER.warning(
                            "wyr: download of slot %s refused: HTTP %s", tag, view.status_code
                        )
                        paths.append(None)
                        continue
                    target = out_dir / f"{prefix}_{tag}.png"
                    target.write_bytes(view.content)
                    paths.append(target)
                    downloaded += 1
                if downloaded == 0:
                    raise ImageGenerationError("download failed: no picture could be fetched")
                return paths
            finally:
                self._forget_run(client, prompt_id, prefix, cancel=not completed)
