# 00010 [ya0yft] M10 — Real-run support pack

## What
Operator-decision list (DNS timing, real account emails, real-run one-hour kill-test
scheduling), Track J prepared for the real run, session-id scrub (spec/independence 02
§2.2's exemption on the author-session id in README.md/KICKOFF-PROMPT.md ends HERE — scrub
it), drill artifacts archived, the finished guide handed to Josh.

## Why
The phase's own docs-and-handoff close-out; the REAL cutover (Purdi's real accounts, real
DNS) happens after this, at human pace, NOT performed by this agent.

## Context / current state
Terminal milestone. Depends on M9's drill passing + Fable acceptance.

**FORWARD OBLIGATION (from M7, spec/independence/06 §2)**: "Track J prepared"
above MUST include actually installing the hub-side pre-cutover state mirror
— `deploy/hub-mirror/` (script + full runbook, built in M7, NOT yet
installed against real infrastructure since `ca-state-backup` didn't exist
yet at build time). Once her real `<org>/ca-state-backup` exists: generate
the write-scoped-only deploy key on hub, register the interactive (never
session 0) Scheduled Task per that directory's own README, verify one
manual run, THEN continue with the rest of the real-run prep — spec's own
"her backup custody starts BEFORE her hosting does" means this should start
protecting her real content as early as practical, not wait until the very
end of this milestone.

## Relevant files + commits
(fill in as PR lands)

## How to continue + acceptance
Phase complete once this lands — no further gate beyond M9's Fable acceptance carrying
forward. Real cutover is human work via the guide, out of scope for this agent per the
kickoff's binding rules.

## Links
spec/independence/09 row 10; spec/independence/02 §2.2.
