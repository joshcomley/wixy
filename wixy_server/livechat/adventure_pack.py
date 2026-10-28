"""The Adventure Time holiday pack job (workspace 00056, spec/server-chat/08-adventure-time §4.3).

When a destination is chosen the round's `pack` goes `pending` and `AdventurePackRunner.run_job`
researches the place live on the internet — a hidden cmd chat run (`cmdchat.py` is the ONE
chokepoint to cmd, Inv 13) that uses only WebSearch/WebFetch and answers with one JSON object: the
food, a couple of places to stay, the culture, the sights, what to do. The answer is parsed
defensively and sanitised (`parse_pack`) and stored on the round row, where it is chat content
erased with the round (Inv 56).

What leaves this server is the destination ONLY (name, region, unit name, coordinates — all from
the static bank): never a person, a message or anything from the chat. cmd keeps its own copy of
each run (the prompt and the final answer, in its hidden `chat-spawn` ledger and transcript) which
this server cannot erase; the prompt is a function of the bank destination alone, but its
timestamp does say "a pack was researched then" — documented as an honest limit (Inv 56).

Concurrency and recovery:
- at most 2 research runs in flight (`CapacityLimiter(2)`) and spawns at least 5 s apart (cmd's
  parallel-spawn gotcha);
- a poll every 10 s, giving up after 25 minutes (cancelling the run); a cmd `error` within the
  first 150 s of a run is retried once;
- every write is a compare-and-set on `(pack = 'pending' AND pack_run_id = <this run>)`, so a
  blue/green overlap where both processes poll one run stores it once, and a round rejected or
  deleted meanwhile is left alone (the job notices and cancels its run);
- at startup `resume` restarts the job for every `pending` round: with a run id it resumes polling
  that run, without one (the process died before the spawn) it starts a new run.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal, Protocol
from urllib.parse import unquote, urlsplit

import anyio
import anyio.to_thread
from anyio import CapacityLimiter

from builder.jsontypes import JsonObject, JsonValue
from wixy_server.background import ContainedTaskGroup
from wixy_server.cmdchat import CmdChatClient, CmdChatError, CmdChatUnreachableError
from wixy_server.livechat.adventure_bank import AdventureBank, AdventureDestination
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.store import (
    ADVENTURE_PACK_FAILED_TEXT,
    ADVENTURE_PACK_UNAVAILABLE_TEXT,
    LiveChatStore,
)

_LOGGER = logging.getLogger(__name__)

PACK_CALLER: Final = "wixy-adventure-pack"
PACK_MODEL: Final = "claude-sonnet-5-5"
PACK_EFFORT: Final = "medium"
PACK_RUN_TIMEOUT_S: Final = 1200
"""cmd's own deadline for the run (its `timeout_secs`); the job gives up a little later (25 min)."""
RESEARCH_DIRNAME: Final = "adventure-research"
"""An empty, non-git folder under the server's private storage that cmd runs the research in."""
DISALLOWED_TOOLS: Final = (
    "Bash",
    "PowerShell",
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "Read",
    "Grep",
    "Glob",
    "Agent",
    "Task",
    "Skill",
    "TodoWrite",
)

# -- the pack schema (spec §4.3) ----------------------------------------------------------------

SECTION_KEYS: Final = ("dishes", "food", "stay", "culture", "sights", "do", "practical")
"""`dishes` (spec §4.3b: the local dishes and drinks themselves, FIRST in the pack) and `food`
(where to eat) are separate sections; a pack with no `dishes` section is still valid."""
SECTION_DEFAULT_TITLES: Final = {
    "dishes": "Local food to try",
    "food": "Where to eat",
    "stay": "Where to stay",
    "culture": "Culture",
    "sights": "Sights",
    "do": "Things to do",
    "practical": "Practical",
}
MAX_HEADLINE: Final = 140
MAX_SUMMARY: Final = 700
MAX_SECTIONS: Final = 7
MAX_SECTION_TITLE: Final = 60
MAX_ITEMS: Final = 6
MAX_ITEM_NAME: Final = 90
MAX_ITEM_DETAIL: Final = 400
MAX_BEST_TIME: Final = 240
MAX_GETTING_THERE: Final = 300
MAX_TRAVEL_ADVICE: Final = 400
MAX_SOURCES: Final = 12
MAX_SOURCE_TITLE: Final = 120
MAX_URL: Final = 500
MAX_WIKIPEDIA_TITLE: Final = 120

_WHITESPACE_RE = re.compile(r"\s+")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_URL_BAD_RE = re.compile(r"[\s\x00-\x1f\x7f]")
_WIKI_TITLE_BAD_RE = re.compile(r"[\x00-\x1f\x7f<>\[\]{}|\\]")
_WIKI_NAMESPACES: Final = frozenset(
    {
        "file",
        "image",
        "category",
        "special",
        "template",
        "user",
        "talk",
        "help",
        "wikipedia",
        "portal",
        "draft",
        "mediawiki",
        "module",
        "media",
    }
)


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _line(value: object, limit: int) -> str:
    """A single-line string field: whitespace collapsed, clipped; anything not a string is empty."""
    if not isinstance(value, str):
        return ""
    return _clip(_WHITESPACE_RE.sub(" ", _CONTROL_RE.sub(" ", value)).strip(), limit)


def _paragraph(value: object, limit: int) -> str:
    """A prose field: line breaks kept (at most one blank line in a row), control characters
    dropped, clipped."""
    if not isinstance(value, str):
        return ""
    text = _CONTROL_RE.sub(" ", value.replace("\r\n", "\n").replace("\r", "\n"))
    lines = [_WHITESPACE_RE.sub(" ", line).strip() for line in text.split("\n")]
    collapsed: list[str] = []
    for line in lines:
        if line or (collapsed and collapsed[-1]):
            collapsed.append(line)
    return _clip("\n".join(collapsed).strip(), limit)


def clean_url(value: object) -> str | None:
    """`value` when it is an `http(s)` URL with a host (a dotted public-style name, no credentials,
    no whitespace, at most 500 characters), else `None`. Never rewritten: what the model gave is
    what is stored, or nothing."""
    if not isinstance(value, str):
        return None
    url = value.strip()
    if not url or len(url) > MAX_URL or _URL_BAD_RE.search(url):
        return None
    try:
        parts = urlsplit(url)
        host = parts.hostname
        _ = parts.port  # raises ValueError for a malformed port
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not host or "." not in host:
        return None
    if parts.username is not None or parts.password is not None:
        return None
    return url


def clean_wikipedia_title(value: object) -> str | None:
    """An English Wikipedia article TITLE (spec §4.3a), as plain text: whitespace collapsed,
    underscores read as spaces, any `#section` dropped, clipped to 120. A full
    `https://en.wikipedia.org/wiki/<Title>` link is reduced to its title; any other URL, a
    non-article namespace (`File:`, `Category:`, ...) and characters a title cannot hold are
    refused. The title is only ever percent-encoded into a request path the server builds itself
    (`adventure_pictures.py`), never fetched as given."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text.lower().startswith(("http://", "https://")):
        parts = urlsplit(text)
        host = (parts.hostname or "").lower()
        if host not in ("en.wikipedia.org", "en.m.wikipedia.org") or not parts.path.startswith(
            "/wiki/"
        ):
            return None
        text = unquote(parts.path[len("/wiki/") :])
    text = text.split("#", 1)[0].replace("_", " ")
    text = _WHITESPACE_RE.sub(" ", text).strip().lstrip(":").strip()
    if not text or _WIKI_TITLE_BAD_RE.search(text):
        return None
    prefix, colon, _ = text.partition(":")
    if colon and prefix.strip().lower() in _WIKI_NAMESPACES:
        return None
    return _clip(text, MAX_WIKIPEDIA_TITLE)


def _sanitise_item(raw: object) -> JsonObject | None:
    if not isinstance(raw, dict):
        return None
    name = _line(raw.get("name"), MAX_ITEM_NAME)
    if not name:
        return None
    return {
        "name": name,
        "detail": _paragraph(raw.get("detail"), MAX_ITEM_DETAIL),
        "url": clean_url(raw.get("url")),
        "wikipedia": clean_wikipedia_title(raw.get("wikipedia")),
    }


def _sanitise_section(raw: object) -> JsonObject | None:
    if not isinstance(raw, dict):
        return None
    key = raw.get("key")
    if not isinstance(key, str) or key not in SECTION_KEYS:
        return None
    items: list[JsonValue] = []
    raw_items = raw.get("items")
    if isinstance(raw_items, list):
        for raw_item in raw_items:
            item = _sanitise_item(raw_item)
            if item is not None:
                items.append(item)
            if len(items) == MAX_ITEMS:
                break
    if not items:
        return None
    if key == "dishes":
        # A dish is the dish itself, not a venue: it has no site of its own to link (its picture
        # comes from the dish's Wikipedia article or a vetted Commons photo — spec §4.3b).
        items = [{**item, "url": None} for item in items if isinstance(item, dict)]
    title = _line(raw.get("title"), MAX_SECTION_TITLE) or SECTION_DEFAULT_TITLES[key]
    return {"key": key, "title": title, "items": items}


def _sanitise_source(raw: object) -> JsonObject | None:
    if not isinstance(raw, dict):
        return None
    url = clean_url(raw.get("url"))
    if url is None:
        return None
    title = _line(raw.get("title"), MAX_SOURCE_TITLE) or (urlsplit(url).hostname or url)
    return {"title": title, "url": url}


def sanitise_pack(raw: object) -> JsonObject | None:
    """The stored holiday pack for a model-produced object, or `None` when it is not a usable
    pack. Every string is validated and clipped to its limit, only `http(s)` URLs with a host
    survive, unknown keys are dropped, a section needs a known key and at least one named item
    (the first section of each key wins), and a pack with no sections at all is a failure."""
    if not isinstance(raw, dict):
        return None
    sections: list[JsonValue] = []
    seen_keys: set[str] = set()
    raw_sections = raw.get("sections")
    if isinstance(raw_sections, list):
        for raw_section in raw_sections:
            section = _sanitise_section(raw_section)
            if section is None or section["key"] in seen_keys:
                continue
            seen_keys.add(str(section["key"]))
            sections.append(section)
            if len(sections) == MAX_SECTIONS:
                break
    if not sections:
        return None
    # `dishes` is always the first section whatever order the model wrote them in; the rest keep
    # the model's order.
    sections.sort(
        key=lambda section: not (isinstance(section, dict) and section["key"] == "dishes")
    )
    sources: list[JsonValue] = []
    raw_sources = raw.get("sources")
    if isinstance(raw_sources, list):
        for raw_source in raw_sources:
            source = _sanitise_source(raw_source)
            if source is not None:
                sources.append(source)
            if len(sources) == MAX_SOURCES:
                break
    return {
        "headline": _line(raw.get("headline"), MAX_HEADLINE),
        "summary": _paragraph(raw.get("summary"), MAX_SUMMARY),
        "wikipedia": clean_wikipedia_title(raw.get("wikipedia")),
        "sections": sections,
        "bestTime": _paragraph(raw.get("bestTime"), MAX_BEST_TIME),
        "gettingThere": _paragraph(raw.get("gettingThere"), MAX_GETTING_THERE),
        "travelAdvice": _paragraph(raw.get("travelAdvice"), MAX_TRAVEL_ADVICE),
        "sources": sources,
    }


def _json_objects(text: str) -> list[object]:
    """Every top-level JSON object embedded in `text`, in order (prose, markdown fences and stray
    braces around them are skipped)."""
    decoder = json.JSONDecoder()
    found: list[object] = []
    position = 0
    while True:
        start = text.find("{", position)
        if start < 0:
            return found
        try:
            value, end = decoder.raw_decode(text, start)
        except json.JSONDecodeError:
            position = start + 1
            continue
        found.append(value)
        position = end


def parse_pack(response_text: str) -> JsonObject | None:
    """The sanitised pack from a research run's final message, or `None` (a failure). Takes the
    LAST JSON object in the text that makes a usable pack."""
    for candidate in reversed(_json_objects(response_text)):
        pack = sanitise_pack(candidate)
        if pack is not None:
            return pack
    return None


def canonical_pack_json(pack: JsonObject) -> str:
    """How a pack is stored in `adv_rounds.pack_json`."""
    return json.dumps(pack, ensure_ascii=False, separators=(",", ":"))


# -- the prompt ---------------------------------------------------------------------------------


def build_prompt(destination: AdventureDestination, unit_name: str) -> str:
    """The research brief. It names ONLY the destination (from the static bank): never a person, a
    message or anything from the chat."""
    return f"""You are a careful, up-to-date travel researcher. Research ONE holiday destination \
live on the internet, then reply with a single JSON object.

Destination: {destination.name}
Area: {destination.region}, {unit_name}
Position: latitude {destination.lat:.4f}, longitude {destination.lng:.4f}

Use ONLY your WebSearch and WebFetch tools (you have no other tools). Read real, current pages; do \
not rely on memory for names, prices or opening details, and never invent a place or a link.

Voice: write as a warm, knowledgeable friend talking to the couple ("you"). Never mention \
yourself, your searches or your sources in the text; if you could not confirm something, leave it \
out.

Cover:
- dishes (put this section FIRST): 4-6 signature local dishes and drinks the area is known for \
- the dish or drink ITSELF, never a restaurant. For each: what it is, how it tastes, where or \
when to try it. Give "wikipedia" as the exact English Wikipedia article title OF THE DISH when \
that article exists (check it exists and is about the dish: a name shared with an animal, a \
place or a person is not it); otherwise null. "url" is null for a dish.
- food: 2-4 specific places to eat or drink (titled "Where to eat").
- stay: 2-4 specific villas, or characterful places to stay, each with a link to its page.
- culture: theatre, music, festivals, museums and local customs worth knowing.
- sights: the main things to see.
- do: what to do there (activities, day trips, walks).
- practical: costs, currency and language, in a few short items.

Your FINAL message must be exactly one JSON object and nothing else: no text before or after it \
and no markdown fences. Use exactly these keys and respect these limits (characters):

{{"headline": string (max {MAX_HEADLINE}),
 "summary": string (max {MAX_SUMMARY}),
 "wikipedia": string | null,
 "sections": [ {{"key": "dishes" | "food" | "stay" | "culture" | "sights" | "do" | "practical",
                "title": string (max {MAX_SECTION_TITLE}),
                "items": [ {{"name": string (max {MAX_ITEM_NAME}), "detail": string \
(max {MAX_ITEM_DETAIL}), "url": string | null, "wikipedia": string | null}} ]  (at most \
{MAX_ITEMS})}} ]  (at most {MAX_SECTIONS}),
 "bestTime": string (max {MAX_BEST_TIME}),
 "gettingThere": string (max {MAX_GETTING_THERE}),
 "travelAdvice": string (max {MAX_TRAVEL_ADVICE}),
 "sources": [ {{"title": string (max {MAX_SOURCE_TITLE}), "url": string}} ]  (at most \
{MAX_SOURCES})}}

Rules: every item "url" is a full https:// link to that place's OWN official website where it has \
one (a restaurant's, villa's, hotel's, museum's or festival's own site), and only when it has none \
a listing or tourist-board page about it, or null; never link a booking or review aggregator when \
an official site exists. "wikipedia" is the exact title of the English Wikipedia article about \
the thing, for the destination itself (top level) and for any item that has an article: places, \
sights, museums, festivals, famous dishes; null when there is no such article (most restaurants \
and villas). Do not supply image links or describe pictures: pictures are found separately. For \
"travelAdvice", \
fetch the country's page on https://www.gov.uk/foreign-travel-advice/ itself and give its current \
headline in one or two sentences; write plain text (no markdown, no HTML); British English.
"""


# -- the researcher (cmd, via cmdchat.py) ---------------------------------------------------------


class ResearchError(Exception):
    """A research call failed (cmd refused the run, or a poll could not be answered)."""


class ResearchUnavailableError(ResearchError):
    """cmd could not be reached to start a run — holiday packs are not available right now."""


@dataclass(frozen=True, slots=True)
class ResearchRun:
    """A research run as the job sees it. `status` is cmd's
    (`queued|running|completed|error|timeout|cancelled`); `response_text` is the final assistant
    message once `completed`."""

    run_id: str
    status: str
    response_text: str | None


class AdventureResearcher(Protocol):
    """What the pack job needs from the research backend — `create_app(adventure_researcher=...)`
    is the seam (the fleet's default is `CmdAdventureResearcher`; tests inject fakes)."""

    async def start(self, *, prompt: str, cwd: Path) -> str:
        """Start a run and return its id. Raises `ResearchUnavailableError` when cmd cannot be
        reached, `ResearchError` for any other refusal."""
        ...

    async def poll(self, run_id: str) -> ResearchRun:
        """The run's current state. Raises `ResearchError` when it cannot be read right now."""
        ...

    async def cancel(self, run_id: str) -> None:
        """Best-effort, idempotent terminate; never raises."""
        ...


class CmdAdventureResearcher:
    """The fleet's researcher: hidden `POST /api/chat-spawn/runs` runs on the subscription, through
    `CmdChatClient` (`cmdchat.py` stays the only module that talks to cmd). The client is the app's
    own, so it is closed with the app."""

    def __init__(self, client: CmdChatClient) -> None:
        self._client = client

    async def start(self, *, prompt: str, cwd: Path) -> str:
        try:
            run = await self._client.spawn_run(
                caller=PACK_CALLER,
                prompt=prompt,
                model=PACK_MODEL,
                effort=PACK_EFFORT,
                cwd=cwd.as_posix(),
                timeout_secs=PACK_RUN_TIMEOUT_S,
                disallowed_tools=list(DISALLOWED_TOOLS),
            )
        except CmdChatUnreachableError as exc:
            raise ResearchUnavailableError("cmd could not be reached") from exc
        except CmdChatError as exc:
            raise ResearchError(f"cmd refused the research run: {str(exc)[:200]}") from exc
        return run.run_id

    async def poll(self, run_id: str) -> ResearchRun:
        try:
            run = await self._client.get_run(run_id)
        except CmdChatError as exc:
            raise ResearchError(f"cmd could not report on the run: {str(exc)[:200]}") from exc
        return ResearchRun(run_id=run.run_id, status=run.status, response_text=run.response_text)

    async def cancel(self, run_id: str) -> None:
        try:
            await self._client.cancel_run(run_id)
        except CmdChatError:
            _LOGGER.warning("could not cancel research run %s", run_id)


# -- the job -------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PackTiming:
    """The job's pacing; the defaults are the spec's. Tests and the e2e fixture shorten them."""

    poll_interval_s: float = 10.0
    spawn_gap_s: float = 5.0
    give_up_s: float = 25.0 * 60.0
    early_retry_s: float = 150.0
    concurrency: int = 2
    max_consecutive_poll_errors: int = 30


class PictureJob(Protocol):
    """The pack's second step (spec §4.3a), implemented by `adventure_pictures.AdventurePictureJob`:
    once the text pack is stored `ready`, the server finds and fetches its pictures. A Protocol so
    this module does not import the picture module (which imports this one)."""

    async def run(self, anchor_seq: int) -> None:
        """Find and attach the round's pictures; never raises for an ordinary failure."""
        ...

    async def resume(self, background: ContainedTaskGroup) -> int:
        """Startup recovery: redo the hunt for every round whose pictures were still pending."""
        ...

    async def watch_forever(self, background: ContainedTaskGroup) -> None:
        """The supervised self-healing loop: re-run hunts pending longer than a hunt can take."""
        ...


class AdventurePackRunner:
    """Runs the holiday-pack job for rounds whose pack is `pending`. One instance per app; it
    keeps no per-round state in memory — the round row (and the compare-and-set writes against it)
    is the truth, so a restart or an overlapping process cannot lose or double a result.

    With a `pictures` job configured, a pack that lands `ready` starts its picture wait in the same
    write (`images = pending`) and the job then runs, outside the research slot; without one the
    pack simply has no pictures (the standalone edition, and a server with no media pipeline)."""

    def __init__(
        self,
        *,
        store: LiveChatStore,
        bank: AdventureBank,
        researcher: AdventureResearcher | None,
        notifier: LiveChatNotifier,
        cwd: Path,
        timing: PackTiming | None = None,
        clock: Callable[[], float] = time.monotonic,
        pictures: PictureJob | None = None,
    ) -> None:
        self._store = store
        self._bank = bank
        self._researcher = researcher
        self._notifier = notifier
        self._cwd = cwd
        self._pictures = pictures
        self._timing = timing if timing is not None else PackTiming()
        self._clock = clock
        # Created on first use, inside the running event loop (anyio primitives bind to it).
        self._limiter: CapacityLimiter | None = None
        self._spawn_lock: anyio.Lock | None = None
        self._last_spawn: float | None = None

    @property
    def available(self) -> bool:
        """Whether a researcher is configured (`pack = unavailable` at once when not)."""
        return self._researcher is not None

    def prepare_directory(self) -> None:
        """Create the empty working folder cmd runs the research in (blocking; call from a
        thread)."""
        self._cwd.mkdir(parents=True, exist_ok=True)

    async def resume(self, background: ContainedTaskGroup) -> int:
        """Startup recovery: start the job for every round whose pack is `pending` (resuming the
        run it recorded, or starting one if the process died before the spawn). Without a
        researcher those rounds can never finish, so they become `unavailable`. Returns how many
        rounds were found."""
        pending = await anyio.to_thread.run_sync(self._store.adventure_pending_packs)
        for anchor_seq, run_id in pending:
            if self._researcher is None:
                await self._finish(
                    anchor_seq,
                    run_id,
                    "unavailable",
                    error=ADVENTURE_PACK_UNAVAILABLE_TEXT,
                )
            else:
                background.spawn("livechat-adventure-pack", self.run_job, anchor_seq)
        if self._pictures is not None:
            await self._pictures.resume(background)
        return len(pending)

    def supervise_pictures(self, background: ContainedTaskGroup) -> None:
        """Start the picture job's self-healing sweep as a supervised app-lifetime loop (Inv 47):
        a pending picture wait never depends on a startup redo alone. A no-op without pictures."""
        pictures = self._pictures
        if pictures is None:
            return

        async def _watch() -> None:
            await pictures.watch_forever(background)

        background.supervise("livechat-adventure-pictures-watch", _watch)

    async def run_job(self, anchor_seq: int) -> None:
        """Research the round's destination and land the outcome on its row; once the pack is
        `ready` (and pictures are configured) go on to find its pictures. Never raises for an
        ordinary failure (it becomes `pack = failed`); only cancellation (shutdown) propagates, and
        the round stays `pending` for the next start to resume."""
        researcher = self._researcher
        if researcher is None:
            return
        limiter, spawn_lock = self._primitives()
        pictures_due = False
        try:
            async with limiter:
                pictures_due = await self._run(anchor_seq, researcher, spawn_lock)
        except Exception:
            _LOGGER.exception("adventure holiday pack job for round %s failed", anchor_seq)
            try:
                row = await anyio.to_thread.run_sync(
                    lambda: self._store.get_adventure_round(anchor_seq=anchor_seq)
                )
                if row is not None:
                    await self._finish(
                        anchor_seq,
                        row.pack_run_id,
                        "failed",
                        error=ADVENTURE_PACK_FAILED_TEXT,
                    )
            except Exception:
                _LOGGER.exception("could not mark round %s's holiday pack failed", anchor_seq)
        if pictures_due and self._pictures is not None:
            # The text pack is already stored and published; the pictures follow when found.
            await self._pictures.run(anchor_seq)

    def _primitives(self) -> tuple[CapacityLimiter, anyio.Lock]:
        if self._limiter is None:
            self._limiter = CapacityLimiter(self._timing.concurrency)
        if self._spawn_lock is None:
            self._spawn_lock = anyio.Lock()
        return self._limiter, self._spawn_lock

    async def _finish(
        self,
        anchor_seq: int,
        run_id: str | None,
        state: Literal["ready", "failed", "unavailable"],
        *,
        pack_json: str | None = None,
        error: str | None = None,
        pictures_pending: bool = False,
    ) -> bool:
        changed = await anyio.to_thread.run_sync(
            lambda: self._store.finish_adventure_pack(
                anchor_seq=anchor_seq,
                run_id=run_id,
                state=state,
                pack_json=pack_json,
                error=error,
                pictures_pending=pictures_pending,
            )
        )
        if changed:
            self._notifier.publish()
        return changed

    async def _still_waiting(self, anchor_seq: int, run_id: str | None) -> bool:
        """Whether the round still has a `pending` pack waiting on exactly `run_id`."""
        row = await anyio.to_thread.run_sync(
            lambda: self._store.get_adventure_round(anchor_seq=anchor_seq)
        )
        return row is not None and row.pack == "pending" and row.pack_run_id == run_id

    async def _start_run(
        self,
        researcher: AdventureResearcher,
        spawn_lock: anyio.Lock,
        anchor_seq: int,
        prompt: str,
        expected_run_id: str | None,
    ) -> str | None:
        """Start a run (spawns serialised and at least `spawn_gap_s` apart) and record it on the
        round. Returns the new run id, or `None` when the job is over — the round no longer wanted
        a run, cmd could not start one (the outcome is already stored), or another process won the
        compare-and-set (our run is cancelled)."""
        async with spawn_lock:
            if not await self._still_waiting(anchor_seq, expected_run_id):
                return None
            if self._last_spawn is not None:
                wait = self._last_spawn + self._timing.spawn_gap_s - self._clock()
                if wait > 0:
                    await anyio.sleep(wait)
            self._last_spawn = self._clock()
            try:
                run_id = await researcher.start(prompt=prompt, cwd=self._cwd)
            except ResearchUnavailableError:
                await self._finish(
                    anchor_seq,
                    expected_run_id,
                    "unavailable",
                    error=ADVENTURE_PACK_UNAVAILABLE_TEXT,
                )
                return None
            except ResearchError:
                _LOGGER.warning("cmd refused the holiday pack research for round %s", anchor_seq)
                await self._finish(
                    anchor_seq, expected_run_id, "failed", error=ADVENTURE_PACK_FAILED_TEXT
                )
                return None
            finally:
                self._last_spawn = self._clock()
        recorded = await anyio.to_thread.run_sync(
            lambda: self._store.set_adventure_pack_run(
                anchor_seq=anchor_seq, run_id=run_id, expected_run_id=expected_run_id
            )
        )
        if not recorded:
            await researcher.cancel(run_id)
            return None
        return run_id

    async def _run(
        self, anchor_seq: int, researcher: AdventureResearcher, spawn_lock: anyio.Lock
    ) -> bool:
        """Drive the research to its outcome. Returns True exactly when THIS call stored the pack
        `ready` and its picture wait is pending (the caller then runs the picture job)."""
        row = await anyio.to_thread.run_sync(
            lambda: self._store.get_adventure_round(anchor_seq=anchor_seq)
        )
        if row is None or row.pack != "pending":
            return False
        destination = (
            self._bank.destination(row.destination_id) if row.destination_id is not None else None
        )
        if destination is None:
            await self._finish(
                anchor_seq, row.pack_run_id, "failed", error=ADVENTURE_PACK_FAILED_TEXT
            )
            return False
        prompt = build_prompt(destination, self._bank.unit_name(row.country_id or ""))

        timing = self._timing
        deadline = self._clock() + timing.give_up_s
        run_id = row.pack_run_id
        may_retry = run_id is None  # a resumed run has no known start, so no early retry
        if run_id is None:
            run_id = await self._start_run(researcher, spawn_lock, anchor_seq, prompt, None)
            if run_id is None:
                return False
        started = self._clock()
        poll_errors = 0

        while True:
            if not await self._still_waiting(anchor_seq, run_id):
                # Rejected, deleted, retried or finished by another process meanwhile.
                await researcher.cancel(run_id)
                return False
            run: ResearchRun | None = None
            try:
                run = await researcher.poll(run_id)
                poll_errors = 0
            except ResearchError:
                poll_errors += 1
                if poll_errors >= timing.max_consecutive_poll_errors:
                    _LOGGER.warning("giving up on research run %s: cmd keeps failing", run_id)
                    await self._finish(
                        anchor_seq, run_id, "failed", error=ADVENTURE_PACK_FAILED_TEXT
                    )
                    return False

            if run is not None:
                if run.status == "completed":
                    pack = parse_pack(run.response_text or "")
                    if pack is None:
                        _LOGGER.warning("research run %s returned no usable pack", run_id)
                        await self._finish(
                            anchor_seq, run_id, "failed", error=ADVENTURE_PACK_FAILED_TEXT
                        )
                        return False
                    stored = await self._finish(
                        anchor_seq,
                        run_id,
                        "ready",
                        pack_json=canonical_pack_json(pack),
                        pictures_pending=self._pictures is not None,
                    )
                    return stored and self._pictures is not None
                if run.status in ("error", "timeout", "cancelled"):
                    early = self._clock() - started <= timing.early_retry_s
                    if run.status == "error" and may_retry and early:
                        may_retry = False
                        retried = await self._start_run(
                            researcher, spawn_lock, anchor_seq, prompt, run_id
                        )
                        if retried is None:
                            return False
                        run_id = retried
                        started = self._clock()
                        continue
                    _LOGGER.warning("research run %s ended %s", run_id, run.status)
                    await self._finish(
                        anchor_seq, run_id, "failed", error=ADVENTURE_PACK_FAILED_TEXT
                    )
                    return False

            if self._clock() >= deadline:
                _LOGGER.warning("research run %s did not finish in time; giving up", run_id)
                await researcher.cancel(run_id)
                await self._finish(anchor_seq, run_id, "failed", error=ADVENTURE_PACK_FAILED_TEXT)
                return False
            await anyio.sleep(timing.poll_interval_s)
