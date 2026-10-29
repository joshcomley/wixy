# Cookout chef trial - final report (round 2)

Real cmd runs (claude-sonnet-5-5, production prompts and validators, up to 3 repairs). Four runs were made while tuning; the table below is the LAST run (seed 3).

| run | code | concepts accepted | on attempt 1/2/3/4 | recipes accepted |
|---|---|---|---|---|
| 1 (seed 1, partial, 19 baskets) | first cut | 19/19 | 7 first | - |
| 2 (seed 1) | + bun/date/challengeNote fixes | 40/40 | 27/9/3/1 | 8/10 |
| 3 (seed 2) | + self-check prompts | 39/40 | 26/8/4/1 | 10/10 (9 first) |
| 4 (seed 3) | + challengeNote schema field, oven-note and crisps fixes | 39/40 | 30/7/1/1 | 9/10 (8 first) |

Bar for concepts (>=38/40, >=30 first attempt) met by run 4. Every remaining violation was read: basket 2 (diced pork, tomato, pork mince), diced beef, custard, potato farl, relish, chilli, crisps, pastry were genuine unpicked foods; the 8+/7+ coverage rejections are structural and honest. The one failed recipe (basket 4) was rejected for the verb "crisps quickly" and "tea towel" (false positives, fixed after the run: ignored phrases) plus an undeclared "cooking oil" (genuine). The post-run scan fixes are covered by offline tests only.

---


Seed 3. Real cmd runs: model `claude-sonnet-5-5`, effort `medium`, production prompts and validators, up to 3 repairs per job.

## Concepts

- accepted: **39 of 40**; on the first attempt: **30**; by attempt: {1: 30, 2: 7, 3: 1, 4: 1}; failed: [2]

| # | twists | accepted on | first-attempt violations |
|---|---|---|---|
| 0 | challenge:six-steps, wildcard | 1 |  |
| 1 | none | 1 |  |
| 2 | none | FAILED | concept a description mentions 'Diced pork', which this dish does not use |
| 3 | none | 1 |  |
| 4 | challenge:six-steps, stars | 2 | at least one concept must use 8+ of the ten picks |
| 5 | none | 1 |  |
| 6 | none | 1 |  |
| 7 | none | 1 |  |
| 8 | style:picnic | 2 | at least one concept must use 8+ of the ten picks |
| 9 | none | 1 |  |
| 10 | none | 1 |  |
| 11 | none | 2 | concept b uses only 6 picks; each concept needs 7+ |
| 12 | none | 1 |  |
| 13 | none | 1 |  |
| 14 | none | 1 |  |
| 15 | stars | 2 | concept c description mentions 'Custard', which this dish does not use |
| 16 | none | 1 |  |
| 17 | none | 1 |  |
| 18 | none | 1 |  |
| 19 | none | 2 | concept b title mentions 'Potato farl', which this dish does not use; concept c description mentions 'Diced beef', which this dish does not use |
| 20 | none | 2 | concept b title mentions 'chilli', which this dish does not use; concept c title mentions 'chilli', which this dish does not use |
| 21 | none | 1 |  |
| 22 | none | 1 |  |
| 23 | challenge:one-pan, wildcard | 3 | at least one concept must use 8+ of the eleven picks |
| 24 | none | 1 |  |
| 25 | none | 2 | at least one concept must use 8+ of the ten picks |
| 26 | none | 1 |  |
| 27 | none | 1 |  |
| 28 | none | 4 | at least one concept must use 8+ of the ten picks |
| 29 | none | 1 |  |
| 30 | style:picnic, challenge:six-steps, wildcard | 1 |  |
| 31 | none | 1 |  |
| 32 | none | 1 |  |
| 33 | none | 1 |  |
| 34 | style:breakfast-for-dinner, challenge:no-oven | 1 |  |
| 35 | none | 1 |  |
| 36 | style:date-night-bistro, stars, swap | 1 |  |
| 37 | style:posh-tasting, challenge:six-steps, stars, swap | 1 |  |
| 38 | style:takeaway-at-home | 1 |  |
| 39 | none | 1 |  |

### Every rejection (all attempts)

- basket 2 attempt 1:
  - concept a description mentions 'Diced pork', which this dish does not use
- basket 2 attempt 2:
  - concept b title mentions 'Tomato', which this dish does not use
- basket 2 attempt 3:
  - concept a description mentions 'Diced pork', which this dish does not use
- basket 2 attempt 4:
  - concept c description mentions 'Pork mince', which this dish does not use
- basket 4 attempt 1:
  - at least one concept must use 8+ of the ten picks
- basket 8 attempt 1:
  - at least one concept must use 8+ of the ten picks
- basket 11 attempt 1:
  - concept b uses only 6 picks; each concept needs 7+
- basket 15 attempt 1:
  - concept c description mentions 'Custard', which this dish does not use
- basket 19 attempt 1:
  - concept b title mentions 'Potato farl', which this dish does not use
  - concept c description mentions 'Diced beef', which this dish does not use
- basket 20 attempt 1:
  - concept b title mentions 'chilli', which this dish does not use
  - concept c title mentions 'chilli', which this dish does not use
- basket 23 attempt 1:
  - at least one concept must use 8+ of the eleven picks
- basket 23 attempt 2:
  - concept c description mentions 'crisps', which this dish does not use
- basket 25 attempt 1:
  - at least one concept must use 8+ of the ten picks
- basket 28 attempt 1:
  - at least one concept must use 8+ of the ten picks
- basket 28 attempt 2:
  - concept b uses only 5 picks; each concept needs 7+
  - concept b vibe mentions 'pastry', which this dish does not use
- basket 28 attempt 3:
  - concept c title mentions 'relish', which this dish does not use

## Bank-it recipes

- accepted: **9 of 10**; on the first attempt: **8**; by attempt: {1: 8, 2: 1, 3: 0, 4: 0}; failed: [4]

| # | twists | accepted on | first-attempt violations |
|---|---|---|---|
| 0 | challenge:six-steps, wildcard | 1 |  |
| 1 | none | 2 | step 3 mentions 'crisps', which this dish does not use |
| 3 | none | 1 |  |
| 4 | challenge:six-steps, stars | FAILED | step 3 mentions 'Cooking oil', which this dish does not use |
| 5 | none | 1 |  |
| 6 | none | 1 |  |
| 7 | none | 1 |  |
| 8 | style:picnic | 1 |  |
| 9 | none | 1 |  |
| 10 | none | 1 |  |

### Every rejection (all attempts)

- basket 1 attempt 1:
  - step 3 mentions 'crisps', which this dish does not use
- basket 4 attempt 1:
  - step 3 mentions 'Cooking oil', which this dish does not use
- basket 4 attempt 2:
  - tip 1 mentions 'crisps', which this dish does not use
- basket 4 attempt 3:
  - tip 1 mentions 'tea', which this dish does not use
  - tip 2 mentions 'crisps', which this dish does not use
- basket 4 attempt 4:
  - cookware must be a list of 1-4 vessels and tools
  - tip 1 mentions 'crisps', which this dish does not use

## Baskets

- 0: firm-tofu, french-breakfast-radish, fresh-ginger, garlic-salt, gooseberry, lasagne-sheets, orzo, sauerkraut, stem-ginger-in-syrup, straw-mushroom, whiting-fillet
- 1: choux-paste, enoki-mushroom, fresh-ginger, fromage-frais, giant-puffball, lamb-shoulder, pickled-turnips, ready-made-lasagne, sesame-seeds, sushi-rice
- 2: brown-beech-mushroom, coconut-flour, enoki-mushroom, fresh-garlic, harissa, lasagne-sheets, pasta-sauce-jar, pork-loin-chop, swordfish-steak, tinned-carrots
- 3: baby-spinach, chocolate-buttons, croissant, kimchi, lemongrass, ready-made-potato-salad, red-leicester, rump-steak, sauerkraut, wasabi-paste
- 4: brandy, dried-mixed-mushrooms, egg-noodle-dough, garlic-cloves, green-peas, lemongrass, pineapple-juice, salami-milano, sultana, tinned-macaroni-cheese
- 5: beef-topside, borlotti-beans-fresh, bridge-roll, estima-potato, green-lentils, lemongrass, mint-jelly, persimmon, rapadura, sauerkraut
- 6: butterhead-lettuce, fresh-turmeric, garlic-flakes, guava, hot-cross-bun, kimchi, lemon-sole, manchego, peanuts, rye-bread
- 7: baking-powder, beef-topside, egg-noodle-dough, orange, ready-made-vegetable-curry, russet-potato, salmon-roe, sauerkraut, tartare-sauce, tinned-carrots
- 8: bay-bolete, celery-leaf, chestnut-flour, croissant, garlic-cloves, guar-beans, onion-bhajis, salami-milano, teriyaki-sauce, turkey-breast-steak
- 9: chicken-mince, flour-tortillas, fresh-ginger, ground-nutmeg, groundnut-oil, honeydew-melon, lamb-mince, lentil-pasta, onion-bhajis, takuan
- 10: chicken-carcass, fresh-garlic, fresh-ginger, frozen-onion-rings, gruyere, horseradish-root, pale-ale, pecan-halves, rye-crispbread, vialone-nano-rice
- 11: beef-sirloin-steak, cheese-and-onion-filling, egg-noodle-nests, fresh-ginger, lemongrass, mixed-peppercorns, onion-bhajis, sauerkraut, sweet-potato, tinned-borlotti-beans
- 12: dried-yeast, egg-noodle-nests, fresh-ginger, gooseberry, lemongrass, lingonberry-jam, monterey-jack, peanut-flour, pomegranate, whiting-fillet
- 13: choux-paste, dried-onion-granules, garlic-cloves, kimchi, mixed-fruit-jam, pork-meatballs, quiche-lorraine, salad-potato, spinach, tinned-mushrooms
- 14: egg-noodle-dough, fresh-chives, fresh-coriander, fresh-egg-tagliatelle, girolle, kimchi, navel-orange, saganaki-cheese, sauerkraut, white-kidney-beans
- 15: beaten-egg, boneless-chicken-thigh, coconut-oil, durum-wheat-semolina, estima-potato, kimchi, pancake-wrap, spinach, tamarind, wasabi-root
- 16: emmental, farfalle, honey-bbq-sauce, invert-sugar-syrup, kamaboko, onion-bhajis, oyster-mushroom, rooster-potato, tinned-lychees, wood-ear-mushroom
- 17: bridge-roll, celery, chilli-flakes, cider-vinegar, croissant, flounder, halloumi, kimchi, lemongrass, shiitake-mushroom
- 18: choux-paste, cooking-spray, fresh-garlic, fresh-ginger, girolle, hot-sauce, kimchi, lamb-leg, peanut-flour, plaice-fillet
- 19: beef-topside, blue-foot-mushroom, fast-action-dried-yeast, frozen-blueberries, frozen-strawberries, minute-steak, oat-bars, rooster-potato, sauerkraut, sweet-potato
- 20: blackberry, button-mushroom, chickpeas, ice-cream-cornet, kidney-beans, lemongrass, light-soy-sauce, oyster-mushroom, sambal-oelek, tinned-spaghetti-hoops
- 21: cep, cheese-and-onion-loaf, honeycomb, kimchi, lamb-chump-chop, new-potato, orange-curd, sauerkraut, stargazy-pie, tinned-carrots
- 22: cream-cracker, dried-lavender, fresh-ginger, frozen-potato-wedges, guar-beans, halibut-steak, sand-dab, victoria-plum, white-turmeric, white-wine-vinegar
- 23: ackee, breaded-calamari-rings, chapati, coconut-flour, fine-beans, galangal, ground-nutmeg, kimchi, lamb-mince, maple-flavouring, pecan-halves
- 24: beef-silverside, cane-syrup, fresh-ginger, garlic-bread-baguette, honeydew-melon, lentil-pasta, sauerkraut, sauvignon-blanc, tamarillo, whelks
- 25: black-fig, camembert, cucumber, egg-noodle-dough, fresh-garlic, frozen-onion-rings, ground-coriander, microwave-rice-pouch, nut-brittle, spanish-mackerel
- 26: brie, estima-potato, garlic-cloves, onion-powder, passion-fruit, peanuts, physalis, pork-spare-ribs, sauerkraut, sweet-potato
- 27: american-cheese-slices, boiled-egg, cranberry-and-walnut-sourdough, fresh-garlic, gin, hot-chilli-powder, nectarine, ready-made-vegetable-curry, sweet-potato, tinned-lychees
- 28: almond-paste, choux-paste, cocoa-powder, firm-tofu, garlic-cloves, jazz-apple, raisin, sweet-potato, tinned-chopped-tomatoes, yellow-split-peas
- 29: blackcurrant, grana-padano, gruyere, ice-cream-cones, kimchi, lemongrass, pork-medallions, preserved-turnip, ready-made-pizza-base, star-anise
- 30: baby-potato, chicken-gravy-powder, conchiglie, cranberry, dried-porcini, green-split-peas, liquid-egg-white, sauerkraut, sudachi, turbot, walnuts
- 31: choux-paste, elephant-garlic, english-breakfast-tea, fuerte-avocado, garden-peas, ground-ginger, gruyere, peanut-flour, tiger-prawns, tinned-cherries
- 32: aubergine, chardonnay, danish-blue, frozen-gyoza, maccheroni, oyster-mushroom, persimmon, rhubarb, roasted-peanuts, wholewheat-spaghetti
- 33: choux-paste, flour-tortillas, fresh-ginger, girolle, lemon-curd, oyster-mushroom, pork-belly-strips, pork-leg, taco-seasoning, yellow-pepper
- 34: bulgur-wheat, chickpeas, goat-s-cheese-log, granny-smith-apple, lemongrass, medium-cut-marmalade, radish, sourdough-loaf, tinned-chopped-tomatoes, whole-cloves
- 35: coconut-flour, dried-yeast, fresh-ginger, lemongrass, lentil-pasta, ready-made-fish-pie, red-sauerkraut, unsalted-butter, whitefish, wood-ear-mushroom
- 36: baby-potato, beef-sirloin-steak, dried-blueberries, grana-padano, kimchi, north-atlantic-prawns, roasted-peanuts, sauerkraut, strawberry, water-biscuit
- 37: creme-de-cassis, garlic-cloves, kidney-beans, lemongrass, natural-yoghurt, raw-sauerkraut, ricotta, sesame-bagel, tinned-processed-peas, yorkshire-pudding
- 38: beef-topside, birch-syrup, cep, enoki-mushroom, fava-beans, garlic-cloves, lemongrass, salad-potato, scone, trail-mix
- 39: celeriac, choux-paste, cod-loin, granulated-sugar, lentil-pasta, persimmon, pisco, sauerkraut, tinned-mushy-peas, white-cabbage
