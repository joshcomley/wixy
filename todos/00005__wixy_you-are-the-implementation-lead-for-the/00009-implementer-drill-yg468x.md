# 00009 [yg468x] M9 — Implementer drill (SPEND-GATED kit provisioning)

## What
Perform the drill (08 §1) by FOLLOWING THE HTML GUIDE VERBATIM on a drill kit: drill GitHub
org with bot invited, DO droplet on a fleet-held account/API token, one cheap test domain
in a drill Cloudflare account, a $5-capped Anthropic key (~£10-15 total). Steps 1-9: org+
repos in place, droplet via curl|bash -> verify.sh green, test hostname through tunnel +
Access, edit->publish->live->restore, engine update + undo, AI conversation ships content
PR -> published, engine feature-lane proof via AI, backup + restore-onto-second-droplet,
no-fleet-dependency proof (egress sweep + short ~5min fleet-wixy stop). Guide corrections
fed back before sign-off. Evidence pack: URLs, SHAs, screenshots, ledger entries, rollback
proof.

## Why
De-bugs the guide before Purdi+Josh repeat it for real. Definition of done for the whole
phase routes through this (spec/independence/00 "Definition of done").

## Context / current state
**BLOCKED on a SPEND GATE**: drill-kit provisioning costs real money (DO droplet, domain,
Anthropic key). Per global CLAUDE.md SPEND GATE rule: must get exact $ estimate then a
FINAL AskUserQuestion confirming before any charge — even though Track J's operator-directed
provisioning is described in the spec, the spec is not itself the spend authorization.
MUST ask the operator immediately before this milestone's provisioning step, not silently
assume the ~£10-15 estimate authorizes the charge.

## Relevant files + commits
(fill in as PR lands)

## How to continue + acceptance
**FABLE ACCEPTANCE** (08 §3, the full binding acceptance criteria list) — this is the
terminal review gate for the whole phase, separate from and stricter than the per-milestone
FABLE gates.

## Links
spec/independence/08 (full); spec/independence/09 row 9.
