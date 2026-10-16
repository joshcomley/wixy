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
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

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

_SUBMIT_TIMEOUT_S = 30.0
_DOWNLOAD_TIMEOUT_S = 60.0
_GENERATION_BUDGET_S = 300.0
_PROBE_TIMEOUT_S = 5.0
_STALE_OUTPUT_AFTER_S = 900.0


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
        entries of `wyr_*` runs whose files are gone or stale. Run at startup and periodically,
        it is the backstop for a run orphaned by a killed process (ComfyUI finishes and writes
        after the replacement process already started) and for a cancelled run whose history
        entry appeared after the delete. Young files and their entries are left alone: they may
        belong to the older process of a blue/green overlap, still working. Returns the number
        of files plus history entries removed."""
        removed = self.purge_leftovers()
        if self._output_dir is None:
            return removed
        cutoff = time.time() - _STALE_OUTPUT_AFTER_S
        try:
            with httpx.Client(base_url=self._base_url, transport=self._transport) as client:
                resp = client.get("/history", params={"max_items": 200}, timeout=_PROBE_TIMEOUT_S)
                if resp.status_code != 200:
                    return removed
                orphans: list[str] = []
                for prompt_id, entry in resp.json().items():
                    names = [
                        str(image.get("filename", ""))
                        for node_out in (entry.get("outputs") or {}).values()
                        for image in node_out.get("images", [])
                    ]
                    mine = [n for n in names if n.startswith(FILE_PREFIX)]
                    if not mine:
                        continue
                    alive = False
                    for name in mine:
                        try:
                            if (self._output_dir / name).stat().st_mtime >= cutoff:
                                alive = True
                        except OSError:
                            pass  # file gone: nothing left for the entry to describe
                    if not alive:
                        orphans.append(prompt_id)
                if orphans:
                    client.post("/history", json={"delete": orphans}, timeout=_PROBE_TIMEOUT_S)
                    removed += len(orphans)
        except httpx.HTTPError, ValueError, AttributeError:
            _LOGGER.warning("wyr: could not sweep ComfyUI history", exc_info=True)
        return removed

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
        for tag, prompt, seed, base in (("a", prompt_a, seed_a, 10), ("b", prompt_b, seed_b, 20)):
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
                            if filename.startswith(f"{prefix}_a"):
                                images["a"] = filename
                            elif filename.startswith(f"{prefix}_b"):
                                images["b"] = filename
                    break
                else:
                    raise ImageGenerationError("generation timed out")
                if "a" not in images or "b" not in images:
                    raise ImageGenerationError(f"missing outputs: {sorted(images)}")
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

                paths: dict[str, Path] = {}
                for tag in ("a", "b"):
                    try:
                        view = client.get(
                            "/view",
                            params={"filename": images[tag], "subfolder": "", "type": "output"},
                            timeout=_DOWNLOAD_TIMEOUT_S,
                        )
                    except httpx.HTTPError as exc:
                        raise ImageGenerationError(f"download failed: {exc}") from exc
                    if view.status_code != 200 or not view.content:
                        raise ImageGenerationError(f"download refused: HTTP {view.status_code}")
                    target = out_dir / f"{prefix}_{tag}.png"
                    target.write_bytes(view.content)
                    paths[tag] = target
                return paths["a"], paths["b"]
            finally:
                self._forget_run(client, prompt_id, prefix, cancel=not completed)
