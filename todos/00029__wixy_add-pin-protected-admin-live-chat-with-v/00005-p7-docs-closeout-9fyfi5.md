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
- Full brief: Delivery Manager intercomm `bbe33eefc96d46b4b799731a3a0ee3bd`.

## Relevant files + commits

Required targets: `docs/ai/invariants.md`, `runbook.md`, `testing.md`, `glossary.md`, `livechat.md`, possibly `architecture.md` and `contracts.md`, `CLAUDE.md`, and new `decisions/` entries. Verify branch/base before candidate commit.

## How to continue + acceptance

Read the P7 brief and its read-first list; verify every changed claim against code. Add Invariants 40–45 and amend 12 without renumbering 46/47; complete docs A–G and decision entries from the brief. Run `ruff check .`, `ruff format --check .`, and `mypy`; check links and identifiers; confirm the diff against `origin/cmd/workspace-00029` contains only docs/, decisions/, CLAUDE.md, and todos/. Commit with generic subject/body and exactly `Release-note: General bug fixes and improvements.`. Report the untouched spec's remaining Inv 44/animated-GIF discrepancy to the DM. Send the DM the candidate SHA and file/verification summary; do not push or merge.

## Links

- `todos/00029__wixy_add-pin-protected-admin-live-chat-with-v/00001-server-live-chat-ssw1p7.md`
- `spec/server-chat/00-brief.md` (read-only)
- `spec/server-chat/01-background-containment-ruling.md` (read-only)
