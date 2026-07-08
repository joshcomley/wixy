# 00013 [h2fu72] M13 WX+CA — Live verification + polish

## What
Full 08 §4 checklist (live chat smoke, external CF Access checks, edit->publish->restore
drill, Lighthouse), fix everything found, `verify` skill evidence in PR, final
docs/todos/decisions sweep, acceptance list 08 §5 ticked one by one in the PR
description.

## Why
Definition of done for the whole build (spec/08-testing-acceptance.md §5) — this is the
milestone that closes the loop and proves all 8 acceptance criteria on the DEPLOYED
instance, not just in tests.

## Context / current state
Depends on everything (00001-00012). This is the final milestone.

## Relevant files
- spec/08-testing-acceptance.md §4 (live verification steps), §5 (the 8 binding
  acceptance criteria — the actual definition of done)

## How to continue + acceptance
Each of the 8 criteria in 08 §5 demonstrated with evidence (URLs, SHAs, version numbers)
in the final PR description: parity vs GH-Pages, all 6 owner-experience bullets live,
atomic/serialized publish incl. kill-during-publish drill on the deployed instance, AI
lane gated (CI required check, chat can't publish), CF Access boundary verified
externally, both repos' CI green + mypy --strict + zero unjustified @ts-ignore, Slots/
Devfleet registered + swap survives, docs/decisions/todos current.

## Links
PR: (fill in when opened)
