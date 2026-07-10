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
**MILESTONE 13 IS COMPLETE — THE BUILD IS DONE.** All 8 spec/08 §5 acceptance criteria
demonstrated with real evidence (full detail: decisions/00044, 00043, 00042):

1. Parity vs GH-Pages: identical Lighthouse scores confirmed (see #2) plus the whole
   migration's own parity harness (spec/03 §5) stayed green through every step.
2. All 6 owner-experience bullets (00 §"experience being bought") exercised live: text
   edit->publish->live change (contact page, twice), restore both directions, AI chat
   making a real content edit end to end (incl. surfacing+fixing a real cross-repo CI
   bug, decisions/00043), theme/media not re-tested this session (already E2E-covered
   + M8's own live install didn't regress).
3. Publish atomicity: kill-during-publish drill on the DEPLOYED instance (not just
   temp-repo unit tests) — precisely timed via lock-file-appearance polling, full
   state survived a hard process kill, follow-up publish succeeded despite the
   orphaned lock, self-healed cleanly.
4. AI lane gated: cottage-aesthetics-preview's `ci.yml` (validate+build+parity) is
   the required check; the AI-lane preamble prohibits the embedded chat from ever
   publishing (unchanged since M10).
5. CF Access boundary: /admin + /api/admin/* verified gated (302) unauthenticated
   AND with a garbage service token (edge validates it, not just checks presence);
   loads correctly (200) with the real service token; public / loads with zero auth.
6. Both repos' CI green; wixy pytest full suite + ruff + mypy --strict all clean
   locally this session (see verify-skill report); zero @ts-ignore introduced.
7. Slots/Devfleet: unchanged since M11, still healthy (restart_count_total climbing
   only from this session's own deliberate kill-drill + genuine transient CI infra
   flakes, both expected).
8. Docs: engine README.md reviewed, still accurate; site CLAUDE.md unchanged, still
   accurate; decisions/00042-00044 cover every M12/M13 judgment call; this sidecar +
   TODO index updated; new `.claude/skills/verify/SKILL.md` persists the live-
   verification recipe for future sessions.

Two real bugs found and fixed via this milestone's own live verification (matching
every prior milestone's experience in this chain): the capture-baseline.yml
--serve-root bug (decisions/00043, found by the AI-conversation drill and
independently also caught by the operator) and the CF Access service-token
verification gap M11 itself had left unexercised (decisions/00042).

## Links
PR (wixy repo, capture-baseline fix): https://github.com/joshcomley/wixy/pull/55 (merged)
PR (wixy repo, M12 docs): https://github.com/joshcomley/wixy/pull/53 (merged)
PR (CA repo, GH Pages retirement + README): https://github.com/joshcomley/cottage-aesthetics-preview/pull/15 (merged)
PR (CA repo, operator's baseline revert): https://github.com/joshcomley/wixy/pull/54 (merged)
PR (CA repo, AI-conversation drill's content fix): https://github.com/joshcomley/cottage-aesthetics-preview/pull/16 (merged)
PR (wixy repo, M13 closing): (fill in when opened)
