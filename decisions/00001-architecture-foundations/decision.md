# Architecture foundations (Wixy v1)

## Context

Greenfield build: a self-hosted CMS + visual editor + AI chat + publisher for
Cottage Aesthetics (`ca.cinnamons.uk`), replacing a static GitHub-Pages site with no
runtime management surface. The full rationale for each decision below was worked out
during spec authoring (session `c42ea1cb-a9d6-413d-bdcb-fc77fc49abba`, adversarially
reviewed 2026-07-08) and lives in `spec/01-architecture.md` §3 — this entry is the
durable, repo-local record so the decisions survive independent of the spec's normative
role fading after v1 ships.

## Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| 1 | Git as the content database (JSON files in the site repo) | SQLite/headless CMS | history/rollback/AI-collab/diff-review come free and stay consistent with template changes |
| 2 | Static build output, pinned per SHA, atomic pointer swap | Server-side rendering of the public site | visitor path = files on disk; rollback = pointer write; instant-render trivially satisfied |
| 3 | `data-wx-*` annotations in real HTML templates + strict builder | Jinja-izing pages, or DOM surgery on raw HTML | templates stay viewable/authorable as plain HTML (AI-friendly); stable editor targets in the live DOM; missing content is a build error, not a blank `<div>` |
| 4 | Sparse draft overlay server-side; materialize on publish | Committing every keystroke, or client-side-only drafts | one commit per publish (clean history); per-key merge with AI work; survives browser crashes |
| 5 | Embedded chat = real cmd chats via new-chat + send + decoded-messages poll→SSE proxy | Embedding cmd's UI in an iframe, a bespoke agent runtime, or direct Anthropic API | "exactly like chatting in cmd" with full fleet tooling; iframe blocked by CF Access + no embed mode; direct API banned fleet-wide |
| 6 | Wixy serves the public site itself (uvicorn static) | Separate nginx/Caddy or GH Pages | one service to deploy/supervise; CF edge caches; GH Pages can't do our publish/rollback semantics |
| 7 | Vanilla strict-TS admin (esbuild), no framework | React/Vue/Svelte SPA | admin is a handful of panels around an iframe; fleet style is framework-less; zero supply-chain sprawl on a security-sensitive surface |
| 8 | bs4 + html5lib for template parsing/injection | regex/string templating, lxml.html | faithful HTML5 round-trip; forgiving parser; pure-Python deps |
| 9 | Engine generic over projects from day one (registry, per-slug state), single project mounted | Hardcoding Cottage Aesthetics | Wixy's mission is a portal; genericity costs ~nothing here; UI stays single-project |
| 10 | CF Access (+ server-side JWT verify) as the only auth | In-app login | fleet-standard door, zero password surface; JWT verify is belt-and-braces vs misconfig |

## What to watch for

- **Decision 3** is the one most likely to feel like friction during migration (03): every
  human-editable string needs a binding; the builder fails the build on a missing key by
  design — that's intentional strictness, not a bug to route around.
- **Decision 4**: overlay merge is last-writer-wins per key, no CRDT — correct for a
  single-operator tool; do not build multi-user conflict resolution on top of it.
- **Decision 5**: the embedded chat has no publish tool by design (04 §9, 06 §2) — a
  future request to let the AI "just publish it" is a scope change, not a bug fix.
- **Decision 6**: publish does not purge Cloudflare's edge cache in v1 — HTML TTL is 5
  minutes by design (04 §3); revisit only if the owner complains about propagation delay.
- **Decision 9**: no `cottage`-specific string literals belong inside `builder/` or
  `wixy_server/` code paths — project-specific facts belong in `projects/*.json` or the
  site repo.
