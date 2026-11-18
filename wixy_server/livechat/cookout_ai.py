"""The Cookout AI jobs (workspace 00058, spec/server-chat/09-cookout.md §3.1, §3.2, §3.4, §3.5).

Two hidden cmd chat runs (`cmdchat.py` is the ONE chokepoint to cmd, Inv 13), neither of which has
any tool at all:

- **Stage 1 — concepts.** When the tenth pick lands, ONE run invents three distinct recipe
  concepts from the ten picked ingredients plus the eight cupboard staples. The answer is checked
  by deterministic Python (`parse_concepts`): structure, an id whitelist, coverage, technique
  diversity and a lexical contraband scan of every prose field against the bank's names and
  aliases. Up to `MAX_REPAIRS` repair runs, each naming the violations, are allowed under the same
  deadline; the last failure ends the job `failed` (retryable by the players). There is no second
  LLM checker.
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
from collections import Counter
from collections.abc import Awaitable, Callable, Mapping, Sequence, Set
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Literal, Protocol

import anyio
import anyio.to_thread
from anyio import CapacityLimiter

from wixy_server.background import ContainedTaskGroup
from wixy_server.cmdchat import CmdChatClient, CmdChatError, CmdChatUnreachableError
from wixy_server.livechat.cookout_modes import Build, CookoutMode, CookoutModes, default_modes
from wixy_server.livechat.cookout_twists import (
    COOKING_VESSEL_WORDS,
    NO_OVEN_WORDS,
    challenge_by_id,
    style_by_id,
)
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
MAX_REPAIRS: Final = 3
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

BASKET_SIZES: Final = (10, 11)
"""A basket is ten picks, or eleven once the wildcard cloche was lifted (spec 09a §2.4)."""
MAX_CHALLENGE_NOTE: Final = 140
NO_OVEN_TECHNIQUES: Final = frozenset({"roast", "bake"})
NO_OVEN_DISH_TYPES: Final = frozenset({"traybake", "pie", "bake"})
COOKWARE_MAX_ITEMS: Final = 4
COOKWARE_MAX_CHARS: Final = 40
THIRTY_MINUTES: Final = 30
SIX_STEPS: Final = 6

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

    def mentions(self, text: str, ingredient_id: str) -> bool: ...

    def food_free_tokens(self, text: str) -> tuple[str, ...]: ...


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


@dataclass(frozen=True, slots=True)
class ConceptTwists:
    """The per-round twist facts a concepts job needs (spec 09a §5.3). All off by default, in which
    case every prompt and check is exactly the core's."""

    star_ids: frozenset[str] = frozenset()
    wildcard_id: str | None = None
    style: str | None = None
    challenge: str | None = None
    forbidden_ids: frozenset[str] = frozenset()

    @property
    def active(self) -> bool:
        return bool(
            self.star_ids
            or self.wildcard_id is not None
            or self.style is not None
            or self.challenge is not None
            or self.forbidden_ids
        )


@dataclass(frozen=True, slots=True)
class RecipeTwists:
    star_ids: frozenset[str] = frozenset()
    style: str | None = None
    challenge: str | None = None
    forbidden_ids: frozenset[str] = frozenset()

    @property
    def active(self) -> bool:
        return bool(
            self.star_ids
            or self.style is not None
            or self.challenge is not None
            or self.forbidden_ids
        )


_COUNT_WORDS: Final = {10: "ten", 11: "eleven"}


def _count_word(size: int) -> str:
    return _COUNT_WORDS.get(size, str(size))


def known_forbidden(bank: AiBank, forbidden_ids: Set[str]) -> list[str]:
    """The forbidden ids that are real bank ingredients or staples, sorted (privacy: nothing else
    is ever added to a prompt)."""
    return sorted(
        i for i in forbidden_ids if bank.ingredient(i) is not None or bank.staple(i) is not None
    )


def display_name(bank: AiBank, item_id: str) -> str:
    found = bank.ingredient(item_id)
    if found is not None:
        return found.name
    staple = bank.staple(item_id)
    return staple.name if staple is not None else item_id


def basket_payload(
    bank: AiBank, basket_ids: Sequence[str], *, twists: ConceptTwists | None = None
) -> dict[str, Any] | None:
    """The food-only facts a concept prompt carries: the ten (or eleven) basket ingredients sorted
    by id (so neither pick order nor which player chose what survives) and the eight staples,
    minus any swapped-out staple. Only when a twist is active a `twists` object adds the sorted
    star ids, the wildcard, the style and challenge ids and the forbidden ids. `None` when a
    basket id is not in the bank."""
    records: list[dict[str, str]] = []
    for ingredient_id in sorted(basket_ids):
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
    active = twists if twists is not None else ConceptTwists()
    forbidden = known_forbidden(bank, active.forbidden_ids)
    payload: dict[str, Any] = {
        "ingredients": records,
        "staples": [{"id": s.id, "name": s.name} for s in bank.staples if s.id not in forbidden],
    }
    extra: dict[str, Any] = {}
    if active.star_ids:
        extra["stars"] = sorted(active.star_ids)
    if active.wildcard_id is not None:
        extra["wildcard"] = active.wildcard_id
    if active.style is not None:
        extra["style"] = active.style
    if active.challenge is not None:
        extra["challenge"] = active.challenge
    if forbidden:
        extra["forbidden"] = forbidden
    if extra:
        payload["twists"] = extra
    return payload


def _concept_twist_lines(
    basket: Mapping[str, Any], forbidden_names: Sequence[str], mode: CookoutMode
) -> list[str]:
    """The twist directives, read back from the payload's own `twists` object so the prompt is a
    pure function of the basket it carries. Only catalogue text and ids ever appear."""
    twists = basket.get("twists")
    if not isinstance(twists, Mapping):
        return []
    lines: list[str] = []
    style_id = twists.get("style")
    style = style_by_id(style_id) if isinstance(style_id, str) else None
    if style is not None:
        directive = f"STYLE: {style.concept_directive}"
        lines.append(f"{directive} {mode.chef.style_line}" if mode.chef.style_line else directive)
    challenge_id = twists.get("challenge")
    challenge = challenge_by_id(challenge_id) if isinstance(challenge_id, str) else None
    if challenge is not None:
        extra = ', and "totalMinutes": integer (5-30)' if challenge.id == "thirty-minutes" else ""
        lines.append(
            f"{challenge.concept_directive} EVERY concept object MUST also include "
            f'"challengeNote": a string (1-{MAX_CHALLENGE_NOTE} chars) saying how it keeps '
            f"the rule{extra}."
        )
    stars = twists.get("stars")
    if isinstance(stars, list) and stars:
        lines.append(
            f"Two STAR ingredients (ids {', '.join(str(i) for i in stars)}) must be used in EVERY "
            "concept and be its hero: name each star in that concept's title or description."
        )
    wildcard = twists.get("wildcard")
    if isinstance(wildcard, str) and wildcard:
        lines.append(
            f"The WILDCARD ingredient (id {wildcard}) was a surprise neither friend chose: use it "
            "in at least two of the three concepts."
        )
    if forbidden_names:
        lines.append(
            "NEVER use or mention these removed ingredients anywhere, not even as a cupboard "
            f"staple: {', '.join(forbidden_names)}."
        )
    return lines


STAPLE_ORDER: Final = ("butter", "plain-flour", "cooking-oil", "granulated-sugar", "milk")


def _pickable_staples_phrase(basket: Mapping[str, Any]) -> str:
    """ "butter, plain-flour, ... and milk": the pickable staples still on offer. A staple removed
    by a rescue swap (the payload's `twists.forbidden`) is dropped from the sentence as it is from
    the staples list; with nothing removed this is exactly the core wording."""
    twists = basket.get("twists")
    removed = twists.get("forbidden") if isinstance(twists, Mapping) else None
    gone = {str(i) for i in removed} if isinstance(removed, list) else set()
    names = [i for i in STAPLE_ORDER if i not in gone]
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def _challenge_id(twists: object) -> str | None:
    value = twists.get("challenge") if isinstance(twists, Mapping) else None
    return value if isinstance(value, str) and challenge_by_id(value) is not None else None


def anchor_of(mode: CookoutMode, ingredient_ids: Sequence[str]) -> str | None:
    """The one anchor-kind (bread) id among `ingredient_ids` in a single-dish mode, else `None`
    (also for Classic and for a basket with no, or more than one, such item)."""
    anchor_kind = mode.chef.anchor_kind
    if mode.chef.format != "single-dish" or anchor_kind is None:
        return None
    found = sorted({i for i in ingredient_ids if mode.kind_of(i) == anchor_kind})
    return found[0] if len(found) == 1 else None


def _build_list(mode: CookoutMode) -> str:
    return ", ".join(f"{b.id} ({b.label}: {b.prompt_phrase})" for b in mode.chef.builds)


def _single_dish_head(basket: Mapping[str, Any], mode: CookoutMode) -> str:
    """Spec 09c §3.2: the single-dish opening and rules, then the BASKET_JSON line."""
    records = [r for r in basket.get("ingredients") or [] if isinstance(r, Mapping)]
    ids = [str(r.get("id")) for r in records]
    bread_id = anchor_of(mode, ids)
    if bread_id is None or mode.chef.concept_text is None:
        raise ValueError("a single-dish basket needs exactly one anchor (bread) ingredient")
    bread = next(str(r["name"]) for r in records if r.get("id") == bread_id)
    fillings = len(ids) - 1
    text = mode.chef.concept_text.format(
        bread=bread,
        bread_id=bread_id,
        n=fillings,
        each=fillings - (mode.chef.each_missing_max or 0),
        best=fillings - (mode.chef.best_missing_max or 0),
        build_list=_build_list(mode),
    )
    return f"{text}\n{_single_dish_rules(fillings)}\n\n{BASKET_MARKER}{_compact(basket)}"


def _single_dish_rules(fillings: int) -> str:
    """The Classic prompt's measured steering, carried into every single-dish mode (09c §3.2 gap,
    found by the real-run trial: without it the chef describes a sauce by what it is made of, or
    compares a dish to another, naming foods nobody picked, and miscounts "omitted")."""
    return (
        "- Ordinary cooking language is always fine (crisp, golden, melted, gooey). "
        "Write a picked item by its full name or its last word ('peanut flour' or 'flour', "
        "never 'peanut'; 'date syrup', never 'date'): the first word of a picked name on its "
        "own names a different food. The check "
        "looks for a real FOOD that is neither picked nor allowed, so never name one: not "
        "what a picked sauce or spread is made of (no chilli, coriander, garlic, herbs or "
        "spices unless picked), not a pickle, relish, chutney, syrup or side, and not another "
        "dish you compare the sandwich to (no fish-finger or similar). Describe each sandwich "
        "using only the picked items and butter. Before you answer, re-read every title, vibe "
        "and description and delete any food word that is not the name of a picked item or a "
        "chosen staple.\n"
        '- "omitted" lists every filling the idea does NOT use (exactly the complement of its '
        'fillings in "pickedIngredientIds"; the bread is never omitted), each with a short '
        'reason, and an idea that uses every filling has "omitted": []. NEVER mention an omitted '
        'filling anywhere except inside its own omitted "reason". Before you answer, count: '
        f"each idea's used fillings plus its omitted fillings must be exactly {fillings}.\n"
        '- Put ONLY picked ids in "pickedIngredientIds" (the bread included) and ONLY unpicked '
        'cupboard staple ids in "stapleIds".'
    )


def build_concepts_prompt(
    basket: Mapping[str, Any], *, mode: CookoutMode, forbidden_names: Sequence[str] = ()
) -> str:
    """The Stage-1 prompt. Without a `twists` object in `basket` the text is exactly the core's;
    otherwise the count words follow the basket size and the twist lines are added before the
    answer schema. `forbidden_names` are the display names of the payload's forbidden ids. A
    single-dish `mode` (09c §3.2) replaces the Classic opening and rules and the dish fields of
    the schema; Classic is byte-identical to the core."""
    single = mode.chef.format == "single-dish"
    count = _count_word(len(basket.get("ingredients") or []) or 10)
    pickable_staples = _pickable_staples_phrase(basket)
    twist_lines = _concept_twist_lines(basket, forbidden_names, mode)
    twist_block = ("\n" + "\n".join(twist_lines) + "\n") if twist_lines else ""
    challenge_id = _challenge_id(basket.get("twists"))
    note_field = ""
    if challenge_id is not None:
        note_field = f'\n   "challengeNote": string (1-{MAX_CHALLENGE_NOTE} chars),'
        if challenge_id == "thirty-minutes":
            note_field += '\n   "totalMinutes": integer (5-30),'
    if single:
        build_ids = " | ".join(f'"{b.id}"' for b in mode.chef.builds)
        return f"""{_single_dish_head(basket, mode)}
{twist_block}
Your FINAL message must be exactly one JSON object and nothing else (no text before or after it, \
no markdown fences):

{{"concepts": [ {{"id": "a" | "b" | "c",
   "title": string (1-90 chars),
   "vibe": string (1-40 chars),
   "build": one of {build_ids},
   "description": string (20-500 chars),{note_field}
   "pickedIngredientIds": [picked ingredient ids used, the bread included],
   "stapleIds": [staple ids used, excluding any id already in pickedIngredientIds],
   "omitted": [ {{"id": picked id not used, "reason": string (1-140 chars)}} ]}} ]}}  \
(exactly three concepts, ids a, b and c)
"""
    return f"""You are a creative, practical home-cooking chef. Two friends have picked {count} \
ingredients between them. Invent THREE distinct recipe concepts for two people that try hard to \
use ALL {count} picked ingredients, then reply with a single JSON object.

{BASKET_MARKER}{_compact(basket)}

Rules:
- Use ONLY the picked ingredients (by "id") and the cupboard staples (by "id"). Never \
introduce any other food: no unpicked fruit, vegetable, stock, garlic, herb, spice, sauce or \
anything else, anywhere in any text. Water, salt and black-pepper are always free. At most \
{MAX_EXTRA_STAPLES} of {pickable_staples} may be used \
in one concept, and only when they are not already picked.
- Ordinary cooking language is always fine ("crisp", "golden", "juices", "gravy" or "broth" made \
from the dish's own picks, "oil" or "onion" when a picked item is that). Write a picked item \
by its full name or its last word ("peanut flour" or "flour", never "peanut"; "date \
syrup", never "date"): the first word of a picked name on its own names a different \
food. The check only looks for \
a real FOOD that is neither picked nor a staple, so never name one. Sides and components count: \
no flatbread, pastry, scone, croutons, crisps, salsa, relish, cream, custard, syrup, caramel, \
dumplings, noodles, cabbage, bechamel, pickle, wafer, crackers, curd or sugar unless that exact \
item is picked or a staple. Describe each dish using only the picked items. Before you answer, \
re-read every title, vibe, description and challengeNote and delete any food word that is not \
the name of a picked item or a chosen staple (a sauce, side, filling, topping, dough, garnish or \
flavour you did not pick still counts).
- Each concept uses at least {MIN_PICKED_EACH} of the {count} picked ingredients, at least one \
uses {MIN_PICKED_BEST} or more, and between them the three concepts use all {count}.
- The three concepts must be genuinely different: three different (dishType, technique) pairs and \
at least two different dishType values.
- "omitted" lists every picked ingredient the concept does NOT use (exactly the complement of \
"pickedIngredientIds"), each with a short reason. NEVER mention an omitted ingredient anywhere \
except inside its own omitted "reason".
- Put ONLY picked ingredient ids in "pickedIngredientIds" and ONLY unpicked cupboard staple ids in \
"stapleIds" (never a staple id in pickedIngredientIds). Before you answer, count each concept's \
pickedIngredientIds: every one needs {MIN_PICKED_EACH} or more and at least one needs \
{MIN_PICKED_BEST} or more.
- Write "title", "vibe" and "description" naming only foods the concept uses. British English, \
plain text, no markdown.
{twist_block}
Your FINAL message must be exactly one JSON object and nothing else (no text before or after it, \
no markdown fences):

{{"concepts": [ {{"id": "a" | "b" | "c",
   "title": string (1-90 chars),
   "vibe": string (1-40 chars),
   "dishType": one of {", ".join(DISH_TYPES)},
   "technique": one of {", ".join(TECHNIQUES)},
   "description": string (20-500 chars),{note_field}
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


def _recipe_twist_lines(
    concept: Mapping[str, Any], manifest: Mapping[str, Any], twists: RecipeTwists
) -> list[str]:
    lines: list[str] = []
    style = style_by_id(twists.style) if twists.style is not None else None
    if style is not None:
        lines.append(f"STYLE: {style.concept_directive}")
    challenge = challenge_by_id(twists.challenge) if twists.challenge is not None else None
    if challenge is not None:
        lines.append(challenge.recipe_directive)
        lines.append(
            'Add this key to the JSON object: "cookware": [string (1-40 chars)] '
            "(1-4 cooking vessels and tools)"
        )
        total = concept.get("totalMinutes")
        if (
            challenge.id == "thirty-minutes"
            and isinstance(total, int)
            and not isinstance(total, bool)
        ):
            lines.append(f"This dish was planned to take {total} minutes in total.")
    if twists.star_ids:
        names = [
            str(item["name"])
            for item in manifest.get("ingredients") or []
            if isinstance(item, Mapping) and item.get("id") in twists.star_ids
        ]
        if names:
            lines.append(f"Make {', '.join(names)} the heroes: generous, central quantities.")
    return lines


def _free_first(mode: CookoutMode) -> list[str]:
    """The mode's free staples, the three seasonings first (Classic's own order)."""
    first = [i for i in ("water", "salt", "black-pepper") if i in mode.staples.free]
    return first + sorted(mode.staples.free - set(first))


def _words_list(ids: Sequence[str], joiner: str) -> str:
    names = [i.replace("-", " ") for i in ids]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + f" {joiner} {names[-1]}"


def _recipe_build(concept: Mapping[str, Any], mode: CookoutMode) -> Build | None:
    build_id = concept.get("build")
    return next((b for b in mode.chef.builds if b.id == build_id), None)


def build_recipe_prompt(
    concept: Mapping[str, Any],
    manifest: Mapping[str, Any],
    *,
    mode: CookoutMode,
    twists: RecipeTwists = RecipeTwists(),  # noqa: B008 - frozen, immutable default
) -> str:
    single = mode.chef.format == "single-dish"
    payload: dict[str, Any] = {
        "title": concept["title"],
        "vibe": concept["vibe"],
        "dishType": concept["dishType"],
        "technique": concept["technique"],
        "description": concept["description"],
        "manifest": manifest,
    }
    dish_line = ""
    free_words = "Water, salt and black-pepper are always free too."
    capped_words = "no butter, flour, oil, sugar or milk"
    if single:
        build = _recipe_build(concept, mode)
        if build is not None:
            payload["build"] = build.id
            if mode.chef.recipe_text:
                dish_line = (
                    mode.chef.recipe_text.format(
                        build_label=build.label, build_phrase=build.prompt_phrase
                    )
                    + "\n"
                )
        free_words = _words_list(_free_first(mode), "and").capitalize() + " are always free too."
        capped = [i for i in STAPLE_ORDER if i in mode.staples.capped]
        capped_words = "no " + _words_list(capped + sorted(mode.staples.capped - set(capped)), "or")
    twist_lines = _recipe_twist_lines(concept, manifest, twists)
    if twists.active:
        marker: dict[str, Any] = {}
        if twists.style is not None:
            marker["style"] = twists.style
        if twists.challenge is not None:
            marker["challenge"] = twists.challenge
        if twists.star_ids:
            marker["stars"] = sorted(twists.star_ids)
        if marker:
            payload["twists"] = marker
    twist_block = ("\n" + "\n".join(twist_lines) + "\n") if twist_lines else ""
    return f"""You are a careful home-cooking recipe writer. Write the full recipe for the dish \
below (serves 2) and reply with a single JSON object.

{CONCEPT_MARKER}{_compact(payload)}
{dish_line}
Rules:
- The manifest lists the ONLY ingredients available: "ingredients" are the picked ingredients the \
dish uses and "staples" the cupboard staples it uses. {free_words} Use every manifest item and \
nothing else: never add any other food, and never mention any other food in any text \
({capped_words} unless it is in the manifest).
- Ordinary cooking language is always fine ("crisp", "juices", "gravy" made from the dish's own \
items). Write a picked item by its full name or its last word ("peanut flour" or "flour", \
never "peanut"; "date syrup", never "date"): the first word of a picked name on its own \
names a different food. Only avoid naming a real food that is not in the manifest. That \
includes tips and \
serving suggestions: no rice, crisps, syrup, eggs, ale, stock or any other side, swap or \
substitute. Before you answer, re-read every note, step and tip and delete any food word that \
is not the name of a manifest item.
- Quantities are for 2 servings, in metric. Every ingredient id must be used in at least one step.
- British English, plain text, no markdown.
{twist_block}
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
    signals: tuple[str, ...] = ()
    """Non-fatal review notes (09c §3.4: a dish word in a single-dish idea). They never affect
    acceptance or the repair loop."""


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


def _id_list(value: object, where: str, problems: list[str], *, dedupe: bool = False) -> list[str]:
    """A list of id strings. A repeated id is a violation, unless `dedupe` (a step's `uses`, where
    only "a subset of the recipe's ingredients" is required) keeps the first of each."""
    if not isinstance(value, list) or not all(isinstance(i, str) for i in value):
        problems.append(f"{where} must be a list of ids")
        return []
    ids = [str(i) for i in value]
    if len(set(ids)) != len(ids):
        if not dedupe:
            problems.append(f"{where} must not repeat an id")
        ids = list(dict.fromkeys(ids))
    return ids


def _int(value: object, where: str, low: int, high: int, problems: list[str]) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        problems.append(f"{where} must be a whole number {low}-{high}")
        return low
    return value


def _normal(title: str) -> str:
    return _WHITESPACE_RE.sub(" ", title).casefold()


def _full_name_hint(bank: AiBank, name: str, used_ids: Set[str]) -> str:
    """A repair hint when the flagged food shares a word with a picked item: the chef most likely
    wrote the first word of that name ("peanut" for peanut flour), which names another food."""
    words = {w for w in re.findall(r"[a-z]+", name.lower()) if len(w) > 2}
    names = [
        ing.name
        for pick_id in sorted(used_ids)
        if (ing := bank.ingredient(pick_id)) is not None
        and words & set(re.findall(r"[a-z]+", ing.name.lower()))
    ]
    if not names:
        return ""
    return f" (if you meant a picked item, write its full name: {', '.join(names[:2])})"


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
        hint = _full_name_hint(bank, name, used_ids)
        problems.append(f"{where} mentions '{name}', which this dish does not use{hint}")


def _forbidden_prose(
    bank: AiBank, text: str, where: str, forbidden_ids: Set[str], problems: list[str]
) -> None:
    """The explicit forbidden-id check (spec 09a §5.3): independent of both lexical passes, so no
    declared staple, family exemption or omitted-reason allowance can excuse naming a removed
    ingredient."""
    if not text:
        return
    for forbidden_id in sorted(forbidden_ids):
        if bank.mentions(text, forbidden_id):
            problems.append(
                f"{where} mentions '{display_name(bank, forbidden_id)}', "
                "which was removed and may not appear anywhere"
            )


def _has_phrase(tokens: Sequence[str], phrase: Sequence[str]) -> bool:
    size = len(phrase)
    return size > 0 and any(
        tuple(tokens[i : i + size]) == tuple(phrase) for i in range(len(tokens) - size + 1)
    )


def parse_concepts(
    response_text: str,
    *,
    bank: AiBank,
    picked_ids: Sequence[str],
    mode: CookoutMode,
    bread_id: str | None = None,
    twists: ConceptTwists = ConceptTwists(),  # noqa: B008 - frozen, immutable default
) -> Parsed:
    """Validate a concepts run's final message (spec §3.2, 09a §5.3). The LAST JSON object
    carrying a `concepts` list is judged against the basket of `len(picked_ids)` (ten, or eleven
    with the wildcard); the twist rules apply only when set. On success the canonical value to
    store (`{"concepts": [...]}`, ids only — the server resolves names) is returned.

    A single-dish `mode` (09c §3.4) swaps the Classic coverage, diversity and staple rules for the
    anchor (bread) in every idea, coverage of the fillings, three different builds and the mode's
    staples. Dish words are never failures: they come back as `Parsed.signals`."""
    selected = list(picked_ids)
    selected_set = set(selected)
    size = len(selected_set)
    count = _count_word(size)
    single = mode.chef.format == "single-dish"
    anchor: str | None = None
    if single:
        anchor = bread_id if bread_id in selected_set else anchor_of(mode, selected)
        if anchor is None:
            return Parsed(None, ("the basket has no single bread to anchor the ideas",))
    fillings_n = size - 1
    build_by_id = {b.id: b for b in mode.chef.builds}
    signals: list[str] = []
    challenge = challenge_by_id(twists.challenge) if twists.challenge is not None else None
    forbidden = set(twists.forbidden_ids)
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
        if isinstance(cid, str) and cid in CONCEPT_IDS and cid not in by_id:
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
        dish_type: object = raw.get("dishType")
        technique: object = raw.get("technique")
        build_id: object = None
        if single:
            build_id = raw.get("build")
            chosen_build = build_by_id.get(build_id) if isinstance(build_id, str) else None
            if chosen_build is None:
                problems.append(f"{tag} build must be one of {', '.join(build_by_id)}")
            # the model's own dishType/technique, if any, are ignored (09c §3.3)
            dish_type = "sandwich"
            technique = chosen_build.technique if chosen_build is not None else None
        else:
            if dish_type not in DISH_TYPES:
                problems.append(f"{tag} dishType must be one of {', '.join(DISH_TYPES)}")
            if technique not in TECHNIQUES:
                problems.append(f"{tag} technique must be one of {', '.join(TECHNIQUES)}")

        challenge_note = ""
        total_minutes: int | None = None
        if challenge is not None:
            challenge_note = _text(
                raw.get("challengeNote"),
                f"{tag} challengeNote",
                1,
                MAX_CHALLENGE_NOTE,
                problems,
            )
            if challenge.id == "thirty-minutes":
                raw_total = raw.get("totalMinutes")
                if (
                    isinstance(raw_total, bool)
                    or not isinstance(raw_total, int)
                    or not 5 <= raw_total <= THIRTY_MINUTES
                ):
                    problems.append(f"{tag} totalMinutes must be a whole number 5-{THIRTY_MINUTES}")
                else:
                    total_minutes = raw_total
            elif challenge.id == "no-oven":
                if single:
                    oven_build = build_by_id.get(build_id) if isinstance(build_id, str) else None
                    if oven_build is not None and oven_build.uses_oven:
                        problems.append(f"{tag} build '{oven_build.id}' needs the oven (no oven)")
                else:
                    if raw.get("technique") in NO_OVEN_TECHNIQUES:
                        problems.append(f"{tag} technique may not be roast or bake (no oven)")
                    if raw.get("dishType") in NO_OVEN_DISH_TYPES:
                        problems.append(
                            f"{tag} dishType may not be traybake, pie or bake (no oven)"
                        )
                for field_name, value in (
                    ("title", title),
                    ("vibe", vibe),
                    ("description", description),
                ):
                    # (the challengeNote may say "no oven needed": it explains the rule)
                    oven = sorted(set(bank.food_free_tokens(value)) & NO_OVEN_WORDS)
                    if oven:
                        problems.append(
                            f"{tag} {field_name} mentions the oven ('{oven[0]}') but the challenge "
                            "is no oven"
                        )

        used = _id_list(raw.get("pickedIngredientIds"), f"{tag} pickedIngredientIds", problems)
        for ingredient_id in used:
            if ingredient_id in forbidden:
                problems.append(
                    f"{tag} uses '{ingredient_id}', which was removed from the basket and is "
                    "forbidden"
                )
            elif ingredient_id not in selected_set:
                problems.append(
                    f"{tag} uses '{ingredient_id}', which is not one of the {count} picks"
                )
        used_set = {i for i in used if i in selected_set}

        staples = _id_list(raw.get("stapleIds"), f"{tag} stapleIds", problems)
        for staple_id in staples:
            if staple_id in forbidden:
                problems.append(
                    f"{tag} stapleIds has '{staple_id}', which was removed and is forbidden"
                )
            elif bank.staple(staple_id) is None:
                problems.append(
                    f"{tag} stapleIds has '{staple_id}', which is not a cupboard staple"
                )
            elif staple_id in used:
                problems.append(f"{tag} stapleIds repeats picked ingredient '{staple_id}'")
        if single:
            for staple_id in staples:
                if bank.staple(staple_id) is not None and staple_id not in (
                    mode.staples.free | mode.staples.capped
                ):
                    problems.append(f"{tag} stapleIds has '{staple_id}', which this game lacks")
            extra = [s for s in staples if s in mode.staples.capped]
            if len(extra) > mode.staples.cap:
                problems.append(f"{tag} uses more than {mode.staples.cap} extra staples")
        else:
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
        for omitted_id in omitted_ids:
            if omitted_id in forbidden:
                problems.append(
                    f"{tag} omitted has '{omitted_id}', which was removed and is forbidden"
                )
        if len(set(omitted_ids)) != len(omitted_ids) or set(omitted_ids) != (
            selected_set - used_set
        ):
            problems.append(f"{tag} omitted must be exactly the picked ingredients it does not use")

        if single:
            assert anchor is not None
            if anchor not in used_set:
                problems.append(
                    f"{tag} leaves out the bread '{anchor}'; the bread must be in every idea"
                )
            coverage = len(used_set - {anchor})
            least = fillings_n - (mode.chef.each_missing_max or 0)
            if coverage < least:
                problems.append(
                    f"{tag} uses only {coverage} fillings; each idea needs {least}+ of the "
                    f"{fillings_n}"
                )
        else:
            coverage = len(used_set)
            if coverage < MIN_PICKED_EACH:
                problems.append(
                    f"{tag} uses only {coverage} picks; each concept needs {MIN_PICKED_EACH}+"
                )

        for star_id in sorted(twists.star_ids):
            if star_id not in used_set:
                problems.append(f"concept {cid} must use star '{star_id}' (it is a hero)")
            elif star_id == anchor:
                continue  # the bread's name is never required in prose (09c §3.4); the UI shows it
            elif not (bank.mentions(title, star_id) or bank.mentions(description, star_id)):
                problems.append(
                    f"concept {cid} must name star '{star_id}' in its title or description"
                )

        # Lexical scans (only meaningful once the ids are sane, but cheap and informative anyway).
        omitted_set = set(omitted_ids) & selected_set
        staple_set = {s for s in staples if bank.staple(s) is not None}
        scanned = [("title", title), ("vibe", vibe), ("description", description)]
        if challenge_note:
            scanned.append(("challengeNote", challenge_note))
        for field_name, value in scanned:
            _scan(
                bank,
                value,
                f"{tag} {field_name}",
                used_ids=used_set,
                staple_ids=staple_set | mode.staples.free,
                omitted_ids=omitted_set,
                problems=problems,
            )
        # An omitted reason is an explanation, never consumption: only the forbidden-id check
        # (below) applies to it, so ordinary words in a reason never fail a concept.

        if forbidden:
            for field_name, value in scanned:
                _forbidden_prose(bank, value, f"{tag} {field_name}", forbidden, problems)
            for item in omitted:
                _forbidden_prose(bank, item["reason"], f"{tag} omitted reason", forbidden, problems)

        concept: dict[str, Any] = {
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
        if single:
            concept["build"] = build_id
            for word in mode.chef.review_dish_words:
                word_tokens = tuple(word.replace("-", " ").split())
                for field_text in (title, vibe, description):
                    if _has_phrase(bank.food_free_tokens(field_text), word_tokens):
                        signals.append(f"concept {cid}: '{word}'")
                        break
        if challenge is not None:
            concept["challengeNote"] = challenge_note
        if total_minutes is not None:
            concept["totalMinutes"] = total_minutes
        concepts.append(concept)

    if single:
        counts = [len(set(c["pickedIngredientIds"]) - {anchor}) for c in concepts]
        best_needed = fillings_n - (mode.chef.best_missing_max or 0)
        if max(counts) < best_needed:
            problems.append(
                f"at least one idea must use {best_needed}+ of the {fillings_n} fillings"
            )
    else:
        counts = [len(c["pickedIngredientIds"]) for c in concepts]
        if max(counts) < MIN_PICKED_BEST:
            problems.append(
                f"at least one concept must use {MIN_PICKED_BEST}+ of the {count} picks"
            )
    union: set[str] = set()
    for c in concepts:
        union.update(c["pickedIngredientIds"])
    if twists.wildcard_id is not None:
        wild_users = sum(1 for c in concepts if twists.wildcard_id in c["pickedIngredientIds"])
        if wild_users < 2:
            problems.append(
                f"the wildcard '{twists.wildcard_id}' must be used in at least two concepts "
                f"(it is in {wild_users})"
            )
    uncovered = sorted(selected_set - union)
    if uncovered:
        problems.append(f"no concept uses these picks: {', '.join(uncovered)}")
    if single:
        builds = [c["build"] for c in concepts]
        for build_name, taken in sorted(Counter(b for b in builds if isinstance(b, str)).items()):
            if taken > 1:
                shared = [str(c["id"]) for c in concepts if c["build"] == build_name]
                problems.append(
                    f"concepts {' and '.join(shared)} share the build '{build_name}'; "
                    "each idea needs a different build"
                )
    # A malformed dishType/technique is already a violation above; only well-typed values are
    # compared (an unhashable one must not crash the validator).
    elif all(c["dishType"] in DISH_TYPES and c["technique"] in TECHNIQUES for c in concepts):
        pairs = {(c["dishType"], c["technique"]) for c in concepts}
        if len(pairs) != 3:
            problems.append("the three concepts need three different (dishType, technique) pairs")
        if len({c["dishType"] for c in concepts}) < 2:
            problems.append("the three concepts need at least two different dishType values")

    if problems:
        return Parsed(None, tuple(problems), tuple(signals))
    return Parsed({"concepts": concepts}, (), tuple(signals))


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def concept_manifest(
    concept: Mapping[str, Any],
    bank: AiBank,
    *,
    forbidden_ids: Set[str] = frozenset(),
    mode: CookoutMode | None = None,
) -> dict[str, Any]:
    """The frozen manifest a recipe prompt carries: the concept's used picks and declared staples
    with their names (plus the always-free seasonings). A forbidden (swapped-out) id is never
    listed, not even as a staple. `mode` (default Classic) says which staples are free: in a
    single-dish mode butter is listed with the seasonings."""
    free_ids = sorted(mode.staples.free if mode is not None else FREE_SEASONING_IDS)
    ingredients: list[dict[str, str]] = []
    for ingredient_id in concept["pickedIngredientIds"]:
        found = bank.ingredient(ingredient_id)
        if found is not None and found.id not in forbidden_ids:
            ingredients.append({"id": found.id, "name": found.name})
    staples: list[dict[str, str]] = []
    for staple_id in [*concept["stapleIds"], *free_ids]:
        staple = bank.staple(staple_id)
        if (
            staple is not None
            and staple.id not in forbidden_ids
            and all(s["id"] != staple.id for s in staples)
        ):
            staples.append({"id": staple.id, "name": staple.name})
    return {"ingredients": ingredients, "staples": staples}


def _vessel_hits(bank: AiBank, text: str, declared_tokens: Set[str]) -> list[str]:
    """Cooking-vessel phrases in `text` (its food-free tokens, longest phrase first) that are not
    made only of words from the declared cookware item itself."""
    tokens = bank.food_free_tokens(text)
    hits: list[str] = []
    longest = max(len(words) for words in COOKING_VESSEL_WORDS)
    index = 0
    while index < len(tokens):
        for size in range(min(longest, len(tokens) - index), 0, -1):
            window = tokens[index : index + size]
            if window in COOKING_VESSEL_WORDS:
                if not set(window) <= declared_tokens:
                    hits.append(" ".join(window))
                index += size
                break
        else:
            index += 1
    return hits


def parse_recipe(
    response_text: str,
    *,
    bank: AiBank,
    concept: Mapping[str, Any],
    mode: CookoutMode,
    twists: RecipeTwists = RecipeTwists(),  # noqa: B008 - frozen, immutable default
) -> Parsed:
    """Validate a recipe run's final message against its concept's frozen manifest (spec §3.4,
    09a §5.3). The LAST JSON object with a `steps` list is judged; the challenge and
    forbidden-id rules apply only when set. On success the canonical recipe to store (with the
    server-computed `totalMinutes`) is returned."""
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
    forbidden = set(twists.forbidden_ids)
    challenge = challenge_by_id(twists.challenge) if twists.challenge is not None else None
    manifest_ids = (set(picked) | set(staples)) - forbidden
    allowed_ids = manifest_ids | mode.staples.free

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
        if ingredient_id in forbidden:
            problems.append(
                f"ingredient '{ingredient_id}' was removed from the basket and is forbidden"
            )
        elif ingredient_id in omitted_ids:
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
        uses = _id_list(step.get("uses"), f"step {index} uses", problems, dedupe=True)
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

    cookware: list[str] = []
    if challenge is not None:
        raw_cookware = candidate.get("cookware")
        if not isinstance(raw_cookware, list) or not 1 <= len(raw_cookware) <= COOKWARE_MAX_ITEMS:
            problems.append(f"cookware must be a list of 1-{COOKWARE_MAX_ITEMS} vessels and tools")
            raw_cookware = []
        for index, item in enumerate(raw_cookware, start=1):
            cookware.append(_text(item, f"cookware {index}", 1, COOKWARE_MAX_CHARS, problems))
        if challenge.id == "thirty-minutes" and prep + cook > THIRTY_MINUTES:
            problems.append(
                f"prepMinutes + cookMinutes must be {THIRTY_MINUTES} or less (it is {prep + cook})"
            )
        elif challenge.id == "six-steps" and len(steps) > SIX_STEPS:
            problems.append(f"steps must be at most {SIX_STEPS} (it is {len(steps)})")
        elif challenge.id == "no-oven":
            texts = [("quantity", i["quantity"]) for i in ingredients] + [
                ("note", i["note"]) for i in ingredients
            ]
            texts += [(f"step {n}", st["text"]) for n, st in enumerate(steps, start=1)]
            texts += [(f"tip {n}", tip) for n, tip in enumerate(tips, start=1)]
            texts += [(f"cookware {n}", c) for n, c in enumerate(cookware, start=1)]
            for where, text in texts:
                oven = sorted(set(bank.food_free_tokens(text)) & NO_OVEN_WORDS)
                if oven:
                    problems.append(
                        f"{where} mentions the oven ('{oven[0]}') but the challenge is no oven"
                    )
        elif challenge.id == "one-pan":
            if len(cookware) != 1:
                problems.append("cookware must list exactly one cooking vessel (one pan only)")
            declared = set(bank.food_free_tokens(cookware[0])) if cookware else set()
            texts = [(f"ingredient {i['id']} note", i["note"]) for i in ingredients]
            texts += [(f"step {n}", st["text"]) for n, st in enumerate(steps, start=1)]
            texts += [(f"tip {n}", tip) for n, tip in enumerate(tips, start=1)]
            for where, text in texts:
                for vessel in _vessel_hits(bank, text, declared):
                    problems.append(
                        f"{where} uses a second cooking vessel ('{vessel}') but the challenge is "
                        "one pan only"
                    )

    used_set = {i for i in picked}
    staple_set = set(staples)
    scan_args: dict[str, Any] = {
        "used_ids": used_set,
        "staple_ids": staple_set | mode.staples.free,
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
    for index, item_text in enumerate(cookware, start=1):
        _scan(bank, item_text, f"cookware {index}", **scan_args)
    if forbidden:
        for item in ingredients:
            _forbidden_prose(
                bank, item["quantity"], f"ingredient {item['id']} quantity", forbidden, problems
            )
            _forbidden_prose(
                bank, item["note"], f"ingredient {item['id']} note", forbidden, problems
            )
        for index, step_item in enumerate(steps, start=1):
            _forbidden_prose(bank, step_item["text"], f"step {index}", forbidden, problems)
        for index, tip in enumerate(tips, start=1):
            _forbidden_prose(bank, tip, f"tip {index}", forbidden, problems)
        for index, item_text in enumerate(cookware, start=1):
            _forbidden_prose(bank, item_text, f"cookware {index}", forbidden, problems)

    if problems:
        return Parsed(None, tuple(problems))
    recipe: dict[str, Any] = {
        "serves": 2,
        "prepMinutes": prep,
        "cookMinutes": cook,
        "totalMinutes": prep + cook,
        "ingredients": ingredients,
        "steps": steps,
        "tips": tips,
    }
    if challenge is not None:
        recipe["cookware"] = cookware
    return Parsed(recipe, ())


# -- the store (spec Appendix A.2) ---------------------------------------------------------------


class AiStore(Protocol):
    def get_cookout_round(self, anchor_seq: int) -> dict[str, Any] | None: ...

    def set_cookout_concepts_run(
        self,
        anchor_seq: int,
        run_id: str,
        *,
        expected_run_id: str | None = None,
        expected_generation: int,
    ) -> bool: ...

    def finish_cookout_concepts(
        self,
        anchor_seq: int,
        run_id: str | None,
        state: Literal["ready", "failed", "unavailable"],
        *,
        expected_generation: int,
        concepts_json: str | None = None,
        error: str | None = None,
        pictures_pending: bool = False,
    ) -> bool: ...

    def cookout_pending_concepts(self) -> list[tuple[int, int, str | None]]: ...

    def set_cookout_recipe_run(
        self,
        anchor_seq: int,
        concept_id: str,
        run_id: str,
        *,
        expected_run_id: str | None = None,
        expected_generation: int,
    ) -> bool: ...

    def finish_cookout_recipe(
        self,
        anchor_seq: int,
        concept_id: str,
        run_id: str | None,
        state: Literal["banked", "failed", "unavailable"],
        *,
        expected_generation: int,
        recipe_json: str | None = None,
        error: str | None = None,
    ) -> bool: ...

    def cookout_pending_recipes(self) -> list[tuple[int, int, str, str | None]]: ...


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
        modes: CookoutModes | None = None,
    ) -> None:
        self._store = store
        self._bank = bank
        self._modes = modes
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
        self._running: set[tuple[str, int, int, str]] = set()
        """`("c", anchor, generation, "")` / `("r", anchor, generation, concept_id)`: a job of an
        older generation never shadows (or is shadowed by) the current generation's."""

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

    def start_concepts(
        self, background: ContainedTaskGroup, anchor_seq: int, generation: int
    ) -> None:
        background.spawn("livechat-cookout-concepts", self.run_concepts, anchor_seq, generation)

    def start_pictures(self, background: ContainedTaskGroup, anchor_seq: int) -> None:
        if self._pictures is not None:
            background.spawn("livechat-cookout-pictures", self._pictures.run, anchor_seq)

    def start_recipe(
        self, background: ContainedTaskGroup, anchor_seq: int, generation: int, concept_id: str
    ) -> None:
        background.spawn(
            "livechat-cookout-recipe", self.run_recipe, anchor_seq, generation, concept_id
        )

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
        for anchor_seq, generation, run_id in concepts:
            if ("c", anchor_seq, generation, "") in self._running:
                continue
            if self._client is None:
                await self._finish_concepts(
                    anchor_seq, generation, run_id, "unavailable", error=CONCEPTS_UNAVAILABLE_TEXT
                )
            else:
                background.spawn(
                    "livechat-cookout-concepts", self.run_concepts, anchor_seq, generation
                )
        recipes = await anyio.to_thread.run_sync(self._store.cookout_pending_recipes)
        for anchor_seq, generation, concept_id, run_id in recipes:
            if ("r", anchor_seq, generation, concept_id) in self._running:
                continue
            if self._client is None:
                await self._finish_recipe(
                    anchor_seq,
                    generation,
                    concept_id,
                    run_id,
                    "unavailable",
                    error=RECIPE_UNAVAILABLE_TEXT,
                )
            else:
                background.spawn(
                    "livechat-cookout-recipe", self.run_recipe, anchor_seq, generation, concept_id
                )

    # -- shared primitives -------------------------------------------------------------------

    def _primitives(self) -> tuple[CapacityLimiter, anyio.Lock]:
        if self._limiter is None:
            self._limiter = CapacityLimiter(self._timing.concurrency)
        if self._spawn_lock is None:
            self._spawn_lock = anyio.Lock()
        return self._limiter, self._spawn_lock

    async def _row(self, anchor_seq: int) -> dict[str, Any] | None:
        return await anyio.to_thread.run_sync(lambda: self._store.get_cookout_round(anchor_seq))

    def _mode_of(self, row: Mapping[str, Any]) -> CookoutMode | None:
        """The round's game mode (`classic` for a row that carries none), or `None` for a mode
        this process does not know: such a job aborts WITHOUT writing (09c §5.6, A.4) — it must
        never fail, finish or claim a round it cannot interpret."""
        modes = self._modes if self._modes is not None else default_modes()
        raw = row.get("mode")
        return modes.mode(raw if isinstance(raw, str) and raw else "classic")

    async def _finish_concepts(
        self,
        anchor_seq: int,
        generation: int,
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
                expected_generation=generation,
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
        generation: int,
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
                expected_generation=generation,
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

    async def run_concepts(self, anchor_seq: int, generation: int) -> None:
        """Drive the round's concept job (for the `generation` it was started for) to its
        outcome; once `ready` with its picture wait pending, go on to the dish pictures (outside
        the cmd slot). Never raises for an ordinary failure (it becomes `concepts = failed`); only
        cancellation (shutdown) propagates, leaving the round `pending` for the next start or
        sweep. A job of a superseded generation does nothing and writes nothing."""
        key = ("c", anchor_seq, generation, "")
        if key in self._running:
            return
        self._running.add(key)
        pictures_due = False
        try:
            if self._client is None:
                row = await self._row(anchor_seq)
                if (
                    row is not None
                    and self._mode_of(row) is not None
                    and row.get("generation", 1) == generation
                    and row.get("concepts") == "pending"
                ):
                    await self._finish_concepts(
                        anchor_seq,
                        generation,
                        row.get("concepts_run_id"),
                        "unavailable",
                        error=CONCEPTS_UNAVAILABLE_TEXT,
                    )
                return
            limiter, spawn_lock = self._primitives()
            try:
                async with limiter:
                    pictures_due = await self._concepts_job(anchor_seq, generation, spawn_lock)
            except Exception:
                _LOGGER.exception("cookout concepts job for round %s failed", anchor_seq)
                await self._fail_after_crash(anchor_seq, generation)
        finally:
            self._running.discard(key)
        if pictures_due and self._pictures is not None:
            await self._pictures.run(anchor_seq)

    async def _fail_after_crash(self, anchor_seq: int, generation: int) -> None:
        try:
            row = await self._row(anchor_seq)
            if (
                row is not None
                and row.get("generation", 1) == generation
                and row.get("concepts") == "pending"
            ):
                await self._finish_concepts(
                    anchor_seq,
                    generation,
                    row.get("concepts_run_id"),
                    "failed",
                    error=CONCEPTS_FAILED_TEXT,
                )
        except Exception:
            _LOGGER.exception("could not mark round %s's concepts failed", anchor_seq)

    async def _concepts_job(self, anchor_seq: int, generation: int, spawn_lock: anyio.Lock) -> bool:
        row = await self._row(anchor_seq)
        if (
            row is None
            or row.get("generation", 1) != generation
            or row.get("concepts") != "pending"
            or row.get("state") != "finished"
        ):
            return False
        mode = self._mode_of(row)
        if mode is None:
            _LOGGER.warning("cookout: round %s has a game mode this server lacks", anchor_seq)
            return False
        basket_ids = [str(i) for i in row.get("basket_ids") or []]
        twists = concept_twists_of(row)
        basket = basket_payload(self._bank, basket_ids, twists=twists)
        bread_id = row.get("bread_id")
        if bread_id is not None and not isinstance(bread_id, str):
            bread_id = None
        if (
            basket is None
            or len(set(basket_ids)) not in mode.basket_sizes
            # a single-dish prompt needs exactly one anchor (bread) item: a basket without one
            # fails the job cleanly instead of raising out of the prompt builder
            or (
                mode.chef.format == "single-dish"
                and (bread_id if bread_id in basket_ids else anchor_of(mode, basket_ids)) is None
            )
        ):
            await self._finish_concepts(
                anchor_seq,
                generation,
                row.get("concepts_run_id"),
                "failed",
                error=CONCEPTS_FAILED_TEXT,
            )
            return False
        forbidden_names = [
            display_name(self._bank, i) for i in known_forbidden(self._bank, twists.forbidden_ids)
        ]

        async def still_waiting(run_id: str | None) -> bool:
            current = await self._row(anchor_seq)
            return (
                current is not None
                and current.get("generation", 1) == generation
                and current.get("concepts") == "pending"
                and current.get("concepts_run_id") == run_id
            )

        async def record_run(run_id: str, expected: str | None) -> bool:
            return await anyio.to_thread.run_sync(
                lambda: self._store.set_cookout_concepts_run(
                    anchor_seq, run_id, expected_run_id=expected, expected_generation=generation
                )
            )

        stored_ready = False

        async def finish_ok(run_id: str, value: dict[str, Any]) -> bool:
            nonlocal stored_ready
            stored_ready = await self._finish_concepts(
                anchor_seq,
                generation,
                run_id,
                "ready",
                concepts_json=canonical_json(value),
                pictures_pending=self._pictures is not None,
            )
            return stored_ready

        async def finish_bad(run_id: str | None, unavailable: bool) -> bool:
            if unavailable:
                return await self._finish_concepts(
                    anchor_seq, generation, run_id, "unavailable", error=CONCEPTS_UNAVAILABLE_TEXT
                )
            return await self._finish_concepts(
                anchor_seq, generation, run_id, "failed", error=CONCEPTS_FAILED_TEXT
            )

        spec = _Spec(
            name=f"concepts round {anchor_seq} generation {generation}",
            caller=CONCEPTS_CALLER,
            prompt=build_concepts_prompt(basket, mode=mode, forbidden_names=forbidden_names),
            initial_run_id=row.get("concepts_run_id"),
            deadline_at=_float_or_none(row.get("concepts_deadline_at")),
            still_waiting=still_waiting,
            record_run=record_run,
            parse=lambda text: parse_concepts(
                text,
                bank=self._bank,
                picked_ids=basket_ids,
                mode=mode,
                bread_id=bread_id,
                twists=twists,
            ),
            finish_ok=finish_ok,
            finish_bad=finish_bad,
        )
        await self._drive(spec, spawn_lock)
        return stored_ready and self._pictures is not None

    # -- Stage 2: Bank this ------------------------------------------------------------------

    async def run_recipe(self, anchor_seq: int, generation: int, concept_id: str) -> None:
        """Drive one concept's full-recipe job (against the `generation` it was started for) to
        `banked` (or `failed`). Never raises for an ordinary failure; only cancellation propagates,
        leaving the row `pending`. A job of a superseded generation writes nothing."""
        key = ("r", anchor_seq, generation, concept_id)
        if key in self._running:
            return
        self._running.add(key)
        try:
            if self._client is None:
                row = await self._row(anchor_seq)
                slot = ((row or {}).get("recipes") or {}).get(concept_id) or {}
                if (
                    row is not None
                    and self._mode_of(row) is not None
                    and row.get("generation", 1) == generation
                    and slot.get("state") == "pending"
                ):
                    await self._finish_recipe(
                        anchor_seq,
                        generation,
                        concept_id,
                        slot.get("run_id"),
                        "unavailable",
                        error=RECIPE_UNAVAILABLE_TEXT,
                    )
                return
            limiter, spawn_lock = self._primitives()
            try:
                async with limiter:
                    await self._recipe_job(anchor_seq, generation, concept_id, spawn_lock)
            except Exception:
                _LOGGER.exception(
                    "cookout recipe job for round %s concept %s failed", anchor_seq, concept_id
                )
                try:
                    row = await self._row(anchor_seq)
                    slot = ((row or {}).get("recipes") or {}).get(concept_id) or {}
                    if (row or {}).get("generation", 1) == generation and (
                        slot.get("state") == "pending"
                    ):
                        await self._finish_recipe(
                            anchor_seq,
                            generation,
                            concept_id,
                            slot.get("run_id"),
                            "failed",
                            error=RECIPE_FAILED_TEXT,
                        )
                except Exception:
                    _LOGGER.exception("could not mark %s/%s failed", anchor_seq, concept_id)
        finally:
            self._running.discard(key)

    async def _recipe_job(
        self, anchor_seq: int, generation: int, concept_id: str, spawn_lock: anyio.Lock
    ) -> None:
        row = await self._row(anchor_seq)
        if (
            row is None
            or row.get("generation", 1) != generation
            or row.get("state") != "finished"
            or row.get("concepts") != "ready"
        ):
            return
        slot = (row.get("recipes") or {}).get(concept_id)
        if not isinstance(slot, dict) or slot.get("state") != "pending":
            return
        concept = _stored_concept(row, concept_id)
        if concept is None:
            await self._finish_recipe(
                anchor_seq,
                generation,
                concept_id,
                slot.get("run_id"),
                "failed",
                error=RECIPE_FAILED_TEXT,
            )
            return
        mode = self._mode_of(row)
        if mode is None:
            _LOGGER.warning("cookout: round %s has a game mode this server lacks", anchor_seq)
            return
        twists = recipe_twists_of(row)
        manifest = concept_manifest(
            concept, self._bank, forbidden_ids=twists.forbidden_ids, mode=mode
        )

        async def still_waiting(run_id: str | None) -> bool:
            current = await self._row(anchor_seq)
            if current is None or current.get("generation", 1) != generation:
                return False
            now_slot = (current.get("recipes") or {}).get(concept_id) or {}
            return now_slot.get("state") == "pending" and now_slot.get("run_id") == run_id

        async def record_run(run_id: str, expected: str | None) -> bool:
            return await anyio.to_thread.run_sync(
                lambda: self._store.set_cookout_recipe_run(
                    anchor_seq,
                    concept_id,
                    run_id,
                    expected_run_id=expected,
                    expected_generation=generation,
                )
            )

        async def finish_ok(run_id: str, value: dict[str, Any]) -> bool:
            return await self._finish_recipe(
                anchor_seq,
                generation,
                concept_id,
                run_id,
                "banked",
                recipe_json=canonical_json(value),
            )

        async def finish_bad(run_id: str | None, unavailable: bool) -> bool:
            if unavailable:
                return await self._finish_recipe(
                    anchor_seq,
                    generation,
                    concept_id,
                    run_id,
                    "unavailable",
                    error=RECIPE_UNAVAILABLE_TEXT,
                )
            return await self._finish_recipe(
                anchor_seq,
                generation,
                concept_id,
                run_id,
                "failed",
                error=RECIPE_FAILED_TEXT,
            )

        spec = _Spec(
            name=f"recipe {anchor_seq}/{generation}/{concept_id}",
            caller=RECIPE_CALLER,
            prompt=build_recipe_prompt(concept, manifest, mode=mode, twists=twists),
            initial_run_id=slot.get("run_id"),
            deadline_at=_float_or_none(slot.get("deadline_at")),
            still_waiting=still_waiting,
            record_run=record_run,
            parse=lambda text: parse_recipe(
                text, bank=self._bank, concept=concept, mode=mode, twists=twists
            ),
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
        # A resumed run may already be a repair run (the store cannot say), so it counts as one
        # used: at most MAX_REPAIRS repair runs per job, all inside the one deadline.
        repairs = 1 if run_id is not None else 0
        if run_id is None and remaining_wall <= 0:
            _LOGGER.warning("%s is already past its deadline; failing without a run", spec.name)
            await spec.finish_bad(None, False)
            return
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
                if parsed.signals:
                    # a count only: signals carry words of the answer, never logged (09c §3.4)
                    _LOGGER.info("%s: %d review signals", spec.name, len(parsed.signals))
                if parsed.value is not None:
                    await spec.finish_ok(run_id, parsed.value)
                    return
                _LOGGER.warning(
                    "%s: answer rejected (%d violations): %s",
                    spec.name,
                    len(parsed.violations),
                    "; ".join(parsed.violations[:3]),
                )
                if repairs >= MAX_REPAIRS or self._clock() >= give_up_at:
                    await spec.finish_bad(run_id, False)
                    return
                repairs += 1
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
                if status == "error" and may_retry and early and repairs == 0:
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


def _id_set(value: object) -> frozenset[str]:
    if not isinstance(value, list | tuple | set | frozenset):
        return frozenset()
    return frozenset(i for i in value if isinstance(i, str))


def _known_style(value: object) -> str | None:
    return value if isinstance(value, str) and style_by_id(value) is not None else None


def _known_challenge(value: object) -> str | None:
    return value if isinstance(value, str) and challenge_by_id(value) is not None else None


def concept_twists_of(row: Mapping[str, Any]) -> ConceptTwists:
    """The concepts-job twists of a `get_cookout_round` read (spec 09a §5.2). An id the catalogue
    does not know is dropped rather than trusted."""
    wildcard = row.get("wildcard_id")
    return ConceptTwists(
        star_ids=_id_set(row.get("star_ids")),
        wildcard_id=wildcard if isinstance(wildcard, str) and wildcard else None,
        style=_known_style(row.get("style")),
        challenge=_known_challenge(row.get("challenge")),
        forbidden_ids=_id_set(row.get("forbidden_ids")),
    )


def recipe_twists_of(row: Mapping[str, Any]) -> RecipeTwists:
    return RecipeTwists(
        star_ids=_id_set(row.get("star_ids")),
        style=_known_style(row.get("style")),
        challenge=_known_challenge(row.get("challenge")),
        forbidden_ids=_id_set(row.get("forbidden_ids")),
    )


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
