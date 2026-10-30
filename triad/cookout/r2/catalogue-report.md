# Cookout ingredient catalogue: build report

3494 of 3494 ingredients have a finished catalogue entry. Sol checked 150 sampled fun facts and 147 held up (the bar is 146 of 150): passed.

## What was measured

- Entries written: 3494 of 3494 (the 3491 pickable ingredients plus the three free seasonings).
- Fun facts per entry: 1 fact(s): 23, 2 fact(s): 1913, 3 fact(s): 1558.
- Model runs started (by pass): audit 15, author 231, factcheck 780.
- Entries with only one surviving fact: 23.
- Entries with no fact at all (waived in `facts_waivers.json`): 0.

## Sol fact audit

- Audit 1: 144 of 150 upheld (seed 2754368933); failed
  - not upheld, shropshire-blue: "It is made from cows' milk and is traditionally crumbled over salads or melted into sauces." (Cow's milk is correct; salad/sauce uses are documented suggestions, but a specific tradition is unsubstantiated. [Recipes](https://www.cropwellbishopcreamery.co.uk/recipes--guides-13-c.asp))
  - not upheld, plum-chutney: 'In Britain, chutney became a popular partner for cold meats and cheese in Victorian times.' (Victorian popularity is documented, but dating both the cheese and cold-meat pairings specifically to that era is insufficiently supported. [Source](https://en.wikipedia.org/wiki/Chutney))
  - not upheld, chicken-mini-fillets: 'Chicken tenders are strips coated in breadcrumbs, a common choice for quick frying and grilling.' (Mini fillets are cuts of chicken, not necessarily breaded strips; the fact confuses the cut with a dish. [Source](https://thebutchershoppe.com.au/products/free-range-chicken-tenderloin))
  - not upheld, fresh-sage: 'Sage belongs to the mint family, and its Latin name salvia comes from the verb salvere, meaning to be saved.' (Salvere means 'to be well', not 'to be saved'. [Source](https://latinitium.com/wp-content/uploads/2021/05/1825-Latin_Synonyms-translated-from-Dumesnil.pdf))
  - not upheld, port-salut: 'It is a semi-soft cheese with a washed rind, which gives it its orange-tinted surface.' (Traditional Port Salut was washed-rind, but modern branded cheese has an orange coating; washing does not explain that surface. [Source](https://www.portsalut.co.uk/faqs-and-contact/))
  - not upheld, frozen-dumplings: 'Dumplings are dough dropped into a simmering stew, where they steam on top of the liquid.' (This describes stew dumplings only; frozen dumplings also include filled types that are steamed, boiled or fried. [Source](https://dictionary.cambridge.org/dictionary/english/dumpling))
- Audit 2: 142 of 150 upheld (seed 3974353782); failed
  - not upheld, custard-apple: 'Custard apples belong to the Annona family, which grows in warm regions around the world.' (Annona is a genus, not a family; custard apples belong to Annonaceae. [Botanical record](https://ntbg.org/database/plants/detail/annona-reticulata))
  - not upheld, floury-bap: 'Baps are a regional bread roll found mainly in northern England and Scotland.' (The geography is too narrow; baps are also established in the Midlands. [Survey](https://dialectandheritage.org.uk/the-great-big-dialect-hunt-the-results-are-in/food-glorious-food/roll-with-it/))
  - not upheld, lupini-beans: 'To make them edible, lupini beans are soaked and brined, which removes the bitterness.' (Incomplete preparation: bitter lupini normally need boiling and repeated water changes before brining. [Source](https://www.eatlupini.com/preparation.html))
  - not upheld, ice-cream-cornet: 'Wafer cones are made by baking a thin batter between heated plates, then rolling it while still warm.' (Describes rolled sugar cones; many wafer cones are baked directly in moulds. [Source](https://www.sciencedirect.com/book/9780128094389/wafer-and-waffle))
  - not upheld, anelletti: 'A timballo is a pasta dish baked in a drum-shaped crust, popular in southern Italy.' (Timballo may contain pasta or rice and need not have a crust; the drum shape refers to its mould. [Source](https://vocabolario.atliteg.org/lemmario/timballo/5310))
  - not upheld, tagliolini: 'The name comes from the Italian word taglio, meaning a cut.' (Treccani derives tagliolini from tagliare, meaning 'to cut', rather than the noun taglio. [Source](https://www.treccani.it/vocabolario/tagliolini/))
  - not upheld, paratha: 'Its flaky layers come from rubbing fat into the dough, folding it and rolling it out before cooking.' (Distinct layers require fat spread between dough folds; rubbing fat into dough alone does not create them. [Source](https://www.kingarthurbaking.com/recipes/lachha-paratha-flaky-paratha-recipe))
  - not upheld, ras-el-hanout: 'It is used in tagines and as a rub for lamb, chicken and couscous across Morocco and North Africa.' (It is a meat rub and couscous seasoning, not a rub for couscous. [Source](https://www.waitrose.com/ecom/recipes/cooks-ingredients/cooks-ingredients-herbs-spices/cooks-ingredients-ras-el-hanout))
- Audit 3: 147 of 150 upheld (seed 1053544123); passed
  - not upheld, chocolate-shavings: 'Chocolate was first prepared as a drink in Mesoamerica, long before solid chocolate was made.' (The Mesoamerican first-origin claim is unsupported: cacao use in Ecuador dates back about 5,300 years. [Archaeological study](https://www.nature.com/articles/s41559-018-0697-x))
  - not upheld, washed-rind-cheese: 'The washing encourages bacteria and moulds that give the cheese its strong smell and sticky orange rind.' (Washing favours bacteria over competing moulds; bacteria chiefly produce the orange, pungent rind. [ASM](https://doi.org/10.1128/microbiolspec.CM-0002-2012))
  - not upheld, pasta-sfoglia: 'Lasagne, tagliatelle and ravioli are typically made from sheets like this.' (Pasta sfoglia means puff pastry; these dishes use sheets of pasta dough. [Culinary text](https://app.ckbk.com/recipe/fund23911c17s001r004/pasta-sfoglia))

## Only one surviving fact

`black-seed-oil`, `chicken-goujons`, `cokelek`, `cooked-prawns`, `dark-liquid-seasoning`, `greenland-halibut`, `individual-meat-and-potato-pie`, `jelly-babies`, `kluski`, `lesser-galangal`, `muscatel-raisin`, `mustard-fruits`, `nut-brittle`, `red-peppercorns`, `sandwich-spread`, `sarsaparilla`, `spider-crab`, `timut-pepper`, `tin-loaf`, `tinned-oxtail-soup`, `white-turmeric`, `whitefish`, `yu-choy`

## Declared deviation from 09b A.2

Spec A.2 has Haiku fact-check the facts. Audits 1 and 2 (144 and 142 of 150) showed it was too
lenient: the 14 failures above are almost all subtle overclaims (a usage or region stated too
narrowly, a preparation true of only some versions, a cut confused with a dish, a loose name
origin or botanical class), none an invented number or date. By ruling of the Architect the
pass-2 fact-check was re-run over every entry with Sonnet 5.5 (web allowed, the same
true/doubtful/false contract) and three added rules: nothing true of only some versions or
brands unless hedged, no single-region or single-use claim unless the food is defined by it,
and name origins and botany only if a dictionary or encyclopedia states them. Authoring stays
Haiku; each entry's `source.factCheck` records the model that last checked it.
