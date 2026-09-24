# 00005 [9fyfi5] P7 docs and invariant close-out

## What

Update the Wixy AI operator manual and decision log to describe the Server chat as implemented, using P7's module brief from the Delivery Manager.

## Why

A fresh agent should be able to maintain the feature from `docs/ai/` and decisions without relying on the build spec or stale delivery notes.

## Context + current state

- P7 is docs and decisions only. Do not change code, anything under `spec/`, another build space, or push/merge.
- Workspace #29, build space P7-docs-closeout, branch `cmd/workspace-00029-bs8`.
- Start SHA: `77e20a372e51b9bcd6d68ce43cad004e359d573d`.
- Latest integrated feature base before the P7 candidate: `0fe4439c2b9034126f5e396f099c98ad7aac63d4`.
- P7 implementation commit: `0e96efbd637428589db6443e18cd6081fb0d0a0a` (`docs: update operator guidance`).
- Full brief: Delivery Manager intercomm `bbe33eefc96d46b4b799731a3a0ee3bd`.

## Relevant files + commits

Changed: `CLAUDE.md`; `docs/ai/{architecture,glossary,invariants,livechat,runbook,testing}.md`; decisions 00145–00147 and 00153–00156; this todo record. `docs/ai/contracts.md` matched the shipped routes, so it needed no edit.

## Outcome + verification

P7 docs and decisions are complete in the local candidate and ready for DM review. `ruff check .`, `ruff format --check .` (733 files), and `mypy` (208 files) passed. All 81 relative Markdown links checked resolve; 29 referenced source/test paths exist; `git diff --check` passed; staged paths were limited to `CLAUDE.md`, `docs/`, `decisions/`, and `todos/`. No pytest or e2e tests were run (docs-only task). No code, spec, or contract file was changed. No PR was opened and nothing was pushed or merged.

One medium documentation discrepancy remains in the untouched spec: §9 Inv 44 says every attachment has one normalized metadata-stripped rendition, while `processing.py` preserves animated GIF source bytes as `full.gif` and creates a separate thumbnail. The implementation manual and decision 00145 document the shipped behavior; report this to the DM for the Architect-owned spec update.

## Links

- `todos/00029__wixy_add-pin-protected-admin-live-chat-with-v/00001-server-live-chat-ssw1p7.md`
- `spec/server-chat/00-brief.md` (read-only)
- `spec/server-chat/01-background-containment-ruling.md` (read-only)
- `decisions/00145-server-chat-media-pipeline/decision.md`
- `decisions/00154-server-chat-erasure-journal/decision.md`
- `decisions/00155-server-chat-background-containment/decision.md`
- `decisions/00156-server-chat-release-notes/decision.md`
