"""The Cookout AI jobs (workspace 00058, spec/server-chat/09-cookout.md §3.1, §3.2, §3.4, §3.5).

Two hidden cmd chat runs (`cmdchat.py` is the ONE chokepoint to cmd, Inv 13), neither of which has
any tool at all:

- **Stage 1 — concepts.** When the tenth pick lands, ONE run invents three distinct recipe
  concepts from the ten picked ingredients plus the eight cupboard staples. The answer is checked
  by deterministic Python (`parse_concepts`): structure, an id whitelist, coverage, technique
  diversity and a lexical contraband scan of every prose field against the bank's names and
  aliases. One repair run, naming the violations, is allowed under the same deadline; a second
  failure ends the job `failed` (retryable by the players). There is no second LLM checker.
- **Stage 2 — "Bank this".** One run per tapped concept writes the full recipe (`parse_recipe`,
  the same two scan passes over the frozen manifest) and only a validated recipe is `banked`.

What leaves this server is food only: the ten ingredient records (id, name, category, blurb, sorted
by id so pick order and player attribution are stripped) and the eight staples — never a player
name, email, message or any chat detail. cmd keeps its own copy of each run's prompt and answer in
its hidden `chat-spawn` ledger, which this server cannot erase (Inv 57).

Concurrency and recovery follow `adventure_pack.py`: at most 2 runs in flight, spawns at least 5 s
apart, every write a compare-and-set on `(pending AND run_id = <this run>)` so a blue/green overlap
stores a result once and a retried or deleted round is left alone, a persisted run id is resumed at
startup, and a supervised 60 s sweep restarts any pending job this process is not already driving
(and clears stale `server/cookout-tmp/` scratch and re-runs abandoned picture waits).
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence, Set
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Literal, Protocol

import anyio
import anyio.to_thread
from anyio import CapacityLimiter

from wixy_server.background import ContainedTaskGroup
from wixy_server.cmdchat import CmdChatClient, CmdChatError, CmdChatUnreachableError
from wixy_server.livechat.notifier import LiveChatNotifier

_LOGGER = logging.getLogger(__name__)

CONCEPTS_CALLER: Final = "wixy-cookout-concepts"
RECIPE_CALLER: Final = "wixy-cookout-recipe"
MODEL: Final = "claude-sonnet-5-5"
EFFORT: Final = "medium"
RUN_TIMEOUT_S: Final = 300
JOBS_DIRNAME: Final = "cookout-jobs"
"""An empty, non-git folder under the server's private storage that cmd runs the jobs in."""
JOB_DEADLINE_S: Final = 900.0
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
    "WebSearch",
    "WebFetch",
)

CONCEPT_IDS: Final = ("a", "b", "c")
FREE_SEASONING_IDS: Final = frozenset({"water", "salt", "black-pepper"})
NON_SEASONING_STAPLE_IDS: Final = frozenset(
    {"butter", "plain-flour", "cooking-oil", "granulated-sugar", "milk"}
)
MAX_EXTRA_STAPLES: Final = 4
DISH_TYPES: Final = (
    "bowl",
    "traybake",
    "stew",
    "soup",
    "salad",
    "pie",
    "pasta",
    "rice",
    "flatbread",
    "sandwich",
    "pancake",
    "fritter",
    "omelette",
    "bake",
    "dessert",
    "platter",
)
TECHNIQUES: Final = ("roast", "bake", "pan-fry", "simmer", "steam", "grill", "no-cook", "mixed")
BASKET_MARKER: Final = "BASKET_JSON: "
CONCEPT_MARKER: Final = "CONCEPT_JSON: "
"""Single-line JSON markers in the prompts (the fake cmd of tests and e2e reads the basket back
out of them)."""

MIN_PICKED_EACH: Final = 7
MIN_PICKED_BEST: Final = 8
MAX_VIOLATIONS_SHOWN: Final = 12

_WHITESPACE_RE = re.compile(r"\s+")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


# -- the bank (the slice of cookout_bank.CookoutBank, spec Appendix A.1, this module uses) -------


class IngredientLike(Protocol):
    @property
    def id(self) -> str: ...
    @property
    def name(self) -> str: ...
    @property
    def category(self) -> str: ...
    @property
    def blurb(self) -> str: ...


class StapleLike(Protocol):
    @property
    def id(self) -> str: ...
    @property
    def name(self) -> str: ...


class AiBank(Protocol):
    @property
    def staples(self) -> Sequence[StapleLike]: ...

    def ingredient(self, ingredient_id: str) -> IngredientLike | None: ...

    def staple(self, staple_id: str) -> StapleLike | None: ...

    def find_contraband_ingredients(
        self,
        text: str,
        *,
        allowed_ingredient_ids: Set[str],
        allowed_staple_ids: Set[str],
        omitted_ingredient_ids: Set[str] = frozenset(),
        allow_omitted_mentions: bool = False,
    ) -> list[str]: ...


class BankNamer:
    """Resolves ids to display names for the picture prompt (`cookout_images.DishNamer`)."""

    def __init__(self, bank: AiBank) -> None:
        self._bank = bank

    def ingredient_name(self, ingredient_id: str) -> str | None:
        found = self._bank.ingredient(ingredient_id)
        return found.name if found is not None else None

    def staple_name(self, staple_id: str) -> str | None:
        found = self._bank.staple(staple_id)
        return found.name if found is not None else None


# -- prompts -------------------------------------------------------------------------------------


def _compact(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def basket_payload(bank: AiBank, picked_ids: Sequence[str]) -> dict[str, Any] | None:
    """The food-only facts a concept prompt carries: the ten picked ingredients sorted by id (so
    neither pick order nor which player chose what survives) and the eight staples. `None` when a
    picked id is not in the bank."""
    records: list[dict[str, str]] = []
    for ingredient_id in sorted(picked_ids):
        found = bank.ingredient(ingredient_id)
        if found is None:
            return None
        records.append(
            {
                "id": found.id,
                "name": found.name,
                "category": found.category,
                "blurb": found.blurb,
            }
        )
    return {
        "ingredients": records,
        "staples": [{"id": s.id, "name": s.name} for s in bank.staples],
    }


def build_concepts_prompt(basket: Mapping[str, Any]) -> str:
    return f"""You are a creative, practical home-cooking chef. Two friends have picked ten \
ingredients between them. Invent THREE distinct recipe concepts for two people that try hard to \
use ALL ten picked ingredients, then reply with a single JSON object.

{BASKET_MARKER}{_compact(basket)}

Rules:
- Use ONLY the picked ingredients (by "id") and the cupboard staples (by "id"). Never \
introduce any other food: no unpicked fruit, vegetable, stock, garlic, herb, spice, sauce or \
anything else, anywhere in any text. Water, salt and black-pepper are always free. At most \
{MAX_EXTRA_STAPLES} of butter, plain-flour, cooking-oil, granulated-sugar and milk may be used \
in one concept, and only when they are not already picked.
- Each concept uses at least {MIN_PICKED_EACH} of the ten picked ingredients, at least one uses \
{MIN_PICKED_BEST} or more, and between them the three concepts use all ten.
- The three concepts must be genuinely different: three different (dishType, technique) pairs and \
at least two different dishType values.
- "omitted" lists every picked ingredient the concept does NOT use (exactly the complement of \
"pickedIngredientIds"), each with a short reason. NEVER mention an omitted ingredient anywhere \
except inside its own omitted "reason".
- Write "title", "vibe" and "description" naming only foods the concept uses. British English, \
plain text, no markdown.

Your FINAL message must be exactly one JSON object and nothing else (no text before or after it, \
no markdown fences):

{{"concepts": [ {{"id": "a" | "b" | "c",
   "title": string (1-90 chars),
   "vibe": string (1-40 chars),
   "dishType": one of {", ".join(DISH_TYPES)},
   "technique": one of {", ".join(TECHNIQUES)},
   "description": string (20-500 chars),
   "pickedIngredientIds": [picked ingredient ids used],
   "stapleIds": [staple ids used, excluding any id already in pickedIngredientIds],
   "omitted": [ {{"id": picked id not used, "reason": string (1-140 chars)}} ]}} ]}}  \
(exactly three concepts, ids a, b and c)
"""


def build_repair_suffix(violations: Sequence[str]) -> str:
    shown = list(violations)[:MAX_VIOLATIONS_SHOWN]
    lines = "\n".join(f"- {v}" for v in shown)
    more = len(violations) - len(shown)
    tail = f"\n- ... and {more} more" if more > 0 else ""
    return f"""

Your previous answer was REJECTED for these reasons:
{lines}{tail}

Reply again with the complete corrected JSON object (same rules, nothing else).
"""


def build_recipe_prompt(concept: Mapping[str, Any], manifest: Mapping[str, Any]) -> str:
    payload = {
        "title": concept["title"],
        "vibe": concept["vibe"],
        "dishType": concept["dishType"],
        "technique": concept["technique"],
        "description": concept["description"],
        "manifest": manifest,
    }
    return f"""You are a careful home-cooking recipe writer. Write the full recipe for the dish \
below (serves 2) and reply with a single JSON object.

{CONCEPT_MARKER}{_compact(payload)}

Rules:
- The manifest lists the ONLY ingredients available: "ingredients" are the picked ingredients the \
dish uses and "staples" the cupboard staples it uses. Water, salt and black-pepper are always free \
too. Use every manifest item and nothing else: never add any other food, and never mention any \
other food in any text (no butter, flour, oil, sugar or milk unless it is in the manifest).
- Quantities are for 2 servings, in metric. Every ingredient id must be used in at least one step.
- British English, plain text, no markdown.

Your FINAL message must be exactly one JSON object and nothing else (no text before or after it, \
no markdown fences):

{{"serves": 2, "prepMinutes": integer (0-240), "cookMinutes": integer (0-480),
 "ingredients": [ {{"id": manifest id or water/salt/black-pepper, "quantity": string (1-80 chars), \
"note": string (max 120 chars, may be empty)}} ]  (1-24, each id once, covering the whole \
manifest),
 "steps": [ {{"text": string (1-600 chars), "minutes": integer (0-480) | null, "uses": [ingredient \
ids this step uses]}} ]  (2-20),
 "tips": [string (1-240 chars)]  (0-4)}}
"""


# -- parsing and deterministic validation --------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Parsed:
    """The outcome of validating a run's answer: the canonical value when it passed, else every
    violation found (what a repair run is told)."""

    value: dict[str, Any] | None
    violations: tuple[str, ...]


def json_objects(text: str) -> list[object]:
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


def _text(
    value: object,
    where: str,
    low: int,
    high: int,
    problems: list[str],
    *,
    allow_empty: bool = False,
) -> str:
    if not isinstance(value, str):
        problems.append(f"{where} must be a string")
        return ""
    cleaned = _WHITESPACE_RE.sub(" ", _CONTROL_RE.sub(" ", value)).strip()
    if not cleaned and allow_empty:
        return ""
    if not low <= len(cleaned) <= high:
        problems.append(f"{where} must be {low}-{high} characters (it is {len(cleaned)})")
    return cleaned


def _id_list(value: object, where: str, problems: list[str]) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(i, str) for i in value):
        problems.append(f"{where} must be a list of ids")
        return []
    ids = [str(i) for i in value]
    if len(set(ids)) != len(ids):
        problems.append(f"{where} must not repeat an id")
    return ids


def _int(value: object, where: str, low: int, high: int, problems: list[str]) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        problems.append(f"{where} must be a whole number {low}-{high}")
        return low
    return value


def _normal(title: str) -> str:
    return _WHITESPACE_RE.sub(" ", title).casefold()


def _scan(
    bank: AiBank,
    text: str,
    where: str,
    *,
    used_ids: Set[str],
    staple_ids: Set[str],
    omitted_ids: Set[str],
    problems: list[str],
) -> None:
    """The lexical contraband scan of one CONSUMPTION field: no bank food the dish does not use
    (a picked ingredient it omits, an undeclared staple, any unpicked ingredient)."""
    if not text:
        return
    found = bank.find_contraband_ingredients(
        text,
        allowed_ingredient_ids=used_ids,
        allowed_staple_ids=set(staple_ids) | FREE_SEASONING_IDS,
        omitted_ingredient_ids=omitted_ids,
        allow_omitted_mentions=False,
    )
    for name in found:
        problems.append(f"{where} mentions '{name}', which this dish does not use")


def parse_concepts(response_text: str, *, bank: AiBank, picked_ids: Sequence[str]) -> Parsed:
    """Validate a concepts run's final message (spec §3.2). The LAST JSON object carrying a
    `concepts` list is judged; on success the canonical value to store
    (`{"concepts": [...]}`, ids only — the server resolves names) is returned."""
    selected = list(picked_ids)
    selected_set = set(selected)
    candidate: dict[str, Any] | None = None
    for obj in reversed(json_objects(response_text)):
        if isinstance(obj, dict) and isinstance(obj.get("concepts"), list):
            candidate = obj
            break
    if candidate is None:
        return Parsed(None, ("the answer is not a JSON object with a 'concepts' list",))
    raw_concepts = candidate["concepts"]
    problems: list[str] = []
    if len(raw_concepts) != 3 or not all(isinstance(c, dict) for c in raw_concepts):
        return Parsed(None, ("'concepts' must hold exactly three objects (ids a, b and c)",))
    by_id: dict[str, dict[str, Any]] = {}
    for raw in raw_concepts:
        cid = raw.get("id")
        if cid in CONCEPT_IDS and cid not in by_id:
            by_id[str(cid)] = raw
    if set(by_id) != set(CONCEPT_IDS):
        return Parsed(None, ("the three concepts must have the ids a, b and c, once each",))

    concepts: list[dict[str, Any]] = []
    titles: set[str] = set()
    for cid in CONCEPT_IDS:
        raw = by_id[cid]
        tag = f"concept {cid}"
        title = _text(raw.get("title"), f"{tag} title", 1, 90, problems)
        if _normal(title) in titles:
            problems.append(f"{tag} title repeats another concept's title")
        titles.add(_normal(title))
        vibe = _text(raw.get("vibe"), f"{tag} vibe", 1, 40, problems)
        description = _text(raw.get("description"), f"{tag} description", 20, 500, problems)
        dish_type = raw.get("dishType")
        if dish_type not in DISH_TYPES:
            problems.append(f"{tag} dishType must be one of {', '.join(DISH_TYPES)}")
        technique = raw.get("technique")
        if technique not in TECHNIQUES:
            problems.append(f"{tag} technique must be one of {', '.join(TECHNIQUES)}")

        used = _id_list(raw.get("pickedIngredientIds"), f"{tag} pickedIngredientIds", problems)
        for ingredient_id in used:
            if ingredient_id not in selected_set:
                problems.append(f"{tag} uses '{ingredient_id}', which is not one of the ten picks")
        used_set = {i for i in used if i in selected_set}

        staples = _id_list(raw.get("stapleIds"), f"{tag} stapleIds", problems)
        for staple_id in staples:
            if bank.staple(staple_id) is None:
                problems.append(
                    f"{tag} stapleIds has '{staple_id}', which is not a cupboard staple"
                )
            elif staple_id in used:
                problems.append(f"{tag} stapleIds repeats picked ingredient '{staple_id}'")
        extra = [s for s in staples if s in NON_SEASONING_STAPLE_IDS]
        if len(extra) > MAX_EXTRA_STAPLES:
            problems.append(f"{tag} uses more than {MAX_EXTRA_STAPLES} extra staples")

        omitted_raw = raw.get("omitted")
        omitted: list[dict[str, str]] = []
        if not isinstance(omitted_raw, list):
            problems.append(f"{tag} omitted must be a list")
            omitted_raw = []
        for item in omitted_raw:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                problems.append(f"{tag} omitted entries must be {{id, reason}} objects")
                continue
            reason = _text(item.get("reason"), f"{tag} omitted reason", 1, 140, problems)
            omitted.append({"id": str(item["id"]), "reason": reason})
        omitted_ids = [o["id"] for o in omitted]
        if len(set(omitted_ids)) != len(omitted_ids) or set(omitted_ids) != (
            selected_set - used_set
        ):
            problems.append(f"{tag} omitted must be exactly the picked ingredients it does not use")

        coverage = len(used_set)
        if coverage < MIN_PICKED_EACH:
            problems.append(
                f"{tag} uses only {coverage} picks; each concept needs {MIN_PICKED_EACH}+"
            )

        # Lexical scans (only meaningful once the ids are sane, but cheap and informative anyway).
        omitted_set = set(omitted_ids) & selected_set
        staple_set = {s for s in staples if bank.staple(s) is not None}
        for field_name, value in (("title", title), ("vibe", vibe), ("description", description)):
            _scan(
                bank,
                value,
                f"{tag} {field_name}",
                used_ids=used_set,
                staple_ids=staple_set,
                omitted_ids=omitted_set,
                problems=problems,
            )
        for item in omitted:
            found = bank.find_contraband_ingredients(
                item["reason"],
                allowed_ingredient_ids=selected_set,
                allowed_staple_ids=staple_set | FREE_SEASONING_IDS,
                omitted_ingredient_ids=omitted_set,
                allow_omitted_mentions=True,
            )
            for name in found:
                problems.append(f"{tag} omitted reason mentions '{name}', which is not a pick")

        concepts.append(
            {
                "id": cid,
                "title": title,
                "vibe": vibe,
                "dishType": dish_type,
                "technique": technique,
                "description": description,
                "pickedIngredientIds": used,
                "stapleIds": staples,
                "omitted": omitted,
            }
        )

    counts = [len(c["pickedIngredientIds"]) for c in concepts]
    if max(counts) < MIN_PICKED_BEST:
        problems.append(f"at least one concept must use {MIN_PICKED_BEST}+ of the ten picks")
    union: set[str] = set()
    for c in concepts:
        union.update(c["pickedIngredientIds"])
    uncovered = sorted(selected_set - union)
    if uncovered:
        problems.append(f"no concept uses these picks: {', '.join(uncovered)}")
    pairs = {(c["dishType"], c["technique"]) for c in concepts}
    if len(pairs) != 3:
        problems.append("the three concepts need three different (dishType, technique) pairs")
    if len({c["dishType"] for c in concepts}) < 2:
        problems.append("the three concepts need at least two different dishType values")

    if problems:
        return Parsed(None, tuple(problems))
    return Parsed({"concepts": concepts}, ())


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def concept_manifest(concept: Mapping[str, Any], bank: AiBank) -> dict[str, Any]:
    """The frozen manifest a recipe prompt carries: the concept's used picks and declared staples
    with their names (plus the always-free seasonings)."""
    ingredients: list[dict[str, str]] = []
    for ingredient_id in concept["pickedIngredientIds"]:
        found = bank.ingredient(ingredient_id)
        if found is not None:
            ingredients.append({"id": found.id, "name": found.name})
    staples: list[dict[str, str]] = []
    for staple_id in [*concept["stapleIds"], *sorted(FREE_SEASONING_IDS)]:
        staple = bank.staple(staple_id)
        if staple is not None and all(s["id"] != staple.id for s in staples):
            staples.append({"id": staple.id, "name": staple.name})
    return {"ingredients": ingredients, "staples": staples}


def parse_recipe(response_text: str, *, bank: AiBank, concept: Mapping[str, Any]) -> Parsed:
    """Validate a recipe run's final message against its concept's frozen manifest (spec §3.4).
    The LAST JSON object with a `steps` list is judged; on success the canonical recipe to store
    (with the server-computed `totalMinutes`) is returned."""
    candidate: dict[str, Any] | None = None
    for obj in reversed(json_objects(response_text)):
        if isinstance(obj, dict) and isinstance(obj.get("steps"), list):
            candidate = obj
            break
    if candidate is None:
        return Parsed(None, ("the answer is not a JSON recipe object with 'steps'",))
    problems: list[str] = []
    picked = list(concept["pickedIngredientIds"])
    staples = list(concept["stapleIds"])
    omitted_ids = {str(o["id"]) for o in concept["omitted"]}
    manifest_ids = set(picked) | set(staples)
    allowed_ids = manifest_ids | FREE_SEASONING_IDS

    if candidate.get("serves") != 2 or isinstance(candidate.get("serves"), bool):
        problems.append("serves must be 2")
    prep = _int(candidate.get("prepMinutes"), "prepMinutes", 0, 240, problems)
    cook = _int(candidate.get("cookMinutes"), "cookMinutes", 0, 480, problems)
    if not 1 <= prep + cook <= 720:
        problems.append("prepMinutes + cookMinutes must be 1-720")

    raw_ingredients = candidate.get("ingredients")
    ingredients: list[dict[str, str]] = []
    if not isinstance(raw_ingredients, list) or not 1 <= len(raw_ingredients) <= 24:
        problems.append("ingredients must be a list of 1-24 items")
        raw_ingredients = []
    for item in raw_ingredients:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            problems.append("each ingredient must be an {id, quantity, note} object")
            continue
        ingredient_id = str(item["id"])
        if ingredient_id in omitted_ids:
            problems.append(f"ingredient '{ingredient_id}' is an omitted pick and may not be used")
        elif ingredient_id not in allowed_ids:
            problems.append(f"ingredient '{ingredient_id}' is not in this dish's manifest")
        quantity = _text(item.get("quantity"), f"{ingredient_id} quantity", 1, 80, problems)
        raw_note = item.get("note", "")
        note = _text(
            "" if raw_note is None else raw_note,
            f"{ingredient_id} note",
            0,
            120,
            problems,
            allow_empty=True,
        )
        ingredients.append({"id": ingredient_id, "quantity": quantity, "note": note})
    recipe_ids = [i["id"] for i in ingredients]
    if len(set(recipe_ids)) != len(recipe_ids):
        problems.append("ingredients must not repeat an id")
    missing = sorted(manifest_ids - set(recipe_ids))
    if missing:
        problems.append(f"ingredients must cover the whole manifest; missing: {', '.join(missing)}")
    recipe_set = set(recipe_ids)

    raw_steps = candidate.get("steps")
    steps: list[dict[str, Any]] = []
    if not isinstance(raw_steps, list) or not 2 <= len(raw_steps) <= 20:
        problems.append("steps must be a list of 2-20 items")
        raw_steps = []
    used_in_steps: set[str] = set()
    for index, step in enumerate(raw_steps, start=1):
        if not isinstance(step, dict):
            problems.append(f"step {index} must be an object")
            continue
        text = _text(step.get("text"), f"step {index} text", 1, 600, problems)
        minutes_raw = step.get("minutes")
        minutes: int | None = None
        if minutes_raw is not None:
            minutes = _int(minutes_raw, f"step {index} minutes", 0, 480, problems)
        uses = _id_list(step.get("uses"), f"step {index} uses", problems)
        for ingredient_id in uses:
            if ingredient_id not in recipe_set:
                problems.append(f"step {index} uses '{ingredient_id}', which is not a recipe item")
        used_in_steps.update(uses)
        steps.append({"text": text, "minutes": minutes, "uses": uses})
    unused = sorted(recipe_set - used_in_steps)
    if unused and raw_steps:
        problems.append(f"every ingredient must be used in a step; unused: {', '.join(unused)}")

    raw_tips = candidate.get("tips", [])
    tips: list[str] = []
    if not isinstance(raw_tips, list) or len(raw_tips) > 4:
        problems.append("tips must be a list of at most 4 strings")
        raw_tips = []
    for index, tip in enumerate(raw_tips, start=1):
        tips.append(_text(tip, f"tip {index}", 1, 240, problems))

    used_set = {i for i in picked}
    staple_set = set(staples)
    scan_args: dict[str, Any] = {
        "used_ids": used_set,
        "staple_ids": staple_set,
        "omitted_ids": omitted_ids,
        "problems": problems,
    }
    for item in ingredients:
        _scan(bank, item["quantity"], f"ingredient {item['id']} quantity", **scan_args)
        _scan(bank, item["note"], f"ingredient {item['id']} note", **scan_args)
    for index, step_item in enumerate(steps, start=1):
        _scan(bank, step_item["text"], f"step {index}", **scan_args)
    for index, tip in enumerate(tips, start=1):
        _scan(bank, tip, f"tip {index}", **scan_args)

    if problems:
        return Parsed(None, tuple(problems))
    return Parsed(
        {
            "serves": 2,
            "prepMinutes": prep,
            "cookMinutes": cook,
            "totalMinutes": prep + cook,
            "ingredients": ingredients,
            "steps": steps,
            "tips": tips,
        },
        (),
    )


# -- the store (spec Appendix A.2) ---------------------------------------------------------------


class AiStore(Protocol):
    def get_cookout_round(self, anchor_seq: int) -> dict[str, Any] | None: ...

    def set_cookout_concepts_run(
        self, anchor_seq: int, run_id: str, *, expected_run_id: str | None = None
    ) -> bool: ...

    def finish_cookout_concepts(
        self,
        anchor_seq: int,
        run_id: str | None,
        state: Literal["ready", "failed", "unavailable"],
        *,
        concepts_json: str | None = None,
        error: str | None = None,
        pictures_pending: bool = False,
    ) -> bool: ...

    def cookout_pending_concepts(self) -> list[tuple[int, str | None]]: ...

    def set_cookout_recipe_run(
        self, anchor_seq: int, concept_id: str, run_id: str, *, expected_run_id: str | None = None
    ) -> bool: ...

    def finish_cookout_recipe(
        self,
        anchor_seq: int,
        concept_id: str,
        run_id: str | None,
        state: Literal["banked", "failed", "unavailable"],
        *,
        recipe_json: str | None = None,
        error: str | None = None,
    ) -> bool: ...

    def cookout_pending_recipes(self) -> list[tuple[int, str, str | None]]: ...


class PictureJobLike(Protocol):
    async def run(self, anchor_seq: int, stale_before: float | None = None) -> None: ...

    async def resume(self, background: ContainedTaskGroup) -> int: ...

    async def sweep(self, background: ContainedTaskGroup) -> int: ...


CONCEPTS_FAILED_TEXT: Final = "The chef couldn't come up with dishes this time. Try again."
CONCEPTS_UNAVAILABLE_TEXT: Final = "Recipe ideas aren't available right now."
RECIPE_FAILED_TEXT: Final = "The recipe didn't finish. Try again."
RECIPE_UNAVAILABLE_TEXT: Final = "Saving recipes isn't available right now."


# -- the runner ----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CookoutTiming:
    """The jobs' pacing; the defaults are the spec's. Tests and the e2e fixture shorten them."""

    poll_interval_s: float = 10.0
    spawn_gap_s: float = 5.0
    give_up_s: float = JOB_DEADLINE_S
    early_retry_s: float = 150.0
    concurrency: int = 2
    max_consecutive_poll_errors: int = 30
    sweep_interval_s: float = 60.0


class _RunError(Exception):
    """cmd refused a run or could not report on it."""


class _RunUnavailableError(_RunError):
    """cmd could not be reached to start a run."""


@dataclass(slots=True)
class _Spec:
    """What the shared driver needs to run one job (concepts or one recipe)."""

    name: str
    caller: str
    prompt: str
    initial_run_id: str | None
    deadline_at: float | None
    still_waiting: Callable[[str | None], Awaitable[bool]]
    record_run: Callable[[str, str | None], Awaitable[bool]]
    parse: Callable[[str], Parsed]
    finish_ok: Callable[[str, dict[str, Any]], Awaitable[bool]]
    finish_bad: Callable[[str | None, bool], Awaitable[bool]]
    """`(run_id, unavailable)`: end the job `failed` (or `unavailable`) on that run id."""


class CmdCookoutRunner:
    """Runs the Cookout concept and recipe jobs and delegates the dish pictures. One instance per
    app; it keeps no per-round state beyond the set of jobs it is driving right now — the round and
    recipe rows (and the compare-and-set writes against them) are the truth. Implements
    `CookoutRunner` (spec Appendix A.2)."""

    def __init__(
        self,
        *,
        store: AiStore,
        bank: AiBank,
        client: CmdChatClient | None,
        notifier: LiveChatNotifier,
        cwd: Path,
        pictures: PictureJobLike | None = None,
        timing: CookoutTiming | None = None,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._store = store
        self._bank = bank
        self._client = client
        self._notifier = notifier
        self._cwd = cwd
        self._pictures = pictures
        self._timing = timing if timing is not None else CookoutTiming()
        self._clock = clock
        self._wall = wall_clock
        self._limiter: CapacityLimiter | None = None
        self._spawn_lock: anyio.Lock | None = None
        self._last_spawn: float | None = None
        self._running: set[tuple[str, int, str]] = set()

    # -- CookoutRunner -----------------------------------------------------------------------

    @property
    def available(self) -> bool:
        """Whether cmd is configured (concepts and recipes are `unavailable` at once when not)."""
        return self._client is not None

    @property
    def images_available(self) -> bool:
        return self._pictures is not None

    def prepare_directory(self) -> None:
        """Create the empty working folder cmd runs the jobs in (blocking; call from a thread)."""
        self._cwd.mkdir(parents=True, exist_ok=True)

    def start_concepts(self, background: ContainedTaskGroup, anchor_seq: int) -> None:
        background.spawn("livechat-cookout-concepts", self.run_concepts, anchor_seq)

    def start_pictures(self, background: ContainedTaskGroup, anchor_seq: int) -> None:
        if self._pictures is not None:
            background.spawn("livechat-cookout-pictures", self._pictures.run, anchor_seq)

    def start_recipe(
        self, background: ContainedTaskGroup, anchor_seq: int, concept_id: str
    ) -> None:
        background.spawn("livechat-cookout-recipe", self.run_recipe, anchor_seq, concept_id)

    async def resume(self, background: ContainedTaskGroup) -> None:
        """Startup recovery: restart every pending job (resuming the run it recorded, or starting
        one if the process died before the spawn), then recover pictures and clear stale scratch.
        Without cmd those rows can never finish, so they become `unavailable`."""
        await self._restart_pending(background)
        if self._pictures is not None:
            await self._pictures.resume(background)

    def supervise(self, background: ContainedTaskGroup) -> None:
        """Start the supervised app-lifetime 60 s sweep (Inv 47): restarts any pending job this
        process is not already driving and heals abandoned picture waits / stale scratch."""

        async def _watch() -> None:
            await self.watch_forever(background)

        background.supervise("livechat-cookout-watch", _watch)

    async def watch_forever(self, background: ContainedTaskGroup) -> None:
        while True:
            await anyio.sleep(self._timing.sweep_interval_s)
            try:
                await self.sweep(background)
            except Exception:
                _LOGGER.exception("cookout: the sweep failed")

    async def sweep(self, background: ContainedTaskGroup) -> None:
        await self._restart_pending(background)
        if self._pictures is not None:
            await self._pictures.sweep(background)

    async def _restart_pending(self, background: ContainedTaskGroup) -> None:
        concepts = await anyio.to_thread.run_sync(self._store.cookout_pending_concepts)
        for anchor_seq, run_id in concepts:
            if ("c", anchor_seq, "") in self._running:
                continue
            if self._client is None:
                await self._finish_concepts(
                    anchor_seq, run_id, "unavailable", error=CONCEPTS_UNAVAILABLE_TEXT
                )
            else:
                background.spawn("livechat-cookout-concepts", self.run_concepts, anchor_seq)
        recipes = await anyio.to_thread.run_sync(self._store.cookout_pending_recipes)
        for anchor_seq, concept_id, run_id in recipes:
            if ("r", anchor_seq, concept_id) in self._running:
                continue
            if self._client is None:
                await self._finish_recipe(
                    anchor_seq, concept_id, run_id, "unavailable", error=RECIPE_UNAVAILABLE_TEXT
                )
            else:
                background.spawn("livechat-cookout-recipe", self.run_recipe, anchor_seq, concept_id)

    # -- shared primitives -------------------------------------------------------------------

    def _primitives(self) -> tuple[CapacityLimiter, anyio.Lock]:
        if self._limiter is None:
            self._limiter = CapacityLimiter(self._timing.concurrency)
        if self._spawn_lock is None:
            self._spawn_lock = anyio.Lock()
        return self._limiter, self._spawn_lock

    async def _row(self, anchor_seq: int) -> dict[str, Any] | None:
        return await anyio.to_thread.run_sync(lambda: self._store.get_cookout_round(anchor_seq))

    async def _finish_concepts(
        self,
        anchor_seq: int,
        run_id: str | None,
        state: Literal["ready", "failed", "unavailable"],
        *,
        concepts_json: str | None = None,
        error: str | None = None,
        pictures_pending: bool = False,
    ) -> bool:
        changed = await anyio.to_thread.run_sync(
            lambda: self._store.finish_cookout_concepts(
                anchor_seq,
                run_id,
                state,
                concepts_json=concepts_json,
                error=error,
                pictures_pending=pictures_pending,
            )
        )
        if changed:
            self._notifier.publish()
        return changed

    async def _finish_recipe(
        self,
        anchor_seq: int,
        concept_id: str,
        run_id: str | None,
        state: Literal["banked", "failed", "unavailable"],
        *,
        recipe_json: str | None = None,
        error: str | None = None,
    ) -> bool:
        changed = await anyio.to_thread.run_sync(
            lambda: self._store.finish_cookout_recipe(
                anchor_seq,
                concept_id,
                run_id,
                state,
                recipe_json=recipe_json,
                error=error,
            )
        )
        if changed:
            self._notifier.publish()
        return changed

    async def _spawn(self, caller: str, prompt: str) -> str:
        client = self._client
        assert client is not None
        try:
            run = await client.spawn_run(
                caller=caller,
                prompt=prompt,
                model=MODEL,
                effort=EFFORT,
                cwd=self._cwd.as_posix(),
                timeout_secs=RUN_TIMEOUT_S,
                disallowed_tools=list(DISALLOWED_TOOLS),
            )
        except CmdChatUnreachableError as exc:
            raise _RunUnavailableError("cmd could not be reached") from exc
        except CmdChatError as exc:
            raise _RunError(f"cmd refused the run: {str(exc)[:200]}") from exc
        return run.run_id

    async def _cancel(self, run_id: str) -> None:
        client = self._client
        if client is None:
            return
        try:
            await client.cancel_run(run_id)
        except CmdChatError:
            _LOGGER.warning("cookout: could not cancel run %s", run_id)

    # -- Stage 1: concepts -------------------------------------------------------------------

    async def run_concepts(self, anchor_seq: int) -> None:
        """Drive the round's concept job to its outcome; once `ready` with its picture wait
        pending, go on to the dish pictures (outside the cmd slot). Never raises for an ordinary
        failure (it becomes `concepts = failed`); only cancellation (shutdown) propagates, leaving
        the round `pending` for the next start or sweep."""
        key = ("c", anchor_seq, "")
        if key in self._running:
            return
        self._running.add(key)
        pictures_due = False
        try:
            if self._client is None:
                row = await self._row(anchor_seq)
                if row is not None and row.get("concepts") == "pending":
                    await self._finish_concepts(
                        anchor_seq,
                        row.get("concepts_run_id"),
                        "unavailable",
                        error=CONCEPTS_UNAVAILABLE_TEXT,
                    )
                return
            limiter, spawn_lock = self._primitives()
            try:
                async with limiter:
                    pictures_due = await self._concepts_job(anchor_seq, spawn_lock)
            except Exception:
                _LOGGER.exception("cookout concepts job for round %s failed", anchor_seq)
                await self._fail_after_crash(anchor_seq)
        finally:
            self._running.discard(key)
        if pictures_due and self._pictures is not None:
            await self._pictures.run(anchor_seq)

    async def _fail_after_crash(self, anchor_seq: int) -> None:
        try:
            row = await self._row(anchor_seq)
            if row is not None and row.get("concepts") == "pending":
                await self._finish_concepts(
                    anchor_seq, row.get("concepts_run_id"), "failed", error=CONCEPTS_FAILED_TEXT
                )
        except Exception:
            _LOGGER.exception("could not mark round %s's concepts failed", anchor_seq)

    async def _concepts_job(self, anchor_seq: int, spawn_lock: anyio.Lock) -> bool:
        row = await self._row(anchor_seq)
        if row is None or row.get("concepts") != "pending" or row.get("state") != "finished":
            return False
        picked = [str(i) for i in row.get("picked_ids") or []]
        basket = basket_payload(self._bank, picked)
        if basket is None or len(set(picked)) != 10:
            await self._finish_concepts(
                anchor_seq, row.get("concepts_run_id"), "failed", error=CONCEPTS_FAILED_TEXT
            )
            return False

        async def still_waiting(run_id: str | None) -> bool:
            current = await self._row(anchor_seq)
            return (
                current is not None
                and current.get("concepts") == "pending"
                and current.get("concepts_run_id") == run_id
            )

        async def record_run(run_id: str, expected: str | None) -> bool:
            return await anyio.to_thread.run_sync(
                lambda: self._store.set_cookout_concepts_run(
                    anchor_seq, run_id, expected_run_id=expected
                )
            )

        stored_ready = False

        async def finish_ok(run_id: str, value: dict[str, Any]) -> bool:
            nonlocal stored_ready
            stored_ready = await self._finish_concepts(
                anchor_seq,
                run_id,
                "ready",
                concepts_json=canonical_json(value),
                pictures_pending=self._pictures is not None,
            )
            return stored_ready

        async def finish_bad(run_id: str | None, unavailable: bool) -> bool:
            if unavailable:
                return await self._finish_concepts(
                    anchor_seq, run_id, "unavailable", error=CONCEPTS_UNAVAILABLE_TEXT
                )
            return await self._finish_concepts(
                anchor_seq, run_id, "failed", error=CONCEPTS_FAILED_TEXT
            )

        spec = _Spec(
            name=f"concepts round {anchor_seq}",
            caller=CONCEPTS_CALLER,
            prompt=build_concepts_prompt(basket),
            initial_run_id=row.get("concepts_run_id"),
            deadline_at=_float_or_none(row.get("concepts_deadline_at")),
            still_waiting=still_waiting,
            record_run=record_run,
            parse=lambda text: parse_concepts(text, bank=self._bank, picked_ids=picked),
            finish_ok=finish_ok,
            finish_bad=finish_bad,
        )
        await self._drive(spec, spawn_lock)
        return stored_ready and self._pictures is not None

    # -- Stage 2: Bank this ------------------------------------------------------------------

    async def run_recipe(self, anchor_seq: int, concept_id: str) -> None:
        """Drive one concept's full-recipe job to `banked` (or `failed`). Never raises for an
        ordinary failure; only cancellation propagates, leaving the row `pending`."""
        key = ("r", anchor_seq, concept_id)
        if key in self._running:
            return
        self._running.add(key)
        try:
            if self._client is None:
                row = await self._row(anchor_seq)
                slot = ((row or {}).get("recipes") or {}).get(concept_id) or {}
                if slot.get("state") == "pending":
                    await self._finish_recipe(
                        anchor_seq,
                        concept_id,
                        slot.get("run_id"),
                        "unavailable",
                        error=RECIPE_UNAVAILABLE_TEXT,
                    )
                return
            limiter, spawn_lock = self._primitives()
            try:
                async with limiter:
                    await self._recipe_job(anchor_seq, concept_id, spawn_lock)
            except Exception:
                _LOGGER.exception(
                    "cookout recipe job for round %s concept %s failed", anchor_seq, concept_id
                )
                try:
                    row = await self._row(anchor_seq)
                    slot = ((row or {}).get("recipes") or {}).get(concept_id) or {}
                    if slot.get("state") == "pending":
                        await self._finish_recipe(
                            anchor_seq,
                            concept_id,
                            slot.get("run_id"),
                            "failed",
                            error=RECIPE_FAILED_TEXT,
                        )
                except Exception:
                    _LOGGER.exception("could not mark %s/%s failed", anchor_seq, concept_id)
        finally:
            self._running.discard(key)

    async def _recipe_job(self, anchor_seq: int, concept_id: str, spawn_lock: anyio.Lock) -> None:
        row = await self._row(anchor_seq)
        if row is None or row.get("state") != "finished" or row.get("concepts") != "ready":
            return
        slot = (row.get("recipes") or {}).get(concept_id)
        if not isinstance(slot, dict) or slot.get("state") != "pending":
            return
        concept = _stored_concept(row, concept_id)
        if concept is None:
            await self._finish_recipe(
                anchor_seq, concept_id, slot.get("run_id"), "failed", error=RECIPE_FAILED_TEXT
            )
            return
        manifest = concept_manifest(concept, self._bank)

        async def still_waiting(run_id: str | None) -> bool:
            current = await self._row(anchor_seq)
            now_slot = ((current or {}).get("recipes") or {}).get(concept_id) or {}
            return now_slot.get("state") == "pending" and now_slot.get("run_id") == run_id

        async def record_run(run_id: str, expected: str | None) -> bool:
            return await anyio.to_thread.run_sync(
                lambda: self._store.set_cookout_recipe_run(
                    anchor_seq, concept_id, run_id, expected_run_id=expected
                )
            )

        async def finish_ok(run_id: str, value: dict[str, Any]) -> bool:
            return await self._finish_recipe(
                anchor_seq, concept_id, run_id, "banked", recipe_json=canonical_json(value)
            )

        async def finish_bad(run_id: str | None, unavailable: bool) -> bool:
            if unavailable:
                return await self._finish_recipe(
                    anchor_seq, concept_id, run_id, "unavailable", error=RECIPE_UNAVAILABLE_TEXT
                )
            return await self._finish_recipe(
                anchor_seq, concept_id, run_id, "failed", error=RECIPE_FAILED_TEXT
            )

        spec = _Spec(
            name=f"recipe {anchor_seq}/{concept_id}",
            caller=RECIPE_CALLER,
            prompt=build_recipe_prompt(concept, manifest),
            initial_run_id=slot.get("run_id"),
            deadline_at=_float_or_none(slot.get("deadline_at")),
            still_waiting=still_waiting,
            record_run=record_run,
            parse=lambda text: parse_recipe(text, bank=self._bank, concept=concept),
            finish_ok=finish_ok,
            finish_bad=finish_bad,
        )
        await self._drive(spec, spawn_lock)

    # -- the shared driver -------------------------------------------------------------------

    async def _start_run(
        self, spec: _Spec, spawn_lock: anyio.Lock, prompt: str, expected_run_id: str | None
    ) -> str | None:
        """Start a run (spawns serialised and at least `spawn_gap_s` apart) and record it. Returns
        its id, or `None` when the job is over (no longer wanted, cmd could not start one — the
        outcome is already stored — or another process won the compare-and-set)."""
        async with spawn_lock:
            if not await spec.still_waiting(expected_run_id):
                return None
            if self._last_spawn is not None:
                wait = self._last_spawn + self._timing.spawn_gap_s - self._clock()
                if wait > 0:
                    await anyio.sleep(wait)
            self._last_spawn = self._clock()
            try:
                run_id = await self._spawn(spec.caller, prompt)
            except _RunUnavailableError:
                await spec.finish_bad(expected_run_id, True)
                return None
            except _RunError:
                _LOGGER.warning("cmd refused %s", spec.name)
                await spec.finish_bad(expected_run_id, False)
                return None
            finally:
                self._last_spawn = self._clock()
        if not await spec.record_run(run_id, expected_run_id):
            await self._cancel(run_id)
            return None
        return run_id

    async def _drive(self, spec: _Spec, spawn_lock: anyio.Lock) -> None:
        timing = self._timing
        give_up_at = self._clock() + timing.give_up_s
        remaining_wall = (
            spec.deadline_at - self._wall() if spec.deadline_at is not None else timing.give_up_s
        )
        give_up_at = min(give_up_at, self._clock() + max(0.0, remaining_wall))
        run_id = spec.initial_run_id
        may_retry = run_id is None  # a resumed run has no known start, so no early retry
        repaired = False
        if run_id is None:
            run_id = await self._start_run(spec, spawn_lock, spec.prompt, None)
            if run_id is None:
                return
        started = self._clock()
        poll_errors = 0
        client = self._client
        assert client is not None

        while True:
            if not await spec.still_waiting(run_id):
                await self._cancel(run_id)  # retried, deleted or finished elsewhere meanwhile
                return
            status: str | None = None
            text: str | None = None
            try:
                run = await client.get_run(run_id)
                status, text = run.status, run.response_text
                poll_errors = 0
            except CmdChatError:
                poll_errors += 1
                if poll_errors >= timing.max_consecutive_poll_errors:
                    _LOGGER.warning("giving up on %s: cmd keeps failing", spec.name)
                    await spec.finish_bad(run_id, False)
                    return

            if status == "completed":
                parsed = spec.parse(text or "")
                if parsed.value is not None:
                    await spec.finish_ok(run_id, parsed.value)
                    return
                _LOGGER.warning(
                    "%s: answer rejected (%d violations): %s",
                    spec.name,
                    len(parsed.violations),
                    "; ".join(parsed.violations[:3]),
                )
                if repaired or self._clock() >= give_up_at:
                    await spec.finish_bad(run_id, False)
                    return
                repaired = True
                retried = await self._start_run(
                    spec, spawn_lock, spec.prompt + build_repair_suffix(parsed.violations), run_id
                )
                if retried is None:
                    return
                run_id = retried
                started = self._clock()
                continue
            if status in ("error", "timeout", "cancelled"):
                early = self._clock() - started <= timing.early_retry_s
                if status == "error" and may_retry and early:
                    may_retry = False
                    retried = await self._start_run(spec, spawn_lock, spec.prompt, run_id)
                    if retried is None:
                        return
                    run_id = retried
                    started = self._clock()
                    continue
                _LOGGER.warning("%s: run %s ended %s", spec.name, run_id, status)
                await spec.finish_bad(run_id, False)
                return

            if self._clock() >= give_up_at:
                _LOGGER.warning("%s did not finish in time; giving up", spec.name)
                await self._cancel(run_id)
                await spec.finish_bad(run_id, False)
                return
            await anyio.sleep(timing.poll_interval_s)


def _float_or_none(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def _stored_concept(row: Mapping[str, Any], concept_id: str) -> dict[str, Any] | None:
    raw = row.get("concepts_json")
    if not isinstance(raw, str):
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    concepts = data.get("concepts") if isinstance(data, dict) else None
    if not isinstance(concepts, list):
        return None
    for concept in concepts:
        if isinstance(concept, dict) and concept.get("id") == concept_id:
            return concept
    return None


def build_cookout_runner(
    *,
    store: Any,
    bank: AiBank,
    client: CmdChatClient | None,
    notifier: LiveChatNotifier,
    paths: Any,
    generator: Any | None = None,
    limiter: Callable[[], CapacityLimiter] | None = None,
    demand: Any | None = None,
    space_ok: Callable[[int], bool] | None = None,
    timing: CookoutTiming | None = None,
    picture_timing: Any | None = None,
) -> CmdCookoutRunner:
    """The runner `create_app` injects as `cookout_runner`, mirroring how the adventure pack
    runner is built: cmd-backed when `client` is given (the fleet edition), otherwise every
    concept and recipe request is `unavailable` at once (standalone). Dish pictures need a ComfyUI
    `generator` plus the shared WYR `limiter` and `demand`; without them the round has none."""
    from wixy_server.livechat.cookout_images import CookoutPictureJob

    pictures: CookoutPictureJob | None = None
    if client is not None and generator is not None and limiter is not None and demand is not None:
        pictures = CookoutPictureJob(
            store=store,
            paths=paths,
            namer=BankNamer(bank),
            generator=generator,
            notifier=notifier,
            limiter=limiter,
            demand=demand,
            space_ok=space_ok,
            timing=picture_timing,
        )
    return CmdCookoutRunner(
        store=store,
        bank=bank,
        client=client,
        notifier=notifier,
        cwd=paths.server_dir / JOBS_DIRNAME,
        pictures=pictures,
        timing=timing,
    )
