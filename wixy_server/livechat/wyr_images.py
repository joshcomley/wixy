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

Both option images go in ONE `/prompt` submission as two sampling chains sharing the
loaded UNET/CLIP/VAE, so the second image never pays a model reload.
"""

from __future__ import annotations

import logging
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

_SUBMIT_TIMEOUT_S = 30.0
_DOWNLOAD_TIMEOUT_S = 60.0
_GENERATION_BUDGET_S = 300.0
_PROBE_TIMEOUT_S = 5.0


class ComfyImageGenerator:
    """Drives one ComfyUI HTTP API (`/prompt` + `/history` + `/view`). All methods are
    synchronous — route code calls them via `anyio.to_thread.run_sync`."""

    def __init__(self, base_url: str, *, model: str = DEFAULT_IMAGE_MODEL) -> None:
        self._base_url = base_url.rstrip("/")
        self._config = IMAGE_MODELS.get(model, IMAGE_MODELS[DEFAULT_IMAGE_MODEL])

    def available(self) -> bool:
        """Cheap liveness probe before any GPU work is queued for a round."""
        try:
            resp = httpx.get(f"{self._base_url}/system_stats", timeout=_PROBE_TIMEOUT_S)
        except httpx.HTTPError:
            return False
        return resp.status_code == 200

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
        prefix = f"wyr_{uuid.uuid4().hex[:12]}"
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

        with httpx.Client(base_url=self._base_url) as client:
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
                raise ImageGenerationError(f"submit returned no prompt_id: {resp.text!r:.200}") from exc

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
                status = entry.get("status") or {}
                if status.get("status_str") != "success":
                    raise ImageGenerationError(
                        f"generation failed: {str(status)[:200]}"
                    )
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
