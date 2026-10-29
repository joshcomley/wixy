# R2-A — the chef must succeed (Cookout round 2, operator first play 2026-10-29)

Read `common.md` first (it binds you). Builder: Sonnet 5.5. You own `wixy_server/livechat/cookout_ai.py`,
`wixy_server/livechat/cookout_bank.py`, `wixy_server/livechat/cookout_ingredients.json` (stopWords/aliases
only, no new ingredients), `wixy_server/tests/test_livechat_cookout_ai.py`, `wixy_server/tests/test_cookout_bank.py`,
`wixy_server/tests/fake_cmd.py`, and a new `tooling/cookout/chef_trial.py`. Specs: core
`spec/server-chat/09-cookout.md` §3.2 and twists `09a` §5 — this brief AMENDS their lexical-scan rules.

## The failure (measured on production, round 11132, run f5e663cd12034d429be6aabc7e86bfbf)

The operator's first real game ended "The chef couldn't finish those dishes". The basket was
guar beans, pea shoots, mantis shrimp, rolled beef joint, dried mixed mushrooms, lemongrass,
vegetable oil, dried onion granules, baby potato, linguine. The chef's dishes were good; our
deterministic prose scan rejected them twice for ordinary cooking language, then gave up:

- first answer: "Mushroom sauce" (a dish phrase, read as the bank item), "onion" (with dried onion
  granules picked), "gravy", "starch" (in an omission reason).
- repair answer (reproduce: `parse_concepts(response_text, bank=load_cookout_bank(), picked_ids=[...])`):
  "lemongrass-scented **oil**" read as the undeclared cooking-oil staple although vegetable oil was
  picked; "**crisp**-tender" read as crisps; "roasting **juices**" read as juice.

## What to build

1. **High-precision scan, not high-recall.** The scan exists to stop a chef introducing a real
   unpicked FOOD (the operator's "you can't just throw mango in"). Rework it so ordinary culinary
   language passes:
   - a bare generic word matches a picked ingredient when any picked (or declared-staple) entry's
     name or alias contains that word as a token (oil ⇐ vegetable oil; onion ⇐ dried onion granules;
     mushroom ⇐ dried mixed mushrooms), including for the staple short forms;
   - no derived plural/inflection matching for single-word entries that are also ordinary
     adjectives/nouns of cooking (crisp/crisps, juice/juices, starch, broth, gravy, sauce, stock as a
     liquid made from picked items, glaze, crumb(s), dressing, batter…): maintain a curated, tested
     `culinaryWords` list in the bank JSON (validator-enforced: none is a distinct food the operator
     would recognise as "added"), and treat cooking by-products of picked items as allowed;
   - omission reasons are explanations, never consumption: only Pass-2 (forbidden swapped-out item)
     applies there; generic words like "starch" never fail a reason;
   - multi-word bank names still match exactly (e.g. "mango chutney"), and a distinct unpicked food
     word (mango, salmon, bacon, chocolate, cheese, garlic…) still fails.
2. **More chances, still honest.** Up to 3 repair runs (not 1) inside the job deadline, each told the
   exact violations; also tell the chef in the FIRST prompt the words to avoid pattern (no unpicked
   foods; "oil"/"onion" etc. fine when a picked item is that). Never weaken the structural id rules.
3. **Prove it on real runs — the rapid local loop.** Write `tooling/cookout/chef_trial.py`: draws N
   random baskets with the real bank + draw engine (include ~25 % with twists: style, challenge, stars,
   wildcard, a swap generation), runs the REAL concepts job through cmd (`CmdChatClient`, the production
   prompt and validator, subscription bucket, sequential with the existing spawn gap), records per basket:
   accepted on attempt 1/2/3/4 or failed + violations, and writes a JSON + markdown report. Acceptance
   bar: **at least 38 of 40 baskets accepted, at least 30 on the first attempt, and every remaining
   violation is a genuine unpicked food** (read each one). Also run 10 bank-it full recipes from
   accepted concepts with the same bar for the recipe validator. Iterate locally until the bar is met;
   put the final report in `triad/cookout/r2/chef-trial.md`.
4. Regression tests from every false positive above (the exact production prose), plus the genuine
   smuggling cases still rejected.

FINAL HANDOFF per `common.md` with the trial numbers. Design questions → the Architect; scope → me.
