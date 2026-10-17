"""Would-you-rather game runtime (workspace 00045): the viewer-filtered round view and the
on-demand image job.

`wyr_view_json` is the ONLY place a round's private answers leave the store. The game rule
("nobody sees the other person's answer until both pressed Reveal") is enforced here, on the
server — a client cannot be trusted to hide what the server sent it. (The chat's trust model is
otherwise unchanged: anyone unlocked can read anything; this filter exists so the game stays fun,
and is documented as such in decisions/.)
"""

from __future__ import annotations

import enum
import logging
import os
import random
import shutil
import tempfile
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import anyio

from builder.jsontypes import JsonObject, JsonValue
from wixy_server.livechat.models import WyrRoundRow
from wixy_server.livechat.reactions import reactor_key
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.wyr_images import ComfyImageGenerator
from wixy_server.livechat.wyr_pool import POOL_FILES, PooledPictures, WyrPool
from wixy_server.livechat.wyr_questions import WyrQuestion, pick_question, style_suffix
from wixy_server.storage import ProjectPaths

_LOGGER = logging.getLogger(__name__)

Choice = Literal["a", "b"]


def _question_json(question: WyrQuestion | None) -> JsonObject:
    if question is None:
        # The bank is append-only so this should not happen; a retired id still renders.
        return {"id": "", "category": "", "a": "Option A", "b": "Option B"}
    return {"id": question.id, "category": question.category, "a": question.a, "b": question.b}


def _slot_of(round_: WyrRoundRow, viewer_key: str | None, viewer_email: str | None) -> int | None:
    """The viewer's player slot, or None. A name that is a slot but arrives under a different
    verified sign-in than the one that took the slot is someone ELSE asserting that name, so
    it is a stranger here (no `you`, none of that player's answers) — the filter keys on a name
    the caller types, and the sign-in is what makes it hold. An unknown email on either side
    (dev/no-auth, grant sessions) falls back to the name alone."""
    if viewer_key is None:
        return None
    slot = (
        1 if round_.player1_key == viewer_key else 2 if round_.player2_key == viewer_key else None
    )
    if slot is None:
        return None
    slot_email = round_.player1_email if slot == 1 else round_.player2_email
    if viewer_email is not None and slot_email is not None and viewer_email != slot_email:
        return None
    return slot


def _player_json(round_: WyrRoundRow, slot: int) -> JsonObject | None:
    name = round_.player1_name if slot == 1 else round_.player2_name
    if name is None:
        return None
    vote = round_.vote1 if slot == 1 else round_.vote2
    choice = round_.choice1 if slot == 1 else round_.choice2
    guess = round_.guess1 if slot == 1 else round_.guess2
    revealed = round_.reveal1 if slot == 1 else round_.reveal2
    return {
        "name": name,
        "vote": vote,
        "answered": choice is not None and guess is not None,
        "revealed": revealed,
    }


def wyr_view_json(
    round_: WyrRoundRow,
    question: WyrQuestion | None,
    viewer: str | None,
    viewer_email: str | None = None,
    *,
    now: float | None = None,
) -> JsonObject:
    """The per-viewer view of a round (`GET /wyr/{seq}?as=<sender>`).

    Public always: the question, state, rev, who the players are and what each has DONE
    (voted / answered / started the Reveal countdown) — never WHAT they answered. The viewer's
    own pick and guess are echoed back (so a refetch restores their toggles). The other player's
    pick and guess appear only once `state == "revealed"` (both pressed Reveal). `images` is
    the picture job's state (`none`/`pending`/`done`/`failed`): a card waits for pictures only while
    `pending`."""
    viewer_key = reactor_key(viewer) if viewer is not None else None
    slot = _slot_of(round_, viewer_key, viewer_email)
    revealed = round_.state == "revealed"
    now_s = time.time() if now is None else now
    reveal_pending = revealed or (
        round_.state == "revealing"
        and round_.reveal_deadline is not None
        and now_s < round_.reveal_deadline
    )

    players: list[JsonValue] = []
    for s in (1, 2):
        player = _player_json(round_, s)
        if player is not None and not reveal_pending:
            player["revealed"] = False
        if player is not None:
            players.append(player)

    you: JsonObject | None = None
    if slot is not None:
        you = {
            "slot": slot,
            "vote": round_.vote1 if slot == 1 else round_.vote2,
            "choice": round_.choice1 if slot == 1 else round_.choice2,
            "guess": round_.guess1 if slot == 1 else round_.guess2,
            "revealed": (round_.reveal1 if slot == 1 else round_.reveal2) and reveal_pending,
        }

    result: JsonObject | None = None
    if revealed:
        result = {
            "players": [
                {
                    "name": round_.player1_name,
                    "choice": round_.choice1,
                    "guess": round_.guess1,
                },
                {
                    "name": round_.player2_name,
                    "choice": round_.choice2,
                    "guess": round_.guess2,
                },
            ],
            # Did each player guess the other's pick? The two headline callouts.
            "guessed": [
                round_.guess1 == round_.choice2,
                round_.guess2 == round_.choice1,
            ],
            "agree": round_.choice1 == round_.choice2,
        }

    return {
        "seq": round_.anchor_message_seq,
        "state": round_.state,
        "rev": round_.rev,
        "revealDeadline": round_.reveal_deadline if reveal_pending and not revealed else None,
        "question": _question_json(question),
        "images": round_.images,
        "players": players,
        "you": you,
        "result": result,
    }


def wyr_scratch_dir(paths: ProjectPaths) -> Path:
    """Where a generation run downloads its PNGs before they are staged as attachments.
    Chat content (Inv 54), so a run that dies with its process must not leave it behind:
    app startup clears what is old enough that no live run can own it."""
    return paths.server_dir / "wyr-tmp"


# A run's whole budget is `wyr_images`'s 300 s generation wait plus downloads; anything older
# than this belongs to a process that died. Younger dirs may belong to the OLDER process of a
# blue/green overlap, still working, and must be left alone.
_SCRATCH_STALE_AFTER_S = 900.0


def clear_wyr_scratch(paths: ProjectPaths, *, now: float | None = None) -> None:
    root = wyr_scratch_dir(paths)
    if not root.is_dir():
        return
    cutoff = (time.time() if now is None else now) - _SCRATCH_STALE_AFTER_S
    for entry in root.iterdir():
        try:
            if entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            _LOGGER.warning("wyr: could not inspect scratch entry %s", entry)


async def run_wyr_sweep_forever(
    generator: ComfyImageGenerator, *, interval_s: float = 600.0
) -> None:
    """Contained loop: sweep ComfyUI's stale `wyr_*` files and history entries at startup and
    every `interval_s` (the backstop for runs orphaned by a killed process — see
    `ComfyImageGenerator.sweep_leftovers`)."""
    while True:
        started_at = time.monotonic()
        await anyio.to_thread.run_sync(generator.sweep_leftovers)
        await anyio.sleep(max(0.0, interval_s - (time.monotonic() - started_at)))


def choose_question(
    store: LiveChatStore, questions: tuple[WyrQuestion, ...], rng: random.Random | None = None
) -> WyrQuestion | None:
    """A random bank question this chat has not played yet; `None` only for an empty bank.
    Once the whole bank has been played the pool resets to the full bank (the repeat guard
    simply starts over: the played set is derived from the rounds that still exist, so
    there is nothing to clear and no separate record of what was played)."""
    return pick_question(questions, store.wyr_used_ids(), rng or random.Random())


def generate_round_images(
    *,
    store: LiveChatStore,
    paths: ProjectPaths,
    generator: ComfyImageGenerator,
    question: WyrQuestion,
    anchor_seq: int,
    by_email: str | None,
    publish: Callable[[], None],
) -> bool:
    """Paint both options of a freshly created round and attach them to its anchor message.

    Blocking (GPU polling) — callers run it in a worker thread, one at a time. The round is
    re-checked immediately before any GPU work and again before anything is attached, so a
    round that was skipped, superseded or deleted meanwhile costs no (or no more) GPU time
    and leaves nothing behind. EVERY exit ends the round's `pending` state (`images` becomes
    `done` or `failed`), so a card never waits for pictures that are not coming. Returns True
    when both pictures were attached. Pictures become ordinary `photo` attachments (ordinal 0
    = option A, 1 = B) attached in ONE transaction, so signed URLs, renditions, quota and
    delete/wipe erasure are inherited from the normal attachment pipeline."""
    staged: list[Path] = []
    work_dir: Path | None = None
    try:
        if not store.wyr_round_is_paintable(anchor_seq=anchor_seq):
            return False
        if not generator.available():
            _LOGGER.warning(
                "wyr: image generator unreachable; round %d stays text-only", anchor_seq
            )
            return False

        rng = random.SystemRandom()
        suffix = style_suffix(question.category)
        scratch_root = wyr_scratch_dir(paths)
        scratch_root.mkdir(parents=True, exist_ok=True)
        work_dir = Path(tempfile.mkdtemp(prefix="wyr-img-", dir=scratch_root))
        png_a, png_b = generator.generate_pair(
            question.image_a + suffix,
            question.image_b + suffix,
            work_dir,
            seed_a=rng.randrange(2**32),
            seed_b=rng.randrange(2**32),
        )
        if not store.wyr_round_is_paintable(anchor_seq=anchor_seq):
            return False

        images: list[tuple[str, int]] = []
        for png in (png_a, png_b):
            att_id = uuid.uuid4().hex
            upload_dir = paths.server_upload_dir(att_id)
            upload_dir.mkdir(parents=True, exist_ok=True)
            staged.append(upload_dir)
            tmp = upload_dir / "assembled.part"
            shutil.copyfile(png, tmp)
            os.replace(tmp, upload_dir / "assembled")
            images.append((att_id, (upload_dir / "assembled").stat().st_size))
        attached = store.create_wyr_image_attachments(
            anchor_seq=anchor_seq, images=images, by_email=by_email, now=time.time()
        )
        if attached:
            staged = []  # the attachments own these directories now
        return attached
    except Exception:
        _LOGGER.exception("wyr: image job failed for round %d", anchor_seq)
        return False
    finally:
        # Staged-but-unattached upload dirs (a failure or a vanished round) and the work dir
        # never outlive the job; the round stops waiting; every open stream hears about it.
        for upload_dir in staged:
            shutil.rmtree(upload_dir, ignore_errors=True)
        if work_dir is not None:
            shutil.rmtree(work_dir, ignore_errors=True)
        try:
            store.fail_wyr_images(anchor_seq=anchor_seq, now=time.time())
        except Exception:
            _LOGGER.exception("wyr: could not end the picture wait for round %d", anchor_seq)
        try:
            publish()
        except Exception:
            _LOGGER.debug("wyr: publish after image job failed", exc_info=True)


# -- the picture pool: pictures painted AHEAD of time (workspace 00045 follow-on) ---------------


class WyrDemand:
    """How many on-demand picture jobs are queued or running. The pool filler yields to them (a
    waiting round beats a speculative picture). Only touched from the event loop thread."""

    def __init__(self) -> None:
        self.count = 0


def wyr_image_limiter(state: Any) -> anyio.CapacityLimiter:
    """The ONE single-flight gate for every picture job (on-demand rounds and the pool filler),
    created on first use inside the event loop (an anyio limiter needs a running loop)."""
    limiter: anyio.CapacityLimiter | None = getattr(state, "livechat_wyr_image_limiter", None)
    if limiter is None:
        limiter = anyio.CapacityLimiter(1)
        state.livechat_wyr_image_limiter = limiter
    return limiter


def pick_round(
    store: LiveChatStore,
    questions: tuple[WyrQuestion, ...],
    pool: WyrPool | None,
    rng: random.Random,
) -> tuple[WyrQuestion | None, PooledPictures | None]:
    """Choose the question for a new round, preferring one whose pictures are already pooled
    (reserved for the caller). Falls back to a random unplayed question, whose pictures the
    on-demand job paints. Once the whole bank has been played the repeat guard starts over."""
    used = store.wyr_used_ids()
    if pool is not None and questions:
        by_id = {q.id: q for q in questions}
        unplayed = {i for i in by_id if i not in used} or set(by_id)
        pooled = pool.take(unplayed, rng)
        if pooled is not None:
            question = by_id.get(pooled.question_id)
            if question is not None:
                return question, pooled
            pool.discard(pooled)  # a retired question's pair
    return pick_question(questions, used, rng), None


def pool_played_ids(store: LiveChatStore, questions: tuple[WyrQuestion, ...]) -> set[str]:
    """The question ids the pool must not hold: the played ones — unless the whole bank has been
    played, when the repeat guard restarts and every question is fair game again."""
    used = store.wyr_used_ids()
    return set() if all(q.id in used for q in questions) else used


def attach_pooled_images(
    *,
    store: LiveChatStore,
    paths: ProjectPaths,
    pooled: PooledPictures,
    anchor_seq: int,
    by_email: str | None,
) -> bool:
    """Attach a reserved pooled pair to a freshly created round: the PNGs are MOVED into
    `uploads/<id>/assembled` and attached in ONE transaction (the on-demand job's own path), so
    the round has both pictures the instant it exists. False on any failure — staged files and
    the reserved pair are removed either way and the caller falls back to the on-demand job."""
    staged: list[Path] = []
    try:
        images: list[tuple[str, int]] = []
        for source in (pooled.a, pooled.b):
            att_id = uuid.uuid4().hex
            upload_dir = paths.server_upload_dir(att_id)
            upload_dir.mkdir(parents=True, exist_ok=True)
            staged.append(upload_dir)
            shutil.move(str(source), str(upload_dir / "assembled"))
            images.append((att_id, (upload_dir / "assembled").stat().st_size))
        attached = store.create_wyr_image_attachments(
            anchor_seq=anchor_seq, images=images, by_email=by_email, now=time.time()
        )
        if attached:
            staged = []  # the attachments own these directories now
        return attached
    except Exception:
        _LOGGER.exception("wyr: could not attach pooled pictures to round %d", anchor_seq)
        return False
    finally:
        for upload_dir in staged:
            shutil.rmtree(upload_dir, ignore_errors=True)
        WyrPool.discard(pooled)


class PoolOutcome(enum.Enum):
    GENERATED = "generated"
    FULL = "full"
    NO_CANDIDATES = "no_candidates"
    YIELDED = "yielded"
    NO_DISK = "no_disk"
    UNAVAILABLE = "unavailable"
    FAILED = "failed"


# Never fill the disk with speculative pictures: stop this far above the chat's own free-space
# floor (`server_min_free_bytes`), which uploads must still be able to use.
_POOL_DISK_HEADROOM_BYTES = 1024 * 1024 * 1024


def pool_step(
    *,
    store: LiveChatStore,
    paths: ProjectPaths,
    generator: ComfyImageGenerator,
    pool: WyrPool,
    questions: tuple[WyrQuestion, ...],
    target: int,
    demand: WyrDemand,
    min_free_bytes: int,
    rng: random.Random | None = None,
    free_bytes: Callable[[], int] | None = None,
) -> PoolOutcome:
    """One blocking filler iteration (callers run it in a worker thread under the picture
    gate): paint ONE pair for a random unplayed, not-yet-pooled question if the pool is below
    target, nothing is waiting for a round's pictures, the disk has room and the generator is
    up. Every outcome is reported, never raised — the loop decides how long to wait."""
    pooled_ids = pool.ids()
    if len(pooled_ids) >= target:
        return PoolOutcome.FULL
    if demand.count > 0:
        return PoolOutcome.YIELDED
    free = free_bytes() if free_bytes is not None else shutil.disk_usage(paths.server_dir).free
    if free < min_free_bytes + _POOL_DISK_HEADROOM_BYTES:
        return PoolOutcome.NO_DISK
    if not generator.available():
        return PoolOutcome.UNAVAILABLE
    used = pool_played_ids(store, questions)
    candidates = [q for q in questions if q.id not in used and q.id not in pooled_ids]
    if not candidates:
        return PoolOutcome.NO_CANDIDATES
    chooser = rng or random.SystemRandom()
    question = chooser.choice(candidates)
    suffix = style_suffix(question.category)
    tmp: Path | None = None
    try:
        tmp = pool.begin(question.id)
        png_a, png_b = generator.generate_pair(
            question.image_a + suffix,
            question.image_b + suffix,
            tmp,
            seed_a=chooser.randrange(2**32),
            seed_b=chooser.randrange(2**32),
        )
        for produced, name in ((png_a, POOL_FILES[0]), (png_b, POOL_FILES[1])):
            if produced != tmp / name:
                produced.replace(tmp / name)
        if question.id in pool_played_ids(store, questions):
            # An on-demand round used this question while it was painting: do not pool a played one.
            WyrPool.abort(tmp)
            return PoolOutcome.GENERATED
        committed = pool.commit(question.id, tmp)
        tmp = None
        return PoolOutcome.GENERATED if committed else PoolOutcome.FAILED
    except Exception:
        _LOGGER.exception("wyr pool: could not paint pictures for %s", question.id)
        return PoolOutcome.FAILED
    finally:
        if tmp is not None:
            WyrPool.abort(tmp)


@dataclass(slots=True)
class PoolPacing:
    """How long the filler waits after each outcome: briefly after a success (the GPU is otherwise
    idle), a minute when there is nothing to do, five when the world is not ready (no disk,
    generator down/misconfigured), and an exponential back-off after failures."""

    failures: int = 0

    def delay_for(self, outcome: PoolOutcome) -> float:
        if outcome is PoolOutcome.FAILED:
            self.failures += 1
            return float(min(300, 30 * 2 ** (self.failures - 1)))
        self.failures = 0
        if outcome is PoolOutcome.GENERATED:
            return 2.0
        if outcome is PoolOutcome.YIELDED:
            return 5.0
        if outcome in (PoolOutcome.NO_DISK, PoolOutcome.UNAVAILABLE):
            return 300.0
        return 60.0  # FULL / NO_CANDIDATES


async def run_wyr_pool_forever(
    *,
    store: LiveChatStore,
    paths: ProjectPaths,
    generator: ComfyImageGenerator,
    pool: WyrPool,
    questions: tuple[WyrQuestion, ...],
    target: int,
    demand: WyrDemand,
    limiter: Callable[[], anyio.CapacityLimiter],
    min_free_bytes: int,
    sleep: Callable[[float], Awaitable[None]] = anyio.sleep,
    cleanup_interval_s: float = 600.0,
    clock: Callable[[], float] = time.monotonic,
) -> None:
    """Contained loop (`livechat-wyr-pool`): keep `target` pictures-pairs ready. Startup first
    removes stale scratch and pairs for questions that have been played, and the same sweep runs
    again every `cleanup_interval_s` (a pair for a question played mid-session, or a reservation
    stranded by a failed take, never outlives that). Each iteration runs one `pool_step` in a
    worker thread under the SAME single-flight gate as on-demand rounds."""
    await anyio.to_thread.run_sync(lambda: pool.cleanup(pool_played_ids(store, questions)))
    last_cleanup = clock()
    pacing = PoolPacing()
    while True:
        if clock() - last_cleanup >= cleanup_interval_s:
            await anyio.to_thread.run_sync(lambda: pool.cleanup(pool_played_ids(store, questions)))
            last_cleanup = clock()
        outcome = await anyio.to_thread.run_sync(
            lambda: pool_step(
                store=store,
                paths=paths,
                generator=generator,
                pool=pool,
                questions=questions,
                target=target,
                demand=demand,
                min_free_bytes=min_free_bytes,
            ),
            limiter=limiter(),
        )
        await sleep(pacing.delay_for(outcome))
