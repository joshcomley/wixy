# Cookout chef trial 10 (audit F4 final code, seed 9)

Bar: concepts >= 38/40 and >= 30 first try; recipes >= 9/10. Result: **concepts 40/40 accepted, 33 first try (by attempt 1/2/3/4 = 33/4/1/2); recipes 10/10, 5 first try.** Bar met.
(An earlier run, seed 8, on the same rule before two fixes and the prompt wording, was cut off by a session restart at basket 38: 22 first-try, 2 failed baskets. Its rejections were read and led to: `spice` looked through in a pick's name ("ground ginger" for ground ginger spice); an alias of a listed by-product judged by the bank's own name ("garlic dip" = garlic sauce); and the full-name instruction in the prompts. It is not counted.)

## Every rejection, labelled
Concepts (all repaired within the budget)
- basket 0: "orange" used as a colour ("salty orange coating") - existing homograph limit of the word scan, not new; "mint" for mint sauce - rule price (hint named "Mint sauce").
- basket 6: "salmon" for a picked lox (cured salmon) - genuine (lox is not recorded as salmon); existing behaviour.
- basket 18: "chicken" for chicken mini fillets; basket 28: "Black beans" for black bean sauce and "Cashews" for cashew milk; basket 29: "chocolate" for chocolate fudge icing; basket 37: "Pomegranate" for pomegranate juice (x3) - the rule working: a modifier word of a picked product is another food. Each rejection named the picked item (hint) and each basket was accepted.
- basket 21: "Cinnamon roll" with a hot dog roll and a sugar-cinnamon mix picked - genuine unpicked food.
- baskets 29, 37: also the structural "one concept must use 8+ picks".
Recipes: basket 0 cookware list (structural); basket 1 "beef" for beef stir-fry strips, basket 6 "Pork rind" (genuine, pork belly picked) - hint names the pick; basket 2 "squash" the verb ("squash with a spoon") - existing homograph limit; basket 7 empty step text (structural) and "crisps" in a tip - genuine unpicked food.
No new defect found: the only false positives are two homographs (orange colour, squash verb) the word scan always had.

## Result
The first-attempt count (33) is above the bar even with the stricter rule, so no loosening was needed. Full pytest, ruff, format, mypy, bank validator clean.
