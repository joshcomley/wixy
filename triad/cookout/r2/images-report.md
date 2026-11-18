# Cookout ingredient pictures: final report (pack v2)

Written 17 November 2026 (UTC). Every number below was counted from the work folder's journal, not estimated.

## The result

- **3,494** ingredients in the catalogue. **3,487 have a picture** (99.8%). **7 have none** and show the emoji tile.
- The pack is GitHub release `cookout-images-v2`: 44,369,920 bytes, 6,974 picture files (3,487 pictures at two sizes), sha256 `d4ffc9f6bf1ea521e562aa55ac5ec6ce8ca72dc3586e8dd0ad75b5e874f5f7de`. It was downloaded back and its checksum matched before the manifest was written, and the history check and the clean-install check both passed.
- Release `cookout-images-v1` (3,480 pictures) was cut first and is kept: a release is immutable. The manifest in this change pins v2; v1 is not referenced by it.
- **Every one of the 3,487 pictures was checked by Haiku and then re-checked by Sol** (the operator's rule, decision 2150): 3,146 passed both, and 341 were settled by a Sol tiebreak after Haiku was unsure. No picture was accepted on one checker's word, and none was accepted on an Opus look alone: nine pictures Opus had chosen were put through Sol, and the ones Sol rejected were dropped or redrawn (below).

## How a picture got in

| Passed on attempt | Pictures |
|---|---|
| 1 | 3,024 |
| 2 | 266 |
| 3 | 112 |
| 4 | 18 |
| 5 | 60 |
| 6 | 7 |

(Attempt numbers of the 22 pictures that went through the rescue rounds below restart at 1: their earlier attempts are archived, not counted here.)

Pass rates measured on the way, which changed the plan:

- First attempts: 86.1% (3,009 of 3,494).
- A plain re-draw of a failed description with a new random number: **33%** (72 of 218).
- A re-draw from a description Haiku had rewritten first: **68%** (34 of 50 over the first two measured batches), against 44% (22 of 50) for pictures already past the rewrite. The ladder now rewrites before attempt 2.

## The 7 with no picture (emoji tile)

Five failed every attempt, including two hand-written descriptions in the final rescue round: **fluted-pumpkin-leaves, garganelli, mahi-mahi, microwave-popcorn-bag, salmon-collar.**

Two were chosen by Opus after both checkers had said "wrong" and then **failed the Sol re-check** the operator requires on every accept, because the food itself was wrong: **dill-seeds** (the seeds look like cumin) and **frozen-prawn-toast** (the prawn looks unfried).

## The rescue rounds

Twenty ingredients had failed all six attempts. For each, a description was written by hand naming what sets it apart from what the model kept drawing. First pass: 9 of 20 passed. Second pass, with a description rewritten from the checker's stated reason: 6 of 11 passed. Fifteen of the 20 are in the pack. Their old attempts, pictures and Opus decisions are kept under `rescue/` in the work folder; nothing was deleted.

Nine more were pictures Opus had chosen after both checkers said "wrong". Each got a fresh Sol check, and all nine failed it. Seven of the nine had failed only on the container (the requested bowl, plate or heap was missing, the food itself recognisable). They were redrawn with the container named in the description and re-checked by Haiku and Sol: **all seven passed** (six on the first try, jiu-soba on the second): cheese-and-onion-crisps, chocolate-rice-cakes, hominy, jaffa-cakes, jiu-soba, sloe, steak-bake.

## Where things ran, and where the plan was bent

- Drawing ran on **Cherry** (an RTX 5080), not the hub: the hub is kept for vital services. Cherry was shared with the Douglas research seat, so every redraw batch was a bounded job of at most 25 minutes on a shared 12,000 MiB claim, started only when no exclusive claim was running, and stopped at a picture boundary on request. Cherry's measured rate was 24-37 seconds a picture; a 50-picture batch took about 20 minutes. In all, 4,473 pictures were drawn for 3,494 ingredients.
- The model recipe is Qwen-Image 2.1 (operator decision 2410). The server's default image model is unchanged: it also serves Would-You-Rather, and the baked pictures do not depend on it.
- Long runs were scheduled tasks and Grid jobs, not a CI lane. Checking ran on the hub, because the checks need cmd.
- The decoy catch rate was measured in the calibration (`image-calibration.md`: both checkers caught 5 of 5 planted wrong pictures). The production rounds did not log it separately, so there is no production figure.

## The descriptions in the catalogue

The rewrite step accepted 413 descriptions. At first the committed catalogue accepted only 402 of them, because the rewrite step used a weaker check than the catalogue (for example it let a description put another ingredient after "with"). Eleven were refused: bakewell-tart, bourbon-biscuits, frozen-prawn-toast, pain-au-chocolat, plaice-fillet, rue, spaetzle, spianata-piccante, stuffed-olives, tinned-cockles, yuzu-kosho. The cause is fixed in the code (the rewrite step now applies the catalogue's own check and tells the model why), and these eleven were reworded by hand, changing only the phrase the check refused (for example "topped with flaked almonds" became "topped by flaked almonds"). **The pictures for these eleven were drawn from the original wording**, which is kept in `rescue/refused_overrides.json` in the work folder; the committed text differs from it only in that phrase.

## Problems found and fixed along the way (all merged)

The hub's check round died twice from a single bad item each time (a folder Windows would not delete; an Opus answer written as prose followed by a fenced block), and a third unreadable answer now just makes that one picture wait. The batch scheduler changed from lock-step groups (36% of lane time idle) to a rolling pool (87% busy). A refused model answer is no longer replayed to the caller that refused it. One end-to-end test was found racing the client's redraw and was fixed at the cause. Outside the repository, the hand-over scripts between the hub and Cherry now send the Opus review decisions with each snapshot, because Cherry had held back five already-reviewed pictures for lack of them.
