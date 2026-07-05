# Wixy self-hosted CMS — build specification

**Read every file below, in order, in full, before writing any code.** This spec was
authored 2026-07-05 (session `c42ea1cb-a9d6-413d-bdcb-fc77fc49abba`, Fable 5) against
verified on-disk/on-wire facts: the site repo's actual markup, cmd's actual API surface
(file:line-checked), and this machine's actual deploy conventions. Where the spec cites an
endpoint, payload, path or port, it was checked — trust it over memory, and re-verify
against reality only when something errors.

| File | Contents |
|---|---|
| [00-mission.md](00-mission.md) | What we're building and why; principles; scope + non-goals; sensitivities |
| [01-architecture.md](01-architecture.md) | System picture; the draft/publish state machine; locked decisions; fleet rules that bind |
| [02-content-model.md](02-content-model.md) | **Normative** `data-wx-*` contract, content/theme JSON, overlay, media, validation |
| [03-site-migration.md](03-site-migration.md) | Restructuring the site repo; parity harness; site CLAUDE.md; site CI |
| [04-server.md](04-server.md) | FastAPI app: serving, preview, publish pipeline, versions/restore, API index, security |
| [05-editor.md](05-editor.md) | Admin shell + the live visual editor (overlay protocol, panels, publish/history UX) |
| [06-ai-chat.md](06-ai-chat.md) | Embedded cmd-powered chat: exact endpoints, lifecycle, preamble, failure table |
| [07-hosting-deploy.md](07-hosting-deploy.md) | D:\Servers\Wixy install, Slots consumer, Devfleet, cloudflared, CF Access, DNS, runbook |
| [08-testing-acceptance.md](08-testing-acceptance.md) | Test plan (unit/E2E/parity/live) + the binding acceptance criteria |
| [09-work-plan.md](09-work-plan.md) | The PR train (13 milestones across the two repos) |
| [KICKOFF-PROMPT.md](KICKOFF-PROMPT.md) | How the implementation chat gets started + its opening prompt |

Context documents (read after the spec): `brief.md` (client brief),
`docs/DESIGN-AND-CONTENT.md` (design blueprint + treatment catalogue),
`todos/TODO-00002.md` (open gallery task 00002 — unrelated lane, don't absorb it),
`docs/projects/01-cottage-aesthetics.md` + `docs/wix-cli/` (the dormant Wix-portal
framing — historical context only).

Ground rules for the implementer:

1. **The spec is decided.** Implement it; don't re-litigate architecture. If reality
   contradicts a cited fact (an endpoint 404s, a port is taken), prefer reality, record a
   `decisions/` entry, keep moving. Peer the author only for genuinely architectural
   conflicts (see KICKOFF-PROMPT.md).
2. **Definition of done is [08 §5](08-testing-acceptance.md)** — all eight criteria,
   demonstrated on the deployed instance, evidence in the final PR.
3. Fleet global rules apply throughout (auto-merge PR train, persistent todos, decision
   log, strict TS/typed Python, parallel tests, no direct Anthropic API, UTF-8, gh via
   PowerShell).
