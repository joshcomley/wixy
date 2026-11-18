# M2 — Server, v22 migration and wire (Sonnet 5.5)

Read `modes-common.md` first. Your files: Appendix A row M2. Spec: §1, §2.1/§2.4/§2.5, §4 (server
side of twists), §5 in full (schema v22, models, game logic, wire A.3, AI read, the activation barrier
§5.6 and `activate_modes.py`, privacy §5.7). Tests: §8.2. Docs: your share of §9.

Dependencies: 09b parcel 3 has merged (go). M1's `cookout_modes.py` (A.1) has not merged yet — build
against an untracked stand-in implementing A.1 exactly until M1's early checkpoint lands (I will tell
you), then switch to the real module and delete the stand-in. M3 owns `cookout_ai.py`; the A.4
interface is the boundary between you — call it as frozen.

Must-haves called out by the review (do not skip): a v21 process must never see a non-Classic round
(§5.6); an unknown mode is refused, and an unfinished round in a mode this build does not know never
blocks starting a new game; the migration test runs from a REAL v21 fixture
(`wixy_server/tests/fixtures/livechat_v21.db`, generated from the deployed v21 schema);
`activate_modes.py` refuses unless every §5.6 check passes and prints each check.
