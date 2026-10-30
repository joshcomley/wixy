# Cookout chef trial 8 (audit F2 head-noun rule, seed 7, commit b3e15e15)

Bar: concepts >= 38/40 accepted and >= 30 first try; recipes >= 9/10. Result: **concepts 38/40, 32 first try (by attempt 1/2/3/4 = 32/5/1/0); recipes 10/10, 7 first try.** Bar met.

## Every first-attempt and later rejection, labelled

Concepts
- basket 7 (failed after 4 attempts): "plum" in titles with only plum sauce picked - the head-noun rule working as intended (use "plum sauce"); "flatbread" and "Lemon" not picked - genuine; one attempt also had 6 picks - structural. Genuine.
- basket 11: "Fresh coconut" for "Coconut-Crusted" with coconut flour and tinned coconut milk picked - rule price (name the pick: "coconut flour crust"). Accepted on attempt 2.
- basket 14 (failed after 4 attempts): "Cranberry" in titles with only cranberry sauce picked - rule price; "Dab" (the fish, "Cranberry Dabs") and "Bechamel sauce", "Lemon" - genuine.
- basket 20: "like a bacon roll" (a simile naming bacon; only bacon fat picked) - genuine; "Hazelnut Pitta Crisps" (a bank snack, only hazelnuts and pitta picked) - genuine; one structural (6 picks).
- basket 23: structural (6 picks). Basket 25: star ingredient missing from title/description - structural. Basket 24: "Enoki crisps up" read as the food crisps - DEFECT, fixed (a modifier word of a pick's name may be the subject of the verb "crisps"); the second attempt was a structural rule.
- basket 37: "Chilli Carp" with only chilli oil picked - rule price.
- basket 9-type count rules: structural.

Recipes
- basket 0/2 none. Basket 1: "prawns, squid, mussels" itemising a picked seafood mix - genuine under the existing rule (the mix is picked, its parts are not). Basket 3: "6 whole cloves" for picked garlic cloves read as the spice - ambiguous, left as a repair (making "whole" free let "whole chicken" and "whole milk" through, so that attempt was reverted); "Fish skin" tip - genuine. Basket 4: "1 whole fish" for a picked whole sea bass - genuine.

## Result
2 failed baskets (7 and 14) are both the new rule meeting a chef who kept saying "plum"/"cranberry" for plum/cranberry sauce; the prompt already tells the chef to use the picked names, and first-try (32) is above the bar, so no prompt change was made. One scan defect found (enoki crisps) and fixed; full pytest 5272 passed; differential re-run: 270 distinct newly accepted, 0 defects; replay of 708 earlier accepted dishes: 63 (8.9%) rejected once, as reported.
