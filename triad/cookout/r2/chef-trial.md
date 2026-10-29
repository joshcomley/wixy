# Cookout chef trial - final report (round 2)

Real cmd runs (claude-sonnet-5-5, production prompts and validators, up to 3 repairs). The tables below the summary are the LAST full run (seed 5).

| run | what it tested | concepts accepted | on attempt 1/2/3/4 | recipes accepted |
|---|---|---|---|---|
| 2 (seed 1) | first fixes | 40/40 | 27/9/3/1 | 8/10 |
| 3 (seed 2) | + self-check prompts | 39/40 | 26/8/4/1 | 10/10 |
| 4 (seed 3) | + challengeNote schema field | 39/40 | 30/7/1/1 | 9/10 |
| 5 (seed 4) | + review fixes H1,H2,H8,M3,M4 | 39/40 | 26/7/4/2 | 18/20 (11 first) |
| **6 (seed 5)** | + dip/tart/pastry fixes, prompt count rules | **40/40** | **32/7/1/0** | **20/20 (16 first)** |
| re-run (seed 5, baskets 5, 9, 36) | final code incl. bacon fat / omelette / "catches and crisps" fixes | 3/3 (all first) | - | 3/3 (2 first) |
| re-run (seed 3, baskets 2, 23) | the earlier failures | 2/2 | basket 2 on attempt 1, basket 23 on attempt 2 | - |

Bar met: concepts 40/40 (>= 38) and 32 first-attempt (>= 30); recipes 20/20 (>= 19).

## Correction to the earlier report

Basket 2 of seed 3 was NOT a genuine smuggling failure: "Pan-fry diced pork loin chop" with the pork loin chop picked was read as the unpicked food "Diced pork" (review finding H2, prep word before a picked name). Fixed and tested; the basket is now accepted first time. The `bun` alias on "Bun noodles" (folded to "bun", so choux "buns" read as noodles) was removed from the bank.

## Every rejection in the last full run (seed 5), labelled

Genuine (the chef named an unpicked food): fried egg, custard, raspberry coulis, chilli oil, garlic butter (x2), relish, honey (title), real ale (tip, twice), double cream (a thickness simile), diced lamb; "answer is not JSON" (basket 9 attempt 1) and "uses only 5 picks / no concept uses 8" (basket 9 attempt 2) are honest structural rejections.

Defects found while reading them, fixed afterwards and re-run (above): "bacon fat" from a picked bacon (basket 9 recipe), "Omelette" as a dish name with eggs picked (basket 36), "so it catches and crisps." read as the food crisps (basket 5 recipe). Earlier runs also exposed: "date night", "a dab of", "wafer-thin", "grit", "tea towel", "dip", "tart", "sweet", "pastry" for a picked pie/pasty - all fixed with tests.

## Design notes for the reviewer

- A multi-word phrase is shorthand only when ONE pick's name supplies all its food words (H1). "cheese sauce" built from a cheese-and-onion loaf plus a pasta sauce jar still passes by design: "sauce" is a stop word and cannot be told apart from the production "mushroom sauce" case.
- A food head (chicken, beef, pork, salmon...) directly before a culinary word must itself be picked ("chicken broth" is flagged). Other bare foods in front of a culinary word, and a bare "chicken" elsewhere, rely on the dictionary: a recall limit of the scan.
- Food spans never cross punctuation (H8). `crisps` is read as a verb or a food by a token rule (M4).
- The post-trial scan changes listed above are covered by offline tests plus the 3-basket re-run.

---


Seed 5. Real cmd runs: model `claude-sonnet-5-5`, effort `medium`, production prompts and validators, up to 3 repairs per job.

## Concepts

- accepted: **40 of 40**; on the first attempt: **32**; by attempt: {1: 32, 2: 7, 3: 1, 4: 0}; failed: []

| # | twists | accepted on | first-attempt violations |
|---|---|---|---|
| 0 | none | 1 |  |
| 1 | swap | 1 |  |
| 2 | none | 2 | concept a title mentions 'Fried egg', which this dish does not use; concept c description mentions 'Custard', which this dish does not use; concept c description mentions 'Raspberry coulis', which this dish does not use |
| 3 | style:street-food, wildcard | 1 |  |
| 4 | none | 1 |  |
| 5 | none | 1 |  |
| 6 | none | 1 |  |
| 7 | none | 1 |  |
| 8 | none | 1 |  |
| 9 | none | 3 | the answer is not a JSON object with a 'concepts' list |
| 10 | swap | 1 |  |
| 11 | none | 1 |  |
| 12 | none | 1 |  |
| 13 | none | 1 |  |
| 14 | none | 1 |  |
| 15 | challenge:one-pan | 1 |  |
| 16 | style:cosy-pub, challenge:six-steps, stars, wildcard, swap | 2 | concept c description mentions 'Diced lamb', which this dish does not use |
| 17 | none | 1 |  |
| 18 | none | 1 |  |
| 19 | none | 1 |  |
| 20 | none | 1 |  |
| 21 | none | 1 |  |
| 22 | style:picnic, wildcard, swap | 1 |  |
| 23 | none | 2 | concept c title mentions 'Honey', which this dish does not use |
| 24 | none | 2 | concept b title mentions 'Garlic butter', which this dish does not use; concept b description mentions 'Garlic butter', which this dish does not use |
| 25 | none | 1 |  |
| 26 | none | 1 |  |
| 27 | none | 1 |  |
| 28 | none | 1 |  |
| 29 | style:posh-tasting, challenge:six-steps | 2 | concept b description mentions 'relish', which this dish does not use |
| 30 | none | 1 |  |
| 31 | none | 1 |  |
| 32 | challenge:thirty-minutes, stars | 1 |  |
| 33 | style:breakfast-for-dinner, swap | 1 |  |
| 34 | none | 1 |  |
| 35 | none | 1 |  |
| 36 | none | 2 | concept c title mentions 'Omelette', which this dish does not use; concept c description mentions 'Omelette', which this dish does not use |
| 37 | none | 2 | concept b title mentions 'Garlic butter', which this dish does not use; concept b description mentions 'Garlic butter', which this dish does not use |
| 38 | none | 1 |  |
| 39 | style:street-food, challenge:six-steps | 1 |  |

### Every rejection (all attempts)

- basket 2 attempt 1:
  - concept a title mentions 'Fried egg', which this dish does not use
  - concept c description mentions 'Custard', which this dish does not use
  - concept c description mentions 'Raspberry coulis', which this dish does not use
- basket 9 attempt 1:
  - the answer is not a JSON object with a 'concepts' list
- basket 9 attempt 2:
  - concept a uses only 5 picks; each concept needs 7+
  - concept c title mentions 'Chilli oil', which this dish does not use
  - concept c description mentions 'Chilli oil', which this dish does not use
  - at least one concept must use 8+ of the ten picks
- basket 16 attempt 1:
  - concept c description mentions 'Diced lamb', which this dish does not use
- basket 23 attempt 1:
  - concept c title mentions 'Honey', which this dish does not use
- basket 24 attempt 1:
  - concept b title mentions 'Garlic butter', which this dish does not use
  - concept b description mentions 'Garlic butter', which this dish does not use
- basket 29 attempt 1:
  - concept b description mentions 'relish', which this dish does not use
- basket 36 attempt 1:
  - concept c title mentions 'Omelette', which this dish does not use
  - concept c description mentions 'Omelette', which this dish does not use
- basket 37 attempt 1:
  - concept b title mentions 'Garlic butter', which this dish does not use
  - concept b description mentions 'Garlic butter', which this dish does not use

## Bank-it recipes

- accepted: **20 of 20**; on the first attempt: **16**; by attempt: {1: 16, 2: 3, 3: 1, 4: 0}; failed: []

| # | twists | accepted on | first-attempt violations |
|---|---|---|---|
| 0 | none | 1 |  |
| 1 | swap | 3 | tip 2 mentions 'Real ale', which this dish does not use |
| 2 | none | 1 |  |
| 3 | style:street-food, wildcard | 1 |  |
| 4 | none | 1 |  |
| 5 | none | 2 | step 6 mentions 'crisps', which this dish does not use |
| 6 | none | 1 |  |
| 7 | none | 1 |  |
| 8 | none | 1 |  |
| 9 | none | 2 | step 3 mentions 'Bacon fat', which this dish does not use |
| 10 | swap | 1 |  |
| 11 | none | 1 |  |
| 12 | none | 1 |  |
| 13 | none | 1 |  |
| 14 | none | 1 |  |
| 15 | challenge:one-pan | 1 |  |
| 16 | style:cosy-pub, challenge:six-steps, stars, wildcard, swap | 1 |  |
| 17 | none | 1 |  |
| 18 | none | 2 | step 2 mentions 'Double cream', which this dish does not use |
| 19 | none | 1 |  |

### Every rejection (all attempts)

- basket 1 attempt 1:
  - tip 2 mentions 'Real ale', which this dish does not use
- basket 1 attempt 2:
  - tip 2 mentions 'Real ale', which this dish does not use
- basket 5 attempt 1:
  - step 6 mentions 'crisps', which this dish does not use
- basket 9 attempt 1:
  - step 3 mentions 'Bacon fat', which this dish does not use
- basket 18 attempt 1:
  - step 2 mentions 'Double cream', which this dish does not use

## Baskets

- 0: chicken-carcass, cooked-ham, lemon, lemongrass, ready-made-pizza-base, salad-potato, sauerkraut, star-anise, sugar-cinnamon-mix, white-peach
- 1: cinnamon-sticks, coarse-polenta, devilled-egg, gochujang, oro-blanco, sauerkraut, sultana, sweet-potato, tinned-ham, wood-ear-mushroom
- 2: crowdie, dried-parsley, free-range-egg, guar-beans, kimchi, raspberry, salad-potato, star-anise, sweet-potato, wood-ear-mushroom
- 3: choux-pastry, cinnamon-sticks, girolle, kimchi, ready-made-cottage-pie, rooster-potato, sapodilla, single-cream, tinned-octopus, tomahawk-steak, white-turmeric
- 4: black-eyed-peas, blackcurrant-cordial, coconut-flour, flour-tortillas, frozen-onion-rings, fuerte-avocado, leek, manchego, mint-yoghurt, white-kimchi
- 5: adzuki-beans, bechamel-sauce, blackberry, brown-basmati-rice, cantaloupe-melon, dried-basil, egg-noodle-dough, girolle, oyster-mushroom, ready-made-shepherd-s-pie
- 6: black-eyed-peas, crepe, egg-noodle-dough, fresh-ginger, halloumi, kimchi, oat-bars, ready-made-coleslaw, self-raising-flour, spring-greens
- 7: baby-button-mushroom, cassia-bark, discovery-apple, dried-onion-granules, fresh-turmeric, guar-beans, pearl-semolina, ready-made-fish-pie, sourdough-loaf, turkey-breast-steak
- 8: cheese-and-onion-filling, chicken-and-mushroom-pie, croissant, durum-wheat-semolina, frozen-blueberries, garlic-cloves, girolle, guar-beans, pancake-mix, swordfish-steak
- 9: back-bacon, black-fig, bulgur-wheat, cantaloupe-melon, dried-chillies-whole, frozen-dim-sum, girolle, instant-mash, prosecco, raw-sauerkraut
- 10: currant, curtido, dried-kidney-beans, egg-noodle-dough, fresh-garlic, kimchi, perch-fillet, tinned-spaghetti-in-tomato-sauce, tonic-water, whole-cloves
- 11: beef-silverside, bicarbonate-of-soda, cep, coconut-flour, curtido, egg-noodle-dough, garlic-cloves, lemongrass, pale-ale, tinned-chickpeas
- 12: cola, frozen-onion-rings, honey-roast-ham, lasagne-sheets, redcurrant, sauerkraut, shiitake-mushroom, spaghetti, swordfish-steak, vintage-port
- 13: celery-salt, chestnut-mushroom, choux-paste, fresh-turmeric, ice-cream-cones, leek, rose-wine, swordfish-steak, whiting-fillet, wood-ear-mushroom
- 14: banana, coconut-flour, fresh-ginger, frozen-pakora, lamb-breast, merlot, new-potato, prosecco, red-sauerkraut, whole-turkey
- 15: baby-spinach, crispbread, fresh-turmeric, frozen-blueberries, green-olives, horse-mackerel, minute-steak, pumpkin-seeds, rose-wine, thick-cut-white-toast
- 16: candied-peel, chicken-flavour-instant-noodles, diced-lamb, dried-blueberries, galangal, girolle, hot-cross-bun, rose-wine, tinned-carrots, vacherin-fribourgeois, vanilla-syrup
- 17: candied-peel, choux-paste, dried-shiitake-mushroom, kamaboko, lemongrass, mozzarella, naan-bread, portobello-mushroom, trail-mix, vanilla-extract
- 18: button-mushroom, chickpea-flour, fresh-ginger, garlic-cloves, king-edward-potato, oyster-mushroom, pale-ale, sea-bass-fillet, soda-bread, tilapia
- 19: cayenne-pepper, cep, chicken-livers, frozen-spring-rolls, garlic-cloves, ground-cinnamon, herring, lemongrass, orzo, tinned-chopped-tomatoes
- 20: brown-sauce, green-split-peas, honey-fungus, kimchi, peach, pork-mince, ready-made-macaroni-cheese, ready-made-pizza-base, sauerkraut, vegan-mayonnaise
- 21: carp, enoki-mushroom, frozen-onion-rings, ginger-biscuits, malbec, new-potato, ready-made-vegetable-curry, sauerkraut, sweet-potato, whole-chicken
- 22: chunky-salsa, crepe, green-split-peas, halloumi, hazelnuts, lemongrass, mung-bean-sprouts, red-sauerkraut, shiitake-mushroom, wholemeal-pitta, wild-strawberry
- 23: bosc-pear, brie, chestnut-flour, flat-rice-noodles, garlic-cloves, honeycomb, lemongrass, lime-juice, salami-milano, white-peach
- 24: crumpet, fuerte-avocado, garlic-cloves, guar-beans, kiwi-fruit, lean-beef-mince, oolong-tea, sea-trout, toasted-sesame-seeds, wholemeal-pitta
- 25: butternut-squash, kimchi, lemongrass, lime-curd, plain-flour, sesame-bagel, tinned-sliced-beetroot, trail-mix, whole-chicken, whole-mackerel
- 26: coconut-flour, cucumber-kimchi, dried-orange-zest, elephant-garlic, green-split-peas, horchata, oyster-mushroom, ready-made-coleslaw, scotch-egg, sweet-potato
- 27: butternut-squash, chicken-flavour-instant-noodles, dried-rosemary, fava-beans, frozen-onion-rings, hot-cross-bun, lemongrass, mozzarella, tinned-peaches, vodka
- 28: baby-button-mushroom, blackcurrant, candied-peel, choux-paste, egg-yolk, oca, red-lentils, shiitake-mushroom, strong-wholemeal-flour, sweet-chilli-sauce
- 29: choux-paste, dried-apricot, dried-porcini, green-chilli, ground-nutmeg, padron-pepper, pinto-beans, sea-bass-fillet, spinach-wrap, yellow-mustard-seeds
- 30: black-treacle, chicken-drumstick, diced-lamb, flat-mushroom, girolle, hot-dog-roll, kimchi, pancake-wrap, pistachios, tinned-peaches
- 31: black-bean-sauce, chestnut-mushroom, choux-paste, enoki-mushroom, fresh-ginger, guar-beans, pasta-sauce-jar, pork-shoulder, scone, spiny-lobster
- 32: enoki-mushroom, feta, guar-beans, instant-mash, king-edward-potato, lemongrass, pork-tenderloin, prune-plum, sesame-seeds, turkey-mince
- 33: black-pudding, cheese-spread, choux-paste, fresh-ginger, frozen-mixed-vegetables, john-dory, pearl-onion, ready-made-coleslaw, rye-bread, vanilla-pods
- 34: cardamom-seeds, dried-kidney-beans, garlic-cloves, ground-nutmeg, linguine, oyster-mushroom, pied-de-mouton, rooster-potato, steak-and-ale-pie, wasabi-root
- 35: carp, kimchi, lamb-mince, lemongrass, sauerkraut, shredded-wheat, single-cream, strawberry-ice-cream, wholewheat-couscous, wood-ear-mushroom
- 36: brown-egg, flat-rice-noodles, fresh-ginger, frozen-yoghurt, garlic-cloves, honey-roast-ham, lentil-pasta, ready-made-vegetable-curry, vanilla-extract, wood-ear-mushroom
- 37: beef-cheek, black-pudding, dried-shiitake-mushroom, fresh-basil, garlic-cloves, lentil-pasta, pickled-turnips, sauerkraut, star-anise, sweet-potato
- 38: bird-s-eye-chilli, brown-lentils, crumpet, dried-shiitake-mushroom, frozen-pepperoni-pizza, garlic-cloves, kimchi, pork-tenderloin, rainbow-nonpareils, star-anise
- 39: blewit, butternut-squash, croissant, fish-bones, fresh-garlic, pangasius, roasted-seed-mix, shiitake-mushroom, tawny-port, water-chestnut
