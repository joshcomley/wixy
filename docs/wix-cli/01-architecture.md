# 01 — Architecture & project-type flows

The Wix CLI is **flow-switched at runtime**. The binary `wix` is the same in every directory, but the set of commands it exposes depends on what kind of project the current working directory contains. This is the single most important fact about the CLI for an AI agent driving it programmatically.

## The four project-type flows

When you run `wix` in a directory, the CLI does this (`src/program-flow.ts` in `@wix/cli`):

1. Look for `wix.config.json` in the current directory.
   - **Missing/malformed** → **UNKNOWN flow** — only global commands (`login`, `logout`, `whoami`, `token`, `telemetry`) are exposed. Any other command produces a `FailedToIdentifyProgramFlow` error.
2. If `wix.config.json` has `appId` AND an `astro.config.{js,cjs,mjs,ts}` exists in the same directory → **ASTRO flow** (modern).
3. Else if `wix.config.json` has `appId` (no astro config) → **legacy APP flow**. The CLI dynamically `require()`s `@wix/cli-app` from the project's own `node_modules` (NOT from the global `@wix/cli` install). If that package isn't installed in the project, the flow falls through.
4. Else if `wix.config.json` has `siteId` → one of three **SITE flows** (see below).
5. Otherwise → **UNKNOWN flow**.

Discovery is mechanical and 100% local; the CLI never asks Wix's servers what kind of project this is.

### Decision table (live, from source)

```
                     | astro.config.* exists | uiVersion in cfg | veloAppId+WIX_CLI_SITE_LIVE | LOADS
─────────────────────┼───────────────────────┼──────────────────┼──────────────────────────────┼────────────────────────
 wix.config has appId│           ✓           │       n/a        │             n/a              │ ASTRO  (src-FPCPNHPG.js)
 wix.config has appId│           ✗           │       n/a        │             n/a              │ legacy APP (@wix/cli-app from project node_modules)
 wix.config has siteId│         n/a          │       ✓          │             n/a              │ SITE-old / Velo (src-D4TMWFPD.js)
 wix.config has siteId│         n/a          │       ✗          │             ✓                │ SITE-LIVE  (src-MDIZCHXS.js)
 wix.config has siteId│         n/a          │       ✗          │             ✗                │ SITE       (src-V6D6W3AV.js)
 anything else        │         n/a          │       n/a        │             n/a              │ UNKNOWN
```

### Which package owns which flow

| Flow | npm package | Bundled inside `@wix/cli`? | Status |
|---|---|---|---|
| ASTRO (`projectType: "Site"` or `"App"` + astro.config.*) | `@wix/cli-astro-commands` | yes — bundled at build time | **current / preferred** |
| Legacy APP (`appId`, no astro) | `@wix/cli-app` | no — required as dep in the project | being deprecated in favour of ASTRO-APP |
| SITE (modern) | `@wix/cli-site` | yes | active |
| SITE-old / Velo | `@wix/cli-site-old` | yes | maintained for legacy Velo sites |
| SITE-LIVE | `@wix/cli-site-live` | yes | active, gated by env var |

The version-mismatch check in `src/cli-app.ts` enforces that `@wix/cli-app` in the project equals the running `@wix/cli` version exactly (prereleases excepted). If you globally upgrade `wix` but a project pins an older `@wix/cli-app`, the CLI will refuse to run with `CliAppVersionMismatch`.

## Command exposure per flow

The global five (`login`, `logout`, `whoami`, `token`, `telemetry`) are always added.

| Flow | Additional commands exposed |
|---|---|
| UNKNOWN | (none — error on any command-like input) |
| ASTRO | `dev`, `build`, `preview`, `release`, `generate`, `env pull|set|remove`, `connect`, `skills add|update`, `schema generate`, `promote` (hidden), `translation pull|push` (hidden) |
| Legacy APP | `app` (then `app dev`, `app build`, `app preview`, `app generate`, `app logs`, `app release`, `app serve` (hidden), `app add-permission` (hidden)) |
| SITE | `dev` (with `--tunnel`), `preview` (`-f`), `publish` (`-y`, `-f`), `install [pkg]`, `uninstall <pkg>` |
| SITE-old / Velo | `dev` (`-s/--https`, `--tunnel`), `preview` (`-f`, `--source`), `publish` (`-y`, `-f`, `--source`), `install [pkg]` (`--yarn`, `--npm`), `uninstall <pkg>` (`--yarn`, `--npm`), `sync-types` (hidden) |
| SITE-LIVE | `dev` only |

Detailed per-command options are in [04-commands.md](04-commands.md).

## Hidden commands

Several commands and options are present in the binary but marked `.hideHelp()` so they don't appear in `--help`. They still run if invoked. Hidden things you can drive:

- **ASTRO**: `promote`, `translation pull`, `translation push`, the `--json` / `--base-url` / `-l, --label` options on `preview`/`release`/`dev`.
- **Legacy APP**: `app serve`, `app add-permission`, `--origin` on `app dev`, `--json` on `app preview` and `app release`.
- **SITE-old**: `sync-types`, `--tunnel` on `dev`.

`wix env pull` is the **default subcommand** of `wix env` (registered with `{ isDefault: true }`), so `wix env` with no subcommand acts like `wix env pull`.

## Where the CLI lives on disk

After `npm install -g @wix/cli`:

- Binary shim: `<npm-prefix>/wix` + `<npm-prefix>/wix.cmd` + `<npm-prefix>/wix.ps1` (Windows).
- Package: `<npm-prefix>/node_modules/@wix/cli/` — `bin/wix.cjs` is the entry point, `build/` is the bundled commander tree, `templates/` are EJS extension templates, `agents/instructions.md` is Wix's own AI guide.
- User state: `~/.wix/` (Unix) / `%USERPROFILE%\.wix\` (Windows) — `auth/`, `user.config.json`, `version.cache.json`, `debug.log`, `user-feedback.cache.json`.
- Per-project state: `<projectDir>/.wix/` — gitignored, holds debug log, build metadata, deployment topology, app config.

See [03-configuration.md](03-configuration.md) for full path details.

## Why this matters for Wixy

A Wixy portal managing many Wix projects must, for each project it touches:

1. Read `wix.config.json` to decide the flow (and so, which commands are available).
2. Confirm `@wix/cli-app` is installed in legacy-APP projects (or auto-install it before running `wix app *`).
3. Confirm an astro config file exists for ASTRO projects.
4. Use the `wix token --site <siteId>` flow rather than scraping interactive output where possible.

Trying to call `wix app release` in a directory whose `wix.config.json` lacks `appId` will fail at the very first step (`FailedToIdentifyProgramFlow`). Trying to call `wix dev` in a `siteId`-only directory triggers the SITE flow — different code path entirely, different options, different semantics.
