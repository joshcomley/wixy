# Cookout ingredient pictures: final report (pack v1)

Written 17 November 2026 (UTC). Every number below was counted from the work folder's journal, not estimated.

## The result

- **3,494** ingredients in the catalogue. **3,480 have a picture** (99.6%). **14 have none** and show the emoji tile.
- Pack v1 is released as GitHub release `cookout-images-v1`: 44,257,280 bytes, 6,960 pictures-and-thumbnails (3,480 at two sizes), sha256 `5b0431d50c9605fc10093aa2c65cc8c5f9880b490d7ecaf11d036d147f902395`. The asset was downloaded back and its checksum matched before the manifest was written.
- **Every one of the 3,480 pictures was checked by Haiku and then re-checked by Sol** (the operator's rule, decision 2150): 3,139 passed both, and 341 were settled by a Sol tiebreak after Haiku was unsure. No picture was accepted on one checker's word.

## How a picture got in

First attempt: 3,018 pictures passed on the first go. The rest needed more:

| Passed on attempt | Pictures |
|---|---|
| 1 | 3,018 |
| 2 | 265 |
| 3 | 112 |
| 4 | 18 |
| 5 | 60 |
| 6 | 7 |

Pass rates measured on the way (these are what changed the plan):

- First attempts: 86.1% (3,009 of 3,494 before the rescue renumbering).
- A plain re-draw of a failed description with a new random number: **33%** (72 of 218).
- A re-draw from a description Haiku had rewritten first: **72%** and **64%** in the first two measured batches (34 of 50 over both), against 44% for pictures already past the rewrite. The ladder was changed to rewrite before attempt 2 as a result.

## The 14 with no picture (emoji tile)

Nine were chosen by Opus after both checkers had said "wrong", and then **failed the Sol re-check** the operator requires on every accept, so they were dropped:

| Ingredient | Sol said |
|---|---|
| cheese-and-onion-crisps | consistent with the flavour, but the requested bowl is missing |
| chocolate-rice-cakes | recognisable, but not in a bowl |
| hominy | consistent with hominy, but the requested bowl is missing |
| jaffa-cakes | recognisable as a Jaffa cake, but the requested plate is missing |
| jiu-soba | consistent with soba, but an aligned stack rather than the requested heap |
| sloe | consistent with sloes, but the requested bowl is missing |
| steak-bake | recognisable as a steak bake, but the requested plate is missing |
| dill-seeds | the seeds look like cumin, and the bowl is missing |
| frozen-prawn-toast | the prawn topping looks unfried, and the plate is missing |

Seven of these nine are recognisable food that failed only on the container (bowl, plate, heap). That is a rule the checkers apply strictly; it can be revisited by drawing them again with the container in the description.

Five failed every attempt, including two hand-written descriptions in a final rescue round: **fluted-pumpkin-leaves, garganelli, mahi-mahi, microwave-popcorn-bag, salmon-collar.**

## The rescue round

Twenty ingredients had failed all six attempts. For each, a description was written by hand, naming what sets it apart from the thing the model kept drawing. Pass A drew one picture each: 9 of 20 passed. Pass B drew a second picture for the 11 that failed, with a new description written from the checker's stated reason: 6 of 11 passed. Fifteen of the 20 are now in the pack. The old attempts, pictures and Opus decisions for these 20 are kept under `rescue/` in the work folder, nothing was deleted.

## Where things ran, and where the plan was bent

- Drawing ran on **Cherry** (an RTX 5080), not the hub: the hub is kept for vital services. Cherry was shared with the Douglas research seat, so every redraw batch was a bounded job of at most 25 minutes on a shared 12,000 MiB claim, started only when no exclusive claim was running, and stopped at a picture boundary on request. Cherry's measured rate was 24-37 seconds a picture; a 50-picture batch took about 20 minutes.
- The model recipe is Qwen-Image 2.1 (operator decision 2410). The server's default image model is unchanged: it also serves Would-You-Rather, and the baked pictures do not depend on it.
- Long runs were scheduled tasks and Grid jobs, not a CI lane. Checking ran on the hub, because the checks need cmd.
- The decoy catch rate was measured in the calibration (`image-calibration.md`: both checkers caught 5 of 5 planted wrong pictures). The production rounds did not log it separately, so there is no production figure.

## Eleven rewrites that the catalogue would not take

The rewrite step accepted 413 descriptions and the committed catalogue accepted 402 of them. Eleven were refused by the catalogue's stricter check, so the committed description for these stays as it was, even though the picture in the pack was drawn from the rewrite: bakewell-tart, bourbon-biscuits, frozen-prawn-toast (no picture), pain-au-chocolat, plaice-fillet, rue, spaetzle, spianata-piccante, stuffed-olives, tinned-cockles, yuzu-kosho. The exact texts are in `rescue/refused_overrides.json` in the work folder. The cause is that the rewrite step and the catalogue use two different checks; making them the same is a small follow-up.

## Problems found and fixed along the way (all merged)

The hub's check round died twice from a single bad item each time (a folder Windows would not delete; an Opus answer written as prose followed by a fenced block), and a third unreadable answer now just makes that one picture wait. Each now costs one picture a retry instead of ending the round. The batch scheduler was changed from lock-step groups (36% of lane time idle) to a rolling pool (87% busy). A refused model answer is no longer replayed to the caller that refused it. One end-to-end test was found racing the client's redraw and was fixed at the cause.
