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
from wixy_server.livechat.wyr_images import ComfyImageGenerator
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
) -> JsonObject:
    """The per-viewer view of a round (`GET /wyr/{seq}?as=<sender>`).

    Public always: the question, state, rev, who the players are and what each has DONE
    (voted / answered / pressed Reveal) — never WHAT they answered. The viewer's own pick and
    guess are echoed back (so a refetch restores their toggles). The other player's pick and
    guess appear only once `state == "revealed"` (both pressed Reveal). `images` is the picture
    job's state (`none`/`pending`/`done`/`failed`): a card waits for pictures only while
    `pending`."""
    viewer_key = reactor_key(viewer) if viewer is not None else None
    slot = _slot_of(round_, viewer_key, viewer_email)
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
