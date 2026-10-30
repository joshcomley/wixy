"""Cookout dish pictures (workspace 00058, spec/server-chat/09-cookout.md §3.3): the generalised
ComfyUI graph (`generate_many(1..3)`), the picture job's `images_generation` fencing, partial
success, attempt-scoped `server/cookout-tmp/` cleanup, `clear_cookout_scratch`, shared-GPU demand
accounting and self-healing — against an in-memory store with the Appendix A.2 signatures (see
test_livechat_cookout_ai.py) and a fake ComfyUI over `httpx.MockTransport`."""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import anyio
import httpx
import pytest

from wixy_server.background import BackgroundTaskHealth, ContainedTaskGroup
from wixy_server.livechat.cookout_images import (
    DEFAULT_PRESENTATION,
    IMAGE_PROMPT_TEMPLATE,
    CookoutPictureJob,
    PictureTiming,
    build_image_prompt,
    clear_cookout_scratch,
    concept_prompts,
    scratch_dir,
)
from wixy_server.livechat.cookout_modes import default_modes
from wixy_server.livechat.cookout_twists import STYLE_IDS, style_by_id
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.wyr_game import WyrDemand
from wixy_server.livechat.wyr_images import (
    DEFAULT_IMAGE_MODEL,
    FILE_PREFIX,
    ComfyImageGenerator,
    ImageGenerationError,
)
from wixy_server.storage import ProjectPaths
from wixy_server.tests.test_livechat_cookout_ai import (
    FakeStore,
    ScanBank,
    canned_concepts_text,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


# -- ComfyUI client: generate_many ------------------------------------------------------------


class FakeComfy:
    """A fake ComfyUI: records every call, writes the pictures its submitted graph asks for (minus
    any slots in `skip`), and reports them in `/history`."""

    def __init__(self, out_dir: Path, *, skip: Sequence[str] = (), fail_status: bool = False):
        self.out_dir = out_dir
        self.skip = set(skip)
        self.fail_status = fail_status
        self.calls: list[tuple[str, str, Any]] = []
        self.graph: dict[str, Any] = {}
        self.prefixes: list[str] = []
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, request.url.path, body))
        path = request.url.path
        if path == "/system_stats":
            return httpx.Response(200, json={"system": {}})
        if path == "/history" and request.method == "GET":
            return httpx.Response(200, json={})
        if path == "/prompt":
            self.graph = (body or {})["prompt"]
            self.prefixes = [
                n["inputs"]["filename_prefix"]
                for n in self.graph.values()
                if n["class_type"] == "SaveImage"
            ]
            for prefix in self.prefixes:
                if prefix[-1] not in self.skip:
                    (self.out_dir / f"{prefix}_00001_.png").write_bytes(PNG)
            return httpx.Response(200, json={"prompt_id": "p1"})
        if path == "/history/p1":
            if self.fail_status:
                return httpx.Response(
                    200, json={"p1": {"status": {"status_str": "error"}, "outputs": {}}}
                )
            outputs = {
                str(i): {"images": [{"filename": f"{prefix}_00001_.png"}]}
                for i, prefix in enumerate(self.prefixes)
                if prefix[-1] not in self.skip
            }
            return httpx.Response(
                200, json={"p1": {"status": {"status_str": "success"}, "outputs": outputs}}
            )
        if path == "/view":
            return httpx.Response(
                200, content=(self.out_dir / request.url.params["filename"]).read_bytes()
            )
        return httpx.Response(200, json={})


def _generator(tmp_path: Path, **kw: Any) -> tuple[ComfyImageGenerator, FakeComfy, Path]:
    out = tmp_path / "comfy-out"
    out.mkdir(exist_ok=True)
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    fake = FakeComfy(out, **kw)
    gen = ComfyImageGenerator("http://comfy.invalid", output_dir=out, transport=fake.transport)
    return gen, fake, work


class TestGenerateMany:
    @pytest.mark.parametrize("count", [1, 2, 3])
    def test_one_submission_with_a_chain_per_prompt_sharing_the_loaders(
        self, tmp_path: Path, count: int
    ) -> None:
        gen, fake, work = _generator(tmp_path)
        paths = gen.generate_many([f"p{i}" for i in range(count)], work, seeds=[1, 2, 3][:count])
        assert [p is not None and p.read_bytes() == PNG for p in paths] == [True] * count
        assert sum(1 for c in fake.calls if c[1] == "/prompt") == 1
        graph = fake.graph
        classes = [n["class_type"] for n in graph.values()]
        for loader in ("UNETLoader", "CLIPLoader", "VAELoader"):
            assert classes.count(loader) == 1
        assert [graph[k]["class_type"] for k in ("1", "2", "3")] == [
            "UNETLoader",
            "CLIPLoader",
            "VAELoader",
        ]
        for chain in range(count):
            base = 10 * (chain + 1)
            assert graph[str(base + 1)]["inputs"]["text"] == f"p{chain}"
            assert graph[str(base + 2)]["class_type"] == "ConditioningZeroOut"
            latent = graph[str(base + 3)]
            assert latent["class_type"] == "EmptyLatentImage"
            assert latent["inputs"] == {"width": 1024, "height": 1024, "batch_size": 1}
            assert graph[str(base + 4)]["inputs"]["seed"] == [1, 2, 3][chain]
            assert graph[str(base + 4)]["inputs"]["negative"] == [str(base + 2), 0]
            assert graph[str(base + 6)]["inputs"]["filename_prefix"].startswith(FILE_PREFIX)
        assert classes.count("SaveImage") == count and len(graph) == 3 + 6 * count

    def test_the_model_settings_are_the_wyr_ones(self, tmp_path: Path) -> None:
        gen, fake, work = _generator(tmp_path)
        gen.generate_many(["x"], work)
        assert DEFAULT_IMAGE_MODEL == "krea2-turbo-nvfp4"
        graph = fake.graph
        assert graph["1"]["inputs"]["unet_name"] == "krea2_turbo_nvfp4.safetensors"
        assert graph["11"]["inputs"]["clip"] == ["2", 0]
        sampler = graph["14"]["inputs"]
        assert (sampler["steps"], sampler["cfg"], sampler["sampler_name"]) == (8, 1.0, "euler")

    def test_a_missing_slot_is_none_and_the_others_are_kept(self, tmp_path: Path) -> None:
        gen, _fake, work = _generator(tmp_path, skip=("b",))
        a, b, c = gen.generate_many(["x", "y", "z"], work)
        assert a is not None and b is None and c is not None

    def test_nothing_made_is_a_failure(self, tmp_path: Path) -> None:
        gen, _fake, work = _generator(tmp_path, skip=("a", "b"))
        with pytest.raises(ImageGenerationError):
            gen.generate_many(["x", "y"], work)

    def test_a_failed_generation_raises(self, tmp_path: Path) -> None:
        gen, _fake, work = _generator(tmp_path, fail_status=True)
        with pytest.raises(ImageGenerationError):
            gen.generate_many(["x"], work)

    @pytest.mark.parametrize("count", [0, 4])
    def test_the_prompt_count_is_one_to_three(self, tmp_path: Path, count: int) -> None:
        gen, _fake, work = _generator(tmp_path)
        with pytest.raises(ValueError):
            gen.generate_many(["x"] * count, work)

    def test_the_seed_count_must_match(self, tmp_path: Path) -> None:
        gen, _fake, work = _generator(tmp_path)
        with pytest.raises(ValueError):
            gen.generate_many(["x", "y"], work, seeds=[1])

    def test_generate_pair_still_returns_two_paths_and_raises_when_one_is_missing(
        self, tmp_path: Path
    ) -> None:
        gen, _fake, work = _generator(tmp_path)
        first, second = gen.generate_pair("x", "y", work, seed_a=1, seed_b=2)
        assert first.read_bytes() == PNG and second.read_bytes() == PNG
        (tmp_path / "two").mkdir()
        gen2, _fake2, work2 = _generator(tmp_path / "two", skip=("b",))
        with pytest.raises(ImageGenerationError):
            gen2.generate_pair("x", "y", work2, seed_a=1, seed_b=2)

    def test_a_finished_run_cleans_comfyui_up_for_every_slot(self, tmp_path: Path) -> None:
        gen, fake, work = _generator(tmp_path)
        gen.generate_many(["x", "y", "z"], work)
        assert [p.name for p in fake.out_dir.iterdir()] == []  # wyr_ prefix files removed
        assert ("POST", "/history", {"delete": ["p1"]}) in fake.calls


# -- the picture job --------------------------------------------------------------------------


class StubGenerator(ComfyImageGenerator):
    """A generator double: `generate_many` writes PNGs for the slots not in `skip`."""

    def __init__(
        self,
        *,
        skip: Sequence[int] = (),
        raises: bool = False,
        up: bool = True,
        hook: Callable[[], None] | None = None,
    ) -> None:
        super().__init__("http://comfy.invalid")
        self.skip = set(skip)
        self.raises = raises
        self.up = up
        self.hook = hook
        self.calls: list[list[str]] = []
        self.work_dirs: list[Path] = []
        self.in_flight = 0
        self.max_in_flight = 0

    def available(self) -> bool:
        return self.up

    def generate_many(
        self, prompts: Sequence[str], out_dir: Path, *, seeds: Sequence[int] | None = None
    ) -> list[Path | None]:
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            self.calls.append(list(prompts))
            self.work_dirs.append(out_dir)
            if self.hook is not None:
                self.hook()
            if self.raises:
                raise ImageGenerationError("boom")
            paths: list[Path | None] = []
            for index, _prompt in enumerate(prompts):
                if index in self.skip:
                    paths.append(None)
                    continue
                target = out_dir / f"shot{index}.png"
                target.write_bytes(PNG + bytes([index]))
                paths.append(target)
            return paths
        finally:
            self.in_flight -= 1


class Harness:
    def __init__(self, tmp_path: Path, generator: StubGenerator, **job_kw: Any) -> None:
        self.paths = ProjectPaths(slug="s", root=tmp_path / "storage")
        self.store = FakeStore()
        self.generator = generator
        self.demand = WyrDemand()
        self.notifier = LiveChatNotifier()
        self.job_kw = job_kw

    def row(self, seq: int = 1) -> dict[str, Any]:
        return self.store.rounds[seq]

    def ready_round(self, seq: int = 1, *, pending: bool = True, **extra: Any) -> dict[str, Any]:
        row = self.store.add_round(seq, concepts="ready", concepts_json=canned_concepts_text())
        if pending:
            row.update(
                images="pending", images_generation=1, images_started_at=time.time(), images_tries=1
            )
        row.update(extra)
        return row

    def job(self, limiter: anyio.CapacityLimiter | None = None) -> CookoutPictureJob:
        shared = limiter

        def limiter_factory() -> anyio.CapacityLimiter:
            nonlocal shared
            if shared is None:
                shared = anyio.CapacityLimiter(1)
            return shared

        return CookoutPictureJob(
            store=self.store,
            paths=self.paths,
            namer=_Namer(),
            generator=self.generator,
            notifier=self.notifier,
            limiter=limiter_factory,
            demand=self.demand,
            **self.job_kw,
        )

    def scratch_entries(self) -> list[str]:
        root = scratch_dir(self.paths)
        return sorted(p.name for p in root.iterdir()) if root.is_dir() else []

    def staged_upload_dirs(self) -> list[Path]:
        uploads = self.paths.server_uploads
        return sorted(uploads.iterdir()) if uploads.is_dir() else []


class _Namer:
    def __init__(self) -> None:
        self.bank = ScanBank()

    def ingredient_name(self, ingredient_id: str) -> str | None:
        found = self.bank.ingredient(ingredient_id)
        return found.name if found is not None else None

    def staple_name(self, staple_id: str) -> str | None:
        found = self.bank.staple(staple_id)
        return found.name if found is not None else None


class TestPrompt:
    def test_the_prompt_is_server_built_from_the_title_and_names(self) -> None:
        text = build_image_prompt("Smoky Steak Plate", ["Ribeye steak", "Butter"])
        assert text == IMAGE_PROMPT_TEMPLATE.format(
            title="Smoky Steak Plate", ingredients="Ribeye steak, Butter"
        )
        assert text.startswith(
            'Photorealistic appetising food photograph of "Smoky Steak Plate", one finished '
            "cooked serving made with Ribeye steak, Butter."
        )
        assert text.endswith("no text, labels, logos, or watermark.")


class TestPictureJob:
    def test_all_three_pictures_are_stored_and_nothing_is_left_behind(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, StubGenerator())
        h.ready_round()
        anyio.run(h.job().run, 1)
        row = h.row()
        assert row["images"] == "done"
        assert set(row["pictures"]) == {"a", "b", "c"}
        assert len(h.generator.calls) == 1 and len(h.generator.calls[0]) == 3
        prompt = h.generator.calls[0][0]
        assert prompt.startswith('Photorealistic appetising food photograph of "')
        assert "Ribeye steak" in h.generator.calls[0][0] or "Aged Gruyère" in prompt
        # The attempt directory is gone; the staged uploads now belong to the store's attachments.
        assert h.scratch_entries() == []
        assert len(h.staged_upload_dirs()) == 3
        assert h.demand.count == 0
        assert h.store.failed_pictures == []

    def test_the_image_prompt_names_the_resolved_picks_and_staples_only(
        self, tmp_path: Path
    ) -> None:
        h = Harness(tmp_path, StubGenerator())
        h.ready_round()
        anyio.run(h.job().run, 1)
        concepts = json.loads(h.row()["concepts_json"])["concepts"]
        for concept, prompt in zip(concepts, h.generator.calls[0], strict=True):
            assert f'"{concept["title"]}"' in prompt
            assert "Salt, Black pepper" in prompt
            for omitted in concept["omitted"]:
                assert omitted["id"].replace("-", " ") not in prompt.casefold()

    def test_partial_success_is_kept_and_ends_failed_so_a_retry_can_fill_the_gap(
        self, tmp_path: Path
    ) -> None:
        h = Harness(tmp_path, StubGenerator(skip=(1,)))
        h.ready_round()
        anyio.run(h.job().run, 1)
        row = h.row()
        assert row["images"] == "failed"
        assert set(row["pictures"]) == {"a", "c"}
        assert h.scratch_entries() == []

        # The manual retry (store: pending again, generation bumped, pictures preserved).
        row.update(images="pending", images_generation=row["images_generation"] + 1)
        row.update(images_started_at=time.time(), images_tries=1)
        h.generator = StubGenerator()
        before = dict(row["pictures"])
        anyio.run(h.job().run, 1)
        assert len(h.generator.calls) == 1 and len(h.generator.calls[0]) == 1  # only slot b
        assert (
            h.generator.calls[0][0].find(json.loads(row["concepts_json"])["concepts"][1]["title"])
            > 0
        )
        assert row["images"] == "done"
        assert row["pictures"]["a"] == before["a"] and row["pictures"]["c"] == before["c"]
        assert set(row["pictures"]) == {"a", "b", "c"}

    def test_a_total_failure_ends_the_wait_and_cleans_up(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, StubGenerator(raises=True))
        h.ready_round()
        anyio.run(h.job().run, 1)
        assert h.row()["images"] == "failed" and not h.row()["pictures"]
        assert h.scratch_entries() == [] and h.staged_upload_dirs() == []
        assert h.demand.count == 0

    def test_an_unreachable_generator_ends_the_wait_without_gpu_work(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, StubGenerator(up=False))
        h.ready_round()
        anyio.run(h.job().run, 1)
        assert h.row()["images"] == "failed"
        assert h.generator.calls == []

    def test_no_room_ends_the_wait_and_removes_the_downloads(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, StubGenerator(), space_ok=lambda size: False)
        h.ready_round()
        anyio.run(h.job().run, 1)
        assert h.row()["images"] == "failed"
        assert h.scratch_entries() == [] and h.staged_upload_dirs() == []

    def test_a_round_deleted_mid_render_stores_nothing_and_leaves_nothing(
        self, tmp_path: Path
    ) -> None:
        h = Harness(tmp_path, StubGenerator(hook=lambda: None))
        h.ready_round()

        def delete_round() -> None:
            h.store.rounds.pop(1)

        h.generator.hook = delete_round
        anyio.run(h.job().run, 1)
        assert h.store.stored_pictures == []
        assert h.scratch_entries() == [] and h.staged_upload_dirs() == []
        assert h.demand.count == 0

    def test_a_round_that_is_not_waiting_costs_no_gpu_time(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, StubGenerator())
        h.ready_round(pending=False)
        anyio.run(h.job().run, 1)
        assert h.generator.calls == []

    def test_a_late_older_attempt_cannot_overwrite_or_end_a_newer_one(self, tmp_path: Path) -> None:
        """Two-store-instance fencing: attempt A claims, attempt B claims during A's render; A's
        late success and A's late failure both return False and leave B's pending wait alone."""
        h = Harness(tmp_path, StubGenerator())
        row = h.ready_round()
        newer_generation: list[int] = []

        def newer_claim() -> None:
            status, generation = h.store.claim_cookout_pictures(
                1, stale_before=None, now=time.time()
            )
            assert status == "claimed"
            newer_generation.append(generation)

        h.generator.hook = newer_claim
        anyio.run(h.job().run, 1)
        assert h.store.stored_pictures == []  # A's late success was refused
        assert row["images"] == "pending" and not row["pictures"]
        assert row["images_generation"] == newer_generation[0]
        assert h.scratch_entries() == [] and h.staged_upload_dirs() == []  # A cleaned up
        # A's late failure write named its own (older) generation and was refused too.
        assert h.store.failed_pictures and h.store.failed_pictures[-1][1] < newer_generation[0]
        assert row["images"] == "pending"

    def test_a_later_attempt_with_ready_slots_regenerates_only_the_missing_ones(
        self, tmp_path: Path
    ) -> None:
        h = Harness(tmp_path, StubGenerator())
        h.ready_round(pictures={"a": "att-a"})
        anyio.run(h.job().run, 1)
        assert len(h.generator.calls[0]) == 2
        assert h.row()["pictures"]["a"] == "att-a"
        assert h.row()["images"] == "done"

    def test_shared_gpu_limiter_serialises_jobs_and_demand_counts_them(
        self, tmp_path: Path
    ) -> None:
        h = Harness(tmp_path, StubGenerator())
        h.ready_round(1)
        h.ready_round(2)
        job = h.job()
        peak_demand: list[int] = []

        def watch() -> None:
            peak_demand.append(h.demand.count)
            time.sleep(0.05)

        h.generator.hook = watch

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(job.run, 1)
                tg.start_soon(job.run, 2)

        anyio.run(go)
        assert h.generator.max_in_flight == 1  # CapacityLimiter(1): one GPU job at a time
        assert max(peak_demand) == 2  # both queued jobs counted while one rendered
        assert h.demand.count == 0
        assert h.row(1)["images"] == "done" and h.row(2)["images"] == "done"

    def test_a_job_already_running_for_a_round_is_not_started_twice(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, StubGenerator())
        h.ready_round()
        job = h.job()
        h.generator.hook = lambda: time.sleep(0.1)

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(job.run, 1)
                tg.start_soon(job.run, 1)

        anyio.run(go)
        assert len(h.generator.calls) == 1

    def test_the_notifier_publishes_when_pictures_land(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, StubGenerator())
        h.ready_round()
        published: list[int] = []
        h.notifier.publish = lambda: published.append(1)  # type: ignore[method-assign]
        anyio.run(h.job().run, 1)
        assert published == [1]


class TestCancellation:
    def test_cancelling_a_running_job_still_removes_its_scratch(self, tmp_path: Path) -> None:
        release = threading.Event()
        started = threading.Event()

        def hold() -> None:
            started.set()
            release.wait(5)

        h = Harness(tmp_path, StubGenerator(hook=hold))
        h.ready_round()
        job = h.job()

        async def go() -> None:
            async with anyio.create_task_group() as tg:
                tg.start_soon(job.run, 1)
                with anyio.fail_after(5):
                    while not started.is_set():
                        await anyio.sleep(0.01)
                    scratch_exists = bool(h.scratch_entries())
                assert scratch_exists
                tg.cancel_scope.cancel()
                release.set()

        anyio.run(go)
        assert h.scratch_entries() == []
        assert h.demand.count == 0
        assert h.row()["images"] == "pending"  # left for the sweep, not ended by a shutdown


# -- scratch ----------------------------------------------------------------------------------


class TestScratch:
    def _entries(self, paths: ProjectPaths) -> tuple[Path, Path, Path]:
        root = scratch_dir(paths)
        old_dir, young_dir = root / "old", root / "young"
        old_dir.mkdir(parents=True)
        young_dir.mkdir()
        (old_dir / "x.png").write_bytes(PNG)
        (young_dir / "y.png").write_bytes(PNG)
        old_file = root / "stray.png"
        old_file.write_bytes(PNG)
        return old_dir, young_dir, old_file

    def test_young_work_is_preserved_and_old_work_is_reclaimed(self, tmp_path: Path) -> None:
        paths = ProjectPaths(slug="s", root=tmp_path)
        old_dir, young_dir, old_file = self._entries(paths)
        long_ago = time.time() - 901
        for entry in (old_dir, old_file):
            os.utime(entry, (long_ago, long_ago))
        assert clear_cookout_scratch(paths) == 2
        assert not old_dir.exists() and not old_file.exists()
        assert young_dir.exists()

    def test_a_young_entry_is_reclaimed_once_it_ages_past_900_seconds(self, tmp_path: Path) -> None:
        paths = ProjectPaths(slug="s", root=tmp_path)
        _old, young_dir, _file = self._entries(paths)
        now = time.time()
        assert clear_cookout_scratch(paths, now=now) == 0 or young_dir.exists()
        assert young_dir.exists()
        assert clear_cookout_scratch(paths, now=now + 1000) >= 1
        assert not young_dir.exists()

    def test_the_age_threshold_is_900_seconds_by_default(self, tmp_path: Path) -> None:
        paths = ProjectPaths(slug="s", root=tmp_path)
        _old, young_dir, _file = self._entries(paths)
        mtime = young_dir.stat().st_mtime
        clear_cookout_scratch(paths, now=mtime + 899)
        assert young_dir.exists()
        clear_cookout_scratch(paths, now=mtime + 901)
        assert not young_dir.exists()

    def test_a_missing_scratch_folder_is_fine(self, tmp_path: Path) -> None:
        assert clear_cookout_scratch(ProjectPaths(slug="s", root=tmp_path)) == 0


# -- recovery and self-healing ----------------------------------------------------------------


async def _group(fn: Callable[[ContainedTaskGroup], Any]) -> None:
    async with anyio.create_task_group() as tg:
        await fn(ContainedTaskGroup(tg, BackgroundTaskHealth()))


class TestRecovery:
    def test_startup_resume_redoes_pending_waits_and_clears_old_scratch(
        self, tmp_path: Path
    ) -> None:
        h = Harness(tmp_path, StubGenerator())
        h.ready_round()
        stale = scratch_dir(h.paths) / "orphan"
        stale.mkdir(parents=True)
        long_ago = time.time() - 5000
        os.utime(stale, (long_ago, long_ago))
        job = h.job()
        anyio.run(_group, job.resume)
        assert not stale.exists()
        assert h.row()["images"] == "done"

    def test_the_sweep_heals_a_wait_pending_longer_than_an_attempt_can_take(
        self, tmp_path: Path
    ) -> None:
        h = Harness(tmp_path, StubGenerator(), timing=PictureTiming(stale_after_s=5.0))
        h.ready_round(images_started_at=time.time() - 600)
        anyio.run(_group, h.job().sweep)
        assert h.row()["images"] == "done"

    def test_the_sweep_leaves_a_recent_wait_alone(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, StubGenerator(), timing=PictureTiming(stale_after_s=600.0))
        h.ready_round()
        anyio.run(_group, h.job().sweep)
        assert h.generator.calls == [] and h.row()["images"] == "pending"

    def test_a_wait_whose_attempts_keep_dying_is_given_up(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, StubGenerator(), timing=PictureTiming(stale_after_s=5.0))
        h.ready_round(images_started_at=time.time() - 600, images_tries=3)
        anyio.run(_group, h.job().sweep)
        assert h.generator.calls == []
        assert h.row()["images"] == "failed"

    def test_the_sweep_skips_a_round_this_process_is_already_painting(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, StubGenerator(), timing=PictureTiming(stale_after_s=0.0))
        h.ready_round()
        job = h.job()
        h.generator.hook = lambda: time.sleep(0.15)

        async def go(background: ContainedTaskGroup) -> None:
            background.spawn("paint", job.run, 1)
            await anyio.sleep(0.05)
            assert await job.sweep(background) == 0

        anyio.run(_group, go)
        assert len(h.generator.calls) == 1


class TestFoldIns:
    def test_l6_a_failing_claim_is_logged_and_never_raises(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, StubGenerator())
        h.ready_round()

        def boom(*a: Any, **k: Any) -> Any:
            raise RuntimeError("database is locked")

        h.store.claim_cookout_pictures = boom  # type: ignore[method-assign]
        anyio.run(h.job().run, 1)
        assert h.generator.calls == [] and h.demand.count == 0
        assert h.row()["images"] == "pending"  # left for the sweep


# -- Cookout twists (spec/server-chat/09a-cookout-twists.md §5.4): the chef's style on the picture
# prompt, and pictures across a rescue swap ------------------------------------------------------

GOLDEN_IMAGE_PROMPT_SHA256 = "a050935fe1cd76800e5bcfb2b7a4b5d07134ce52c01b51e7474811034fc29f80"
"""sha256 of the style-free picture prompt exactly as the shipped core builds it."""


class TestStylePrompts:
    def test_a_style_free_prompt_is_byte_identical_to_the_core(self) -> None:
        text = build_image_prompt("Smoky Steak Plate", ["Ribeye steak", "Butter"])
        assert hashlib.sha256(text.encode()).hexdigest() == GOLDEN_IMAGE_PROMPT_SHA256
        assert text == build_image_prompt(
            "Smoky Steak Plate", ["Ribeye steak", "Butter"], style=None
        )

    @pytest.mark.parametrize("style_id", STYLE_IDS)
    def test_each_style_replaces_only_the_presentation_phrase(self, style_id: str) -> None:
        style = style_by_id(style_id)
        assert style is not None
        plain = build_image_prompt("Smoky Steak Plate", ["Ribeye steak", "Butter"])
        styled = build_image_prompt("Smoky Steak Plate", ["Ribeye steak", "Butter"], style=style_id)
        phrase = style.picture_phrase[:1].upper() + style.picture_phrase[1:]
        assert phrase in styled
        assert DEFAULT_PRESENTATION not in styled
        assert styled == plain.replace(DEFAULT_PRESENTATION, phrase)
        for clause in (
            "no people, no hands, no raw-ingredient collage, no unlisted side dishes",
            "no text, labels, logos, or watermark.",
            'Photorealistic appetising food photograph of "Smoky Steak Plate"',
        ):
            assert clause in styled

    def test_an_unknown_style_id_falls_back_to_the_core_prompt(self) -> None:
        plain = build_image_prompt("Smoky Steak Plate", ["Ribeye steak"])
        assert build_image_prompt("Smoky Steak Plate", ["Ribeye steak"], style="nonsense") == plain

    def test_a_title_with_braces_is_not_reformatted(self) -> None:
        text = build_image_prompt("Brace {x} Plate", ["Ribeye {steak}"], style="picnic")
        assert 'photograph of "Brace {x} Plate"' in text and "Ribeye {steak}" in text

    def test_the_round_style_reaches_every_dish_prompt(self) -> None:
        row = {"concepts_json": canned_concepts_text(), "style": "campfire"}
        prompts = concept_prompts(row, _Namer())
        assert prompts is not None and set(prompts) == {"a", "b", "c"}
        style = style_by_id("campfire")
        assert style is not None
        for prompt in prompts.values():
            assert style.picture_phrase[1:] in prompt and DEFAULT_PRESENTATION not in prompt
        plain = concept_prompts({"concepts_json": canned_concepts_text()}, _Namer())
        assert plain is not None
        for slot, prompt in plain.items():
            assert DEFAULT_PRESENTATION in prompt
            assert prompt == prompts[slot].replace(
                style.picture_phrase[:1].upper() + style.picture_phrase[1:], DEFAULT_PRESENTATION
            )

    def test_a_lifted_wildcard_or_swapped_in_item_is_named_when_the_dish_uses_it(self) -> None:
        concepts = json.loads(canned_concepts_text())
        used = concepts["concepts"][0]["pickedIngredientIds"]
        used.append("mango")
        concepts["concepts"][0]["omitted"] = [
            o for o in concepts["concepts"][0]["omitted"] if o["id"] != "mango"
        ]
        prompts = concept_prompts({"concepts_json": json.dumps(concepts)}, _Namer())
        assert prompts is not None
        assert "Mango" in prompts["a"] and "Mango" not in prompts["b"]


class TestPicturesAcrossASwap:
    def test_the_job_paints_in_the_round_style(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, StubGenerator())
        h.ready_round(style="street-food")
        anyio.run(h.job().run, 1)
        style = style_by_id("street-food")
        assert style is not None
        assert all(style.picture_phrase[1:] in p for p in h.generator.calls[0])
        assert h.row()["images"] == "done"

    def test_a_swap_during_a_render_fences_the_old_generations_pictures(
        self, tmp_path: Path
    ) -> None:
        h = Harness(tmp_path, StubGenerator())
        row = h.ready_round()

        def swap_lands_mid_render() -> None:
            h.store.complete_swap(1)

        h.generator.hook = swap_lands_mid_render
        anyio.run(h.job().run, 1)
        assert h.store.stored_pictures == [], "generation 1's late pictures must not be attached"
        assert row["generation"] == 2 and row["images"] == "none" and not row["pictures"]
        assert h.scratch_entries() == [] and h.staged_upload_dirs() == []
        assert h.demand.count == 0
        # the late failure write named generation 1's attempt and was refused as well
        assert h.store.failed_pictures and row["images"] == "none"

    def test_generation_2_gets_a_fresh_wait_and_its_own_pictures(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, StubGenerator())
        row = h.ready_round()
        h.store.complete_swap(1)
        row["concepts"] = "ready"
        row["concepts_json"] = canned_concepts_text()
        row.update(images="pending", images_started_at=time.time(), images_tries=1)
        row["images_generation"] += 1
        anyio.run(h.job().run, 1)
        assert row["images"] == "done" and set(row["pictures"]) == {"a", "b", "c"}
        assert len(h.generator.calls) == 1 and len(h.generator.calls[0]) == 3


# -- game modes: Toasted sandwich pictures (spec/server-chat/09c-cookout-modes.md §3.6, §8.3) ---


@pytest.fixture(scope="module")
def real_bank() -> Any:
    from wixy_server.livechat.cookout_bank import load_cookout_bank

    return load_cookout_bank()


def _toastie() -> Any:
    mode = default_modes().mode("toastie")
    assert mode is not None
    return mode


class TestToastiePictures:
    BREAD = "sliced-white-bread"
    FILLINGS = ["mature-cheddar", "cooked-ham", "tomato"]

    def _concept(self, **extra: Any) -> dict[str, Any]:
        return {
            "id": "a",
            "title": "Golden Ham And Cheddar Toastie",
            "build": "skillet",
            "pickedIngredientIds": [self.BREAD, *self.FILLINGS],
            "stapleIds": ["butter", "milk"],
            **extra,
        }

    def test_the_prompt_has_the_bread_the_fillings_the_build_and_the_default_setting(self) -> None:
        mode = _toastie()
        build = next(b for b in mode.chef.builds if b.id == "skillet")
        text = build_image_prompt(
            "Golden Ham And Cheddar Toastie",
            ["Mature cheddar", "Cooked ham", "Tomato"],
            mode=mode,
            bread_name="Sliced white bread",
            build=build,
        )
        assert text.startswith(
            'Photorealistic appetising food photograph of "Golden Ham And Cheddar Toastie": '
            "one closed toasted sandwich made with Sliced white bread, pan-fried until deep "
            "golden and crunchy, cut in half with the two halves stacked slightly apart, the cut "
            "faces turned toward the camera so the hot, melted filling of Mature cheddar, Cooked "
            "ham, Tomato shows in the cross-section."
        )
        assert mode.picture.default_presentation is not None
        assert mode.picture.default_presentation in text
        assert "no open sandwich" in text and text.endswith("no text, labels, logos, or watermark.")

    def test_a_chefs_style_becomes_the_setting_and_the_subject_stays_a_toastie(self) -> None:
        mode = _toastie()
        style = style_by_id("campfire")
        assert style is not None
        text = build_image_prompt(
            "T", ["Tomato"], style="campfire", mode=mode, bread_name="Ciabatta roll", build=None
        )
        assert style.picture_phrase[1:] in text
        assert mode.picture.default_presentation not in text
        assert "one closed toasted sandwich made with Ciabatta roll" in text

    def test_the_round_prompts_name_fillings_only_never_staples_or_the_bread_twice(
        self, real_bank: Any
    ) -> None:
        from wixy_server.livechat.cookout_ai import BankNamer

        row = {
            "mode": "toastie",
            "bread_id": self.BREAD,
            "concepts_json": json.dumps(
                {
                    "concepts": [
                        self._concept(id="a"),
                        self._concept(id="b", build="pressed"),
                        self._concept(id="c", build="jaffle", title="Jaffle Special"),
                    ]
                }
            ),
        }
        prompts = concept_prompts(row, BankNamer(real_bank))
        assert prompts is not None and set(prompts) == {"a", "b", "c"}
        a = prompts["a"]
        assert "made with Sliced white bread, pan-fried" in a
        assert "filling of Mature Cheddar, Cooked ham, Tomato shows" in a
        assert "Butter" not in a and "Milk" not in a
        assert a.count("Sliced white bread") == 1
        assert "with the ridged marks of a sandwich press" in prompts["b"]
        assert "sealed at the edges in a rounded jaffle shape" in prompts["c"]

    def test_the_round_style_reaches_every_toastie_prompt(self, real_bank: Any) -> None:
        from wixy_server.livechat.cookout_ai import BankNamer

        concepts = [
            self._concept(id=i, build=b)
            for i, b in zip("abc", ("pressed", "skillet", "jaffle"), strict=True)
        ]
        row = {
            "mode": "toastie",
            "style": "campfire",
            "concepts_json": json.dumps({"concepts": concepts}),
        }
        prompts = concept_prompts(row, BankNamer(real_bank))
        assert prompts is not None
        style = style_by_id("campfire")
        assert style is not None
        assert all(style.picture_phrase[1:] in p for p in prompts.values())

    def test_the_bread_is_found_when_the_round_row_does_not_say_which(self, real_bank: Any) -> None:
        from wixy_server.livechat.cookout_ai import BankNamer

        concepts = [
            self._concept(id=i, build=b)
            for i, b in zip("abc", ("pressed", "skillet", "jaffle"), strict=True)
        ]
        row = {"mode": "toastie", "concepts_json": json.dumps({"concepts": concepts})}
        prompts = concept_prompts(row, BankNamer(real_bank))
        assert prompts is not None and "made with Sliced white bread" in prompts["a"]

    def test_an_unknown_mode_has_no_prompts(self, real_bank: Any) -> None:
        from wixy_server.livechat.cookout_ai import BankNamer

        row = {"mode": "pizza", "concepts_json": canned_concepts_text()}
        assert concept_prompts(row, BankNamer(real_bank)) is None

    def test_the_template_and_phrases_name_no_bank_food(self, real_bank: Any) -> None:
        mode = _toastie()
        free = {i for i in ("water", "salt", "black-pepper", "butter")}
        assert mode.picture.template is not None
        texts = [mode.picture.template, mode.picture.default_presentation or ""]
        texts += [b.picture_phrase for b in mode.chef.builds]
        for text in texts:
            found = real_bank.find_contraband_ingredients(
                text,
                allowed_ingredient_ids=set(),
                allowed_staple_ids=free,
            )
            assert found == [], (text, found)
