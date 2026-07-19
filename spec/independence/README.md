# Independence phase — build specification

**Goal in one sentence:** make Cottage Aesthetics' entire web presence — hosting, editing,
publishing, AI assistance, and engine updates — run on accounts and infrastructure Purdi
owns, so no falling-out with Josh can take anything from her, while Josh keeps shipping
engine features from his own lane for as long as both want that.

Read every file, in order, in full, before writing code. Authored 2026-07-19 (session
`c42ea1cb-a9d6-413d-bdcb-fc77fc49abba`, Fable 5) against the DEPLOYED system (wixy main
`574c5c4`, live at ca.cinnamons.uk, publish ledger at v7). This spec follows and reuses
the conventions of the CMS spec (`spec/00`–`09`) — where this spec is silent, that one
governs (typing, testing, PR train, fleet rules).

| File | Contents |
|---|---|
| [00-mission.md](00-mission.md) | The dependency inventory, the dual-control principle, definition of done |
| [01-architecture.md](01-architecture.md) | Target topology: repos, hosting, ingress/auth, AI, backups; what remains Josh's |
| [02-licensing-and-publication.md](02-licensing-and-publication.md) | MIT relicense + the pre-publication audit of the repo |
| [03-standalone-deploy.md](03-standalone-deploy.md) | Docker target, DigitalOcean droplet, cloudflared ingress, secrets |
| [04-fork-sync-dual-control.md](04-fork-sync-dual-control.md) | Her engine fork, upstream sync, "Get engine updates", her feature lane |
| [05-pluggable-ai.md](05-pluggable-ai.md) | The AI backend interface: cmd (fleet) vs BYO-Anthropic-key (standalone) |
| [06-backups-monitoring.md](06-backups-monitoring.md) | Nightly state mirror, uptime alerting to her |
| [07-html-guide.md](07-html-guide.md) | THE flagship deliverable: the ridiculously-easy step-by-step guide |
| [08-drill-acceptance.md](08-drill-acceptance.md) | The independence drill + binding acceptance criteria |
| [09-work-plan.md](09-work-plan.md) | Milestone train + Fable review gates |
| [KICKOFF-PROMPT.md](KICKOFF-PROMPT.md) | How the Sonnet 5 implementation chat starts |

Ground rules for the implementer:

1. **The spec is decided** — implement faithfully; reality-vs-spec conflicts follow the
   CMS spec's rule (prefer reality, record a `decisions/` entry, keep moving; peer the
   author only for architectural conflicts).
2. **Review gates are mandatory** (09 §3): security-sensitive milestones (licensing
   audit, auth, secrets, deploy scripts) wait for Fable's PR review before merge;
   everything else rides the normal CI-gated auto-merge train.
3. **Nothing here may degrade the running production site.** ca.cinnamons.uk keeps
   serving throughout; the cutover to her infrastructure is a deliberate, reversible,
   guide-driven step at the end — not a side effect of any earlier milestone.
4. **Human steps are guide steps.** Anything requiring a human (account signup, repo
   transfer, card entry, DNS at her registrar) is NEVER done by an agent — it becomes a
   step in the HTML guide (07), tested for followability, with the automation meeting
   the human halfway (verify buttons, pre-filled values, copy-paste blocks).
