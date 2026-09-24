# 00006 [8r6iuy] P7 docs review round 1

## What

Fix the four medium findings from the fresh Sol docs-vs-code review of P7 candidate `bf225620b325a37c2e0b36110faf2dc35c058671`.

## Why

Keep the manual and decisions truthful for the currently merged code while preserving target policy and marking audit fixes that have not landed as pending.

## Context + current state

- Workspace #29, builder session `14b18836-3dc7-4418-a559-e1ab3e2aab2b`, branch `cmd/workspace-00029-bs8`.
- Reviewed base: `0fe4439c2b9034126f5e396f099c98ad7aac63d4`; starting candidate: `bf225620b325a37c2e0b36110faf2dc35c058671`.
- Fix-round implementation commit: `766a8d58fb93c8ac1326d299e68b00c7c92a44bc` (`docs: clarify pending feature guarantees`).
- Review record: intercomm `1fbf2cb01cde42259429db1605f09140`; DM round brief: `88c07a58ad634cdea0d965a1a75422dc`.
- Scope is docs, decisions, `CLAUDE.md`, and todos only. No code, `spec/`, push, or merge. Do not update the F2 photo table until its code fix lands and DM requests the final docs-vs-final-code pass.

## Relevant files + commits

- M1: `docs/ai/testing.md`, `decisions/00155-server-chat-background-containment/decision.md`; confirm other 10/10 wording remains correct.
- M2: `docs/ai/invariants.md` Inv 41; mark F8 malformed-PIN 422 echo as pending without weakening the target invariant.
- M3: `docs/ai/invariants.md` Inv 42; mark F4 stream-start-after-lock race during pending history load as pending without weakening fail-closed target policy.
- M4: `docs/ai/invariants.md` Inv 45, `docs/ai/livechat.md` push and delivery-status sections, `decisions/00146-server-chat-push/decision.md`; distinguish intended opt-in policy from the unmounted toggle (F1).

## Outcome + verification

M1–M4 are addressed. M1 now requires 10/10 passes on an unloaded node before a hub-only failure can be called host-load-only. Inv 41 and Inv 42 retain their target guarantees with visible pending F8/F4 caveats. Inv 45, livechat.md, and decision 00146 distinguish the intended push policy from the currently unmounted F1 toggle. The F2 media table is unchanged.

`ruff check .` passed; `ruff format --check .` passed (734 files); all 15 checked relative links resolve; `git diff --check` passed; the base diff contains only docs/, decisions/, CLAUDE.md, and todos/. No tests were run. No code or spec was changed; nothing was pushed or merged. Candidate commits use the exact generic release-note trailer.

## Links

- `docs/ai/testing.md`
- `docs/ai/invariants.md`
- `docs/ai/livechat.md`
- `decisions/00146-server-chat-push/decision.md`
- `decisions/00155-server-chat-background-containment/decision.md`
