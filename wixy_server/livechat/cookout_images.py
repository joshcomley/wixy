"""Cookout dish pictures: the three finished-dish photographs painted on hub's local ComfyUI
(workspace 00058, spec/server-chat/09-cookout.md §3.3).

Text first, pictures second: the concepts are already stored and published (`concepts = ready`)
when this job runs. `CookoutPictureJob.run` claims the round's picture wait (`images_generation`
fencing: every claim bumps the counter, and every store or failure write names the generation it
claimed, so an older attempt that finishes late can neither overwrite nor end a newer one), renders
the still-missing slots `a|b|c` in ONE ComfyUI submission (`ComfyImageGenerator.generate_many`)
under the shared single-flight GPU limiter, and attaches each finished PNG to the anchor message as
an ordinary private `photo` attachment in one store transaction. Partial success is kept: a slot
that came out stays attached and only the missing ones are retried.

Chat content (Inv 57): the PNGs are downloaded into an attempt-scoped random directory under
`server/cookout-tmp/`; `try/finally` removes it, and every staged upload the store did not take
over, on EVERY exit (success, partial or total failure, a lost claim, a vanished round,
cancellation). `clear_cookout_scratch` is the backstop for a killed process: at startup and on the
60 s sweep it removes anything older than 900 s, so young work of the older side of a blue/green
overlap is left alone. ComfyUI's own `wyr_` output files and history entries are swept by the
existing WYR sweep (the generator keeps `FILE_PREFIX = "wyr_"`, Inv 54).

What reaches ComfyUI: a dish title and ingredient names built from the static bank — never a
person, a message or anything else from the chat.
"""

from __future__ import annotations

import json
import logging
import os
import random
import secrets
import shutil
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Protocol

import anyio
import anyio.to_thread
from anyio import CapacityLimiter

from wixy_server.background import ContainedTaskGroup
from wixy_server.livechat.cookout_twists import style_by_id
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.wyr_game import WyrDemand
from wixy_server.livechat.wyr_images import ComfyImageGenerator
from wixy_server.storage import ProjectPaths

_LOGGER = logging.getLogger(__name__)

SCRATCH_DIRNAME: Final = "cookout-tmp"
SCRATCH_MAX_AGE_S: Final = 900.0
SLOTS: Final = ("a", "b", "c")
MAX_PICTURE_TRIES: Final = 3
PICTURE_BUDGET_S: Final = 600.0
"""The `images_deadline_at` window the store gives a picture wait (and so how long one attempt may
run before the sweep counts it abandoned)."""
STALE_MARGIN_S: Final = 60.0

DEFAULT_PRESENTATION: Final = (
    "Rustic home-cooked presentation, natural kitchen light, simple ceramic plate"
)
"""The presentation phrase of a round with no chef's style; a style replaces it (spec 09a §5.4)."""
IMAGE_PROMPT_TEMPLATE: Final = (
    'Photorealistic appetising food photograph of "{title}", one finished cooked serving made '
    "with {ingredients}. Rustic home-cooked presentation, natural kitchen light, simple ceramic "
    "plate, shallow depth of field, no people, no hands, no raw-ingredient collage, no unlisted "
    "side dishes, no text, labels, logos, or watermark."
)
_STYLED_TEMPLATE: Final = IMAGE_PROMPT_TEMPLATE.replace(DEFAULT_PRESENTATION, "{presentation}")
assert _STYLED_TEMPLATE != IMAGE_PROMPT_TEMPLATE


def scratch_dir(paths: ProjectPaths) -> Path:
    """`<storage>/projects/<slug>/server/cookout-tmp/` — where a picture attempt downloads its
    PNGs (each attempt in its own random sub-directory)."""
    return paths.server_dir / SCRATCH_DIRNAME


def clear_cookout_scratch(
    paths: ProjectPaths, *, max_age_s: float = SCRATCH_MAX_AGE_S, now: float | None = None
) -> int:
    """Remove every file or sub-directory of `server/cookout-tmp/` last touched more than
    `max_age_s` ago (blocking; call from a thread). Younger work may belong to the older process
    of a blue/green overlap, still running, and is preserved. Returns how many entries went."""
    root = scratch_dir(paths)
    if not root.is_dir():
        return 0
    cutoff = (time.time() if now is None else now) - max_age_s
    removed = 0
    for entry in root.iterdir():
        try:
            if entry.stat().st_mtime > cutoff:
                continue
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                entry.unlink()
            removed += 1
        except OSError:
            _LOGGER.warning("cookout: could not clear scratch entry %s", entry)
    return removed


def build_image_prompt(
    title: str, ingredient_names: Sequence[str], *, style: str | None = None
) -> str:
    """The deterministic, server-built dish prompt (spec §3.3): the concept title plus the
    resolved names of its picked ingredients and declared staples. A known chef's `style` swaps
    the core presentation phrase for that style's fixed picture phrase (spec 09a §5.4); every
    "no people / no text" clause is unchanged."""
    names = ", ".join(ingredient_names)
    chosen = style_by_id(style) if style is not None else None
    if chosen is None:
        return IMAGE_PROMPT_TEMPLATE.format(title=title, ingredients=names)
    phrase = chosen.picture_phrase
    return _STYLED_TEMPLATE.format(
        title=title, ingredients=names, presentation=phrase[:1].upper() + phrase[1:]
    )


class PictureStore(Protocol):
    """The slice of `LiveChatStore` the picture job calls (spec Appendix A.2)."""

    def get_cookout_round(self, anchor_seq: int) -> dict[str, Any] | None: ...

    def claim_cookout_pictures(
        self, anchor_seq: int, *, stale_before: float | None, now: float
    ) -> tuple[str, int]: ...

    def store_cookout_pictures(
        self,
        anchor_seq: int,
        expected_generation: int,
        slot_uploads: Mapping[str, tuple[str, int]],
        by_email: str | None,
        *,
        all_done: bool,
        now: float,
    ) -> bool: ...

    def fail_cookout_pictures(
        self, anchor_seq: int, *, expected_generation: int, now: float
    ) -> bool: ...

    def cookout_stale_pictures(self, *, stale_before: float) -> list[int]: ...


class DishNamer(Protocol):
    """How the job turns a concept's stored ids into the names the prompt carries (the bank)."""

    def ingredient_name(self, ingredient_id: str) -> str | None: ...

    def staple_name(self, staple_id: str) -> str | None: ...


@dataclass(frozen=True, slots=True)
class PictureTiming:
    """Pacing of the self-healing sweep; the defaults are production's, tests shorten them."""

    stale_after_s: float = PICTURE_BUDGET_S + STALE_MARGIN_S
    scratch_max_age_s: float = SCRATCH_MAX_AGE_S


def concept_prompts(round_row: Mapping[str, Any], namer: DishNamer) -> dict[str, str] | None:
    """`{slot: image prompt}` for the round's three stored concepts, or `None` when the concepts
    are not a readable list of the three slots."""
    raw = round_row.get("concepts_json")
    if not isinstance(raw, str):
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    concepts = data.get("concepts") if isinstance(data, dict) else None
    if not isinstance(concepts, list):
        return None
    style = round_row.get("style")
    prompts: dict[str, str] = {}
    for concept in concepts:
        if not isinstance(concept, dict):
            continue
        slot = concept.get("id")
        title = concept.get("title")
        if slot not in SLOTS or not isinstance(title, str):
            continue
        names: list[str] = []
        for key, lookup in (
            ("pickedIngredientIds", namer.ingredient_name),
            ("stapleIds", namer.staple_name),
        ):
            ids = concept.get(key)
            if not isinstance(ids, list):
                continue
            for item in ids:
                name = lookup(item) if isinstance(item, str) else None
                if name is not None and name not in names:
                    names.append(name)
        prompts[str(slot)] = build_image_prompt(
            title, names, style=style if isinstance(style, str) else None
        )
    return prompts if set(prompts) == set(SLOTS) else None


def _decoded_pictures(round_row: Mapping[str, Any]) -> dict[str, str]:
    raw = round_row.get("pictures")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = None
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items() if k in SLOTS and v}


def pictures_wanted(round_row: Mapping[str, Any] | None, generation: int) -> bool:
    """Whether `generation` is still the round's live picture attempt."""
    return (
        round_row is not None
        and round_row.get("state") == "finished"
        and round_row.get("concepts") == "ready"
        and round_row.get("images") == "pending"
        and round_row.get("images_generation") == generation
    )


class CookoutPictureJob:
    """Paints and attaches a round's missing dish pictures. One instance per app; it keeps no
    per-round state beyond the set of rounds it is working on right now — the round row and the
    generation fence are the truth, so a restart or an overlapping process cannot double or lose a
    result."""

    def __init__(
        self,
        *,
        store: PictureStore,
        paths: ProjectPaths,
        namer: DishNamer,
        generator: ComfyImageGenerator,
        notifier: LiveChatNotifier,
        limiter: Callable[[], CapacityLimiter],
        demand: WyrDemand,
        space_ok: Callable[[int], bool] | None = None,
        timing: PictureTiming | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._store = store
        self._paths = paths
        self._namer = namer
        self._generator = generator
        self._notifier = notifier
        self._limiter = limiter
        self._demand = demand
        self._space_ok = space_ok
        self._timing = timing if timing is not None else PictureTiming()
        self._clock = clock
        self._running: set[int] = set()

    # -- recovery ----------------------------------------------------------------------------

    async def resume(self, background: ContainedTaskGroup) -> int:
        """Startup recovery: clear stale scratch, then redo every picture wait the previous
        process left `pending` (each redo is a fresh claim). Returns how many were started."""
        await anyio.to_thread.run_sync(
            lambda: clear_cookout_scratch(
                self._paths, max_age_s=self._timing.scratch_max_age_s, now=self._clock()
            )
        )
        return await self._redo(background, stale_before=float("inf"))

    async def sweep(self, background: ContainedTaskGroup) -> int:
        """One pass of the self-healing check (the supervised 60 s sweep): clear stale scratch and
        re-run every wait pending longer than a picture attempt can take. A round this process
        is already painting is left alone. Returns how many attempts were started."""
        await anyio.to_thread.run_sync(
            lambda: clear_cookout_scratch(
                self._paths, max_age_s=self._timing.scratch_max_age_s, now=self._clock()
            )
        )
        return await self._redo(background, stale_before=self._clock() - self._timing.stale_after_s)

    async def _redo(self, background: ContainedTaskGroup, *, stale_before: float) -> int:
        stale = await anyio.to_thread.run_sync(
            lambda: self._store.cookout_stale_pictures(stale_before=stale_before)
        )
        started = 0
        for anchor_seq in stale:
            if anchor_seq in self._running:
                continue
            background.spawn("livechat-cookout-pictures", self.run, anchor_seq, stale_before)
            started += 1
        return started

    # -- the attempt -------------------------------------------------------------------------

    async def run(self, anchor_seq: int, stale_before: float | None = None) -> None:
        """Claim the round's picture wait and paint what is missing. Never raises for an ordinary
        failure (the round ends `images = failed` and keeps whatever was already attached); only
        cancellation (shutdown) propagates, leaving the round `pending` for the sweep. A
        `stale_before` makes the claim conditional (the sweep): a wait that is not that old is
        left alone."""
        if anchor_seq in self._running:
            return
        self._running.add(anchor_seq)
        try:
            await self._attempt(anchor_seq, stale_before)
        finally:
            self._running.discard(anchor_seq)

    async def _attempt(self, anchor_seq: int, stale_before: float | None) -> None:
        if stale_before is not None and stale_before == float("inf"):
            stale_before = None
        now = self._clock()
        try:
            status, generation = await anyio.to_thread.run_sync(
                lambda: self._store.claim_cookout_pictures(
                    anchor_seq, stale_before=stale_before, now=now
                )
            )
        except Exception:
            _LOGGER.exception("could not claim round %s's picture wait", anchor_seq)
            return
        if status == "gave_up":
            _LOGGER.warning("cookout pictures: round %s keeps dying; giving up", anchor_seq)
            self._notifier.publish()
            return
        if status != "claimed":
            return
        stored = False
        try:
            stored = await self._paint(anchor_seq, generation)
        except Exception:
            _LOGGER.exception("cookout picture job for round %s failed", anchor_seq)
        if stored:
            self._notifier.publish()
            return
        try:
            changed = await anyio.to_thread.run_sync(
                lambda: self._store.fail_cookout_pictures(
                    anchor_seq, expected_generation=generation, now=self._clock()
                )
            )
        except Exception:
            _LOGGER.exception("could not end the picture wait for round %s", anchor_seq)
            return
        if changed:
            self._notifier.publish()

    async def _row(self, anchor_seq: int) -> dict[str, Any] | None:
        return await anyio.to_thread.run_sync(lambda: self._store.get_cookout_round(anchor_seq))

    async def _paint(self, anchor_seq: int, generation: int) -> bool:
        """Render the missing slots and store them. True only when the store took the pictures
        (a partial set counts: the store itself then ends the wait as `failed`)."""
        row = await self._row(anchor_seq)
        if not pictures_wanted(row, generation):
            return False
        assert row is not None
        prompts = concept_prompts(row, self._namer)
        if prompts is None:
            return False
        have = _decoded_pictures(row)
        missing = [slot for slot in SLOTS if slot not in have]
        if not missing:
            return False
        if not await anyio.to_thread.run_sync(self._generator.available):
            _LOGGER.warning("cookout: image generator unreachable for round %s", anchor_seq)
            return False

        work_dir = scratch_dir(self._paths) / secrets.token_hex(8)
        staged: list[Path] = []
        # `demand` is only touched from the event loop thread: a waiting round beats the WYR pool
        # filler, which yields while it is non-zero.
        self._demand.count += 1
        try:
            rng = random.SystemRandom()
            seeds = [rng.randrange(2**32) for _ in missing]
            slot_prompts = [prompts[slot] for slot in missing]

            def _render() -> list[Path | None]:
                work_dir.mkdir(parents=True, exist_ok=True)
                return self._generator.generate_many(slot_prompts, work_dir, seeds=seeds)

            pngs = await anyio.to_thread.run_sync(_render, limiter=self._limiter())
            if not pictures_wanted(await self._row(anchor_seq), generation):
                return False
            made = {slot: png for slot, png in zip(missing, pngs, strict=True) if png is not None}
            if not made:
                return False

            def _stage() -> dict[str, tuple[str, int]]:
                uploads: dict[str, tuple[str, int]] = {}
                total = sum(png.stat().st_size for png in made.values())
                if self._space_ok is not None and not self._space_ok(total):
                    _LOGGER.warning("cookout: no room for round %s's pictures", anchor_seq)
                    return uploads
                for slot, png in made.items():
                    upload_id = uuid.uuid4().hex
                    upload_dir = self._paths.server_upload_dir(upload_id)
                    upload_dir.mkdir(parents=True, exist_ok=True)
                    staged.append(upload_dir)
                    part = upload_dir / "assembled.part"
                    shutil.copyfile(png, part)
                    os.replace(part, upload_dir / "assembled")
                    uploads[slot] = (upload_id, (upload_dir / "assembled").stat().st_size)
                return uploads

            slot_uploads = await anyio.to_thread.run_sync(_stage)
            if not slot_uploads:
                return False
            all_done = set(slot_uploads) | set(have) == set(SLOTS)
            took = await anyio.to_thread.run_sync(
                lambda: self._store.store_cookout_pictures(
                    anchor_seq,
                    generation,
                    slot_uploads,
                    None,
                    all_done=all_done,
                    now=self._clock(),
                )
            )
            if took:
                staged.clear()  # the attachments own these directories now
            return took
        finally:
            self._demand.count -= 1
            # Synchronous on purpose: a cancelled task must still clean up before it unwinds.
            _cleanup(work_dir, staged)


def _cleanup(work_dir: Path, staged: Sequence[Path]) -> None:
    for upload_dir in staged:
        shutil.rmtree(upload_dir, ignore_errors=True)
    shutil.rmtree(work_dir, ignore_errors=True)
