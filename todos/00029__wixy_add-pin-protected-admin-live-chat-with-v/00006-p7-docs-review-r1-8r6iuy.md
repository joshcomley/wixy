# 00006 [8r6iuy] P7 docs review round 1

## What

Fix the four medium findings from the fresh Sol docs-vs-code review of P7 candidate `bf225620b325a37c2e0b36110faf2dc35c058671`.

## Why

Keep the manual and decisions truthful for the currently merged code while preserving target policy and marking audit fixes that have not landed as pending.

## Context + current state

- Workspace #29, builder session `14b18836-3dc7-4418-a559-e1ab3e2aab2b`, branch `cmd/workspace-00029-bs8`.
- Reviewed base: `0fe4439c2b9034126f5e396f099c98ad7aac63d4`; starting candidate: `bf225620b325a37c2e0b36110faf2dc35c058671`.
- Review record: intercomm `1fbf2cb01cde42259429db1605f09140`; DM round brief: `88c07a58ad634cdea0d965a1a75422dc`.
- Scope is docs, decisions, `CLAUDE.md`, and todos only. No code, `spec/`, push, or merge. Do not update the F2 photo table until its code fix lands and DM requests the final docs-vs-final-code pass.

## Relevant files + commits

- M1: `docs/ai/testing.md`, `decisions/00155-server-chat-background-containment/decision.md`; confirm other 10/10 wording remains correct.
- M2: `docs/ai/invariants.md` Inv 41; mark F8 malformed-PIN 422 echo as pending without weakening the target invariant.
- M3: `docs/ai/invariants.md` Inv 42; mark F4 stream-start-after-lock race during pending history load as pending without weakening fail-closed target policy.
- M4: `docs/ai/invariants.md` Inv 45, `docs/ai/livechat.md` push and delivery-status sections, `decisions/00146-server-chat-push/decision.md`; distinguish intended opt-in policy from the unmounted toggle (F1).

## How to continue + acceptance

Apply M1–M4 exactly as stated in the DM brief. Use visible `PENDING-AUDIT-FIX F1/F4/F8` labels so the later final pass can remove them after the code fixes merge. Leave the F2 media table unchanged. Run `ruff check .`, `ruff format --check .`, link check, and `git diff --check`; confirm only docs/, decisions/, CLAUDE.md, and todos/ differ from base `0fe4439`. Commit locally with the exact generic release-note trailer; hand the exact SHA and M1–M4 mapping to the DM and copy the Orchestrator. Do not push or merge.

## Links

- `docs/ai/testing.md`
- `docs/ai/invariants.md`
- `docs/ai/livechat.md`
- `decisions/00146-server-chat-push/decision.md`
- `decisions/00155-server-chat-background-containment/decision.md`
