# 00001 [qv7n2m] Randomize and broaden Would You Rather content

## What
Make each round draw from a randomly chosen topic category and then a randomly chosen question within it. Add varied topic categories and distinctive question pairs.

## Why
The game already selected questions uniformly at random, but the bank was concentrated in ten lifestyle categories and included repeated template families. As the bank grows, flat question-level selection would make new categories rare. Random category-first selection gives every topic category an equal chance while keeping the next round unpredictable.

## Context + current state
The picker in `wixy_server/livechat/wyr_questions.py` selects from all unplayed questions using `rng.choice`; `wyr_game.pick_round` uses the same selection when pictures are pre-painted or painted on demand. The current bank has 2,352 entries across ten categories, with many near-identical variants. Existing IDs are permanent and append-only. `wyr_rounds` tracks played IDs; selection must avoid repeats until every question has been played, then start a new cycle.

## Relevant files + commits
- `wixy_server/livechat/wyr_questions.py`
- `wixy_server/livechat/wyr_questions.json`
- `wixy_server/tests/test_livechat_wyr.py`
- `docs/ai/livechat.md`

## How to continue + acceptance
1. Select a category uniformly among categories that still have unplayed questions, then select uniformly within it. When all questions are used, restart with every question eligible. Pooled and on-demand rounds must use this picker.
2. Append distinctive questions with unique permanent IDs, suitable image descriptions, and broad categories beyond food, travel, dates, home and lifestyle.
3. Tests verify category-first selection, no repeats until exhaustion, restart behavior, valid/unique IDs and pairs, and broad topic coverage.
4. Update the livechat operator documentation and run the focused WYR test suite. Keep touched files LF.

## Links
- Delivery record: `a544f055-fdaf-4246-8de6-f04cb0337e9d`

## Outcome
Merged pull request 325 at `241baf6e7f63e2840af432acf740e1462d8e10b3`. The question bank contains 2,472 questions across 25 categories; the picker samples a category uniformly, then an unplayed question within it.
