# 06 — Driving the CLI programmatically (for Wixy)

This file is the gloves-on guide for Wixy: how to invoke the Wix CLI as a child process and not get burned by interactive UI, agent detection, network calls, env vars, or credential races.

## The `--json` output mode

The CLI defines a hidden constant `NO_TTY_JSON_OUTPUT_OPTION = "--json"`. Commands that wire it up route through `nonInteractive*` code paths that emit a single JSON object to stdout instead of rendering an Ink TUI.

### Commands that respect `--json`

| Command | What stdout looks like with `--json` |
|---|---|
| `wix token --json` | `{"accessToken":"<jwt>"}` (single line, newline-terminated) |
| `wix env pull --json` | Object describing pulled vars + counts |
| `wix generate --params '<json>'` (implies `--json`) | `{"success":true, ...}` or `{"success":false,"error":"..."}` |
| `wix schema generate` | JSON Schema of every extension type (default on) |
| `wix preview --json` (ASTRO + legacy APP) | Object with preview URL and metadata |
| `wix release --json` (legacy APP) | Object describing the created version |
| `wix translation pull --json` / `push --json` | Result object |

### Commands that do NOT support `--json`

`wix dev`, `wix build`, `wix login`, `wix logout`, `wix whoami`, `wix telemetry`, `wix connect`, `wix install`, `wix uninstall`, `wix publish`, `wix sync-types`, `wix promote`, `wix skills *`, the legacy `wix app dev|build|generate|logs` commands.

For commands without `--json`, you must either:

- Parse stderr/stdout (fragile — Wix changes the Ink output without warning).
- Skip the CLI and call the underlying Wix REST API directly with a bearer token from `wix token --site <id>`.

For Wixy's MVP: lean hard on `wix token` + direct REST calls for read paths. Use the CLI only where it does work the REST API can't replicate (dev server, code uploads in `preview`/`release`, scaffolding).

## AI-agent detection

At every startup, the CLI runs `@vercel/detect-agent` to figure out whether it's being driven by a known AI agent (Claude Code, Cursor, GitHub Copilot, etc.).

The detected agent name is:

1. Attached to BI telemetry (`createBiLogger` arg).
2. Set on the Sentry error context (`errorReporter.setAiAgentName`).
3. Used by `wix login` to short-circuit straight to the non-interactive login flow (avoiding the Ink UI).

For Wixy specifically: the CLI doesn't know about "Wixy" by default. Three options:

- **Best**: drive everything via `wix login --api-key <token>` so it never matters.
- **OK**: set `CI=1` or `TERM=dumb` to suppress Ink rendering (works for some commands).
- **Tempting but flaky**: claim to be an AI agent via env vars `@vercel/detect-agent` checks for (it inspects `CURSOR_AGENT`, `CLAUDECODE`, `GITHUB_COPILOT_AGENT`, etc.). Don't rely on this — Wix can change the detection rules whenever.

## Environment variables

Set in the child process you spawn:

| Var | Set by | Effect |
|---|---|---|
| `WIX_CLI_SITE_LIVE` | You | When `=true`, switches a `siteId+veloAppId` project to the **SITE-LIVE flow** (`src-MDIZCHXS.js`). |
| `WIX_CLI_NPX_PATH` | You | Path to the `npx` executable used by `wix skills add|update` to shell out. Default `npx`. |
| `HOME` (Unix) / `USERPROFILE` (Windows) | You | The CLI reads `~/.wix/` here. Set per-process to isolate accounts. |
| `CI` | You / CI runner | Some Ink components check this and skip interactive prompts (best-effort). |
| `CLAUDECODE`, `CURSOR_AGENT`, ... | Parent environment | `@vercel/detect-agent` consumes these. |
| `PYTHONUTF8`, `LANG`, etc. | OS | Affect text codec. The CLI uses Node's default (utf-8). Pass through unchanged. |

The CLI also respects a *test override* hook (`getTestOverrides()`) — it reads keys like `dataDir`, `minRetryTimeout` from a Node-internal channel. Don't rely on this in production; it's not stable API.

## Spawning the CLI cleanly

A typical Wixy invocation (Node.js):

```ts
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const accountHome = mkdtempSync(join(tmpdir(), "wix-account-"));
writeFileSync(join(accountHome, ".wix/auth/api-key.json"), JSON.stringify({
  token: WIX_API_KEY,
  accountId: ACCOUNT_ID,
  userInfo: { userId: USER_ID, email: USER_EMAIL },
}, null, 2));

const child = spawn("wix", ["token", "--site", siteId, "--json"], {
  cwd: projectDir,
  env: {
    ...process.env,
    HOME: accountHome,        // Unix
    USERPROFILE: accountHome, // Windows
    CI: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
```

Per-account `accountHome` means parallel calls for different customers don't race on `~/.wix/auth/`.

For commands that just need a token, *prefer pre-seeding the credential file directly* over running `wix login --api-key <token>` first — the latter does a network roundtrip to validate and writes the same file you can write yourself.

## HTTP endpoints the CLI calls

| Purpose | Method + path |
|---|---|
| Device-code request | `POST manage.wix.com/v1/oauth/device/code` |
| Device-code verify (polling) | `POST manage.wix.com/v1/oauth/device/verify` |
| Token exchange / refresh | `POST manage.wix.com/v1/oauth/token` (or `iam/wix-idp/v1/oauth/token`) |
| Wix REST APIs | `https://www.wixapis.com/*` |
| Editor (sites editor) | `https://editor.wix.com/*` |
| Code (Velo) | `https://code.wix.com/*` |
| Marketing/general | `https://www.wix.com/*` |

Tied to a hard-coded **OAuth client ID** `6f95cec8-3e98-48b9-b4e5-1fb92fcd9973`. Public — same on every install.

The CLI sends an opinionated header set on every request:

- `X-XSRF-TOKEN: nocheck`
- `Cookie: XSRF-TOKEN=nocheck`
- `User-Agent: wix-cli`

If you're going to bypass the CLI and call `wixapis.com` directly, you need a valid bearer token (from `wix token --site <id>`) and **the same XSRF-TOKEN bypass headers**, otherwise Wix's edge will reject the request.

## Telemetry / BI logging

The CLI uses `@wix/bi-logger-dev-tools-data` (Wix internal BI). Every command emits BI events with the user ID, CLI session ID (random UUID per process), agent name, and command name/args.

Disable per-machine with `wix telemetry off` (writes `~/.wix/user.config.json` → `{ telemetry: false }`). For Wixy: respect the user's setting on their own machine; don't force `telemetry: true`.

Sentry error reporting also runs at every command. DSN is hard-coded in `chunk-YT5BPQDJ.js`. Errors are scrubbed for PII but **arguments and command names DO go to Sentry** — don't pass secrets as CLI args.

## Error model

The CLI throws `CliError` with a typed `CliErrorCode` (see `@wix/cli-error`). On any unhandled throw, the top-level `errorHandler` formats and prints a red-prefixed message and exits 1. Common codes you'll see:

| `CliErrorCode` | Meaning | Action |
|---|---|---|
| `FailedToIdentifyProgramFlow` | `wix.config.json` missing or malformed. | Re-check the file; show user the schema for the expected flow. |
| `InvalidConfigSchemaError` | `wix.config.json` parses but fails the flow's Zod schema (e.g. missing `siteId` for ASTRO-SITE). | Surface the zodError details to the user. |
| `AuthenticationRequired` | No valid auth in `~/.wix/auth/`. | Run `wix login` (or seed credentials). |
| `CliAppVersionMismatch` | `@wix/cli-app` in project ≠ globally-installed `@wix/cli`. | `npm install @wix/cli-app@<global-version>` in the project. |
| `FailedToImportCliApp` | Project's `@wix/cli-app` exists but throws at import. | Reinstall the package; check Node version. |
| `FailedToGetDeviceCode` / `FailedToGetAuthToken` | OAuth flow failed. | Likely network or expired refresh token. |
| `FailedToRunExternalCommand` | An external command (npx, package manager) failed. | Inspect logs. |
| `DeprecatedVersion` | Installed CLI is below Wix's published minimum. | Upgrade `@wix/cli`. |
| `NetworkError` | axios couldn't reach Wix servers. | Retry; check connectivity. |

Crashes write to `<project>/.wix/debug.log` AND `~/.wix/debug.log` and are also reported to Sentry.

## Race conditions to avoid

1. **Two CLI invocations sharing `~/.wix/auth/`**: token refresh may produce two refreshes simultaneously; the second loses. Isolate `HOME` per account, or serialise calls per-account in your queue.
2. **`wix dev` lifetime mixed with `wix build`**: building while dev is running breaks the dev server. Treat `dev` as a long-lived background and don't fire other commands against the same project.
3. **`wix env pull` overlapping with edits to `.env.local`**: pulls *merge*, but the file is written non-atomically. Wrap with a per-project mutex.

## Patterns Wixy should adopt

1. **Pin the CLI version** globally per Wixy server (one specific `@wix/cli` install per machine). Don't update casually.
2. **One auth per child process** — short-lived child with isolated `HOME`, drop it after the call.
3. **Cache `wix token --site <id>` results** for the JWT's lifetime (decode the `exp` claim). Save round-trips.
4. **For long-running commands** (`dev`, `build`, `preview`, `release`): pipe stdout/stderr through the UI and capture exit code. Don't try to parse interactive Ink output.
5. **For data fetches**: skip the CLI. Call `wixapis.com` directly with a token.
6. **Detect the flow once per project read** (cache the result), keyed off `wix.config.json` mtime.
7. **Run `wix --version`** at boot and refuse to operate if the binary on PATH disagrees with what Wixy expects.

## What the CLI does NOT do

Knowing the boundary saves Wixy from reinventing things:

- ✗ List a user's sites or apps. (No `wix list` command. Use REST: `GET https://manage.wix.com/api/v1/sites` and friends.)
- ✗ Switch the active account. (Logout + login again, with isolated HOME per account.)
- ✗ Cross-project orchestration. (CLI is per-cwd.)
- ✗ Background scheduling, webhooks, or polling. (Wixy's job.)
- ✗ Direct content management (CMS rows, member edits). (REST/SDK.)

What Wixy SHOULD lean on the CLI for: code uploads (`preview`, `release`), local dev (`dev`), scaffolding (`generate`), interactive auth setup (`login`). Everything else, use REST.
