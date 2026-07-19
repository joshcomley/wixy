# Kickoff — the independence-phase implementation chat

Start ONE cmd chat on the wixy project, Sonnet 5, max effort (same mechanism as
`spec/KICKOFF-PROMPT.md`):
`POST 127.0.0.1:9320/api/project/wixy/new-chat` with
`{"model": "claude-sonnet-5", "effort": "max", "prompt": <below>}`.

## The opening prompt

```
You are the implementation lead for the Wixy INDEPENDENCE phase. The complete, decided
specification is spec/independence/ in this repo; the system it modifies is DEPLOYED
and serving production (ca.cinnamons.uk) — do not degrade it.

First actions, in order:
1. git fetch origin && git merge origin/main --no-edit.
2. Read spec/independence/README.md then EVERY file 00–09 IN FULL, then this file.
   Where that spec is silent, the CMS spec (spec/00–09) governs — read any part you
   need. Skim the deployed reality it describes (wixy_server/, deploy state) before
   coding.
3. Create your workspace's persistent todos, one task per milestone of
   spec/independence/09-work-plan.md.
4. Run the train end-to-end. Milestones 2, 3, 4, 6 and 7 are SECURITY-GATED: open the
   PR, peer-message session c42ea1cb-a9d6-413d-bdcb-fc77fc49abba (the spec author; cmd
   routes to its successor if handed over) with the PR number + the milestone's review
   checklist, arm a ScheduleWakeup, and MERGE ONLY AFTER an explicit approval reply.
   Milestone 9 ends in the Fable ACCEPTANCE review (08 §3) — the phase is not done
   until that approval. While waiting on any gate, continue milestones not dependent
   on it. Everything else auto-merges on green CI.

Binding rules:
- The spec is DECIDED — implement faithfully; reality conflicts → prefer reality +
  decisions/ entry + keep moving; architectural conflicts → peer the author.
- Definition of done = spec/independence/08 §3, proven by the drill (08 §1) on
  throwaway accounts with evidence in the final PR.
- The fleet deployment stays green after every merge; the real cutover is HUMAN work
  via the guide — you never touch her real accounts, real DNS, or the live domain.
- The standalone edition's direct-Anthropic backend is the operator-decided exception
  to the fleet's no-direct-API rule (spec/independence/05 §2) — implement it there and
  ONLY there; the fleet edition keeps the cmd backend.
- All fleet global rules otherwise apply (strict typing, capped pytest, gh via
  PowerShell, todos/decisions discipline, auto-merge on green).

Report at each milestone boundary in-chat (one line: milestone, PR, what demonstrably
works). Begin with milestone 1 now.
```

## Reviewer-side contract (the spec author's duties)

On each gated peer request: review the PR diff against the milestone's checklist
(02 §2, 03 §4, 05 §4), reply via peer with explicit "APPROVED — merge" or the required
changes; target < 24 h turnaround. At milestone 9: full acceptance review against
08 §3 before the phase is called done.
