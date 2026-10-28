"""Local food to try, with pictures (workspace 00056, spec/server-chat/08-adventure-time.md 4.3b,
Inv 56): the `dishes` section (prompt, sanitiser, order), the pure food/title rules, the plan, and
the dish picture sources — a Wikipedia lead image only when the article reads as food, else a vetted
Commons photo whose TITLE names the dish and whose categories or description mention food — against
the fake Wikipedia / Commons web. The measured failure they exist for: "Buzara" (a shellfish stew)
is a genus of moths on English Wikipedia. Hermetic."""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from typing import Any

import pytest

from wixy_server.livechat import adventure_pictures
from wixy_server.livechat.adventure_dishes import (
    dish_search_name,
    dish_tokens,
    first_sentence,
    fold,
    has_food_term,
    summary_reads_as_food,
    title_names_dish,
)
from wixy_server.livechat.adventure_pack import (
    MAX_SECTIONS,
    SECTION_DEFAULT_TITLES,
    SECTION_KEYS,
    build_prompt,
    parse_pack,
    sanitise_pack,
)
from wixy_server.livechat.adventure_pictures import (
    DISH_SLOTS_MAX,
    HERO_MAX,
    MAX_DISH_PICTURES,
    MAX_OTHER_PICTURES,
    MAX_PICTURES,
    PicturePlan,
    plan_pictures,
)
from wixy_server.tests.adventure_testkit import fixture_bank
from wixy_server.tests.fake_open_web import (
    COMMONS_HOST,
    THUMB_HOST,
    UPLOAD_HOST,
    WIKI_HOST,
    FakeFile,
    FakeOpenWeb,
    PackSpec,
    make_image,
)
from wixy_server.tests.test_livechat_adventure_pictures import (
    KOTOR_PLAN_ARGS,
    by_slot,
    item,
    plan_of,
    run_find,
)

# -- the pure rules ------------------------------------------------------------------------------


class TestFoodTerms:
    @pytest.mark.parametrize(
        "text",
        [
            "Montenegrin dry-cured ham",
            "Grilled dish of minced meat",
            "Doughnuts of Montenegro",
            "Food of Montenegro|Cuisine of Montenegro",
            "Cuttlefish risotto",
            "Fried dough",
            "Croatian red wine",
            "Traditional Balkan spirits",
            "Cheeses",
            "Fish soup",
            "Montenegrin brandy (rakija)",
            "A SOUP with beer",
            "Ice cream",
            "Dessert",
        ],
    )
    def test_food_and_drink_are_recognised(self, text: str) -> None:
        assert has_food_term(text), text

    @pytest.mark.parametrize(
        "text",
        [
            "Genus of moths",
            "Moths of Africa|Noctuidae|Erebidae",
            "Hamlets in Montenegro",  # not "ham"
            "Price list",  # not "rice"
            "Team photo",  # not "tea"
            "Port of Kotor",
            "Bay of Kotor|Churches in Kotor",
            "Mountain village",
            "Fishing boats",  # not "fish"
            "",
            None,
        ],
    )
    def test_places_animals_and_nothing_are_not(self, text: str | None) -> None:
        assert not has_food_term(text), text

    def test_the_first_sentence_is_cut_at_the_first_full_stop_followed_by_a_capital(self) -> None:
        extract = "Buzara is a genus of moths in the family Erebidae. It was described in 1858."
        assert first_sentence(extract) == "Buzara is a genus of moths in the family Erebidae."
        assert first_sentence("No full stop at all") == "No full stop at all"
        assert first_sentence(None) == "" and first_sentence("") == ""
        assert len(first_sentence("x" * 5000)) == 400

    @pytest.mark.parametrize(
        ("description", "extract", "reads_as_food"),
        [
            ("Montenegrin dry-cured ham", None, True),
            (None, "Priganice are a Montenegrin fried dough. They are served with honey.", True),
            ("Genus of moths", "Buzara is a genus of moths in the family Erebidae.", False),
            (
                "Genus of moths",
                "Buzara is a genus of moths. Its larvae eat bread.",  # food only in sentence two
                False,
            ),
            (None, None, False),
            (12, ["not", "text"], False),
        ],
    )
    def test_a_summary_reads_as_food_by_its_description_or_first_sentence(
        self, description: object, extract: object, reads_as_food: bool
    ) -> None:
        assert summary_reads_as_food(description, extract) is reads_as_food


class TestDishNames:
    def test_accents_fold_the_way_a_person_reads_them(self) -> None:
        assert fold("Ćevapčići") == "cevapcici"
        assert fold("Njeguški PRŠUT") == "njeguski prsut"
        assert fold("Đurđevak") == "durdevak" and fold("Łódź") == "lodz" and fold("Æble") == "aeble"

    def test_the_search_name_drops_the_parenthetical_gloss(self) -> None:
        assert dish_search_name("Njeguški pršut (Njeguši smoked ham)") == "Njeguški pršut"
        assert dish_search_name("  Black   risotto [crni rižot] ") == "Black risotto"
        assert dish_search_name("(only a gloss)") == "(only a gloss)"

    @pytest.mark.parametrize(
        ("names", "tokens"),
        [
            (("Njeguški pršut (Njeguši smoked ham)",), ("njeguski", "prsut")),
            (("Black risotto",), ("risotto",)),  # "black" names a colour, not the dish
            (("Buzara",), ("buzara",)),
            (("Ćevapčići", "Ćevapi"), ("cevapcici", "cevapi")),
            (("Fish stew", "Brodet"), ("fish", "stew", "brodet")),
            # every long word is generic: the plain 4-letter words are used rather than nothing
            (("Montenegrin smoked ham",), ("montenegrin", "smoked")),
            (("Red wine",), ("wine",)),
            (("Kačamak", None), ("kacamak",)),
            (("Raki", "Rakia"), ("raki", "rakia")),
            (("a b c",), ()),
        ],
    )
    def test_significant_tokens(
        self, names: tuple[str | None, ...], tokens: tuple[str, ...]
    ) -> None:
        assert dish_tokens(*names) == tokens

    @pytest.mark.parametrize(
        ("title", "tokens", "named"),
        [
            ("File:Black Risotto.jpg", ("risotto",), True),
            ("File:Crnogorske priganice 1.jpg", ("priganice",), True),
            ("File:Njeguski prsut.JPG", ("njeguski", "prsut"), True),
            ("File:Cevapi s kajmakom.jpg", ("cevapi",), True),
            ("File:Risottos of Italy.jpg", ("risotto",), True),  # starts with the token
            ("File:Buzara moth.jpg", ("buzara",), True),  # the title alone cannot decide
            ("File:Black Mountain.jpg", ("risotto",), False),
            ("File:Kotor old town.jpg", ("risotto",), False),
            ("File:Prsa.jpg", ("prsut",), False),
            ("File:IMG_1234.jpg", ("risotto",), False),
        ],
    )
    def test_a_title_names_a_dish_by_a_word_or_the_start_of_one(
        self, title: str, tokens: tuple[str, ...], named: bool
    ) -> None:
        assert title_names_dish(title, tokens) is named


# -- the pack: the `dishes` section --------------------------------------------------------------


def as_any(value: object) -> Any:
    """A parsed pack as untyped JSON, for the tests that index into it."""
    return value


def dishes_pack(**over: Any) -> dict[str, Any]:
    pack: dict[str, Any] = {
        "headline": "Kotor",
        "summary": "A walled bay town.",
        "wikipedia": "Kotor",
        "sections": [
            {
                "key": "food",
                "title": "Where to eat",
                "items": [
                    {"name": "Galion", "detail": "Seafood.", "url": "https://galion.example/"}
                ],
            },
            {
                "key": "dishes",
                "title": "",
                "items": [
                    {
                        "name": "Njeguški pršut",
                        "detail": "Dry-cured ham.",
                        "url": "https://shop.example/pršut",
                        "wikipedia": "Njeguški pršut",
                    },
                    {"name": "Buzara", "detail": "Shellfish stew.", "wikipedia": "Buzara"},
                ],
            },
        ],
    }
    pack.update(over)
    return pack


class TestDishesSection:
    def test_the_section_keys_are_the_documented_seven_dishes_first(self) -> None:
        assert SECTION_KEYS == ("dishes", "food", "stay", "culture", "sights", "do", "practical")
        assert MAX_SECTIONS == 7
        assert SECTION_DEFAULT_TITLES["dishes"] == "Local food to try"
        assert SECTION_DEFAULT_TITLES["food"] == "Where to eat"

    def test_dishes_is_always_first_whatever_order_the_model_wrote(self) -> None:
        pack = sanitise_pack(dishes_pack())
        assert pack is not None
        sections = as_any(pack)["sections"]
        assert [s["key"] for s in sections] == ["dishes", "food"]
        assert sections[0]["title"] == "Local food to try"  # the default title fills a blank one

    def test_a_dish_has_no_link_but_keeps_its_article_title(self) -> None:
        pack = sanitise_pack(dishes_pack())
        assert pack is not None
        dishes = as_any(pack)["sections"][0]["items"]
        assert dishes[0] == {
            "name": "Njeguški pršut",
            "detail": "Dry-cured ham.",
            "url": None,  # a dish is not a venue: the model's link is dropped
            "wikipedia": "Njeguški pršut",
        }
        assert dishes[1]["wikipedia"] == "Buzara"

    def test_a_pack_without_dishes_is_still_valid_and_other_sections_keep_their_order(self) -> None:
        raw = dishes_pack()
        raw["sections"] = raw["sections"][:1]
        pack = sanitise_pack(raw)
        assert pack is not None
        assert [s["key"] for s in as_any(pack)["sections"]] == ["food"]
        only = dishes_pack(
            sections=[
                {"key": "sights", "items": [{"name": "Gate"}]},
                {"key": "food", "items": [{"name": "Galion"}]},
            ]
        )
        again = sanitise_pack(only)
        assert again is not None
        assert [s["key"] for s in as_any(again)["sections"]] == ["sights", "food"]

    def test_all_seven_sections_fit(self) -> None:
        sections = [{"key": key, "items": [{"name": f"{key} one"}]} for key in SECTION_KEYS]
        pack = sanitise_pack({"sections": sections})
        assert pack is not None and len(as_any(pack)["sections"]) == 7

    def test_a_response_with_dishes_parses_end_to_end(self) -> None:
        pack = parse_pack("Here you go:\n" + json.dumps(dishes_pack()))
        assert pack is not None and as_any(pack)["sections"][0]["key"] == "dishes"

    def test_the_prompt_asks_for_dishes_first_with_the_dish_article_and_where_to_eat(self) -> None:
        bank = fixture_bank()
        destination = bank.destination("AAA.one")
        assert destination is not None
        prompt = build_prompt(destination, "Alphaland")
        assert '"dishes" | "food" | "stay"' in prompt
        for needle in (
            "dishes (put this section FIRST): 4-6 signature local dishes and drinks",
            "the dish or drink ITSELF, never a restaurant",
            "exact English Wikipedia article title OF THE DISH",
            "a name shared with an animal",
            'food: 2-4 specific places to eat or drink (titled "Where to eat")',
            "at most 7",
        ):
            assert needle in prompt, needle


# -- the plan ------------------------------------------------------------------------------------


class TestDishPlan:
    def test_dishes_are_planned_first_and_always_even_without_an_article(self) -> None:
        plan = plan_of(
            {
                "food": [item("Galion", url="https://galion.example/")],
                "dishes": [item("Buzara"), item("Pršut", wikipedia="Njeguški pršut")],
                "sights": [item("Gate")],
            },
            wikipedia=None,
        )
        keys = [s.key for s in plan.slots]
        assert keys == ["dishes:0", "sights:0", "food:0", "dishes:1"]
        first = plan.slots[0]
        assert first.is_dish and first.wikipedia is None and first.url is None and not first.search
        assert not plan.slots[1].is_dish

    def test_a_dish_never_uses_a_site(self) -> None:
        plan = plan_of({"dishes": [item("Pršut", url="https://shop.example/prsut")]})
        assert plan.slots[0].url is None

    def test_the_dish_and_other_caps_are_independent(self) -> None:
        sections = {
            "dishes": [item(f"dish number {i}") for i in range(9)],
            "sights": [item(f"sight {i}") for i in range(6)],
            "food": [item(f"f{i}", url=f"https://f{i}.example/") for i in range(6)],
            "stay": [item(f"s{i}", url=f"https://s{i}.example/") for i in range(6)],
            "culture": [item(f"c{i}", url=f"https://c{i}.example/") for i in range(6)],
            "do": [item(f"d{i}", url=f"https://d{i}.example/") for i in range(6)],
        }
        plan = plan_of(sections)
        assert sum(s.is_dish for s in plan.slots) == DISH_SLOTS_MAX == 6
        assert sum(not s.is_dish for s in plan.slots) == adventure_pictures.ITEM_SLOT_ATTEMPTS

    def test_the_budget_adds_up_to_twenty_two(self) -> None:
        assert (HERO_MAX, MAX_DISH_PICTURES, MAX_OTHER_PICTURES) == (6, 6, 10)
        assert MAX_PICTURES == 22


# -- the dish picture sources --------------------------------------------------------------------


def dish_queries(open_web: FakeOpenWeb) -> list[str]:
    """The Commons searches made for dishes (the destination's hero search is not one)."""
    return [q for q in open_web.search_queries if not q.startswith("Kotor Montenegro")]


def dish_plan(*dishes: tuple[str, str | None], wikipedia: str | None = None) -> PicturePlan:
    return plan_pictures(
        PackSpec(
            wikipedia,
            {"dishes": [item(name, wikipedia=title) for name, title in dishes]},
        ).as_pack(),
        **KOTOR_PLAN_ARGS,
    )


class TestDishLeadImage:
    def test_a_food_article_gives_its_lead_image_with_the_description_as_caption(self) -> None:
        ham = FakeFile("Njeguski prsut.jpg", 4000, 2667, seed=1)

        def configure(w: FakeOpenWeb) -> None:
            w.add_file(ham)
            w.add_article("Njeguški pršut", ham, description="Montenegrin dry-cured ham")

        pictures, web, open_web = run_find(
            configure, dish_plan(("Njeguški pršut", "Njeguški pršut"))
        )
        (pic,) = pictures
        assert pic.slot == "dishes:0" and pic.caption == "Montenegrin dry-cured ham"
        assert pic.credit == "Jane Doe, CC BY-SA 4.0" and pic.page.endswith(
            "File:Njeguski_prsut.jpg"
        )
        assert dish_queries(open_web) == []  # the lead image was enough
        assert web.seen(UPLOAD_HOST) == []

    def test_the_first_sentence_of_the_extract_can_carry_the_food_term(self) -> None:
        file = FakeFile("Priganice.jpg", 4000, 2667, seed=2)

        def configure(w: FakeOpenWeb) -> None:
            w.add_file(file)
            w.add_article(
                "Priganice",
                file,
                description="Montenegrin treat",
                extract="Priganice are a Montenegrin fried dough served with honey. They are old.",
            )

        (pic,) = run_find(configure, dish_plan(("Priganice", "Priganice")))[0]
        assert pic.slot == "dishes:0"

    def test_a_disambiguation_page_is_skipped(self) -> None:
        file = FakeFile("Any.jpg", 4000, 2667)

        def configure(w: FakeOpenWeb) -> None:
            w.add_file(file)
            w.add_article("Raki", file, description="Alcoholic drink", kind="disambiguation")

        assert run_find(configure, dish_plan(("Raki", "Raki")))[0] == []


class TestMothNamedDish:
    """The measured failure: on English Wikipedia "Buzara" is a genus of moths."""

    def _configure(self, w: FakeOpenWeb) -> None:
        moth = w.add_file(
            FakeFile(
                "Buzara onelia.jpg",
                4000,
                2667,
                seed=7,
                categories="Buzara|Moths of Africa|Erebidae",
                description="Buzara onelia, a moth, at rest",
            )
        )
        w.add_article(
            "Buzara",
            moth,
            description="Genus of moths",
            extract="Buzara is a genus of moths in the family Erebidae.",
        )
        w.add_search("Buzara", [moth.title])

    def test_both_checks_reject_it_and_the_dish_stays_text_only(self) -> None:
        pictures, web, open_web = run_find(self._configure, dish_plan(("Buzara", "Buzara")))
        assert pictures == []
        # The lead image was refused on the summary alone (the moth's file was never even looked up
        # or downloaded), and the Commons hit was refused on its categories before any download.
        assert open_web.imageinfo_titles == [] or open_web.imageinfo_titles == []
        assert web.seen(THUMB_HOST) == [] and web.seen(UPLOAD_HOST) == []
        assert dish_queries(open_web) == [
            '"Buzara" filemime:image/jpeg',
            "Buzara Montenegro filemime:image/jpeg",
        ]

    def test_there_is_no_article_images_fallback(self) -> None:
        _, web, _ = run_find(self._configure, dish_plan(("Buzara", "Buzara")))
        paths = [r.path for r in web.seen(WIKI_HOST)]
        assert paths == ["/api/rest_v1/page/summary/Buzara"]  # only the summary: no media list

    def test_a_genuine_stew_photo_beside_the_moth_is_the_one_taken(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            self._configure(w)
            stew = w.add_file(
                FakeFile(
                    "Buzara od skampi.jpg",
                    4000,
                    2667,
                    seed=8,
                    categories="Seafood stews|Food of Croatia",
                    description="Scampi buzara",
                )
            )
            moth = w.files["File:Buzara onelia.jpg"]
            w.searches.clear()
            w.add_search("Buzara", [moth.title, stew.title])

        (pic,) = run_find(configure, dish_plan(("Buzara", "Buzara")))[0]
        assert pic.page.endswith("File:Buzara_od_skampi.jpg")


class TestDishCommonsSearch:
    def _risotto(self, w: FakeOpenWeb) -> FakeFile:
        return w.add_file(
            FakeFile(
                "Black Risotto.jpg",
                4000,
                2667,
                seed=3,
                categories="Risotto|Food of Montenegro",
                description="Black risotto with cuttlefish",
            )
        )

    def test_the_title_and_the_categories_both_pass(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            w.add_search("Black risotto", [self._risotto(w).title])

        (pic,) = run_find(configure, dish_plan(("Black risotto", None)))[0]
        assert pic.slot == "dishes:0" and pic.page.endswith("File:Black_Risotto.jpg")
        assert pic.credit == "Jane Doe, CC BY-SA 4.0" and pic.caption is None

    def test_the_description_can_stand_in_for_the_categories(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            f = w.add_file(
                FakeFile("Priganice 1.jpg", 4000, 2667, seed=4, description="Fried dough balls")
            )
            w.add_search("Priganice", [f.title])

        (pic,) = run_find(configure, dish_plan(("Priganice", None)))[0]
        assert pic.page.endswith("File:Priganice_1.jpg")

    @pytest.mark.parametrize(
        ("title", "categories", "description"),
        [
            (
                "Priganice.jpg",
                "Montenegro|Churches",
                "A view",
            ),  # the title names it, nothing says food
            (
                "Fish market.jpg",
                "Fish|Food markets",
                "Fresh fish on ice",
            ),  # food, but not this dish
            ("IMG_0042.jpg", "Priganice|Food", "priganice"),  # food, but the title says nothing
        ],
    )
    def test_either_check_failing_rejects_the_file(
        self, title: str, categories: str, description: str
    ) -> None:
        def configure(w: FakeOpenWeb) -> None:
            f = w.add_file(
                FakeFile(title, 4000, 2667, categories=categories, description=description)
            )
            w.add_search("Priganice", [f.title])

        pictures, web, _ = run_find(configure, dish_plan(("Priganice", None)))
        assert pictures == [] and web.seen(THUMB_HOST) == []  # refused before any download

    def test_the_phrase_search_comes_first_then_the_dish_with_the_country(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            r = self._risotto(w)
            # Nothing for the quoted phrase; the second query finds it.
            w.add_search("Black risotto Montenegro", [r.title])

        pictures, _, open_web = run_find(configure, dish_plan(("Black risotto", None)))
        assert dish_queries(open_web) == [
            '"Black risotto" filemime:image/jpeg',
            "Black risotto Montenegro filemime:image/jpeg",
        ]
        assert [p.slot for p in pictures] == ["dishes:0"]

    def test_the_gloss_in_brackets_is_not_searched(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            f = w.add_file(
                FakeFile(
                    "Njeguski prsut.jpg", 4000, 2667, seed=5, categories="Ham", description="ham"
                )
            )
            w.add_search("Njeguški pršut", [f.title])

        pictures, _, open_web = run_find(
            configure, dish_plan(("Njeguški pršut (Njeguši smoked ham)", None))
        )
        assert dish_queries(open_web)[0] == '"Njeguški pršut" filemime:image/jpeg'
        assert pictures and pictures[0].page.endswith("File:Njeguski_prsut.jpg")  # accents folded

    def test_a_png_a_small_picture_and_a_banner_are_not_taken(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            files = [
                w.add_file(
                    FakeFile("Risotto png.png", 4000, 2667, mime="image/png", categories="Risotto")
                ),
                w.add_file(
                    FakeFile("Risotto tiny.jpg", 400, 300, served=(400, 300), categories="Risotto")
                ),
                w.add_file(FakeFile("Risotto banner.jpg", 4000, 800, categories="Risotto")),
                w.add_file(FakeFile("Risotto good.jpg", 4000, 2667, seed=9, categories="Risotto")),
            ]
            w.add_search("risotto", [f.title for f in files])

        (pic,) = run_find(configure, dish_plan(("risotto", None)))[0]
        assert pic.page.endswith("File:Risotto_good.jpg")

    def test_at_most_three_hits_are_downloaded_for_one_dish(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            files = [
                w.add_file(
                    FakeFile(
                        f"Risotto {i}.jpg", 4000, 2667, categories="Risotto", image=b"not an image"
                    )
                )
                for i in range(6)
            ]
            w.add_search("risotto", [f.title for f in files])

        pictures, web, _ = run_find(configure, dish_plan(("risotto", None)))
        assert pictures == [] and len(web.seen(THUMB_HOST)) == 3

    def test_a_dish_with_nothing_found_stays_text_only(self) -> None:
        pictures, _, open_web = run_find(lambda w: None, dish_plan(("Kačamak", None)))
        assert pictures == [] and len(dish_queries(open_web)) == 2

    def test_a_dish_without_a_usable_token_is_not_searched(self) -> None:
        _, _, open_web = run_find(lambda w: None, dish_plan(("Pie", None)))
        assert dish_queries(open_web) == []  # nothing of 4 letters to match a title against

    def test_two_dishes_cannot_share_a_photo_the_loser_looks_again(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            shared = w.add_file(
                FakeFile("Pršut and kajmak.jpg", 4000, 2667, seed=11, categories="Ham|Cheese")
            )
            second = w.add_file(
                FakeFile("Kajmak 2.jpg", 4000, 2667, seed=12, categories="Cheese|Dairy products")
            )
            w.add_search("Pršut", [shared.title])
            w.add_search("Kajmak", [shared.title, second.title])

        pictures, _, _ = run_find(configure, dish_plan(("Pršut", None), ("Kajmak", None)))
        got = by_slot(pictures)
        assert got["dishes:0"].page.endswith("File:Pr%C5%A1ut_and_kajmak.jpg")
        assert got["dishes:1"].page.endswith("File:Kajmak_2.jpg")

    def test_the_destination_lead_image_is_not_reused_for_a_dish(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            lead = w.add_file(
                FakeFile("Kotor risotto lead.jpg", 4000, 2667, seed=13, categories="Risotto")
            )
            w.add_article("Kotor", lead)
            w.add_search("risotto", [lead.title])

        pictures, _, _ = run_find(configure, dish_plan(("risotto", None), wikipedia="Kotor"))
        assert [p.slot for p in pictures] == ["hero:0"]  # the hero keeps it; the dish stays bare


class TestDishBudget:
    def test_at_most_six_dishes_and_ten_others_with_the_hero_makes_at_most_twenty_two(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            lead = w.add_file(FakeFile("Kotor Lead.jpg", 4256, 2832, seed=1))
            w.add_article("Kotor", lead)
            hero = [
                w.add_file(FakeFile(f"Kotor View {i}.jpg", 4000, 2667, seed=30 + i)).title
                for i in range(8)
            ]
            w.add_search("Kotor Montenegro", hero)
            for i in range(8):
                food = w.add_file(
                    FakeFile(f"Dishname{i} plate.jpg", 3000, 2000, seed=60 + i, categories="Food")
                )
                w.add_article(f"Dishname{i}", food, description="A traditional dish")
            for i in range(14):
                w.add_venue(
                    f"v{i}.example.com",
                    "/",
                    og_image="/img/hero.jpg",
                    image=make_image(1000, 700, seed=100 + i),
                )

        plan = plan_of(
            {
                "dishes": [item(f"Dishname{i}", wikipedia=f"Dishname{i}") for i in range(8)],
                "food": [item(f"f{i}", url=f"http://v{i}.example.com/") for i in range(6)],
                "stay": [item(f"s{i}", url=f"http://v{6 + i}.example.com/") for i in range(6)],
                "culture": [item(f"c{i}", url=f"http://v{12 + i}.example.com/") for i in range(2)],
            }
        )
        pictures = run_find(configure, plan)[0]
        slots = [p.slot for p in pictures]
        hero = [s for s in slots if s.startswith("hero:")]
        dishes = [s for s in slots if s.startswith("dishes:")]
        others = [s for s in slots if not s.startswith(("hero:", "dishes:"))]
        assert len(hero) == adventure_pictures.HERO_TARGET
        assert dishes == [
            f"dishes:{i}" for i in range(6)
        ]  # the 7th and 8th found photos too, dropped
        assert len(others) == 10
        assert len(pictures) == len(hero) + 6 + 10 <= MAX_PICTURES
        assert slots[: len(hero)] == hero  # the hero comes first
        assert [s for s in slots if s in dishes] == dishes  # the items are in plan order

    def test_decoding_stays_one_at_a_time_whatever_the_number_of_pictures(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The memory guarantee does not grow with the picture total: decodes are serialised."""
        assert adventure_pictures.DECODE_PARALLELISM == 1
        active = {"now": 0, "max": 0}
        lock = threading.Lock()
        real: Callable[..., Any] = adventure_pictures.prepare_picture

        def counting(*args: Any, **kwargs: Any) -> Any:
            with lock:
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
            try:
                time.sleep(0.02)
                return real(*args, **kwargs)
            finally:
                with lock:
                    active["now"] -= 1

        monkeypatch.setattr(adventure_pictures, "prepare_picture", counting)

        def configure(w: FakeOpenWeb) -> None:
            for i in range(10):
                f = w.add_file(FakeFile(f"Dishname{i} plate.jpg", 3000, 2000, seed=60 + i))
                w.add_article(f"Dishname{i}", f, description="A traditional dish")

        plan = plan_of(
            {"dishes": [item(f"Dishname{i}", wikipedia=f"Dishname{i}") for i in range(6)]}
        )
        pictures = run_find(configure, plan)[0]
        assert len([p for p in pictures if p.slot.startswith("dishes:")]) == 6
        assert active["max"] == 1


class TestRealKotorShapes:
    """The Kotor dishes measured on 2026-10-28, in the shapes the real services gave."""

    def test_priganice_is_found_by_its_title_and_its_doughnut_category(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            f = w.add_file(
                FakeFile(
                    "Crnogorske priganice 1.jpg",
                    4000,
                    2667,
                    seed=21,
                    categories="Doughnuts of Montenegro|Food of Montenegro",
                    description="",
                )
            )
            w.add_search("Priganice", [f.title])

        (pic,) = run_find(configure, dish_plan(("Priganice", "Priganice")))[0]
        assert pic.page.endswith("File:Crnogorske_priganice_1.jpg")

    def test_a_dish_picture_credit_and_page_are_the_commons_file(self) -> None:
        def configure(w: FakeOpenWeb) -> None:
            f = w.add_file(
                FakeFile(
                    "Black Risotto.jpg",
                    4000,
                    2667,
                    categories="Risotto",
                    artist_html='<a href="//x">User:Ana K</a>',
                    licence="CC0",
                )
            )
            w.add_search("risotto", [f.title])

        (pic,) = run_find(configure, dish_plan(("risotto", None)))[0]
        assert pic.credit == "Ana K, CC0"
        assert (
            pic.page
            == f"http://{COMMONS_HOST}:{pic.page.split(':')[2].split('/')[0]}/wiki/File:Black_Risotto.jpg"
        )
