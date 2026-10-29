"""Image generation driver (spec/server-chat/09b §B): gate, journal, ladder, renditions, pack.

Run as a Grid task on a hub worker (never session 0). The ComfyUI client is
`wixy_server.livechat.wyr_images.ComfyImageGenerator`, unchanged. Everything that matters for
correctness (the empty-queue gate, the attempt ladder, resumability, the deterministic pack and
the manifest) is a small pure function so it is unit-tested with no GPU or network.

This module holds the library pieces only. The long-running render/check driver and the
`gh` release step need the live fleet and the catalogue (parcel 1), so they are wired in a
later change; nothing here claims a CLI.
"""

from __future__ import annotations

import hashlib
import io
import json
import tarfile
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CARD_PX = 512
THUMB_PX = 160
GATE_POLLS = 3
GATE_POLL_GAP_S = 1.0
STATES = ("queued", "rendered", "checked", "accepted", "regenerate", "review")
MAX_AUTO_ATTEMPTS = 4
MAX_REVIEW_ATTEMPTS = 6
EMPTY_MANIFEST_RENDITIONS = {"card": CARD_PX, "thumb": THUMB_PX}


# --- the empty-queue gate --------------------------------------------------------------------


def queue_is_idle(queue: Mapping[str, Any]) -> bool:
    return not queue.get("queue_running") and not queue.get("queue_pending")


def wait_for_idle(
    get_queue: Callable[[], Mapping[str, Any]],
    *,
    pause_file: Path | None = None,
    sleep: Callable[[float], None] = time.sleep,
    polls: int = GATE_POLLS,
    gap_s: float = GATE_POLL_GAP_S,
    max_wait_s: float | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> bool:
    """Block until ComfyUI's `/queue` shows nothing running or pending on `polls` consecutive
    polls `gap_s` apart. Returns False if `pause_file` exists (the batch stops between pictures)
    or `max_wait_s` passes. A live game's picture therefore waits for at most one batch picture."""
    started = clock()
    calm = 0
    while calm < polls:
        if pause_file is not None and pause_file.exists():
            return False
        if max_wait_s is not None and clock() - started > max_wait_s:
            return False
        calm = calm + 1 if queue_is_idle(get_queue()) else 0
        if calm < polls:
            sleep(gap_s)
    return True


# --- the attempt ladder ----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AttemptPlan:
    attempt: int
    rewrite_visual: bool  # attempt 3: Haiku rewrites `visual` first
    new_seed: bool  # attempt 1 draws a random seed too; 2 and 4 are explicit "new seed"


def plan_attempt(attempt: int) -> AttemptPlan:
    """1 catalogue visual; 2 same visual new seed; 3 rewritten visual; 4 rewritten, new seed.
    5 and 6 (after an Opus review gives a new visual) are checked normally."""
    if not 1 <= attempt <= MAX_REVIEW_ATTEMPTS:
        raise ValueError(f"attempt {attempt} is outside 1..{MAX_REVIEW_ATTEMPTS}")
    return AttemptPlan(attempt, rewrite_visual=attempt == 3, new_seed=True)


def after_failure(attempt: int, *, reviewed: bool) -> str:
    """What follows a failed attempt: `retry` (next attempt), `review` (Opus), `pictureless`."""
    if reviewed:
        return "retry" if attempt < MAX_REVIEW_ATTEMPTS else "pictureless"
    return "retry" if attempt < MAX_AUTO_ATTEMPTS else "review"


# --- journal ---------------------------------------------------------------------------------


def journal_append(path: Path, entry: Mapping[str, Any]) -> None:
    if entry.get("state") not in STATES:
        raise ValueError(f"unknown state {entry.get('state')!r}")
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({**entry, "at": time.time()}, sort_keys=True)
    with path.open("a", encoding="utf-8", newline="\n") as fh:
        fh.write(line + "\n")


def journal_state(path: Path) -> dict[str, dict[str, Any]]:
    """Latest journal line per ingredient id (a torn final line from a crash is ignored)."""
    latest: dict[str, dict[str, Any]] = {}
    if not path.exists():
        return latest
    for raw in path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict) and isinstance(entry.get("id"), str):
            latest[entry["id"]] = entry
    return latest


def pending_work(
    ids: Sequence[str], state: Mapping[str, Mapping[str, Any]], masters_exist: Callable[[str], bool]
) -> list[str]:
    """Ids still to do: accepted ones are skipped, and an attempt whose master file is missing
    is re-rendered rather than trusted."""
    todo: list[str] = []
    for ident in ids:
        entry = state.get(ident)
        if entry is None:
            todo.append(ident)
        elif entry["state"] == "accepted":
            continue
        elif entry["state"] in ("rendered", "checked") and not masters_exist(ident):
            todo.append(ident)
        elif entry["state"] in ("queued", "regenerate"):
            todo.append(ident)
    return todo


# --- renditions ------------------------------------------------------------------------------


def encode_master(png_path: Path, dest: Path) -> None:
    """1024 master as WebP q92, metadata stripped (disk is tight: no PNG masters)."""
    from PIL import Image

    dest.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(png_path) as im:
        im.convert("RGB").save(dest, "WEBP", quality=92, method=6, exif=b"", icc_profile=None)


def make_renditions(master: Path) -> tuple[bytes, bytes]:
    """(card 512 WebP q82, thumb 160 WebP q78), Lanczos, method 6."""
    from PIL import Image

    out: list[bytes] = []
    with Image.open(master) as im:
        rgb = im.convert("RGB")
        for px, quality in ((CARD_PX, 82), (THUMB_PX, 78)):
            buf = io.BytesIO()
            rgb.resize((px, px), Image.Resampling.LANCZOS).save(
                buf, "WEBP", quality=quality, method=6
            )
            out.append(buf.getvalue())
    return out[0], out[1]


# --- the pack and its manifest ---------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AcceptedPicture:
    ident: str
    card: bytes
    thumb: bytes
    attempt: int
    accepted_by: str


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_pack(
    pictures: Sequence[AcceptedPicture], tar_path: Path, *, pack_version: int, url: str
) -> dict[str, Any]:
    """Write the deterministic tar (sorted members, zeroed metadata) and return the manifest
    dict. Identical pictures give an identical tar, so a re-run reproduces the same sha256."""
    objects: dict[str, bytes] = {}
    items: dict[str, dict[str, Any]] = {}
    for pic in sorted(pictures, key=lambda p: p.ident):
        card_sha, thumb_sha = sha256_hex(pic.card), sha256_hex(pic.thumb)
        objects[card_sha] = pic.card
        objects[thumb_sha] = pic.thumb
        items[pic.ident] = {
            "card": card_sha,
            "thumb": thumb_sha,
            "attempt": pic.attempt,
            "acceptedBy": pic.accepted_by,
        }
    tar_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tar_path, "w", format=tarfile.USTAR_FORMAT) as tar:
        for sha in sorted(objects):
            info = tarfile.TarInfo(f"objects/{sha[:2]}/{sha}.webp")
            info.size = len(objects[sha])
            info.mtime = 0
            info.mode = 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(objects[sha]))
    data = tar_path.read_bytes()
    return {
        "packVersion": pack_version,
        "pack": {
            "url": url,
            "sha256": sha256_hex(data),
            "bytes": len(data),
            "objects": len(objects),
            "installedBytes": sum(len(b) for b in objects.values()),
        },
        "renditions": dict(EMPTY_MANIFEST_RENDITIONS),
        "items": items,
    }


def write_manifest(path: Path, manifest: Mapping[str, Any]) -> None:
    """Same layout as the committed empty manifest: sorted keys, indent 1, LF, newline."""
    path.write_text(
        json.dumps(manifest, sort_keys=True, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def release_url(owner_repo: str, pack_version: int) -> str:
    tag = f"cookout-images-v{pack_version}"
    return f"https://github.com/{owner_repo}/releases/download/{tag}/{tag}.tar"


def history_check(
    manifests: Sequence[Mapping[str, Any]], head_bytes: Callable[[str], int | None]
) -> list[str]:
    """For every manifest ever committed, its pack URL must answer with exactly its `bytes`.
    Returns the problems (empty = the history is intact). Empty-pack manifests are skipped."""
    problems: list[str] = []
    for manifest in manifests:
        pack = manifest.get("pack")
        if not isinstance(pack, dict):
            continue
        url, expected = pack.get("url"), pack.get("bytes")
        got = head_bytes(url) if isinstance(url, str) else None
        if got != expected:
            problems.append(f"{url}: answers {got}, manifest says {expected}")
    return problems


def status_json(
    total: int, state: Mapping[str, Mapping[str, Any]], rate_per_s: float | None
) -> dict[str, Any]:
    by_state: dict[str, int] = {}
    for entry in state.values():
        by_state[entry["state"]] = by_state.get(entry["state"], 0) + 1
    accepted = by_state.get("accepted", 0)
    eta = None if not rate_per_s else (total - accepted) / rate_per_s
    return {"total": total, "byState": by_state, "etaSeconds": eta, "at": time.time()}


# =============================================================================================
# Live driver: plan, render, check, regenerate, review, pack, publish.
# Everything below needs the live fleet (hub's ComfyUI, cmd chat-spawn runs, `gh`); the pure
# pieces above are what the unit tests cover. The driver functions take their collaborators as
# arguments so they can be exercised with fakes (see test_cookout_visual_tooling.py).
# =============================================================================================

import asyncio  # noqa: E402
import os  # noqa: E402
import random  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
from collections import defaultdict  # noqa: E402

_REPO = Path(__file__).resolve().parents[3]
for _p in (str(_REPO), str(Path(__file__).resolve().parent)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import check as _check  # noqa: E402
import prompts as _prompts  # noqa: E402
import review as _review  # noqa: E402

PILOT_PER_CATEGORY = 40
CHECK_TIMEOUT_S = 900
CALLER = "wixy-cookout-pictures"
GH_EXE = r"C:\Program Files\GitHub CLI\gh.exe"
GH_REPO = "joshcomley/wixy"


def default_work_dir() -> Path:
    root = Path(os.environ.get("AIM_ROOT", "D:\\"))
    return root / "Servers" / "Wixy" / "Storage" / "cookout-images" / "work"


def interleave(ids_by_category: Mapping[str, Sequence[str]]) -> list[str]:
    """Round-robin over the categories so any prefix of the result is a stratified slice."""
    queues = {c: list(v) for c, v in sorted(ids_by_category.items())}
    out: list[str] = []
    while any(queues.values()):
        for c in sorted(queues):
            if queues[c]:
                out.append(queues[c].pop(0))
    return out


def make_plan(
    category_of: Mapping[str, str], seed: int, per_category: int = PILOT_PER_CATEGORY
) -> dict[str, Any]:
    """The pilot is `per_category` random ids from every category (the seed is recorded); the
    rest follow category-interleaved. The caller persists the result and never redraws it."""
    rng = random.Random(seed)
    by_cat: dict[str, list[str]] = defaultdict(list)
    for ident in sorted(category_of):
        by_cat[category_of[ident]].append(ident)
    pilot: dict[str, list[str]] = {}
    rest: dict[str, list[str]] = {}
    for cat, ids in by_cat.items():
        chosen = rng.sample(ids, min(per_category, len(ids)))
        pilot[cat] = chosen
        rest[cat] = [i for i in ids if i not in set(chosen)]
    return {"seed": seed, "pilot": interleave(pilot), "rest": interleave(rest)}


@dataclass(frozen=True, slots=True)
class Subject:
    ident: str
    name: str
    category: str
    what: str
    visual: str
    presentation: str


def load_subjects(catalogue_path: Path, bank_path: Path | None = None) -> dict[str, Subject]:
    """Accepted catalogue entries joined with the bank's name and category. Read-only."""
    from wixy_server.livechat.cookout_bank import load_cookout_bank
    from wixy_server.livechat.cookout_catalogue import subjects

    bank = load_cookout_bank(bank_path)
    raw = json.loads(catalogue_path.read_text(encoding="utf-8"))["items"]
    out: dict[str, Subject] = {}
    for s in subjects(bank):
        entry = raw.get(s.id)
        if entry is not None:
            out[s.id] = Subject(
                s.id, s.name, s.category, entry["what"], entry["visual"], entry["presentation"]
            )
    return out


class WorkDir:
    """`<work>/images/...`: journal, plan, masters, renditions, per-attempt records, overrides."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.images = root / "images"
        self.journal = self.images / "journal.jsonl"
        self.plan = self.images / "plan.json"
        self.pause = root / "PAUSE"
        self.overrides = self.images / "visual_overrides.json"

    def master(self, ident: str, attempt: int) -> Path:
        return self.root / "masters" / ident / f"{attempt}.webp"

    def card(self, ident: str, attempt: int) -> Path:
        return self.images / "renditions" / ident / f"{attempt}.card.webp"

    def thumb(self, ident: str, attempt: int) -> Path:
        return self.images / "renditions" / ident / f"{attempt}.thumb.webp"

    def attempts_file(self, ident: str) -> Path:
        return self.images / "attempts" / f"{ident}.json"

    def read_attempts(self, ident: str) -> list[dict[str, Any]]:
        path = self.attempts_file(ident)
        return list(json.loads(path.read_text("utf-8"))) if path.exists() else []

    def write_attempts(self, ident: str, attempts: list[dict[str, Any]]) -> None:
        path = self.attempts_file(ident)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(attempts, indent=1, sort_keys=True) + "\n", encoding="utf-8")

    def read_overrides(self) -> dict[str, str]:
        if not self.overrides.exists():
            return {}
        return dict(json.loads(self.overrides.read_text("utf-8")))

    def write_override(self, ident: str, visual: str) -> None:
        data = self.read_overrides()
        data[ident] = visual
        self.overrides.parent.mkdir(parents=True, exist_ok=True)
        self.overrides.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n", "utf-8")


class PoolRunner:
    """`check.Runner` over a `cmdruns.RunPool`. The batch key hashes the whole request, so
    a restarted tool resumes the same journalled run instead of spawning another."""

    def __init__(self, pool: Any, run_spec: Callable[..., Any], model_of: Callable[..., Any]):
        self._pool, self._spec, self._model = pool, run_spec, model_of

    async def run(
        self,
        *,
        prompt: str,
        model: str,
        provider: str,
        effort: str,
        cwd: Path,
        tool_profile: str,
        timeout_secs: int,
    ) -> str:
        key = sha256_hex(f"{provider}|{model}|{cwd.name}|{prompt}".encode())[:24]
        spec = self._spec(
            caller=CALLER,
            prompt=prompt,
            model=self._model(provider, model),
            effort=effort,
            cwd=str(cwd),
            timeout_secs=timeout_secs,
            tool_profile=tool_profile,
        )
        outcome = await self._pool.run(key, f"image-{tool_profile}", [], spec)
        if not outcome.ok or outcome.text is None:
            raise _check.VerdictError(f"run {outcome.status}: {outcome.error}")
        return str(outcome.text)


def comfy_queue_getter(base_url: str) -> Callable[[], Mapping[str, Any]]:
    import httpx

    def get() -> Mapping[str, Any]:
        response = httpx.get(f"{base_url.rstrip('/')}/queue", timeout=10.0)
        response.raise_for_status()
        data = response.json()
        return dict(data) if isinstance(data, dict) else {}

    return get


def render_one(
    generator: Any,
    ident: str,
    prompt: str,
    seed: int,
    attempt: int,
    work: WorkDir,
    scratch: Path,
) -> None:
    """Render one picture, keep the 1024 master, make both renditions. Synchronous (a thread)."""
    scratch.mkdir(parents=True, exist_ok=True)
    paths = generator.generate_many([prompt], scratch, seeds=[seed])
    png = paths[0] if paths else None
    if png is None:
        raise RuntimeError(f"ComfyUI produced no picture for {ident}")
    try:
        encode_master(png, work.master(ident, attempt))
    finally:
        png.unlink(missing_ok=True)
    card, thumb = make_renditions(work.master(ident, attempt))
    for target, data in ((work.card(ident, attempt), card), (work.thumb(ident, attempt), thumb)):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def visual_for(subject: Subject, overrides: Mapping[str, str]) -> str:
    return overrides.get(subject.ident, subject.visual)


def pick_decoy_factory(
    subjects_by_id: Mapping[str, Subject],
    rendered: Callable[[], Mapping[str, Path]],
    rng: random.Random,
) -> Callable[[], _check.Decoy]:
    """A picture of one ingredient labelled as an ingredient of a *different* category, with the
    picture's own category and the label's category also different from each other."""

    def pick() -> _check.Decoy:
        cards = rendered()
        ids = [i for i in sorted(cards) if i in subjects_by_id]
        categories = {subjects_by_id[i].category for i in ids}
        if len(categories) < 2:
            raise RuntimeError("need rendered pictures from at least 2 categories for a decoy")
        shown = rng.choice(ids)
        shown_cat = subjects_by_id[shown].category
        pool = [i for i in sorted(subjects_by_id) if subjects_by_id[i].category != shown_cat]
        label = subjects_by_id[rng.choice(pool)]
        return _check.Decoy(cards[shown], label.name, label.what, label.presentation)

    return pick


def record_attempt(
    work: WorkDir, ident: str, attempt: int, seed: int, visual: str, prompt: str
) -> None:
    attempts = [a for a in work.read_attempts(ident) if a["attempt"] != attempt]
    attempts.append(
        {
            "attempt": attempt,
            "seed": seed,
            "visual": visual,
            "promptHash": _prompts.prompt_hash(prompt),
            "verdict": None,
            "reason": "",
        }
    )
    work.write_attempts(ident, sorted(attempts, key=lambda a: a["attempt"]))


def record_verdict(
    work: WorkDir, ident: str, attempt: int, verdict: str, reason: str, by: str
) -> None:
    attempts = work.read_attempts(ident)
    for a in attempts:
        if a["attempt"] == attempt:
            a.update(verdict=verdict, reason=reason, by=by)
    work.write_attempts(ident, attempts)


def next_attempt(work: WorkDir, ident: str) -> int:
    attempts = work.read_attempts(ident)
    return max((a["attempt"] for a in attempts), default=0) + 1


async def check_chunk(
    runner: _check.Runner,
    checker: _check.CheckerModel,
    tiebreaker: _check.CheckerModel,
    chunk: Sequence[tuple[str, int]],
    subjects_by_id: Mapping[str, Subject],
    work: WorkDir,
    pick_decoy: Callable[[], _check.Decoy],
    rng: random.Random,
    tag: str,
) -> dict[str, str]:
    """Check up to 10 rendered pictures. Returns ident -> `accepted` | `regenerate`."""
    real = [
        _check.CheckImage(
            i,
            subjects_by_id[i].name,
            subjects_by_id[i].what,
            subjects_by_id[i].presentation,
            work.card(i, a),
        )
        for i, a in chunk
    ]
    attempt_of = dict(chunk)
    check_root = work.root / "check"
    result = await _check.check_images(runner, checker, tag, real, pick_decoy, check_root, rng)
    if result.discarded:
        # the decoy was marked correct twice: this checker is not trusted for these pictures,
        # so each goes to the second checker (a different model) one at a time
        for img in real:
            single = await _check.check_images(
                runner, tiebreaker, f"{tag}-alt-{img.ident}", [img], pick_decoy, check_root, rng
            )
            result.verdicts.update(single.verdicts)
    outcome: dict[str, str] = {}
    for ident, verdict in result.verdicts.items():
        kind = _check.classify(verdict.verdict)
        by = checker.label
        if kind == "tiebreak":
            img = next(r for r in real if r.ident == ident)
            second = await _check.check_images(
                runner, tiebreaker, f"{tag}-tie-{ident}", [img], pick_decoy, check_root, rng
            )
            sv = second.verdicts.get(ident)
            if sv is not None and sv.verdict == "correct":
                kind, by, verdict = "accepted", "sol-tiebreak", sv
            else:
                kind = "regenerate"
                verdict = sv if sv is not None else verdict
        attempt = attempt_of[ident]
        record_verdict(work, ident, attempt, verdict.verdict, verdict.reason, by)
        outcome[ident] = "accepted" if kind == "accepted" else "regenerate"
        journal_append(
            work.journal,
            {
                "id": ident,
                "attempt": attempt,
                "state": outcome[ident],
                "by": by if kind == "accepted" else None,
            },
        )
    return outcome


async def rewrite_visuals(
    runner: _check.Runner,
    haiku: _check.CheckerModel,
    ids: Sequence[str],
    subjects_by_id: Mapping[str, Subject],
    work: WorkDir,
) -> None:
    """Attempt 3: Haiku rewrites `visual` given the name, `what`, the old visual and every
    checker reason so far. The new text goes to an overrides file; the committed catalogue is
    updated once, at the end, through `catalogue.set_visual`."""
    from wixy_server.livechat.cookout_catalogue import visual_problems

    overrides = work.read_overrides()
    entries = []
    for i in ids:
        s = subjects_by_id[i]
        reasons = [a["reason"] for a in work.read_attempts(i) if a.get("reason")]
        entries.append((i, s.name, s.what, visual_for(s, overrides), reasons))
    cwd = work.root / "rewrite"
    cwd.mkdir(parents=True, exist_ok=True)
    text = await runner.run(
        prompt=_prompts.visual_rewrite_prompt(entries),
        model=haiku.model,
        provider=haiku.provider,
        effort="medium",
        cwd=cwd,
        tool_profile="judge",
        timeout_secs=CHECK_TIMEOUT_S,
    )
    data = _check.strip_json(text)
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise _check.VerdictError("rewrite answer is not {items: [...]}")
    for item in data["items"]:
        if not (isinstance(item, dict) and item.get("id") in ids):
            continue
        visual = item.get("visual")
        if isinstance(visual, str) and not visual_problems(visual):
            work.write_override(item["id"], visual)


async def review_failures(
    runner: _check.Runner,
    opus: _check.CheckerModel,
    ident: str,
    subjects_by_id: Mapping[str, Subject],
    work: WorkDir,
    review_path: Path = _review.REVIEW_PATH,
) -> str:
    """Opus sees every attempt. Returns `accepted:<n>` or `retry` (a new visual is stored).
    Decisions are recorded so a re-run never re-litigates them."""
    s = subjects_by_id[ident]
    attempts = work.read_attempts(ident)
    cwd = work.root / "review" / ident
    cwd.mkdir(parents=True, exist_ok=True)
    rows = []
    for a in attempts:
        name = f"attempt{a['attempt']}.webp"
        (cwd / name).write_bytes(work.card(ident, a["attempt"]).read_bytes())
        rows.append((a["attempt"], name, f"{a.get('verdict')}: {a.get('reason')}"))
    text = await runner.run(
        prompt=_prompts.opus_review_prompt(ident, s.name, s.what, rows),
        model=opus.model,
        provider=opus.provider,
        effort="high",
        cwd=cwd,
        tool_profile="replay_probe",
        timeout_secs=CHECK_TIMEOUT_S,
    )
    decision = _review.parse_review(text, max(a["attempt"] for a in attempts))
    if decision.choose is not None:
        _review.record_decision(ident, "accepted", decision.choose, decision.reason, review_path)
        return f"accepted:{decision.choose}"
    assert decision.visual is not None
    work.write_override(ident, decision.visual)
    _review.record_decision(ident, "retry", None, decision.reason, review_path)
    return "retry"


def mark_pictureless(work: WorkDir, ident: str, reason: str, review_path: Path) -> None:
    _review.record_decision(ident, "pictureless", None, reason, review_path)
    journal_append(work.journal, {"id": ident, "state": "review", "pictureless": True})


def accepted_pictures(work: WorkDir) -> list[AcceptedPicture]:
    """Every accepted id's pictures (attempt and accepting checker from the journal)."""
    pics: list[AcceptedPicture] = []
    for ident, entry in sorted(journal_state(work.journal).items()):
        if entry.get("state") != "accepted":
            continue
        attempt = int(entry["attempt"])
        pics.append(
            AcceptedPicture(
                ident,
                work.card(ident, attempt).read_bytes(),
                work.thumb(ident, attempt).read_bytes(),
                attempt,
                str(entry.get("by") or "claude-haiku-5-5"),
            )
        )
    return pics


def gh(*args: str) -> subprocess.CompletedProcess[str]:
    """Every `gh` call goes through the full path, with captured pipes (fleet rule)."""
    return subprocess.run(  # noqa: S603
        [GH_EXE, *args], capture_output=True, text=True, encoding="utf-8", timeout=600, check=False
    )


def head_bytes(url: str) -> int | None:
    import urllib.request

    try:
        request = urllib.request.Request(url, method="HEAD")  # noqa: S310
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            length = response.headers.get("Content-Length")
            return int(length) if length is not None else None
    except Exception:  # noqa: BLE001
        return None


def manifest_history(manifest_path: Path) -> list[dict[str, Any]]:
    """Every version of the manifest ever committed."""
    rel = manifest_path.resolve().relative_to(_REPO).as_posix()
    revs = subprocess.run(  # noqa: S603
        ["git", "-C", str(_REPO), "log", "--follow", "--format=%H", "--", rel],  # noqa: S607
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    ).stdout.split()
    out: list[dict[str, Any]] = []
    for rev in revs:
        shown = subprocess.run(  # noqa: S603
            ["git", "-C", str(_REPO), "show", f"{rev}:{rel}"],  # noqa: S607
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )
        if shown.returncode == 0:
            try:
                out.append(json.loads(shown.stdout))
            except json.JSONDecodeError:
                continue
    return out


def publish(
    work: WorkDir, manifest_path: Path, storage: Path, *, dry_run: bool = False
) -> dict[str, Any]:
    """Build the pack, release it, download it back, verify, write the manifest, install it
    under a pending pin, run the history check. Any failure stops the publish."""
    pics = accepted_pictures(work)
    if not pics:
        raise RuntimeError("no accepted pictures to publish")
    current = json.loads(manifest_path.read_text("utf-8"))
    version = int(current.get("packVersion", 0)) + 1
    tar_path = work.root / "pack" / f"cookout-images-v{version}.tar"
    manifest = build_pack(pics, tar_path, pack_version=version, url=release_url(GH_REPO, version))
    if dry_run:
        return manifest
    tag = f"cookout-images-v{version}"
    made = gh(
        "release",
        "create",
        tag,
        str(tar_path),
        "--repo",
        GH_REPO,
        "--title",
        f"Cookout ingredient pictures v{version}",
        "--notes",
        "Immutable picture pack. Never delete: older manifests pin it by sha256.",
    )
    if made.returncode != 0:
        raise RuntimeError(f"gh release create failed: {made.stderr[:400]}")
    back = work.root / "pack" / "verify"
    back.mkdir(parents=True, exist_ok=True)
    got = gh("release", "download", tag, "--repo", GH_REPO, "--dir", str(back), "--clobber")
    downloaded = back / tar_path.name
    if got.returncode != 0 or sha256_hex(downloaded.read_bytes()) != manifest["pack"]["sha256"]:
        raise RuntimeError("the downloaded release asset does not match the built pack")
    write_manifest(manifest_path, manifest)
    from wixy_server.livechat import cookout_pack

    loaded = cookout_pack.load_manifest(manifest_path)
    store = cookout_pack.PackStore(storage / "cookout-images", min_free_bytes=0)
    store.install(tar_path, loaded)
    problems = history_check([*manifest_history(manifest_path), manifest], head_bytes)
    if problems:
        raise RuntimeError("history check failed: " + "; ".join(problems))
    return manifest


def build_status(work: WorkDir, total: int) -> dict[str, Any]:
    state = journal_state(work.journal)
    stamps = [e["at"] for e in state.values() if isinstance(e.get("at"), int | float)]
    rate = None
    if len(stamps) > 50:
        span = max(stamps) - min(stamps)
        rate = len(stamps) / span if span > 0 else None
    return status_json(total, state, rate)


async def run_pipeline(
    ids: Sequence[str],
    subjects_by_id: Mapping[str, Subject],
    work: WorkDir,
    generator: Any,
    get_queue: Callable[[], Mapping[str, Any]],
    runner: _check.Runner,
    checker: _check.CheckerModel,
    haiku: _check.CheckerModel,
    tiebreaker: _check.CheckerModel,
    opus: _check.CheckerModel,
    *,
    chunk_size: int = _check.BATCH_REAL,
    review_path: Path = _review.REVIEW_PATH,
    rng: random.Random | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, int]:
    """Render and check `ids` to completion: render a chunk (one picture at a time, only when
    ComfyUI is idle), check it, regenerate failures along the attempt ladder, send persistent
    failures to Opus. Resumable from the journal. Returns counts."""
    rng = rng or random.Random()
    decisions = _review.load_decisions(review_path)
    rendered: dict[str, Path] = {}
    pick_decoy = pick_decoy_factory(subjects_by_id, lambda: rendered, rng)
    totals = {"accepted": 0, "pictureless": 0, "rendered": 0}

    def master_exists(ident: str) -> bool:
        return work.master(ident, max(1, next_attempt(work, ident) - 1)).exists()

    pending = [
        i
        for i in pending_work(ids, journal_state(work.journal), master_exists)
        if decisions.get(i, {}).get("decision") != "pictureless"
    ]
    batch_no = 0
    while pending:
        chunk_ids, pending = pending[:chunk_size], pending[chunk_size:]
        rewrite = [i for i in chunk_ids if next_attempt(work, i) == 3]
        if rewrite:
            await rewrite_visuals(runner, haiku, rewrite, subjects_by_id, work)
        chunk: list[tuple[str, int]] = []
        for ident in chunk_ids:
            if not wait_for_idle(get_queue, pause_file=work.pause, sleep=sleep):
                return totals  # PAUSE file: stop between pictures
            attempt = next_attempt(work, ident)
            visual = visual_for(subjects_by_id[ident], work.read_overrides())
            prompt = _prompts.image_prompt(visual)
            seed = random.SystemRandom().randrange(2**32)
            record_attempt(work, ident, attempt, seed, visual, prompt)
            await asyncio.to_thread(
                render_one, generator, ident, prompt, seed, attempt, work, work.root / "scratch"
            )
            rendered[ident] = work.card(ident, attempt)
            journal_append(
                work.journal,
                {
                    "id": ident,
                    "attempt": attempt,
                    "seed": seed,
                    "state": "rendered",
                    "promptHash": _prompts.prompt_hash(prompt),
                },
            )
            totals["rendered"] += 1
            chunk.append((ident, attempt))
        batch_no += 1
        outcome = await check_chunk(
            runner,
            checker,
            tiebreaker,
            chunk,
            subjects_by_id,
            work,
            pick_decoy,
            rng,
            f"b{batch_no}",
        )
        for ident, result in outcome.items():
            if result == "accepted":
                totals["accepted"] += 1
                continue
            attempt = next_attempt(work, ident) - 1
            reviewed = decisions.get(ident, {}).get("decision") == "retry"
            step = after_failure(attempt, reviewed=reviewed)
            if step == "retry":
                pending.append(ident)
            elif step == "review":
                verdict = await review_failures(
                    runner, opus, ident, subjects_by_id, work, review_path
                )
                decisions = _review.load_decisions(review_path)
                if verdict.startswith("accepted:"):
                    n = int(verdict.split(":")[1])
                    journal_append(
                        work.journal,
                        {"id": ident, "attempt": n, "state": "accepted", "by": "opus-review"},
                    )
                    totals["accepted"] += 1
                else:
                    pending.append(ident)
            else:
                mark_pictureless(work, ident, "failed all six attempts", review_path)
                totals["pictureless"] += 1
        work.images.mkdir(parents=True, exist_ok=True)
        (work.images / "status.json").write_text(
            json.dumps(build_status(work, len(ids)), indent=1) + "\n", encoding="utf-8"
        )
    return totals


# --- command line ---------------------------------------------------------------------------


def _parser() -> Any:
    import argparse

    p = argparse.ArgumentParser(prog="images.py", description="Cookout picture pipeline")
    p.add_argument("--work-dir", default=None)
    p.add_argument(
        "--catalogue",
        required=False,
        default=str(_REPO / "wixy_server" / "livechat" / "cookout_catalogue.json"),
        help="catalogue JSON to READ (parcel 1's file); never written",
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    plan = sub.add_parser("plan", help="draw the pilot (once) and write plan.json")
    plan.add_argument("--seed", type=int, default=None)
    run = sub.add_parser("run", help="render and check; resumable")
    run.add_argument("--phase", choices=["pilot", "rest", "all"], default="pilot")
    run.add_argument("--checker", choices=["haiku", "luna"], default="haiku")
    run.add_argument("--limit", type=int, default=None)
    sub.add_parser("status")
    pub = sub.add_parser("publish", help="build, release, verify and install a pack")
    pub.add_argument(
        "--manifest",
        default=str(_REPO / "wixy_server" / "livechat" / "cookout_ingredient_images.json"),
    )
    pub.add_argument(
        "--storage", default=os.environ.get("WIXY_STORAGE_ROOT", r"D:\Servers\Wixy\Storage")
    )
    pub.add_argument("--dry-run", action="store_true")
    sub.add_parser("apply-overrides", help="write attempt-3 rewrites into the committed catalogue")
    return p


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    work = WorkDir(Path(args.work_dir) if args.work_dir else default_work_dir())
    catalogue = Path(args.catalogue)
    if args.cmd == "status":
        plan = json.loads(work.plan.read_text("utf-8")) if work.plan.exists() else {}
        total = len(plan.get("pilot", [])) + len(plan.get("rest", []))
        print(json.dumps(build_status(work, total), indent=1))
        return 0
    if args.cmd == "plan":
        if work.plan.exists():
            print(f"plan exists (never redrawn): {work.plan}")
            return 0
        subs = load_subjects(catalogue)
        seed = args.seed if args.seed is not None else random.SystemRandom().randrange(2**32)
        plan = make_plan({i: s.category for i, s in subs.items()}, seed)
        work.images.mkdir(parents=True, exist_ok=True)
        work.plan.write_text(json.dumps(plan, indent=1) + "\n", encoding="utf-8")
        print(f"pilot {len(plan['pilot'])} ids, rest {len(plan['rest'])}, seed {seed}")
        return 0
    if args.cmd == "apply-overrides":
        from tooling.cookout.visual import catalogue as cat_tool

        target = _REPO / "wixy_server" / "livechat" / "cookout_catalogue.json"
        for ident, visual in work.read_overrides().items():
            cat_tool.set_visual(target, ident, visual, "image-rewrite")
        print("applied")
        return 0
    if args.cmd == "publish":
        manifest = publish(work, Path(args.manifest), Path(args.storage), dry_run=args.dry_run)
        print(json.dumps(manifest["pack"], indent=1))
        return 0
    # run
    from tooling.cookout.visual import cmdruns
    from wixy_server.livechat.wyr_images import ComfyImageGenerator

    env = _load_env(Path(os.environ.get("WIXY_ENV_FILE", r"D:\Servers\Wixy\Storage\.env")))
    base_url = env.get("WIXY_COMFY_URL", "http://127.0.0.1:8199")
    out_dir = env.get("WIXY_COMFY_OUTPUT_DIR")
    if not out_dir:
        print("WIXY_COMFY_OUTPUT_DIR is not set; refusing to render", file=sys.stderr)
        return 2
    plan = json.loads(work.plan.read_text("utf-8"))
    subs = load_subjects(catalogue)
    order = {"pilot": plan["pilot"], "rest": plan["rest"], "all": plan["pilot"] + plan["rest"]}[
        args.phase
    ]
    ids = [i for i in order if i in subs]
    if args.limit:
        ids = ids[: args.limit]
    pool = cmdruns.RunPool(
        client=cmdruns.real_client(), journal=cmdruns.Journal(work.images / "runs.jsonl")
    )
    runner = PoolRunner(pool, cmdruns.RunSpec, cmdruns.Model)
    checker = _check.HAIKU if args.checker == "haiku" else _check.LUNA
    totals = asyncio.run(
        run_pipeline(
            ids,
            subs,
            work,
            ComfyImageGenerator(base_url, output_dir=Path(out_dir)),
            comfy_queue_getter(base_url),
            runner,
            checker,
            _check.HAIKU,
            _check.SOL,
            _check.OPUS,
        )
    )
    print(json.dumps(totals))
    return 0


def _load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, _, value = line.partition("=")
                out[key.strip()] = value.strip()
    return out


if __name__ == "__main__":
    raise SystemExit(main())
