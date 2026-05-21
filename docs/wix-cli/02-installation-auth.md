# 02 — Installation & authentication

## Installation

```bash
npm install -g @wix/cli
```

Verify:

```bash
wix --version    # → 1.1.197 at time of writing
```

### Prerequisites

- **Node `>= 20.11.0`** — hard-enforced in `bin/wix.cjs`. The CLI prints a red error and exits non-zero on older Node.
- The npm package weighs **~65 MB unpacked** (mostly the bundled `commander`/`react`/`yoga.wasm`/`ink` UI tree — the CLI uses Ink to render device-code prompts).
- Optional native dep `fsevents` for macOS file watching (silently skipped on Linux/Windows).

### Where the binary ends up (Windows)

After global install on a typical NVM-for-Windows setup:

- `C:\nvm4w\nodejs\wix.cmd`, `C:\nvm4w\nodejs\wix.ps1`
- `C:\nvm4w\nodejs\node_modules\@wix\cli\bin\wix.cjs` (the actual JS entry)
- `C:\nvm4w\nodejs\node_modules\@wix\cli\build\index.js` (bundled program)

### Version-pin between `@wix/cli` and `@wix/cli-app`

If a project's `package.json` depends on `@wix/cli-app`, that package's version **must equal** the globally-installed `@wix/cli`. The CLI throws `CliAppVersionMismatch` otherwise (prereleases are excepted). This makes upgrades a coordinated step:

1. Upgrade `@wix/cli` globally.
2. In every legacy-APP project, bump `@wix/cli-app` to the same version and `npm install`.

For Wixy: if you're driving many projects, freeze the global CLI version and reflect it in the projects you scaffold/maintain. Or pin per-project via `npx --package=@wix/cli@1.1.197 wix ...`.

## Authentication overview

There are **three** auth strategies, all stored under `~/.wix/auth/`:

| Strategy | File | Trigger | Use case |
|---|---|---|---|
| Account (device-code OAuth) | `~/.wix/auth/account.json` | Interactive `wix login` | Human user on a workstation |
| API key | `~/.wix/auth/api-key.json` | `wix login --api-key <token>` | CI / automation / Wixy backend |
| Site-scoped token | `~/.wix/auth/<siteId>.json` | Lazy — created when a site-scoped op runs | Per-site SDK calls |

A legacy file at `~/.wix/auth.json` is migrated/deleted on logout. New installs ignore it.

### `~/.wix/` layout in full

```
~/.wix/
  auth/
    account.json          # {accessToken, refreshToken, expiresIn, issuedAt, userInfo:{userId, email}}
    api-key.json          # {token, accountId, userInfo:{userId, email}}
    <siteId>.json         # {accessToken, refreshToken, expiresIn, issuedAt}  (one file per site)
  user.config.json        # {telemetry: boolean, tunneling: boolean}
  version.cache.json      # CLI's cache of latest-published version (for self-deprecation warnings)
  debug.log               # Most recent stack traces
  user-feedback.cache.json
```

`~` is resolved with Node's `os.homedir()`. On Windows that's `%USERPROFILE%` (typically `C:\Users\<you>\`). The folder is overridable in tests via `getTestOverrides().dataDir` but there's no documented production override env var.

## Interactive login (device-code OAuth)

Plain `wix login` runs the device-code OAuth2 flow:

1. CLI calls `POST https://manage.wix.com/v1/oauth/device/code` with the hard-coded client ID `6f95cec8-3e98-48b9-b4e5-1fb92fcd9973` and scope `offline_access`.
2. Server returns `{deviceCode, verificationUri, userCode, expiresIn}`.
3. CLI displays the `userCode` and opens `verificationUri` in the user's browser (or shows the URL).
4. CLI polls `POST https://manage.wix.com/v1/oauth/token` (grant_type `urn:ietf:params:oauth:grant-type:device_code`) until the user approves.
5. On success: writes `~/.wix/auth/account.json` with the access token, refresh token, expires-at timestamp, and user info.

The CLI uses `axios` with retry (3 tries, 1-3s backoff). User-Agent is hard-coded to `wix-cli`. It sends `X-XSRF-TOKEN: nocheck` and `Cookie: XSRF-TOKEN=nocheck` headers (Wix's internal anti-CSRF bypass for first-party tooling).

## Non-interactive login

### API key (preferred for automation)

```bash
wix login --api-key <token>
```

API keys are minted in the Wix dashboard ("Settings → Account → API Keys") and are tied to an account. The CLI stores them in `~/.wix/auth/api-key.json` and uses them in preference to account auth.

### Refresh token (hidden, undocumented)

```bash
wix login --refresh-token <token>
```

This option is in the source but marked `.hideHelp()`. It conflicts with `--api-key`. Useful if you've extracted a refresh token from a prior interactive login and want to seed a non-interactive environment.

### AI-agent detection

The CLI imports `@vercel/detect-agent` and runs it at startup. When it detects an agent (Claude Code, Cursor, etc.), `wix login` **silently runs the non-interactive login path** instead of trying to render an interactive Ink prompt. The detected agent name is also sent in BI telemetry and Sentry context.

For Wixy: setting the right env vars to look like an agent (or just calling `wix login --api-key`) avoids the interactive UI entirely.

## Programmatic token retrieval

```bash
# Get an account-level access token (refreshes if expired)
wix token

# Get a site-scoped access token (JWT for calling Wix REST in that site's context)
wix token --site <site-uuid>

# JSON output (hidden flag, useful for scripts)
wix token --json
wix token --site <site-uuid> --json
```

`wix token` returns the token on stdout (no trailing newline beyond `\n`). `--json` wraps it as `{"accessToken": "..."}`. Use this anywhere a Wix REST endpoint expects an `Authorization: Bearer <token>` header.

The CLI refreshes the token silently if `issuedAt + expiresIn < now`. If the refresh-token has been revoked, the CLI clears `~/.wix/auth/account.json` and prompts re-login. In a non-interactive context this surfaces as exit code 1 with `AuthenticationRequired`.

## Logout

```bash
wix logout
```

Deletes `~/.wix/auth/` (recursively) and `~/.wix/auth.json` (legacy file, if present). The Wix server may still hold the refresh token; the CLI doesn't revoke remotely.

## `whoami`

```bash
wix whoami
```

Prints the email associated with the current account auth. If logged in via API key, prints the API-key-owner email (read from `~/.wix/auth/api-key.json`'s `userInfo.email`). Useful to confirm which Wix account a session is bound to before running write operations.

## OAuth endpoints reference

| Purpose | URL |
|---|---|
| Device code request | `POST https://manage.wix.com/v1/oauth/device/code` |
| Device code verify | `POST https://manage.wix.com/v1/oauth/device/verify` |
| Token exchange / refresh | `POST https://manage.wix.com/v1/oauth/token` |
| Wix REST APIs | `https://www.wixapis.com/*` |
| Editor (Wix sites editing) | `https://editor.wix.com/*` |
| Code (Velo/code.wix.com) | `https://code.wix.com/*` |
| General / marketing | `https://www.wix.com/*` |

The hard-coded OAuth client ID is `6f95cec8-3e98-48b9-b4e5-1fb92fcd9973` (extracted from `cli-auth/src/client.ts`). This is a **public client ID** — it's the same for every CLI install on every machine.

## Multi-account strategy for Wixy

The CLI assumes ONE Wix account per machine — there's no built-in account switching. To manage many Wix accounts from a single Wixy backend, isolate per child process:

- **Per-process HOME**: spawn `wix` with `HOME` (Unix) / `USERPROFILE` (Windows) pointing at a per-account directory. Each directory then holds its own `~/.wix/` tree. This is the cleanest isolation; no global mutable state is shared.
- **Per-account API keys**: store each customer's Wix API key encrypted in Wixy's DB. Pass it via a transient `~/.wix/auth/api-key.json` (or directly via `wix login --api-key <token>` against the isolated HOME) just before invoking commands.
- **Avoid** swapping `~/.wix/auth/` files between calls in a shared HOME — there are race conditions (the CLI reads/writes auth files lazily; concurrent invocations would corrupt state).

For site-level operations specifically, **prefer `wix token --site <siteId>` once + direct REST calls** over running the full CLI command. The CLI is built for developer ergonomics, not portal-scale orchestration.
