# Decision 00204: one rule for a multi-word bank product the chef names (audit F4)

## Symptom
Audit F4: bare stop and culinary words were dropped from a span before it was judged, and the pick's head
noun then cleared a different product: salad cream via double cream, water chestnut via chestnuts, spinach
wrap via spinach, tartare sauce via beef tartare, stuffing mix via seafood mix, pork pie via pork collar.
`POOLED_HEADS` also passed peanut butter, rice flour, coconut oil, date sugar. This was the second strike on
the same mechanism (audit F2 was its modifier-word form), so a senior consult redesigned it.

## Root cause
A "shorthand" test built from words (all remaining words appear in some pick) can never tell "X sauce made of
X" from "X sauce served with X, or a bottled product", because English does not mark it. Dropping words made
every such span look like a pick.

## Decision (senior ruling, amends spec 09 section 3.2 and the R2-A brief)
Bank identity first. If the longest-match span is a multi-word bank product that is not a used pick, it
passes only as (A) the pick's own name written short (an order-preserving run of one name, skipping only
modifier words, containing the name's head noun, trailing ring/rings allowed), (B) an entry of a curated,
validated `byproducts` list whose sources the dish supplies, (C) the existing same-family exemption, (D) the
existing generic-pasta-shape exemption. `food_words` dropping and `POOLED_HEADS` are deleted. The list is a
new required key `byproducts` in the bank JSON (amending "stopWords/aliases only"), validated at load: closed
head set `BYPRODUCT_HEADS`, key resolves to a non-staple ingredient, every source satisfiable, carrier named.
Interpretation recorded: sources must be a phrase of the key except the kitchen co-ingredients
sugar/butter/egg/milk/oil (strawberry jam needs sugar, lemon curd egg and butter, bread sauce milk), which the
ruling's own examples require.

## Why
Each pass has one named reason (recorded by the scan), so a differential can class every newly accepted phrase
by code and a human only reads pick-runs and the list. A grammar rule and a per-item `derivedFrom` field were
rejected (cannot be decided from English / the same list spread over 3,491 records).

## Watch for
Regenerating the bank: run `tooling/cookout/byproducts.py` and review new candidates. A chef that writes a
modifier alone ("plum" for plum sauce) is rejected and must use the picked name; that is intended. Do not widen
`BYPRODUCT_HEADS` to cream/water/wrap/bake/pie/mix/flour/milk/salt/vinegar/spread. Reports:
triad/cookout/r2/f4-differential.md and f4-trial.md.
