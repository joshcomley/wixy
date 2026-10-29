# P2 ingredient bank — checkpoint 2 (spec parcel P1): draw engine + contraband scan

Read `common.md` first. You own `cookout_ingredients.json`, `cookout_bank.py`,
`tooling/cookout/validate_bank.py`, `wixy_server/tests/test_cookout_bank.py`.

Include your in-flight M1 (sentence-case names, consistent blurb full stops), then implement exactly:

1. Spec §2.1 deltas: top-level `stopWords` (generic NON-food culinary words only — no staple/food names,
   per §3.2); category names exactly as §2.1 lists them; every validator rule in §2.1 (25 % category
   cap, ≥ 200 per role and ≥ 30 everyday families per role, mandatory examples toast/sugar/parsley/beef/
   cream, staple rules, 500 simulated maximum-skip rounds asserting EVERY emitted pair satisfies the hard
   pair rules — not merely no exception).
2. Spec §2.3 + Appendix A.1: `shuffle_role_schedule`, `draw_pair` exactly as frozen (hard: two
   categories, two families, ≥ 1 everyday ENTRY, no seen id, no picked family; feasibility before the
   least-shown tie-break; only the offered-family preference is soft; infeasible → a typed exhausted
   error the server maps to `409 exhausted`), `Ingredient.to_snapshot`, `stop_words`.
3. Spec §3.2 + A.1: `find_contraband_ingredients` — Pass 1 (dictionary scan with family/stop-word
   exclusions) and Pass 2 (manifest-specific pass for omitted items and undeclared non-seasoning staples,
   never suppressed by stop-words); word-boundary, case/accent folded, aliases included. A pure function,
   heavily unit-tested with the §6 cases (mango/bacon, undeclared milk as a fifth extra, omitted item in a
   step, properly declared words allowed, generic words allowed).
4. Loader API as A.1 states (`load_cookout_bank`, `load_cookout_bank_or_empty`); keep a thin alias for the
   checkpoint-1 names only if something already imports them.

Done = validator clean, all checks green. FINAL HANDOFF as in `common.md`.
