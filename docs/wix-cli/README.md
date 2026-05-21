# Wix CLI Reference (for AI consumption)

This is a deep reference of the `wix` command-line tool (`@wix/cli`), pinned to **v1.1.197** (current as of 2026-05-21). It is the source-of-truth for any AI agent building [Wixy](../../README.md) — a portal that manages many Wix projects by driving the Wix CLI on their behalf.

The reference was assembled by:

1. **Probing the live binary** — every `--help` text was captured by running `wix <cmd> --help` in projects scaffolded to trigger each project-type flow.
2. **Inspecting the published npm package** — `@wix/cli@1.1.197` and `@wix/cli-app@1.1.197` were unpacked and the bundled `commander` registrations (including hidden commands) were read.
3. **Cross-referencing the official docs** at `dev.wix.com/docs/wix-cli/*` (partial; many pages are stub or paywall-shaped).
4. **Reading the Wix-shipped AI guide** at `node_modules/@wix/cli/agents/instructions.md` — Wix's own canonical "what to tell an AI agent" file (incomplete: omits `token`, `publish`, `promote`, `connect`, `install`/`uninstall`, `translation`, `schema`, hidden commands).

Use this directory as the canonical reference. If something here disagrees with Wix's own docs, the live CLI behaviour wins — re-probe.

## How to read this directory

| File | Contains | When you need it |
|---|---|---|
| [01-architecture.md](01-architecture.md) | Project-type flows, npm packages, command-loading logic | First — every other doc depends on understanding the flow model. |
| [02-installation-auth.md](02-installation-auth.md) | Install, Node requirements, login (device-code & API-key), credential storage, programmatic auth, multi-account | Setting up a machine; driving the CLI on behalf of many users. |
| [03-configuration.md](03-configuration.md) | `wix.config.json` schemas (all 4 variants), `.env.local`, `~/.wix/` layout, per-project `.wix/` layout | Detecting what kind of project a directory is; parsing project state. |
| [04-commands.md](04-commands.md) | Every command across every flow, every option, every default, every hidden flag | Day-to-day reference. The fattest file. |
| [05-extensions.md](05-extensions.md) | Extension types, templates, `wix generate`, `wix schema generate` (machine-readable extension JSON schema) | Scaffolding extensions; programmatically generating from JSON. |
| [06-automation-for-wixy.md](06-automation-for-wixy.md) | `--json` mode, AI-agent detection, env vars, HTTP endpoints, error handling for programmatic use | Implementing Wixy itself. |

## TL;DR for an AI agent driving `wix` programmatically

1. **Detect the flow first.** Read `wix.config.json` from the project root. The fields you see determine which commands the CLI exposes:
    - `projectType: "App"` + `appId` → **ASTRO-APP** flow (modern, requires astro.config.* file).
    - `projectType: "Site"` (or default) + `appId` + `siteId` → **ASTRO-SITE** flow (headless project, modern).
    - `appId` only, no `astro.config.*` → **legacy APP** flow (loads `@wix/cli-app` from project's own `node_modules`).
    - `siteId` only → **modern SITE** flow.
    - `siteId` + `uiVersion` → **legacy SITE** (Velo) flow.
    - `siteId` + `veloAppId` AND `WIX_CLI_SITE_LIVE=true` → **SITE-LIVE** flow (only `dev`).
2. **Use `--json` wherever the CLI offers it.** Several ASTRO and APP commands accept a hidden `--json` flag that produces a non-interactive JSON output. See [06-automation-for-wixy.md](06-automation-for-wixy.md#json-output-mode).
3. **Set `CI` or rely on AI-agent detection.** Login auto-switches to non-interactive when the CLI detects an AI agent (via `@vercel/detect-agent`). For automations, use `wix login --api-key <token>` instead.
4. **Credentials live in `~/.wix/auth/`** — `account.json` (device-code), `api-key.json`, `<siteId>.json` (per-site). For multi-account, isolate per Wix account by overriding `HOME` (Unix) / `USERPROFILE` (Windows) per child process, OR set `dataDir` via test override (rarely safe in prod).
5. **Refresh tokens via `wix token`** — `wix token` prints the current access token and refreshes it if expired. `wix token --site <site-uuid>` returns a site-scoped token (the JWT you need to call Wix REST/SDK APIs in the context of a specific site).
6. **Don't use the CLI for anything the [Wix REST API](https://dev.wix.com/docs/rest) can do directly.** The CLI is a developer ergonomics layer; managing a portfolio of sites at scale is almost always better done by talking to `https://www.wixapis.com/*` with a bearer token from `wix token --site <id>`.

## Tested versions

- `@wix/cli` — v1.1.197 (latest, 2026-05-21)
- `@wix/cli-app` — v1.1.197 (loaded by legacy APP flow; version-pinned to `@wix/cli`)
- `@wix/create-new` — v0.0.64 (the `npm create @wix/new` scaffolder)
- Node — `>= 20.11.0` (enforced; `wix.cjs` aborts if older)
