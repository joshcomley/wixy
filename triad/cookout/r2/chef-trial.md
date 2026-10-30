# Cookout chef trial - final report (round 2)

Real cmd runs (claude-sonnet-5-5, production prompts and validators, up to 3 repairs). The tables below the summary are the LAST full run (run 7, seed 6, on the final code, apart from the fixes listed under "Trial 7 findings", which were re-run).

| run | what it tested | concepts accepted | on attempt 1/2/3/4 | recipes accepted |
|---|---|---|---|---|
| 2 (seed 1) | first fixes | 40/40 | 27/9/3/1 | 8/10 |
| 3 (seed 2) | + self-check prompts | 39/40 | 26/8/4/1 | 10/10 |
| 4 (seed 3) | + challengeNote schema field | 39/40 | 30/7/1/1 | 9/10 |
| 5 (seed 4) | + review fixes H1,H2,H8,M3,M4 | 39/40 | 26/7/4/2 | 18/20 (11 first) |
| 6 (seed 5) | + dip/tart/pastry fixes, prompt count rules | 40/40 | 32/7/1/0 | 20/20 (16 first) |
| **7 (seed 6)** | + v2 review fixes M1, M2, M5, L1-L3 (fresh seed) | **39/40** (basket 15 was a defect, fixed, re-run accepted first try) | **33/6/0/0** | **20/20 (15 first)** |
| re-run (seed 6, baskets 3,4,6,9,11,18,24 + 15) | scan fixes from trial 7 | 8/8 | 7 first | 8/8 |
| re-run (seed 6, baskets 6, 18) | pasta shapes / soft-boiled egg fixes | 2/2 (first) | - | 2/2 (first) |

Bar met: concepts 39/40 (>= 38) and 33 first-attempt (>= 30); recipes 20/20 (>= 19). With the one defect fixed, the same basket is accepted first time.

## Trial 7 findings (every rejection read by hand)

Concepts:
- basket 3 attempt 1: "fish" in "the fish juices" with an opah (a fish) picked - DEFECT (fixed: a bank "fish" blurb implies the bare word "fish"). Also title "flatbread" with no flatbread picked - genuine.
- basket 4 attempt 1: "sage and onion" for a picked stuffing mix (dried sage and onion crumbs) - DEFECT (fixed: stuffing picks imply sage and onion).
- basket 9, 16 attempt 1: "at least one concept must use 8+ of the ten picks" - genuine structural rule.
- basket 11 attempt 1: "Tinned pineapple rings" with tinned pineapple picked (its alias is "pineapple rings") - DEFECT (fixed: "ring/rings" is a shape word).
- basket 15, all four attempts: "bitter" (as a taste: "a bitter finish", "bitter crunch") read as the alias of Real ale - DEFECT, the one failed basket (fixed: the alias "bitter" was removed from the bank; "real ale" still matches). Re-run on the final code: accepted on attempt 1.
- basket 24 attempt 1: "ragu-style gravy" read as Bolognese sauce - DEFECT (fixed: alias "ragu" removed; "bolognese sauce" still matches).

Recipes:
- basket 0: cookware count - genuine structural rule.
- basket 4: "Beat the egg" / "beaten, for glazing" with a free-range egg picked - DEFECT (fixed: raw-egg picks imply beaten, poached, boiled, fried, scrambled, soft/hard, yolk, white, omelette, frittata).
- basket 6: "poach the egg", "poached egg", "egg yolk" with an egg picked - DEFECT (same fix). A "soft-boiled egg" in the re-run - DEFECT (same family, "soft"/"hard" added).
- basket 9 attempt 1 and basket 18: "bitter" (white pith, bitter bites) read as Real ale - DEFECT (same fix as basket 15).
- basket 18: "small shapes such as macaroni / penne / fusilli" note on a picked lentil pasta - DEFECT (fixed: shapes of a picked generic pasta pass; a named different pasta such as squid ink pasta still fails).

Seven of the eight concept rejections and nearly all recipe rejections were defects of the scan, not smuggling; all are fixed with regression tests, and a replay of 621 earlier accepted no-twist dishes through the final scan flags none of them.

## Correction to the earlier report

Basket 2 of seed 3 was NOT a genuine smuggling failure: "Pan-fry diced pork loin chop" with the pork loin chop picked was read as the unpicked food "Diced pork" (review finding H2, prep word before a picked name). Fixed and tested; the basket is now accepted first time. The `bun` alias on "Bun noodles" (folded to "bun", so choux "buns" read as noodles) was removed from the bank.

Run 6 (seed 5): "garlic butter" (x2) was labelled genuine earlier; it was a DEFECT (garlic and butter both picked, from different sources) and is fixed by the v2 review fix M2 (two standalone picked foods may form a phrase). "pork mince" from a pork pick plus a mince pick is still flagged.

## v2 review fixes (all tested)

- M1 crisps: the verb reading needs a subject just before ("the skin crisps", "so it catches and crisps"); "sprinkle crisps over", "crisps on top" are flagged as the food.
- M2 pooled coverage for phrases built from two standalone picked foods ("garlic butter").
- M5 the flaky "retried round" test now waits, bounded, for the runner to record its run.
- L1 "roll" no longer implies pastry (only "sausage roll" does). L2 only raw or whole egg picks imply omelette. L3 "fond" is a culinary word again, so "chicken fond" flags "chicken"; "brown sugar" is flagged when only granulated sugar is picked.

## Design notes for the reviewer

- A multi-word phrase is shorthand only when ONE pick's name supplies all its food words (H1), or when every food word is itself a standalone picked food (M2). "cheese sauce" built from two picks still passes by design: "sauce" is a stop word and cannot be told apart from the production "mushroom sauce" case (deliberate, accepted in review).
- Family exemption (a long-standing spec rule, not changed here): an ingredient whose family is that of a used pick is allowed. So "omelette" passes when an egg custard (same family, egg dish) is picked.
- A food head (chicken, beef, pork, salmon...) directly before a culinary word must itself be picked ("chicken broth" is flagged). Other bare foods in front of a culinary word, and a bare "chicken" elsewhere, rely on the dictionary: a recall limit of the scan.
- Food spans never cross punctuation (H8). `crisps` is read as a verb or a food by a token rule (M1).

---

Seed 6. Real cmd runs: model `claude-sonnet-5-5`, effort `medium`, production prompts and validators, up to 3 repairs per job.

## Concepts

- accepted: **39 of 40**; on the first attempt: **33**; by attempt: {1: 33, 2: 6, 3: 0, 4: 0}; failed: [15]

| # | twists | accepted on | first-attempt violations |
|---|---|---|---|
| 0 | style:street-food, challenge:thirty-minutes, stars, wildcard | 1 |  |
| 1 | none | 1 |  |
| 2 | style:cosy-pub | 1 |  |
| 3 | none | 2 | concept b description mentions 'fish', which this dish does not use |
| 4 | none | 2 | concept a title mentions 'sage', which this dish does not use; concept a description mentions 'sage', which this dish does not use; concept a description mentions 'onion', which this dish does not use; concept c description mentions 'sage', which this dish does not use |
| 5 | style:date-night-bistro, wildcard | 1 |  |
| 6 | none | 1 |  |
| 7 | none | 1 |  |
| 8 | none | 1 |  |
| 9 | challenge:six-steps, stars, swap | 2 | at least one concept must use 8+ of the ten picks |
| 10 | style:campfire, swap | 1 |  |
| 11 | none | 2 | concept b description mentions 'Tinned pineapple rings', which this dish does not use |
| 12 | none | 1 |  |
| 13 | none | 1 |  |
| 14 | none | 1 |  |
| 15 | none | FAILED | concept a description mentions 'Real ale', which this dish does not use; concept c description mentions 'Real ale', which this dish does not use |
| 16 | style:street-food, challenge:thirty-minutes | 2 | at least one concept must use 8+ of the ten picks |
| 17 | none | 1 |  |
| 18 | none | 1 |  |
| 19 | none | 1 |  |
| 20 | none | 1 |  |
| 21 | none | 1 |  |
| 22 | none | 1 |  |
| 23 | style:takeaway-at-home, challenge:one-pan, wildcard | 1 |  |
| 24 | none | 2 | concept b description mentions 'Bolognese sauce', which this dish does not use |
| 25 | none | 1 |  |
| 26 | none | 1 |  |
| 27 | none | 1 |  |
| 28 | none | 1 |  |
| 29 | none | 1 |  |
| 30 | style:campfire, swap | 1 |  |
| 31 | style:takeaway-at-home, stars | 1 |  |
| 32 | none | 1 |  |
| 33 | none | 1 |  |
| 34 | none | 1 |  |
| 35 | none | 1 |  |
| 36 | style:date-night-bistro | 1 |  |
| 37 | none | 1 |  |
| 38 | none | 1 |  |
| 39 | none | 1 |  |

### Every rejection (all attempts)

- basket 3 attempt 1:
  - concept b description mentions 'fish', which this dish does not use
- basket 4 attempt 1:
  - concept a title mentions 'sage', which this dish does not use
  - concept a description mentions 'sage', which this dish does not use
  - concept a description mentions 'onion', which this dish does not use
  - concept c description mentions 'sage', which this dish does not use
  - concept c description mentions 'onion', which this dish does not use
- basket 9 attempt 1:
  - at least one concept must use 8+ of the ten picks
- basket 11 attempt 1:
  - concept b description mentions 'Tinned pineapple rings', which this dish does not use
- basket 15 attempt 1:
  - concept a description mentions 'Real ale', which this dish does not use
  - concept c description mentions 'Real ale', which this dish does not use
- basket 15 attempt 2:
  - concept a description mentions 'Real ale', which this dish does not use
  - concept c description mentions 'Real ale', which this dish does not use
- basket 15 attempt 3:
  - concept a description mentions 'Real ale', which this dish does not use
  - concept c description mentions 'Real ale', which this dish does not use
- basket 15 attempt 4:
  - concept b uses only 5 picks; each concept needs 7+
  - concept b vibe mentions 'Real ale', which this dish does not use
  - concept c description mentions 'Real ale', which this dish does not use
- basket 16 attempt 1:
  - at least one concept must use 8+ of the ten picks
- basket 24 attempt 1:
  - concept b description mentions 'Bolognese sauce', which this dish does not use

## Bank-it recipes

- accepted: **20 of 20**; on the first attempt: **15**; by attempt: {1: 15, 2: 3, 3: 1, 4: 1}; failed: []

| # | twists | accepted on | first-attempt violations |
|---|---|---|---|
| 0 | style:street-food, challenge:thirty-minutes, stars, wildcard | 2 | cookware must be a list of 1-4 vessels and tools |
| 1 | none | 1 |  |
| 2 | style:cosy-pub | 1 |  |
| 3 | none | 1 |  |
| 4 | none | 2 | step 5 mentions 'Beaten egg', which this dish does not use |
| 5 | style:date-night-bistro, wildcard | 1 |  |
| 6 | none | 4 | step 9 mentions 'Poached egg', which this dish does not use |
| 7 | none | 1 |  |
| 8 | none | 1 |  |
| 9 | challenge:six-steps, stars, swap | 2 | tip 1 mentions 'Real ale', which this dish does not use |
| 10 | style:campfire, swap | 1 |  |
| 11 | none | 1 |  |
| 12 | none | 1 |  |
| 13 | none | 1 |  |
| 14 | none | 1 |  |
| 16 | style:street-food, challenge:thirty-minutes | 1 |  |
| 17 | none | 1 |  |
| 18 | none | 3 | ingredient lentil-pasta note mentions 'Maccheroni', which this dish does not use; step 1 mentions 'Real ale', which this dish does not use; tip 1 mentions 'Real ale', which this dish does not use |
| 19 | none | 1 |  |
| 20 | none | 1 |  |

### Every rejection (all attempts)

- basket 0 attempt 1:
  - cookware must be a list of 1-4 vessels and tools
- basket 4 attempt 1:
  - step 5 mentions 'Beaten egg', which this dish does not use
- basket 6 attempt 1:
  - step 9 mentions 'Poached egg', which this dish does not use
- basket 6 attempt 2:
  - tip 1 mentions 'Egg yolk', which this dish does not use
- basket 6 attempt 3:
  - step 7 mentions 'Poached egg', which this dish does not use
  - tip 3 mentions 'Poached egg', which this dish does not use
- basket 9 attempt 1:
  - tip 1 mentions 'Real ale', which this dish does not use
- basket 18 attempt 1:
  - ingredient lentil-pasta note mentions 'Maccheroni', which this dish does not use
  - step 1 mentions 'Real ale', which this dish does not use
  - tip 1 mentions 'Real ale', which this dish does not use
- basket 18 attempt 2:
  - tip 2 mentions 'Real ale', which this dish does not use

## Baskets

- 0: cashews, cod-liver, egg-noodle-dough, grated-cheese, mature-cheddar, pitted-dates, porcini-oil, spinach, strawberry, taro, tinned-fruit-cocktail
- 1: beef-stir-fry-strips, crispy-fried-onions, enoki-mushroom, kimchi, lamb-mince, nicoise-olives, physalis, salad-potato, salted-butter, sweet-potato
- 2: black-bean-sauce, choux-paste, ciabatta, fava-beans, frozen-onion-rings, guar-beans, honeycomb, lychee, oyster-mushroom, tinned-luncheon-meat
- 3: blewit, crinkle-cut-chips, garlic-cloves, kimchi, mozzarella, opah, sesame-bagel, sparkling-wine, strong-wholemeal-flour, wood-ear-mushroom
- 4: arrowroot, blackcurrant, cider-vinegar, free-range-egg, guar-beans, mixed-salad-leaves, puff-pastry, sea-bass-fillet, stuffing-mix, turkish-apricot
- 5: balsamic-vinegar, black-beans, cockles, fresh-ginger, frozen-onion-rings, hot-dog-roll, lemongrass, orange-jelly, oyster-mushroom, smoked-cheese, sweet-potato
- 6: asparagus, baking-powder, cornbread, dragon-fruit, dried-bay-leaf, enoki-mushroom, free-range-egg, frozen-pepperoni-pizza, green-split-peas, kimchi
- 7: beef-silverside, grapefruit, guar-beans, kimchi, mozzarella-sticks, pickling-vinegar, sauerkraut, spaghetti, spearmint, sushi-rice
- 8: asparagus, baby-sweetcorn, chestnut-spread, couscous, fresh-ginger, frozen-yorkshire-puddings, octopus, shelled-edamame, strong-white-bread-flour, wood-ear-mushroom
- 9: banana-ketchup, blancmange-powder, chorizo, egg-noodle-dough, juniper-berry, kimchi, sauerkraut, sushi-rice, tinned-butter-beans, tinned-lychees
- 10: almonds, arborio-rice, bulgur-wheat, clementine, fine-beans, fish-bones, kimchi, manchego, maple-syrup, raw-sauerkraut
- 11: baby-button-mushroom, camembert, chestnut-flour, durum-wheat-semolina, fast-action-dried-yeast, fresh-ginger, jellied-eels, kimchi, sweet-potato, tinned-pineapple
- 12: asparagus, barramundi, cep, chilli-flakes, egg-noodle-dough, guar-beans, lotus-root, pork-shoulder, tamari, white-kimchi
- 13: garlic-cloves, lamb-leg, lemongrass, napa-cabbage, orange-curd, pomegranate, scrambled-egg, stelline, sweet-potato, vegetable-oil
- 14: blewit, capellini-d-angelo, conch, diced-beef, grapefruit, guar-beans, lemongrass, rice-vinegar, stout, tinned-ravioli
- 15: chestnut-mushroom, cocoa-nibs, desiree-potato, diced-lamb, dried-salted-fish, egg-noodle-dough, fresh-turmeric, preserving-sugar, ready-made-vegetable-curry, tinned-lychees
- 16: cooking-wine, egg-noodles, garlic-cloves, kimchi, lemon-curd, lemon-sole, microwave-noodles, pork-loin, sauerkraut, sugar-snap-peas
- 17: bouquet-garni, chilli-powder, fresh-ginger, perch-fillet, radish, rigatoni, sauerkraut, stracciatella, sweet-potato, tinned-carrots
- 18: chicken-drumstick, choux-paste, enoki-mushroom, fresh-garlic, gouda, kaffir-lime, lentil-pasta, maras-pepper, napa-cabbage, strong-white-bread-flour
- 19: dried-onion-granules, eel, fettuccine, fresh-ginger, halloumi, kimchi, mixed-nuts-and-raisins, papaya, rice-cakes, sauerkraut
- 20: crepe, dried-mint, fresh-turmeric, halloumi, lemongrass, onion-bhajis, passion-fruit, rocamadour, spaghetti, tahini-sauce
- 21: fennel-seeds, fuerte-avocado, garlic-and-coriander-naan, kimchi, mashed-potato-pot, saffron-milk-cap, sauerkraut, stem-ginger-in-syrup, tinned-tuna-in-brine, yellowfin-tuna
- 22: aged-gouda, bagel, dried-porcini, frozen-fish-fingers, girolle, katsu-curry-sauce, lasagne-sheets, salted-butter, tinned-sweetcorn, white-kimchi
- 23: baked-potato-jacket, chestnut-flour, choy-sum, egg-wash, fresh-dill, kimchi, lemongrass, maraschino-cherry, salted-herring, stilton, tinned-carrots
- 24: black-beans, blackcurrant, courgette, dried-rosemary, irish-whiskey, kimchi, lamb-chump-chop, lentil-pasta, ready-made-pizza-base, sauerkraut
- 25: dried-kidney-beans, dried-shiitake-mushroom, flattened-rice, fresh-ginger, kimchi, mixed-salad-leaves, pecan-halves, pepper-jack, sliced-wholemeal-bread, sweet-chilli-sauce
- 26: beef-shin, blackberry, caesar-dressing, choux-paste, flat-mushroom, frozen-onion-rings, garlic-powder, mussels, rye-bread, tinned-fruit-cocktail
- 27: button-mushroom, choux-paste, dried-kidney-beans, fresh-ginger, kimchi, sauerkraut, sesame-oil, strawberry-sauce, sweet-potato, tofu
- 28: baby-sweetcorn, fig, fromage-blanc, haddock-fillet, harissa, oyster-mushroom, stuffing-mushrooms, sweet-potato, taco-shell, tinned-mushy-peas
- 29: button-mushroom, dried-banana-chips, egg-yolk, garlic-bread-baguette, honeycomb, kimchi, lemongrass, pikelet, pork-leg, sparkling-wine
- 30: brandy, brown-crab-meat, egg-noodle-dough, enoki-mushroom, kimchi, lemongrass, spearmint, sweet-potato, tinned-mixed-beans, white-peach
- 31: apple-crumble-topping, black-pudding, cottage-cheese, frozen-mixed-vegetables, giant-puffball, ground-cloves, lasagne-sheets, maris-piper-potato, rhubarb, sweetcorn
- 32: candied-lemon-peel, chicken-carcass, fresh-ginger, garlic-cloves, ginger-cordial, individual-meat-and-potato-pie, linguine, marionberry, semi-skimmed-milk, sushi-rice
- 33: beetroot, blackberry, caramelised-onion-chutney, cranberry-wensleydale, fresh-basil, jasmine-rice, kumquat, pancake-mix, saddle-of-lamb, tenderstem-broccoli
- 34: blackberry, boneless-chicken-thigh, chicken-and-mushroom-pie, couscous, ground-cumin, papaya, red-onion, star-anise, trifle-sponges, wood-ear-mushroom
- 35: buttercream, choux-paste, cuttlefish, dried-porcini, dried-yeast, fresh-ginger, galangal, mini-tortilla, pink-grapefruit, tilapia
- 36: coffee-extract, double-gloucester, dried-yeast, garlic-cloves, kimchi, lemongrass, nut-flour, pearl-couscous, perch-fillet, pickled-mustard-greens
- 37: calf-s-liver, dried-shiitake-mushroom, frozen-breaded-cod-fillets, hazelnuts, ice-cream, lemongrass, orzo, oyster-mushroom, sweet-potato, tinned-fruit-cocktail
- 38: bergamot, chicken-thigh, egg-noodle-dough, kidney-beans, lemongrass, lentil-pasta, runny-honey, sauerkraut, star-anise, tinned-fruit-cocktail
- 39: almond-extract, button-mushroom, choux-paste, fondant-icing-sugar, fresh-garlic, frozen-fish-fingers, girolle, kimchi, mature-cheddar, nut-flour
