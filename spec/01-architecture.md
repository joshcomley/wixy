# 01 — Architecture

## 1. System picture

```
                          Cloudflare edge
                 ┌────────────────────────────────┐
   visitors ───► │ ca.cinnamons.uk                │
                 │   /admin*  ── CF Access (JWT)  │
                 └───────────────┬────────────────┘
                                 │ cloudflared tunnel (hub VM)
                                 ▼
                    Wixy server · FastAPI · 127.0.0.1:<port>
                    ├─ public: static files ◄── Storage\…\builds\<sha>\  (live.json pointer)
                    ├─ /admin: shell + editor + /api/admin/*
                    │      draft overlay ─┐
                    │                     ▼
                    │            Storage\…\repo\  (clone of site repo @ main)
                    │                     ▲ fetch/ff-only     │ commit+push (publish)
                    └─ chat proxy         │                   ▼
                         │        github.com/joshcomley/cottage-aesthetics-preview  = SOURCE OF TRUTH
                         ▼                                    ▲ PR → main (auto-merge, CI-gated)
                    cmd (9320/9321, localhost)                │
                    └─ per-conversation agent chats in worktrees of the site repo
```

- **wixy repo** (this repo) = the engine: builder, server, admin UI, editor overlay,
  project registry. Deployed as service **Wixy** via the standard Slots blue/green flow;
  supervised by Devfleet. Merging wixy `main` redeploys the ENGINE (and never touches
  site content — published builds live in Storage).
- **site repo** (`cottage-aesthetics-preview`) = templates + content JSON + theme +
  images (post-migration, 03). Single source of truth for everything the public sees.
- **Storage** (`D:\Servers\Wixy\Storage\`) = runtime state: the engine's own site-repo
  checkout, the draft overlay, immutable per-SHA builds, the publish ledger, chat
  registry. Nothing irreplaceable lives ONLY here (repo + tags reconstruct it).

## 2. The publish/draft state machine (the core idea)

```
                    editor PATCH (overlay op)          AI merge to main
   draft view  =  origin/main  ⊕  overlay      ◄──────────────────────┐
        │                                                             │
        │ Publish (owner button)                                      │
        ▼                                                             │
   materialize overlay → commit → push → build(sha) → verify → swap live pointer
        │                                                             ▲
        ▼                                                             │
   live site  =  builds/<published-sha>   ── Restore(version) ────────┘
```

Two editing lanes, one merge point, one human gate:

- **Editor lane** (owner): sparse overlay on top of main; publish materializes it as one
  commit. Never conflicts with itself; per-key last-writer-wins vs upstream (02 §8).
- **AI lane** (cmd agents): normal git work in their own worktrees → PR → CI (validate +
  build + parity) → main. Appears in the owner's draft preview on next fetch; goes live
  only via the owner's Publish.
- **Live** is a pinned SHA's immutable build — a crash, bad merge, or half-publish can
  never mutate it; swap is a pointer write.

## 3. Key decisions (log as `decisions/00001…` in PR #1; rationale inline here)

| # | Decision | Over | Because |
|---|---|---|---|
| 1 | Git as the content database (JSON files in the site repo) | SQLite/headless CMS | history/rollback/AI-collab/diff-review come free and stay consistent with template changes; the fleet already runs everything through git |
| 2 | Static build output, pinned per SHA, atomic pointer swap | server-side rendering of the public site | visitor path = files on disk; rollback = pointer; instant-render trivially satisfied |
| 3 | `data-wx-*` annotations in real HTML templates + strict builder | Jinja-izing the pages, or editing raw HTML via DOM surgery | keeps templates viewable/authorable as plain HTML (AI-friendly), gives the editor stable targets in the live DOM, and validation makes missing content a build error, not a blank `<div>` |
| 4 | Sparse draft overlay server-side; materialize on publish | committing every keystroke, or client-side-only drafts | one commit per publish (clean history), per-key merge with AI work, survives browser crashes |
| 5 | Embedded chat = real cmd chats via new-chat + send + decoded-messages poll→SSE proxy | embedding cmd's UI in an iframe, or a bespoke agent runtime, or direct Anthropic API | "exactly like chatting in cmd" with full fleet tooling; iframe is blocked by CF Access + no embed mode (verified in cmd source); direct API is banned fleet-wide |
| 6 | Wixy serves the public site itself (uvicorn static) | separate nginx/Caddy or GH Pages | one service to deploy/supervise; traffic is tiny; CF edge caches; GH Pages can't do our publish/rollback semantics |
| 7 | Vanilla strict-TS admin (esbuild), no framework | React/Vue/Svelte SPA | the admin is a handful of panels around an iframe; fleet style is framework-less; zero supply-chain/build sprawl on a security-sensitive surface |
| 8 | bs4 + html5lib for template parsing/injection | regex/string templating, lxml.html | faithful HTML5 round-trip (the pages are hand-authored HTML5), forgiving parser, pure-Python deps |
| 9 | Engine generic over projects from day one (registry, per-slug state), single project mounted | hardcoding Cottage Aesthetics | the Wixy mission is a portal; genericity here costs ~nothing; UI stays single-project |
| 10 | CF Access (+ server-side JWT verify) as the only auth | in-app login | fleet-standard door, zero password surface; JWT verify = belt-and-braces vs misconfig |

## 4. Component inventory

| Component | Language | Spec |
|---|---|---|
| `builder` (build/validate/serve/parity CLI + lib) | Python, typed, zero server deps | 02, 03 |
| `wixy_server` (FastAPI: public, admin API, preview, publisher, cmdchat, media) | Python | 04, 06 |
| `admin-ui` (shell, panels) + `editor` (iframe overlay) | TypeScript strict, esbuild | 05 |
| site repo migration + `CLAUDE.md` + CI | HTML/JSON | 03 |
| deploy (install.py, launcher, Slots consumer, Devfleet child, tunnel, Access, DNS) | Python/config | 07 |

## 5. Cross-cutting fleet rules that bind this build

- New JS = strict TypeScript; new Python fully typed; `any`/`@ts-ignore` are smells.
- Instant-render doctrine (<100 ms shells; slow data via APIs into skeletons).
- Never author in `D:\Servers\` checkouts; engine work in cmd worktrees of wixy; site
  work in cmd worktrees of the site repo. `install.py` derives paths from `AIM_ROOT`.
- All Claude inference via cmd (no Anthropic SDK/API anywhere, including the engine).
- Tests parallel via pytest-xdist with a FIXED worker cap in `addopts` (`-n 4`; NEVER
  `-n auto` — fleet ban after the 2026-07-07 hub incident; the suite runs on the hub VM
  next to production cmd). A failing test is yours to fix; red main blocks merges.
- UTF-8 everywhere explicitly (subprocess/open/PowerShell per global rules).
- gh CLI through PowerShell full path; auto-merge each round; conventional commits.
