"""Would-you-rather game runtime (workspace 00045): the viewer-filtered round view and the
on-demand image job.

`wyr_view_json` is the ONLY place a round's private answers leave the store. The game rule
("nobody sees the other person's answer until both pressed Reveal") is enforced here, on the
server — a client cannot be trusted to hide what the server sent it. (The chat's trust model is
otherwise unchanged: anyone unlocked can read anything; this filter exists so the game stays fun,
and is documented as such in decisions/.)
"""

from __future__ import annotations

import logging
import os
import random
import shutil
import tempfile
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from builder.jsontypes import JsonObject, JsonValue
from wixy_server.livechat.models import WyrRoundRow
from wixy_server.livechat.reactions import reactor_key
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.wyr_images import ComfyImageGenerator, ImageGenerationError
from wixy_server.livechat.wyr_questions import WyrQuestion, pick_question, style_suffix
from wixy_server.storage import ProjectPaths

_LOGGER = logging.getLogger(__name__)

Choice = Literal["a", "b"]


def _question_json(question: WyrQuestion | None) -> JsonObject:
    if question is None:
        # The bank is append-only so this should not happen; a retired id still renders.
        return {"id": "", "category": "", "a": "Option A", "b": "Option B"}
    return {"id": question.id, "category": question.category, "a": question.a, "b": question.b}


def _slot_of(round_: WyrRoundRow, viewer_key: str | None) -> int | None:
    if viewer_key is None:
        return None
    if round_.player1_key == viewer_key:
        return 1
    if round_.player2_key == viewer_key:
        return 2
    return None


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
    *,
    images: bool = False,
) -> JsonObject:
    """The per-viewer view of a round (`GET /wyr/{seq}?as=<sender>`).

    Public always: the question, state, rev, who the players are and what each has DONE
    (voted / answered / pressed Reveal) — never WHAT they answered. The viewer's own pick and
    guess are echoed back (so a refetch restores their toggles). The other player's pick and
    guess appear only once `state == "revealed"` (both pressed Reveal). `images` says whether
    this server paints pictures for rounds at all (a generator is configured), so a card knows
    whether to wait for pictures or lay out as text only."""
    viewer_key = reactor_key(viewer) if viewer is not None else None
    slot = _slot_of(round_, viewer_key)
    revealed = round_.state == "revealed"

    players: list[JsonValue] = []
    for s in (1, 2):
        player = _player_json(round_, s)
        if player is not None:
            players.append(player)

    you: JsonObject | None = None
    if slot is not None:
        you = {
            "slot": slot,
            "vote": round_.vote1 if slot == 1 else round_.vote2,
            "choice": round_.choice1 if slot == 1 else round_.choice2,
            "guess": round_.guess1 if slot == 1 else round_.guess2,
            "revealed": round_.reveal1 if slot == 1 else round_.reveal2,
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
        "question": _question_json(question),
        "images": images,
        "players": players,
        "you": you,
        "result": result,
    }


def wyr_scratch_dir(paths: ProjectPaths) -> Path:
    """Where a generation run downloads its PNGs before they are staged as attachments.
    Chat content (Inv 54), so a process that dies mid-run must not leave it behind: app
    startup clears this directory."""
    return paths.server_dir / "wyr-tmp"


def clear_wyr_scratch(paths: ProjectPaths) -> None:
    shutil.rmtree(wyr_scratch_dir(paths), ignore_errors=True)


def choose_question(
    store: LiveChatStore, questions: tuple[WyrQuestion, ...], rng: random.Random | None = None
) -> WyrQuestion | None:
    """A random bank question this chat has not played yet; `None` only for an empty bank.
    Once the whole bank has been played the pool resets to the full bank (the repeat guard
    simply starts over — `wyr_used` keeps accumulating via INSERT OR IGNORE)."""
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

    Blocking (GPU polling) — callers run it in a worker thread. Every failure is contained:
    the round simply keeps its text-only placeholders. Returns True when both images were
    attached. Images become ordinary `photo` attachments (ordinal 0 = option A, 1 = option
    B), so signed URLs, renditions, quota accounting and delete/wipe erasure are inherited
    from the normal attachment pipeline, not reimplemented here."""
    if not generator.available():
        _LOGGER.warning("wyr: image generator unreachable; round %d stays text-only", anchor_seq)
        return False

    rng = random.SystemRandom()
    suffix = style_suffix(question.category)
    scratch_root = wyr_scratch_dir(paths)
    scratch_root.mkdir(parents=True, exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(prefix="wyr-img-", dir=scratch_root))
    try:
        try:
            png_a, png_b = generator.generate_pair(
                question.image_a + suffix,
                question.image_b + suffix,
                work_dir,
                seed_a=rng.randrange(2**32),
                seed_b=rng.randrange(2**32),
            )
        except ImageGenerationError:
            _LOGGER.exception("wyr: image generation failed for round %d", anchor_seq)
            return False

        attached = 0
        for ordinal, png in enumerate((png_a, png_b)):
            att_id = uuid.uuid4().hex
            upload_dir = paths.server_upload_dir(att_id)
            upload_dir.mkdir(parents=True, exist_ok=True)
            assembled = upload_dir / "assembled"
            try:
                tmp = upload_dir / "assembled.part"
                shutil.copyfile(png, tmp)
                os.replace(tmp, assembled)
                size = assembled.stat().st_size
                ok = store.create_wyr_image_attachment(
                    anchor_seq=anchor_seq,
                    att_id=att_id,
                    size_bytes=size,
                    by_email=by_email,
                    ordinal=ordinal,
                    now=time.time(),
                )
            except OSError:
                _LOGGER.exception("wyr: could not stage image for round %d", anchor_seq)
                shutil.rmtree(upload_dir, ignore_errors=True)
                return False
            if not ok:
                # The round's message was deleted while the GPU worked: the store
                # journaled the ids for cleanup; drop the staged file now.
                shutil.rmtree(upload_dir, ignore_errors=True)
                return False
            attached += 1
            publish()
        return attached == 2
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
