# Kickoff — starting the implementation chat

**Status: NOT yet started** (operator said prepare only). When the operator says go,
start ONE cmd chat on the wixy project with **Sonnet 5** at **max effort** and the opening
prompt below.

## How to start it (single API call, from any shell on the hub VM)

```bash
curl -s -X POST http://127.0.0.1:9320/api/project/wixy/new-chat \
  -H 'Content-Type: application/json' \
  --data @- <<'JSON'
{
  "model": "claude-sonnet-5",
  "effort": "max",
  "prompt": "<the opening prompt below, JSON-escaped>"
}
JSON
```

Notes: `new-chat` (not chat-spawn) — human-requested project chat, provisions a fresh wixy
workspace, visible in cmd. `claude-sonnet-5` must be the **full id** (the bare alias
`sonnet` is a different pin). Response is 202 `{session_id, …}`; the chat appears at
`cmd.cinnamons.uk/chat/<session_id>` once provisioned. Alternatively: cmd UI → wixy →
New Chat with model Sonnet 5 / effort max and paste the prompt.

## The opening prompt

```
You are the implementation lead for the Wixy self-hosted CMS build. The complete,
already-decided specification lives in this repo.

First actions, in this order:
1. git fetch origin && git merge origin/main --no-edit  (fleet handover-receiver rule).
2. Read spec/README.md, then EVERY spec file in numbered order (00–09), IN FULL — no
   skimming — then spec/KICKOFF-PROMPT.md, brief.md, and docs/DESIGN-AND-CONTENT.md.
3. Create this workspace's persistent todos (todos/TODO-<workspaceID>.md + sidecars per
   the persistent-todos skill), one task per milestone of spec/09-work-plan.md.
4. Execute the 13-milestone PR train end-to-end without stopping between milestones:
   branch → conventional commits → push → PR → checks green → merge, per fleet
   auto-merge doctrine. Keep todos and decisions/ current as you go.

Binding rules:
- The spec is DECIDED. Implement it faithfully; do not redesign or downscope. Where
  reality contradicts a spec-cited fact (an endpoint, port, path), prefer reality,
  record a decisions/ entry, and continue.
- Definition of done = spec/08-testing-acceptance.md §5 — all eight criteria demonstrated
  on the DEPLOYED instance (ca.cinnamons.uk), with evidence in the final PR description.
- Site-repo work (milestones 3–5, 12) happens in a worktree of the
  cottage-aesthetics-preview clone (create under
  D:\Servers\Cmd\Storage\clones\cottage-aesthetics-preview__worktrees\<NNNNN>__<slug>,
  branch per PR) — never in the canonical clone, never in D:\Servers runtime dirs.
- Consult the spec author ONLY for a genuinely architectural conflict (spec-internal
  contradiction, or a decided design that reality makes impossible): use the peer skill
  to session c42ea1cb-a9d6-413d-bdcb-fc77fc49abba, arm a ScheduleWakeup, and use
  peer_check on silence per the skill. Everything smaller: decide per spec + fleet
  rules and keep moving. You should not need to consult.
- All global fleet rules apply (strict TS / typed Python, parallel tests, no direct
  Anthropic API — cmd chats only, UTF-8 discipline, gh via PowerShell full path,
  background long-running commands, admin gate for elevated steps).

Report progress in-chat at each milestone boundary (one line: milestone, PR link,
what's demonstrably working). Begin with milestone 1 now.
```

## Consultation contract (for the spec author's side)

The implementer may peer-message session `c42ea1cb-a9d6-413d-bdcb-fc77fc49abba` (this
spec's authoring session; cmd routes to its successor if handed over). Expected traffic:
zero to a handful of genuinely architectural questions. Anything asking permission to
proceed, choose, or interpret settled text should be answered by pointing at the spec
section that decides it.
