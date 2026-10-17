# 00002 [f4k7zp] Two-player timed Reveal rendezvous

## What
Change WYR Reveal into a two-player rendezvous: the first player starts a server-timed 30-second countdown; the other player must tap Reveal before it expires. Show the countdown as a shrinking progress bar and provide a tappable prompt on the chat round card that opens this round's WYR tab.

## Why
The current Reveal can be pressed once by each player at any later time. The operator wants both people present for the reveal, with a visible short window and an easy way to join it from the chat.

## Context + current state
- Existing schema v15 stores `reveal1` and `reveal2` booleans. `reveal_wyr` serializes changes in a SQLite write transaction; `state='revealed'` is the only condition under which the other player's answer is served.
- WYR messages carry `{state, rev}` and updates use `message_updated`; the client fetches the viewer-filtered `/wyr/{seq}` view.
- The completed 00001 bank/randomization delivery is merged in pull request 325 at `241baf6e7f63e2840af432acf740e1462d8e10b3`.
- Concurrency consult relation `46333e22-6ac0-4ac0-9312-5fbc5956739d`: reuse Reveal flags with one server-owned deadline; expire/reset atomically on a later mutation; use the existing round card anchor to navigate; no architecture stop.

## Relevant files + commits
- `wixy_server/livechat/store.py`, `models.py`, `wyr_game.py`, `routes_livechat.py`
- `admin-ui/src/server/api/wyr.ts`, `wyrControls.ts`, `wyrCard.ts`, `wyrGame.ts`, `thread.ts`
- `wixy_server/tests/test_livechat_wyr.py`, `admin-ui/tests/serverWyr.test.ts`
- `docs/ai/contracts.md`, `docs/ai/livechat.md`, `docs/ai/invariants.md`

## How to continue + acceptance
1. Persist an absolute 30-second deadline atomically with the first Reveal flag. A second distinct player tap strictly before the deadline changes the round to `revealed`; the deadline is never extended by refresh or repeated taps.
2. When expired, clear the pending Reveal flag/deadline atomically before a new request can start. No background timer is needed. Simultaneous and late taps cannot expose answers. Existing player identity checks and erasure cascades remain intact.
3. Return only the countdown deadline/status in each player's round view. Render a live shrinking progress bar and seconds; expire it locally at the deadline. Add a clickable prompt to the ordinary chat round card that opens the correct round's WYR tab.
4. Regression tests cover timely second tap, exact/late expiry, restart after expiry, concurrent taps, viewer privacy, countdown rendering, and round-card navigation. Update docs and run focused verification.

## Links
- Delivery record: `d9467436-71e0-40bc-a299-57b74edb5002`.
