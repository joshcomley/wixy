# Audit F4 differential (3,000 baskets, reason-recorded) and replay

Tool: `tooling/cookout/f4_differential.py` (gen / run / report / invariant). 3,000 random baskets of 10 picks, 215,599 candidate phrases (names of unpicked bank foods sharing a word with a pick, plus 15 random each), scanned as "serve with <name>" with two random declared staples. Three trees: the scan before round 2 (0c4163fd), the previous tip (2a20ccd1), this branch. Every newly accepted phrase carries the reason the scan recorded; none is without one.

Reading guide: `byproduct(key, by)` = a curated list entry whose sources the basket supplies; `pick-run(N)` = the pick's own name written short; `covered-word` = a head noun of a pick used bare; `pasta-shape` / `ring-shape` / `own-name-overlap` = the pinned exceptions. A newly flagged phrase is a distinct product, or (when it ends in a by-product head) read for a curation gap: the 26 not on the list are served-with sauces (burger, cocktail, curry, fish, oyster, pizza, stir-fry, tartare, black/yellow bean, scotch bonnet), nut/seed oils and butters (avocado, coconut, mustard, perilla, walnut, pecan), date/icing sugar and syrups, aioli, vanilla paste, vegetable stock and the five-spice marinade, all excluded by the curation rule; 0 curation gaps.

## Against the scan before round 2

Newly accepted: 244 distinct phrases by reason: {'byproduct': 121, 'covered-word': 57, 'pick-run': 51, 'pasta-shape': 13, 'ring-shape': 1, 'own-name-overlap': 1}.
Accepted with no recorded reason (defects): 0.
Newly flagged: 0 distinct phrases.

### Newly accepted - byproduct (121)

- Anchovy paste [byproduct(anchovy paste, Salted anchovies)] x1
- Apple jelly [byproduct(apple jelly, Discovery apple; Granulated sugar)] x15
- Apple juice [byproduct(apple juice, Braeburn apple)] x22
- Apple sauce [byproduct(apple sauce, Red Delicious apple)] x30
- Apricot glaze [byproduct(apricot glaze, Apricot)] x9
- Apricot jam [byproduct(apricot jam, Apricot; Granulated sugar)] x7
- Bacon fat [byproduct(bacon fat, Canadian bacon)] x45
- Basil oil [byproduct(basil oil, Lemon basil; Cooking oil)] x12
- Beef bone broth [byproduct(beef bone broth, Beef mince)] x35
- Beef gravy [byproduct(beef gravy, beef)] x39
- Beef stock [byproduct(beef stock, Bulgogi beef)] x47
- Beef stock pot [byproduct(beef stock, Bulgogi beef)] x46
- Beetroot juice [byproduct(beetroot juice, Golden beetroot)] x25
- Bilberry jam [byproduct(bilberry jam, Bilberry; Granulated sugar)] x5
- Blackberry jam [byproduct(blackberry jam, Blackberry; Granulated sugar)] x4
- Blackcurrant jam [byproduct(blackcurrant jam, Blackcurrant; Granulated sugar)] x4
- Blue cheese dressing [byproduct(blue cheese dressing, Blue cheese)] x1
- Blueberry jam [byproduct(blueberry jam, Blueberry; Granulated sugar)] x4
- Bread sauce [byproduct(bread sauce, Sliced wholemeal bread; Milk)] x18
- Brown butter [byproduct(brown butter, Butter)] x37
- Brown chicken stock [byproduct(brown chicken stock, chicken)] x44
- Cardamom sugar [byproduct(cardamom sugar, Ground cardamom; Granulated sugar)] x2
- Carolina reaper sauce [byproduct(carolina reaper sauce, Carolina Reaper flakes)] x23
- Carrot juice [byproduct(carrot juice, Heritage carrot)] x32
- Cheese sauce [byproduct(cheese sauce, Soft goat's cheese)] x33
- Cherry jam [byproduct(cherry jam, Amarena cherry; Granulated sugar)] x21
- Cherry juice [byproduct(cherry juice, Rainier cherry)] x37
- Chicken bone broth [byproduct(chicken bone broth, chicken)] x47
- Chicken gravy [byproduct(chicken gravy, chicken)] x50
- Chicken stock [byproduct(chicken stock, chicken)] x47
- Chicken stock pot [byproduct(chicken stock, chicken)] x53
- Chilli crisp oil [byproduct(chilli crisp oil, Bird's eye chilli; Cooking oil)] x21
- Chilli jam [byproduct(chilli jam, Cascabel chilli; Granulated sugar)] x17
- Chilli oil [byproduct(chilli oil, Bird's eye chilli; Cooking oil)] x21
- Clarified butter [byproduct(clarified butter, Butter)] x18
- Cloudberry jam [byproduct(cloudberry jam, Cloudberry; Granulated sugar)] x4
- Crab apple jelly [byproduct(crab apple jelly, Crab apple; Granulated sugar)] x3
- Cranberry juice [byproduct(cranberry juice, Cranberry)] x10
- Cranberry sauce [byproduct(cranberry sauce, Cranberry)] x11
- Damson jam [byproduct(damson jam, Damson; Granulated sugar)] x6
- Duck fat [byproduct(duck fat, Duck liver)] x12
- Egg mayonnaise [byproduct(egg mayonnaise, Century egg; Light mayonnaise)] x6
- Elderberry jelly [byproduct(elderberry jelly, Elderberry; Granulated sugar)] x3
- Elderflower syrup [byproduct(elderflower syrup, Elderflower; Granulated sugar)] x5
- Fig jam [byproduct(fig jam, Fig; Granulated sugar)] x4
- Fish stock [byproduct(fish stock, fish)] x37
- Galangal paste [byproduct(galangal paste, Lesser galangal)] x30
- Garlic butter [byproduct(garlic butter, Smoked garlic; Butter)] x5
- Garlic mayonnaise [byproduct(garlic mayonnaise, Garlic cloves; Mayonnaise)] x2
- Garlic puree [byproduct(garlic puree, Garlic cloves)] x24
- Garlic sauce [byproduct(garlic sauce, Garlic cloves)] x26
- Ginger and garlic paste [byproduct(ginger and garlic paste, Young ginger; Black garlic)] x3
- Ginger puree [byproduct(ginger puree, Red pickled ginger)] x13
- Ginger syrup [byproduct(ginger syrup, Ground ginger; Caster sugar)] x8
- Goose fat [byproduct(goose fat, Wild goose)] x14
- Grapefruit juice [byproduct(grapefruit juice, Pink grapefruit)] x16
- Greengage jam [byproduct(greengage jam, Greengage; Granulated sugar)] x6
- Habanero hot sauce [byproduct(habanero hot sauce, Habanero powder)] x3
- Ham hock stock [byproduct(ham hock stock, Gammon hock)] x9
- Ham stock [byproduct(ham stock, York ham)] x35
- Hollandaise sauce [byproduct(hollandaise sauce, Hollandaise)] x9
- Horseradish sauce [byproduct(horseradish sauce, Fresh horseradish)] x3
- Lamb stock [byproduct(lamb stock, Lamb loin chops)] x43
- Lavender sugar [byproduct(lavender sugar, culinary lavender; Granulated sugar)] x3
- Lemon glaze [byproduct(lemon glaze, Lemon; Granulated sugar)] x1
- Lemon juice [byproduct(lemon juice, Meyer lemon)] x8
- Lemon oil [byproduct(lemon oil, Preserved lemon; Flaxseed oil)] x4
- Lemongrass paste [byproduct(lemongrass paste, Lemongrass)] x11
- Lime curd [byproduct(lime curd, Key lime; Dried egg powder; Butter; Granulated sugar)] x1
- Lime juice [byproduct(lime juice, Lime)] x25
- Lingonberry jam [byproduct(lingonberry jam, Lingonberry; Granulated sugar)] x3
- Mango juice [byproduct(mango juice, Mango)] x17
- Mango salsa [byproduct(mango salsa, Mango)] x16
- Mint jelly [byproduct(mint jelly, Moroccan mint; Granulated sugar)] x3
- Mint sauce [byproduct(mint sauce, Moroccan mint)] x9
- Miso dressing [byproduct(miso dressing, Barley miso)] x23
- Miso gravy [byproduct(miso gravy, White miso)] x24
- Mushroom sauce [byproduct(mushroom sauce, Oyster mushroom)] x50
- Mushroom stock [byproduct(mushroom stock, Shiitake mushroom)] x52
- Onion gravy [byproduct(onion gravy, White onion)] x19
- Orange jelly [byproduct(orange jelly, Seville orange; Granulated sugar)] x4
- Orange juice [byproduct(orange juice, Navel orange)] x12
- Orange oil [byproduct(orange oil, Valencia orange; Chilli crisp oil)] x8
- Orange sauce [byproduct(orange sauce, Cara Cara orange)] x19
- Parsley sauce [byproduct(parsley sauce, Curly parsley)] x18
- Peach jam [byproduct(peach jam, Peach; Granulated sugar)] x11
- Peanut sauce [byproduct(peanut sauce, Peanuts)] x1
- Pineapple jam [byproduct(pineapple jam, Pineapple; Granulated sugar)] x8
- Pineapple juice [byproduct(pineapple juice, Candied pineapple)] x21
- Plum jam [byproduct(plum jam, Victoria plum; Granulated sugar)] x8
- Plum sauce [byproduct(plum sauce, Mirabelle plum)] x28
- Pomegranate juice [byproduct(pomegranate juice, Pomegranate)] x8
- Pork bone broth [byproduct(pork bone broth, Pork cheek)] x46
- Quince jelly [byproduct(quince jelly, Quince; Granulated sugar)] x3
- Raspberry coulis [byproduct(raspberry coulis, Yellow raspberry)] x8
- Raspberry jam [byproduct(raspberry jam, Raspberry; Granulated sugar)] x6
- Red wine gravy [byproduct(red wine gravy, Red wine)] x2
- Red wine jus [byproduct(red wine jus, Red wine)] x1
- Redcurrant jelly [byproduct(redcurrant jelly, Redcurrant; Granulated sugar)] x1
- Rhubarb jam [byproduct(rhubarb jam, Rhubarb; Granulated sugar)] x6
- Rocket pesto [byproduct(rocket pesto, Rocket)] x15
- Strawberry jam [byproduct(strawberry jam, Strawberry; Granulated sugar)] x4
- Strawberry jelly [byproduct(strawberry jelly, Strawberry; Granulated sugar)] x4
- Strawberry sauce [byproduct(strawberry sauce, Strawberry)] x10
- Sweet chilli sauce [byproduct(sweet chilli sauce, Chilli powder; Granulated sugar)] x15
- Tahini sauce [byproduct(tahini sauce, Tahini)] x7
- Tamarind paste [byproduct(tamarind paste, Tamarind pods)] x7
- Tamarind sauce [byproduct(tamarind sauce, Tamarind pods)] x7
- Tomato juice [byproduct(tomato juice, Green tomato)] x29
- Tomato puree [byproduct(tomato puree, Vine tomato)] x32
- Tomato salsa [byproduct(tomato salsa, Datterini tomato)] x29
- Tomato sauce [byproduct(tomato sauce, Sun-dried tomato)] x32
- Truffle oil [byproduct(truffle oil, Summer truffle; Cooking oil)] x9
- Turkey gravy [byproduct(turkey gravy, turkey)] x37
- Vanilla sugar [byproduct(vanilla sugar, Vanilla pods; Granulated sugar)] x3
- Vanilla syrup [byproduct(vanilla syrup, Vanilla pods; Granulated sugar)] x3
- Veal stock [byproduct(veal stock, veal)] x32
- Walnut sauce [byproduct(walnut sauce, Walnut halves)] x13
- Wild garlic pesto [byproduct(wild garlic pesto, Garlic granules)] x19
- Yuzu dressing [byproduct(yuzu dressing, Yuzu)] x8
- Yuzu juice [byproduct(yuzu juice, Yuzu)] x10

### Newly accepted - covered-word (57)

- Almonds [covered-word] x14
- Beetroot [covered-word] x7
- Bonito [covered-word] x4
- Bream [covered-word] x3
- Butter [covered-word] x21
- Camembert [covered-word] x10
- Carob [covered-word] x4
- Cheddar [covered-word] x12
- Chermoula [covered-word] x6
- Cherry [covered-word] x1
- Chorizo [covered-word] x1
- Citron [covered-word] x8
- Cockles [covered-word] x1
- Couscous [covered-word] x8
- Crispbread [covered-word] x10
- Custard [covered-word] x8
- Drumstick [covered-word] x8
- Dulse [covered-word] x4
- Eel [covered-word] x5
- Fennel [covered-word] x8
- Galangal [covered-word] x3
- Gnocchi [covered-word] x28
- Gochugaru [covered-word] x1
- Harissa [covered-word] x2
- Herring [covered-word] x36
- Honey [covered-word] x11
- Honeycomb [covered-word] x5
- Jackfruit [covered-word] x4
- Liquorice [covered-word] x6
- Mayonnaise [covered-word] x56
- Meringue [covered-word] x13
- Milk [covered-word] x34
- Nori [covered-word] x10
- Octopus [covered-word] x2
- Omelette [covered-word] x1
- Orange [covered-word] x1
- Papaya [covered-word] x3
- Peanuts [covered-word] x11
- Pineapple [covered-word] x5
- Poblano [covered-word] x8
- Quinoa [covered-word] x5
- Radish [covered-word] x6
- Raspberry [covered-word] x1
- Scone [covered-word] x3
- Spaghetti [covered-word] x12
- Sprats [covered-word] x2
- Squash [covered-word] x66
- Squid [covered-word] x4
- Stilton [covered-word] x2
- Sturgeon [covered-word] x3
- Suet [covered-word] x3
- Tagliatelle [covered-word] x8
- Tamarind [covered-word] x7
- Tofu [covered-word] x3
- Tomato [covered-word] x6
- Turnip [covered-word] x13
- Walnuts [covered-word] x4

### Newly accepted - own-name-overlap (1)

- Sausage roll [own-name-overlap] x1

### Newly accepted - pasta-shape (13)

- Acini di pepe [pasta-shape] x1
- Alphabet pasta [pasta-shape] x22
- Angel hair pasta [pasta-shape] x23
- Calamarata [pasta-shape] x1
- Capellini d'angelo [pasta-shape] x2
- Ditalini [pasta-shape] x1
- Fresh spaghetti [pasta-shape] x2
- Fusilli [pasta-shape] x2
- Garganelli [pasta-shape] x1
- Gemelli [pasta-shape] x1
- Mezze maniche [pasta-shape] x1
- Penne lisce [pasta-shape] x1
- Vermicelli pasta [pasta-shape] x19

### Newly accepted - pick-run (51)

- Baby squid [pick-run(Tinned baby squid)] x3
- Baked beans [pick-run(Reduced-sugar baked beans)] x4
- Bao bun [pick-run(Frozen bao buns)] x3
- Basmati rice [pick-run(Microwave basmati rice pouch)] x4
- Beaten egg [pick-run(Blue egg)] x14
- Beef burger patty [pick-run(Frozen beef burger patties)] x1
- Black beans [pick-run(Fermented black beans)] x1
- Boiled egg [pick-run(Blue egg)] x15
- Carolina Reaper [pick-run(Carolina Reaper flakes)] x14
- Cheese spread [pick-run(Cream cheese spread)] x2
- Chestnut purée [pick-run(Sweet chestnut puree)] x1
- Chicken goujons [pick-run(Breaded chicken goujons)] x4
- Chicken wings [pick-run(Crispy chicken wings)] x3
- Chilli powder [pick-run(fine korean chilli powder)] x2
- Coconut milk [pick-run(Tinned coconut milk)] x2
- Cod fillet [pick-run(Frozen breaded cod fillets)] x2
- Coffee beans [pick-run(Chocolate-coated coffee beans)] x3
- Dried yeast [pick-run(Fast-action dried yeast)] x3
- Duck egg [pick-run(Salted duck egg)] x3
- Egg white [pick-run(Pheasant egg)] x26
- Egg yolk [pick-run(Hen's egg)] x18
- Fish pie mix [pick-run(Frozen fish pie mix)] x4
- Fried egg [pick-run(Turkey egg)] x24
- Ground ginger [pick-run(Ground ginger spice)] x2
- Hard-Boiled egg [pick-run(Goose egg)] x9
- Ice cream [pick-run(Vanilla ice cream)] x12
- Ice cream cone [pick-run(Ice cream cones)] x5
- Ice cream cones [pick-run(Ice cream cone)] x3
- Lamb leg [pick-run(lamb leg chunks)] x3
- Lentil pasta [pick-run(Red lentil pasta)] x3
- Mackerel fillet [pick-run(Smoked mackerel fillet)] x3
- Mushy peas [pick-run(Tinned mushy peas)] x2
- Mustard greens [pick-run(Pickled mustard greens)] x2
- Olive oil [pick-run(Tuna in olive oil jar)] x4
- Pizza base [pick-run(Ready-made pizza base)] x4
- Plain flour [pick-run(Wholemeal plain flour)] x2
- Poached egg [pick-run(Brown egg)] x14
- Poppy seeds [pick-run(White poppy seeds)] x1
- Pork mince [pick-run(Beef and pork mince)] x1
- Red bean paste [pick-run(Sweet red bean paste)] x2
- Refried beans [pick-run(Tinned refried beans)] x3
- Rice paper [pick-run(edible rice paper)] x10
- Roasted peanuts [pick-run(Dry-roasted peanuts)] x11
- Scrambled egg [pick-run(Duck egg)] x15
- Soft-Boiled egg [pick-run(Organic egg)] x22
- Tinned tomatoes [pick-run(Tinned chopped tomatoes)] x2
- Vol-au-vent case [pick-run(Vol-au-vent cases)] x8
- Vol-au-vent cases [pick-run(Vol-au-vent case)] x7
- Wasabi root [pick-run(Fresh wasabi root)] x1
- Water chestnut [pick-run(Water chestnut pods)] x8
- Yorkshire pudding [pick-run(Giant Yorkshire pudding)] x6

### Newly accepted - ring-shape (1)

- Tinned pineapple rings [ring-shape(Tinned pineapple)] x2

### Newly flagged - listed by-products whose sources the basket lacked (0)



### Newly flagged - by-product-shaped phrases NOT on the list: read each for a curation gap (0)


### Newly flagged - distinct products (0)



## Against the previous tip (2a20ccd1)

Newly accepted: 78 distinct phrases by reason: {'byproduct': 66, 'pick-run': 11, 'covered-word': 1}.
Accepted with no recorded reason (defects): 0.
Newly flagged: 99 distinct phrases.

### Newly accepted - byproduct (66)

- Anchovy paste [byproduct(anchovy paste, Salted anchovies)] x1
- Apple jelly [byproduct(apple jelly, Discovery apple; Granulated sugar)] x15
- Apricot jam [byproduct(apricot jam, Apricot; Granulated sugar)] x7
- Bacon fat [byproduct(bacon fat, bacon)] x8
- Beef bone broth [byproduct(beef bone broth, Beef mince)] x35
- Beef gravy [byproduct(beef gravy, beef)] x18
- Beef stock pot [byproduct(beef stock, beef)] x19
- Bilberry jam [byproduct(bilberry jam, Bilberry; Granulated sugar)] x5
- Blackberry jam [byproduct(blackberry jam, Blackberry; Granulated sugar)] x4
- Blackcurrant jam [byproduct(blackcurrant jam, Blackcurrant; Granulated sugar)] x4
- Blueberry jam [byproduct(blueberry jam, Blueberry; Granulated sugar)] x4
- Brown butter [byproduct(brown butter, Butter)] x37
- Brown chicken stock [byproduct(brown chicken stock, chicken)] x44
- Cherry jam [byproduct(cherry jam, Amarena cherry; Granulated sugar)] x21
- Chicken bone broth [byproduct(chicken bone broth, chicken)] x45
- Chicken gravy [byproduct(chicken gravy, chicken)] x25
- Chicken stock [byproduct(chicken stock, chicken)] x23
- Chicken stock pot [byproduct(chicken stock, chicken)] x34
- Chilli jam [byproduct(chilli jam, Cascabel chilli; Granulated sugar)] x15
- Clarified butter [byproduct(clarified butter, Butter)] x18
- Cloudberry jam [byproduct(cloudberry jam, Cloudberry; Granulated sugar)] x4
- Crab apple jelly [byproduct(crab apple jelly, Crab apple; Granulated sugar)] x3
- Damson jam [byproduct(damson jam, Damson; Granulated sugar)] x6
- Duck fat [byproduct(duck fat, duck)] x6
- Elderberry jelly [byproduct(elderberry jelly, Elderberry; Granulated sugar)] x3
- Elderflower syrup [byproduct(elderflower syrup, Elderflower; Granulated sugar)] x5
- Fig jam [byproduct(fig jam, Fig; Granulated sugar)] x4
- Fish stock [byproduct(fish stock, fish)] x23
- Galangal paste [byproduct(galangal paste, Lesser galangal)] x30
- Garlic puree [byproduct(garlic puree, Garlic cloves)] x24
- Ginger and garlic paste [byproduct(ginger and garlic paste, Young ginger; Black garlic)] x3
- Ginger puree [byproduct(ginger puree, Red pickled ginger)] x13
- Ginger syrup [byproduct(ginger syrup, Ground ginger; Caster sugar)] x8
- Goose fat [byproduct(goose fat, goose)] x9
- Greengage jam [byproduct(greengage jam, Greengage; Granulated sugar)] x6
- Habanero hot sauce [byproduct(habanero hot sauce, Habanero powder)] x3
- Ham hock stock [byproduct(ham hock stock, Gammon hock)] x7
- Lamb stock [byproduct(lamb stock, lamb)] x18
- Lavender sugar [byproduct(lavender sugar, culinary lavender; Granulated sugar)] x3
- Lemongrass paste [byproduct(lemongrass paste, Lemongrass)] x11
- Lime curd [byproduct(lime curd, Key lime; Dried egg powder; Butter; Granulated sugar)] x1
- Lingonberry jam [byproduct(lingonberry jam, Lingonberry; Granulated sugar)] x3
- Mango salsa [byproduct(mango salsa, Mango)] x16
- Mint jelly [byproduct(mint jelly, Moroccan mint; Granulated sugar)] x2
- Orange jelly [byproduct(orange jelly, Seville orange; Granulated sugar)] x4
- Peach jam [byproduct(peach jam, Peach; Granulated sugar)] x11
- Pineapple jam [byproduct(pineapple jam, Pineapple; Granulated sugar)] x8
- Plum jam [byproduct(plum jam, Victoria plum; Granulated sugar)] x8
- Pork bone broth [byproduct(pork bone broth, Pork cheek)] x46
- Quince jelly [byproduct(quince jelly, Quince; Granulated sugar)] x3
- Raspberry coulis [byproduct(raspberry coulis, Yellow raspberry)] x8
- Raspberry jam [byproduct(raspberry jam, Raspberry; Granulated sugar)] x6
- Redcurrant jelly [byproduct(redcurrant jelly, Redcurrant; Granulated sugar)] x1
- Rhubarb jam [byproduct(rhubarb jam, Rhubarb; Granulated sugar)] x6
- Rocket pesto [byproduct(rocket pesto, Rocket)] x15
- Strawberry jam [byproduct(strawberry jam, Strawberry; Granulated sugar)] x4
- Strawberry jelly [byproduct(strawberry jelly, Strawberry; Granulated sugar)] x4
- Sweet chilli sauce [byproduct(sweet chilli sauce, Chilli powder; Granulated sugar)] x15
- Tamarind paste [byproduct(tamarind paste, Tamarind pods)] x7
- Tomato puree [byproduct(tomato puree, Vine tomato)] x32
- Tomato salsa [byproduct(tomato salsa, Datterini tomato)] x29
- Turkey gravy [byproduct(turkey gravy, turkey)] x17
- Vanilla sugar [byproduct(vanilla sugar, Vanilla pods; Granulated sugar)] x3
- Vanilla syrup [byproduct(vanilla syrup, Vanilla pods; Granulated sugar)] x3
- Veal stock [byproduct(veal stock, veal)] x18
- Wild garlic pesto [byproduct(wild garlic pesto, Garlic granules)] x19

### Newly accepted - covered-word (1)

- Chermoula [covered-word] x6

### Newly accepted - pick-run (11)

- Beaten egg [pick-run(White egg)] x1
- Beef stock [pick-run(Beef stock pot)] x17
- Cheese spread [pick-run(Cream cheese spread)] x2
- Egg yolk [pick-run(White egg)] x1
- Fried egg [pick-run(White egg)] x3
- Garlic sauce [pick-run(Chilli garlic sauce)] x2
- Ground ginger [pick-run(Ground ginger spice)] x2
- Hard-Boiled egg [pick-run(White egg)] x3
- Poached egg [pick-run(White egg)] x1
- Scrambled egg [pick-run(White egg)] x2
- Soft-Boiled egg [pick-run(White egg)] x2

### Newly flagged - listed by-products whose sources the basket lacked (13)

Apple jelly; Bread sauce; Cherry jam; Chilli jam; Garlic butter; Ginger syrup; Lemon curd; Lemon glaze; Lemon oil; Lime curd; Mint jelly; Onion gravy; Orange jelly

### Newly flagged - by-product-shaped phrases NOT on the list: read each for a curation gap (26)

- Aioli sauce
- Avocado oil
- Black bean sauce
- Burger sauce
- Carob syrup
- Chinese five-spice marinade
- Chocolate syrup
- Cocktail sauce
- Coconut oil
- Curry sauce
- Date sugar
- Date syrup
- Fish sauce
- Icing sugar
- Mustard oil
- Oyster sauce
- Pecan butter
- Perilla oil
- Pizza sauce
- Scotch bonnet sauce
- Stir-fry sauce
- Tartare sauce
- Vanilla paste
- Vegetable stock
- Walnut oil
- Yellow bean sauce

### Newly flagged - distinct products (60)

Banana pepper; Beaten egg; Beetroot relish; Biscuit spread; Black beans; Boiled egg; Celery salt; Cheese rind; Cheese spread; Chestnut flour; Chestnut spread; Coconut flour; Coconut water; Cream cheese spread; Dried mixed fruit; Egg noodle dough; Egg white; Egg yolk; Fried egg; Garlic salt; Gravy granules; Green peppercorns; Hard-Boiled egg; Lemon pepper; Matzo meal; Olive oil spread; Onion gravy granules; Onion salt; Orange bitters; Pancake wrap; Pasta sauce jar; Peanut flour; Plum chutney; Poached egg; Pork pie; Potato starch; Pudding rice; Rice flour; Roast chicken; Roasted red pepper spread; Rose water; Salad cream; Salad potato; Sausagemeat stuffing; Scrambled egg; Soda water; Soft-Boiled egg; Spinach wrap; Steak bake; Stuffing mix; Stuffing mushrooms; Tinned mushroom soup; Tinned mushrooms; Tinned tomato soup; Tomato wrap; Truffle salt; Water chestnut; Water kefir; Water spinach; White egg

## Full invariant sweep (every multi-word bank name x every pick of another family sharing a word)
```
105036 scans in 80s; leaking phrases: 8
  Acini di pepe via squid-ink-pasta
  Alphabet pasta via beetroot-pasta
  Angel hair pasta via beetroot-pasta
  Tinned pineapple rings via tinned-pineapple
  Vermicelli pasta via beetroot-pasta
  onion rings via brown-onion
  pineapple rings via candied-pineapple
  spaghetti rings via fresh-spaghetti (pasta)
```
Only the pinned exceptions remain: generic/shape pasta (class D) and a trailing ring/rings shape of a pick. (The tip leaked 80 phrases.)

## Replay of accepted trial dishes (runs 2-9)
```
distinct accepted dishes replayed 822 fields flagged 75 distinct phrases 39
8 peanuts | ['peanut-flour']
5 hen's egg | []
5 black beans | ['black-bean-sauce']
4 roast chicken | []
3 cranberry | ['cranberry-sauce']
3 chocolate | ['chocolate-chips']
3 blackcurrant | ['blackcurrant-cordial']
3 orange | ['orange-juice']
3 lingonberry | ['lingonberry-jam']
3 lime | ['lime-cordial']
2 scotch egg sausagemeat | []
2 chilli | ['tinned-chilli-con-carne']
2 beef | ['beef-topside']
2 chestnuts | ['chestnut-mushroom']
2 strawberry | ['strawberry-ice-cream']
2 potato | ['baked-potato-jacket']
1 cream | ['cream-cheese-spread']
1 ginger | ['ginger-marmalade']
1 meringue | ['meringue-nests']
1 green cardamom pods | []
1 elderflower | ['elderflower-cordial']
1 fresh wasabi root | []
1 biscuits | ['water-biscuit']
1 cherry | ['cherry-juice']
1 raspberry | ['raspberry-coulis']
1 maccheroni | []
1 jelly | []
1 curry sauce | ['ready-made-vegetable-curry']
1 almonds | ['almond-paste']
1 mustard | ['yellow-mustard-seeds']
1 chicken | ['chicken-carcass']
1 oats | ['oat-bars']
1 chickpeas | ['chickpea-flour']
1 fish | ['fish-bones']
1 cep | []
1 tahini | ['tahini-sauce']
1 prickly pear | []
1 fennel | ['fennel-seeds']
1 coffee | ['coffee-extract']
```
Every flagged phrase is a modifier word or another product named for a picked product (peanuts for peanut flour, black beans for black bean sauce, orange for orange juice, cranberry for cranberry sauce...), or a food no pick supplied (hen's egg, cep, prickly pear, maccheroni, wasabi root) that earlier scans let through the family and bare-word exemptions. The prompt now tells the chef to write the full picked name (or its last word) and a flagged name names the picked item it probably meant.
