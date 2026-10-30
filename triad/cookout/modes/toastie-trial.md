# Toasted sandwich: real-run trial (spec 09c §8.4)

Real cmd runs, production prompts and validators, model `claude-sonnet-5-5` (effort medium), up to
3 repairs per job, seed 1, 40 baskets (a quarter with twists: style, challenge, stars, wildcard,
swap). Tool: `tooling/cookout/chef_trial.py --mode toastie`.

**Deviations declared (read first)**

1. **Basket draw.** The trial ran before M1's `candidates`/`facet` draw arguments (A.2) reached my
   branch, so baskets come from an equivalent fallback draw in `chef_trial.py` (the mode's real
   schedule and kind pools; two different families per pair, at least one everyday; same picking
   rules). The chef only sees the picked basket, so this does not change what was tested; the real
   draw is used automatically now that A.2 is merged.
2. **Picture judge (§8.4 said Haiku).** Haiku was the wrong instrument (table below), so on the
   coordinator's ruling the 12 pictures were judged by **Sol and Opus** through cmd with the
   unchanged spec question and the unchanged spec template.
3. **Result against the picture bar: NOT MET on one cell.** Bar is ≥11/12 from each judge on each
   set. Existing set: Sol 12/12, Opus 12/12. Fresh set: Opus 12/12, **Sol 10/12**. See Pictures.

## Chef concepts

| run | prompt | judged | accepted | attempt 1 | 2 | 3 | 4 | failed |
|---|---|---|---|---|---|---|---|---|
| 1 (stopped by me at basket 21) | toastie text only | 22 | 18 | 7 | 5 | 5 | 1 | 4 (baskets 7, 8, 13, 21) |
| **2 (final)** | + the Classic steering rules | **40** | **40** | **36** | 4 | 0 | 0 | 0 |

Bars: ≥38/40 accepted (**40**), ≥30 first attempt (**36**), no wrongly rejected good toastie (below).

**Run 1 gap (found by reading every rejection).** The toasted-sandwich prompt text lacked the
Classic prompt's measured rules. The chef described a picked sauce by what it contains ("fresh
chilli and coriander heat" for zhoug), added a pickle, relish, chutney, syrup, honey, cumin,
cranberry or cornmeal that nobody picked, compared a dish to a "fish-finger sandwich", and got the
`omitted` list wrong (`"omitted": []` while leaving a filling out). Every one was a genuine break
of the rule, not a scan defect and not a correct answer wrongly rejected. Fix (commit `1c6c2b0a`):
`_single_dish_rules` in `cookout_ai.py` carries the Classic steering (never name an unpicked food,
including what a sauce is made of, side words and comparison dishes; the exact `omitted` rule;
the id lists). I added it in code beside the mode text, not in `cookout_modes.json`. Run 2 is the
same seed re-run end to end.

**Run 2 rejections (all attempts, all genuine):**

| basket | twists | attempt | violation | class |
|---|---|---|---|---|
| 13 | none | 1 | concept a uses only 4 fillings; each idea needs 5+ of 7 | genuine (coverage rule) |
| 21 | none | 1 | concept c names 'Flour tortillas' (not picked) | genuine smuggling |
| 30 | no-oven, stars, swap | 1 | concept a omitted list not the exact complement | genuine (omitted rule) |

All three were accepted on attempt 2. No scan defect, and no correct toastie was rejected.

**Review signals (`Parsed.signals`): none raised** across the 40 accepted answers.

**Replays of the review's phrasings** (4 accepted answers rewritten with a short bread name,
"never an open sandwich" and a "-inspired" filling, run through the real validator): **4/4
accepted**, each raising exactly the expected signals (`'open sandwich'` and `'bruschetta'`), no
violation. (The dead `wrap` review word is noted separately; it can never match because the bank
knows "wrap" as a food.)

## Bank this (recipes)

10 recipes: **10/10 accepted** (8 on attempt 1, 2 on attempt 2). The two retries: recipe 5 named
'Squash' in a tip, recipe 6 had an empty step text and named 'Squash' in a tip; both genuine.

## Pictures

12 pictures rendered on hub's ComfyUI from accepted concepts (production prompt, spec template, the
empty-queue gate). One Classic basket picture is the control (must be answered no): every judge
answered no.

I looked at all 12 myself: all 12 are one closed toasted sandwich, cut in half, filling showing, no
text, no open sandwich.

**Haiku (the spec's judge) was unreliable:** 7/12 on the spec question; 9/12 on a clarified
question (the halves of one cut sandwich count as one); 4/12 on a reworded template that I tried
and discarded (it drew one half leaning beside a flat half, which reads as two items). Several
Haiku reasons contradict their own verdict ("closed sandwich, not open" then no; "this would be a
yes, not a no"). The spec template (the cut, stacked toastie) and question were kept unchanged.

**Sol and Opus, spec question, spec template:**

| set | Sol | Opus |
|---|---|---|
| the 12 existing pictures | 12/12 | 12/12 |
| 12 fresh renders (baskets 12-23, new seeds) | **10/12** | 12/12 |

Per picture:

| set | picture | Sol | Opus | Haiku (spec Q) | Haiku (clarified Q) |
|---|---|---|---|---|---|
| existing | 01-basket0-a | yes | yes | no | no |
| existing | 02-basket1-c | yes | yes | yes | yes |
| existing | 03-basket2-a | yes | yes | yes | yes |
| existing | 04-basket3-b | yes | yes | yes | no |
| existing | 05-basket4-a | yes | yes | yes | no |
| existing | 06-basket5-b | yes | yes | no | yes |
| existing | 07-basket6-b | yes | yes | no | yes |
| existing | 08-basket7-b | yes | yes | yes | yes |
| existing | 09-basket8-c | yes | yes | yes | yes |
| existing | 10-basket9-b | yes | yes | yes | yes |
| existing | 11-basket10-a | yes | yes | no | yes |
| existing | 12-basket11-a | yes | yes | no | yes |
| fresh | f12-b | yes | yes | - | - |
| fresh | f13-a | yes | yes | - | - |
| fresh | f14-b | yes | yes | - | - |
| fresh | f15-a | yes | yes | - | - |
| fresh | f16-b | yes | yes | - | - |
| fresh | f17-c | yes | yes | - | - |
| fresh | f18-b | yes | yes | - | - |
| fresh | f19-a | yes | yes | - | - |
| fresh | f20-a | yes | yes | - | - |
| fresh | **f21-a** | **no** | yes | - | - |
| fresh | f22-c | yes | yes | - | - |
| fresh | **f23-c** | **no** | yes | - | - |

**The two Sol misses, looked at by hand** (`toastie-pictures/f21-a.webp`, `f23-c.webp`): f21-a is
one toasted sandwich cut in half with the halves stacked (creamy herb filling, closed bread on
both halves); Sol read the stack as "two sandwiches". f23-c is one bagel toastie cut in half and
stacked, melted cheese and orange pieces showing; Sol: "there appears to be more than one
sandwich". Both are the same misreading of the deliberately stacked cut, not a defect in the
picture (a wrongly failed good picture is a checker defect, as for Haiku). Opus accepted both.
Honestly this is one picture short of the bar for Sol on the fresh set; I have changed nothing
further and am reporting it.

Picture files: `triad/cookout/modes/toastie-pictures/` (`f21-a`, `f23-c` rejected by Sol;
`f12-b`, `04-basket3-b` accepted by both).

## Baskets

40 baskets, seed 1; the full ingredient lists and every raw answer are in the run's
`chef-trial.json` (kept out of the repo). 10 baskets carried twists (style, challenge, stars,
wildcard, swap); the challenges seen included no-oven, six-steps and one-pan.
